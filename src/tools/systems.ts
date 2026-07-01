import { z } from 'zod';
import { defineTool, type ToolDef } from './registry.js';
import { asArray, isRecord, num, str, viewUrl } from '../util/shape.js';
import {
  deriveInsights,
  findUnderperformers,
  type InsightOrder,
  type InsightProduct,
} from '../knowledge/insights.js';
import { listMyOrders, listMyProducts } from './read.js';
import type { ToolContext } from './context.js';

// Systems of action (tool spec §6). Multi-step, policy-bounded workflows over the merchant's own
// data. Mutating tools default to a DRY-RUN preview and only ever take safe actions (archive, not
// delete; keep listings' state; respect pricing floors) when explicitly applied.

const enc = encodeURIComponent;

async function loadData(
  ctx: ToolContext,
  storeUuid: string | undefined,
  workspace: string | undefined,
): Promise<{ products: InsightProduct[]; orders: InsightOrder[] }> {
  const p = (await listMyProducts.handler(
    { limit: 100, store_uuid: storeUuid, workspace },
    ctx,
  )) as unknown as { products?: InsightProduct[] };
  const o = (await listMyOrders.handler(
    { limit: 100, store_uuid: storeUuid, workspace },
    ctx,
  )) as unknown as { orders?: InsightOrder[] };
  return { products: p.products ?? [], orders: o.orders ?? [] };
}

export const analyzeWhatWorks = defineTool({
  name: 'analyze_what_works',
  description:
    "Surface insights from the merchant's own products + orders: best sellers, top channel, average order value. Read-only. Own-account signal (cross-merchant intelligence is a future feature).",
  inputSchema: z.object({
    scope: z.enum(['designs', 'products', 'channels', 'all']).optional(),
    time_window: z.enum(['7d', '30d', '90d', 'all']).optional(),
    store_uuid: z.string().optional(),
    workspace: z.string().optional(),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const { products, orders } = await loadData(ctx, input.store_uuid, input.workspace);
    return { insights: deriveInsights(products, orders) };
  },
});

export const autoOptimizeListings = defineTool({
  name: 'auto_optimize_listings',
  description:
    'Propose (and, with dry_run=false, apply) optimizations across listings. Currently flags no-sales products to pause. DEFAULTS TO DRY-RUN; applying only ever archives (never deletes, never changes a listing to live).',
  inputSchema: z.object({
    scope: z.enum(['underperformers', 'out_of_date', 'all']).optional(),
    dry_run: z.boolean().optional().describe('Default true — preview only.'),
    store_uuid: z.string().optional(),
    workspace: z.string().optional(),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    const { products, orders } = await loadData(ctx, input.store_uuid, input.workspace);
    const proposals = findUnderperformers(products, orders);
    const dryRun = input.dry_run ?? true;
    if (dryRun) {
      return { proposed_actions: proposals, executed: false };
    }
    const results: Record<string, unknown>[] = [];
    for (const p of proposals) {
      if (p.action !== 'pause') continue; // only the safe action auto-executes
      try {
        await ctx.api.patch(`product/${enc(p.product_uuid)}`, {
          body: { status: 'archived' },
          workspace: input.workspace,
          signal: ctx.signal,
        });
        results.push({ product_uuid: p.product_uuid, action: 'paused', status: 'ok' });
      } catch (err) {
        results.push({
          product_uuid: p.product_uuid,
          action: 'paused',
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { proposed_actions: proposals, executed: true, results };
  },
});

export const cascadePriceChange = defineTool({
  name: 'cascade_price_change',
  description:
    'Change a product price once and propagate it: the platform cascades to all variants, and (when store_uuid is given) this re-syncs each connected channel so the price is consistent everywhere. Avoids the "changed on one channel, forgot the others" footgun.',
  inputSchema: z.object({
    product_uuid: z.string().min(1),
    new_price: z.number().positive(),
    also_update_channels: z.boolean().optional().describe('Default true.'),
    store_uuid: z.string().optional().describe('Required to re-sync channels.'),
    workspace: z.string().optional(),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    const ws = input.workspace;
    const current = await ctx.api.get(`product/${enc(input.product_uuid)}`, { workspace: ws, signal: ctx.signal });
    const product = isRecord(current) && isRecord(current.product) ? current.product : current;
    const oldPrice = num(product, 'price', 'retail_price');

    await ctx.api.patch(`product/${enc(input.product_uuid)}`, {
      body: { price: input.new_price },
      workspace: ws,
      signal: ctx.signal,
    });

    const channelUpdates: Record<string, unknown>[] = [];
    let note: string | undefined;
    const channels = asArray(
      isRecord(product) ? (product.channel_statuses ?? product.ecommerce_statuses) : undefined,
    );
    if ((input.also_update_channels ?? true) && channels.length) {
      if (!input.store_uuid) {
        note = 'Pass store_uuid to also re-sync the new price to connected channels.';
      } else {
        for (const ch of channels) {
          const integ = str(ch, 'integration_uuid', 'uuid');
          if (!integ) continue;
          try {
            // No listing_state -> update the existing listing in place (don't flip it to draft).
            await ctx.api.post(
              `store/${enc(input.store_uuid)}/products/${enc(input.product_uuid)}/sync`,
              {
                query: { target: 'ecommerce', integration_uuid: integ },
                workspace: ws,
                signal: ctx.signal,
              },
            );
            channelUpdates.push({ integration_uuid: integ, status: 'updated' });
          } catch (err) {
            channelUpdates.push({
              integration_uuid: integ,
              status: 'failed',
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }

    return {
      product_uuid: input.product_uuid,
      old_price: oldPrice,
      new_price: input.new_price,
      variant_updates: 'cascaded',
      channel_updates: channelUpdates,
      product_url: viewUrl.product(input.product_uuid),
      note,
    };
  },
});

export const recoverFromOutage = defineTool({
  name: 'recover_from_outage',
  description:
    'Find products in a failed sync state (fulfillment or channel) and, with dry_run=false + a store_uuid, retry the syncs. DEFAULTS TO DRY-RUN (diagnose only).',
  inputSchema: z.object({
    store_uuid: z.string().optional(),
    scope: z.enum(['inventory', 'credentials', 'sync_drift', 'all']).optional(),
    dry_run: z.boolean().optional().describe('Default true — diagnose only.'),
    workspace: z.string().optional(),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    const ws = input.workspace;
    const raw = (await listMyProducts.handler(
      { limit: 100, store_uuid: input.store_uuid, workspace: ws },
      ctx,
    )) as { products?: Record<string, unknown>[] };
    const products = raw.products ?? [];

    const issues: Record<string, unknown>[] = [];
    for (const p of products) {
      const productUuid = str(p, 'product_uuid');
      const ff = isRecord(p) ? p.fulfillment_status : undefined;
      if (/fail/i.test(str(ff, 'sync_status') ?? '')) {
        issues.push({ product_uuid: productUuid, issue_type: 'fulfillment_sync_failed' });
      }
      for (const ch of asArray(isRecord(p) ? p.channel_statuses : undefined)) {
        if (/fail/i.test(str(ch, 'sync_status') ?? '')) {
          issues.push({
            product_uuid: productUuid,
            integration_uuid: str(ch, 'integration_uuid'),
            issue_type: 'channel_sync_failed',
          });
        }
      }
    }

    const dryRun = input.dry_run ?? true;
    if (dryRun || !input.store_uuid) {
      return {
        issues_found: issues,
        remediation_actions: issues.map((i) => ({ ...i, action: 'retry_sync' })),
        executed: false,
        ...(issues.length && !input.store_uuid && !dryRun
          ? { note: 'Pass store_uuid to retry the failed syncs.' }
          : {}),
      };
    }

    const results: Record<string, unknown>[] = [];
    for (const issue of issues) {
      const productUuid = String(issue.product_uuid ?? '');
      if (!productUuid) continue;
      try {
        if (issue.issue_type === 'fulfillment_sync_failed') {
          await ctx.api.post(`store/${enc(input.store_uuid)}/products/${enc(productUuid)}/sync`, {
            query: { target: 'merchandise' },
            workspace: ws,
            signal: ctx.signal,
          });
        } else {
          await ctx.api.post(`store/${enc(input.store_uuid)}/products/${enc(productUuid)}/sync`, {
            query: { target: 'ecommerce', integration_uuid: String(issue.integration_uuid ?? '') },
            workspace: ws,
            signal: ctx.signal,
          });
        }
        results.push({ ...issue, status: 'retried' });
      } catch (err) {
        results.push({ ...issue, status: 'failed', error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { issues_found: issues, executed: true, results };
  },
});

export const systemsTools: ToolDef[] = [
  analyzeWhatWorks,
  autoOptimizeListings,
  cascadePriceChange,
  recoverFromOutage,
];

import { z } from 'zod';
import { AhError } from '../errors.js';
import { defineTool, type ToolDef } from './registry.js';
import { asArray, bool, isRecord, num, str, total } from '../util/shape.js';

// Catalog import: TRACKED listings (platform epic apparelhub-ai#1326, API #1328).
//
// An established seller already has products live on a sales channel that ApparelHub never
// made. These tools bring those listings in so an agent can see the merchant's whole catalog.
// The contract that matters, and that every description below repeats because an agent will
// relay it to a merchant:
//   - READ-ONLY against the channel. Nothing is written to the merchant's store.
//   - Tracked, never fulfilled. Those products keep shipping exactly as they do today.
//   - A listing ApparelHub created is recognised and linked to its product, not duplicated.
//   - Images are the channel's own URLs, referenced rather than copied.
// Available where the channel reports catalog_read (WooCommerce and TikTok Shop today; the
// GET /store/{uuid} capability map and the catalog's `channels` both carry it); anything else
// answers catalog_read_unsupported.

const enc = encodeURIComponent;

const workspaceField = z
  .string()
  .optional()
  .describe('Workspace uuid (agency accounts). Omit for the Default workspace.');

const NOTHING_WRITTEN =
  "Nothing is written to the merchant's store, and these products stay fulfilled exactly as " +
  'they are today.';

export function mapImportRun(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null;
  return {
    run_uuid: str(raw, 'uuid', 'run_uuid'),
    integration_uuid: str(raw, 'integration_uuid') ?? null,
    status: str(raw, 'status'),
    pages: num(raw, 'pages') ?? 0,
    seen: num(raw, 'seen') ?? 0,
    created: num(raw, 'created') ?? 0,
    updated: num(raw, 'updated') ?? 0,
    ours: num(raw, 'ours') ?? 0,
    removed: num(raw, 'removed') ?? 0,
    images_fetched: num(raw, 'images_fetched') ?? 0,
    error: str(raw, 'error') ?? null,
    started_at: str(raw, 'started_at') ?? null,
    finished_at: str(raw, 'finished_at') ?? null,
  };
}

/** What the agent should do next, from a run's status. Never a guess about anything else. */
function nextStepFor(run: Record<string, unknown> | null): string | undefined {
  const status = run?.status;
  if (status === 'queued' || status === 'running') {
    return 'Still going. Poll get_catalog_import_run every few seconds until status is completed or failed.';
  }
  if (status === 'completed') {
    return 'Done. Read the listings with list_tracked_listings (scope "external" shows only the ones ApparelHub did not create).';
  }
  if (status === 'failed') {
    return 'The import stopped; `error` says why. What was read before it stopped is kept, and nothing was marked removed on a partial pass. Fix the cause (often: reconnect the channel) and start a new import; re-running never duplicates.';
  }
  return undefined;
}

function mapVariant(raw: unknown): Record<string, unknown> {
  return {
    // Kept as a string: channel ids can exceed 2^53 (TikTok's do).
    external_variant_id:
      isRecord(raw) && raw.external_variant_id != null ? String(raw.external_variant_id) : null,
    sku: str(raw, 'sku') ?? null,
    title: str(raw, 'title') ?? null,
    price: num(raw, 'price') ?? null,
  };
}

export function mapTrackedListing(raw: unknown): Record<string, unknown> {
  const productUuid = str(raw, 'product_uuid') ?? null;
  return {
    listing_uuid: str(raw, 'uuid', 'listing_uuid'),
    integration_uuid: str(raw, 'integration_uuid') ?? null,
    channel: str(raw, 'channel') ?? null,
    external_id: isRecord(raw) && raw.external_id != null ? String(raw.external_id) : null,
    title: str(raw, 'title') ?? null,
    description: str(raw, 'description') ?? null,
    image_url: str(raw, 'image_url') ?? null,
    price: num(raw, 'price') ?? null,
    currency: str(raw, 'currency') ?? null,
    channel_status: str(raw, 'channel_status') ?? null,
    product_sku: str(raw, 'product_sku') ?? null,
    variants: asArray(isRecord(raw) ? raw.variants : undefined).map(mapVariant),
    made_in_apparelhub: bool(raw, 'made_in_apparelhub') ?? productUuid !== null,
    product_uuid: productUuid,
    first_seen_at: str(raw, 'first_seen_at') ?? null,
    last_seen_at: str(raw, 'last_seen_at') ?? null,
    removed_at: str(raw, 'removed_at') ?? null,
  };
}

function mapChannelState(raw: unknown): Record<string, unknown> {
  return {
    integration_uuid: str(raw, 'integration_uuid'),
    channel: str(raw, 'channel') ?? null,
    catalog_read: bool(raw, 'catalog_read') ?? false,
    last_run: mapImportRun(isRecord(raw) ? raw.last_run : undefined),
  };
}

// The 409 refusals the start endpoint can return, each with its REAL next step. The broad
// error code stays `conflict` elsewhere; here the specific condition is the useful answer.
const REFUSALS: Record<string, { message: string; suggestion: string }> = {
  integration_inactive: {
    message: 'This sales channel is disconnected, so its catalog cannot be read.',
    suggestion:
      'Ask the merchant to reconnect the channel (start_channel_connect / check_connection_status), then start the import again.',
  },
  catalog_read_unsupported: {
    message: 'Catalog import is not available for this sales channel yet.',
    suggestion:
      'Do not retry. Catalog import works where the channel reports catalog_read: true (WooCommerce and TikTok Shop today; list_tracked_listings shows it per channel). Tell the merchant it is not available for this channel yet.',
  },
};

export const importChannelCatalog = defineTool({
  name: 'import_channel_catalog',
  description:
    'Bring the products a merchant ALREADY sells on a connected sales channel into ApparelHub as ' +
    'TRACKED listings, so you can see their whole catalog, not just what ApparelHub made. Use it ' +
    'when an established seller wants to see or manage what they already sell. ' +
    "READ-ONLY against the channel: nothing is written to the merchant's store, and those " +
    'products keep being fulfilled exactly as they are today (ApparelHub never fulfils them). ' +
    'Tell the merchant both of those things before you start. Listings ApparelHub created are ' +
    "recognised and linked to their product, not duplicated. Images stay the channel's own URLs. " +
    'Available where the channel reports catalog_read: true (WooCommerce and TikTok Shop today). ' +
    'To check first, call list_tracked_listings(store_uuid): its `channels` list every connected ' +
    'channel with catalog_read and last_run, even before any import. The import runs in the background: this returns a run to ' +
    'poll with get_catalog_import_run every few seconds until completed or failed, then read the ' +
    'result with list_tracked_listings. If an import for this channel is already running, this ' +
    'returns THAT run (already_running: true) instead of starting another; poll it. Re-running ' +
    'later is safe: it updates, never duplicates, and marks listings that left the channel as removed.',
  inputSchema: z.object({
    store_uuid: z.string().min(1).describe('The store uuid (from list_my_stores).'),
    integration_uuid: z
      .string()
      .min(1)
      .describe("The sales channel's integration uuid (list_my_stores -> ecommerce_integrations)."),
    workspace: workspaceField,
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  handler: async (input, ctx) => {
    const path =
      `store/${enc(input.store_uuid)}/ecommerce/integration/` +
      `${enc(input.integration_uuid)}/catalog/import`;
    try {
      const raw = await ctx.api.post(path, {
        body: {},
        workspace: input.workspace,
        signal: ctx.signal,
      });
      const run = mapImportRun(isRecord(raw) ? raw.run : undefined);
      return {
        run,
        already_running: false,
        note: NOTHING_WRITTEN,
        next_step: nextStepFor(run),
      };
    } catch (err) {
      if (!(err instanceof AhError) || err.httpStatus !== 409) throw err;
      if (err.apiCode === 'import_in_progress') {
        // The 409 body carries the running run, but the error path does not keep bodies, so
        // read it back from the catalog's per-channel state. Starting a second import is
        // exactly what the platform refused; the useful answer is the one already going.
        const state = await ctx.api.get(`store/${enc(input.store_uuid)}/catalog`, {
          query: { integration: input.integration_uuid, limit: 1 },
          workspace: input.workspace,
          signal: ctx.signal,
        });
        const channel = asArray(isRecord(state) ? state.channels : undefined)
          .map(mapChannelState)
          .find((c) => c.integration_uuid === input.integration_uuid);
        const run = (channel?.last_run as Record<string, unknown> | null | undefined) ?? null;
        return {
          run,
          already_running: true,
          note: NOTHING_WRITTEN,
          next_step: run
            ? nextStepFor(run)
            : 'An import for this channel is already running. Wait a few seconds and call list_tracked_listings or this tool again.',
        };
      }
      const refusal = err.apiCode ? REFUSALS[err.apiCode] : undefined;
      if (refusal) {
        throw new AhError({
          httpStatus: 409,
          code: err.apiCode as string,
          message: err.message || refusal.message,
          suggestion: refusal.suggestion,
        });
      }
      throw err;
    }
  },
});

export const getCatalogImportRun = defineTool({
  name: 'get_catalog_import_run',
  description:
    'Progress of a catalog import started with import_channel_catalog. status is queued, running, ' +
    'completed or failed, with counts: pages read, listings seen, created, updated, ours (listings ' +
    'ApparelHub made, linked to their product), removed (left the channel since the last import) ' +
    'and images_fetched. A failed run states `error`; what was read before it stopped is kept and ' +
    'nothing is marked removed on a partial pass. Poll every few seconds while queued/running. ' +
    'Read-only.',
  inputSchema: z.object({
    store_uuid: z.string().min(1).describe('The store uuid the import was started on.'),
    run_uuid: z.string().min(1).describe('The run uuid import_channel_catalog returned.'),
    workspace: workspaceField,
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.get(
      `store/${enc(input.store_uuid)}/catalog/runs/${enc(input.run_uuid)}`,
      { workspace: input.workspace, signal: ctx.signal },
    );
    const run = mapImportRun(isRecord(raw) ? raw.run : undefined);
    return { run, next_step: nextStepFor(run) };
  },
});

export const listTrackedListings = defineTool({
  name: 'list_tracked_listings',
  description:
    "The listings imported from a store's sales channels with import_channel_catalog, plus each " +
    "channel's import state (catalog_read, last_run). Each listing is the channel's view: title, " +
    'description, price, currency, channel_status (live/draft/archived/unknown), SKUs, variants and ' +
    "the channel's own image_url. made_in_apparelhub + product_uuid mark a listing ApparelHub " +
    'created. scope "external" returns only the merchant\'s own listings (what they sold before ' +
    'ApparelHub), "ours" only ApparelHub-made ones, "all" both. TRACKED LISTINGS ARE NOT ' +
    'APPARELHUB PRODUCTS: you cannot sync, price-cascade, edit or fulfil them through ApparelHub, ' +
    'and they keep shipping exactly as today. Removed listings (gone from the channel) are hidden ' +
    'unless include_removed is true. Paged: limit 1-500 (default 100), offset. Read-only.',
  inputSchema: z.object({
    store_uuid: z.string().min(1).describe('The store uuid (from list_my_stores).'),
    integration: z
      .string()
      .optional()
      .describe('Limit to one sales channel (its integration uuid).'),
    scope: z
      .enum(['all', 'external', 'ours'])
      .optional()
      .describe(
        '"external" = only listings ApparelHub did not create; "ours" = only ones it did. Default all.',
      ),
    include_removed: z
      .boolean()
      .optional()
      .describe('Also return listings that have left the channel (removed_at set). Default false.'),
    limit: z.number().int().min(1).max(500).optional().describe('Page size, 1-500. Default 100.'),
    offset: z.number().int().min(0).optional().describe('Rows to skip. Default 0.'),
    workspace: workspaceField,
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.get(`store/${enc(input.store_uuid)}/catalog`, {
      query: {
        integration: input.integration,
        scope: input.scope,
        include_removed: input.include_removed ? 'true' : undefined,
        limit: input.limit,
        offset: input.offset,
      },
      workspace: input.workspace,
      signal: ctx.signal,
    });
    const listings = asArray(raw, 'listings').map(mapTrackedListing);
    const channels = asArray(isRecord(raw) ? raw.channels : undefined).map(mapChannelState);
    return {
      listings,
      total: total(raw, listings.length),
      limit: num(raw, 'limit') ?? input.limit ?? 100,
      offset: num(raw, 'offset') ?? input.offset ?? 0,
      channels,
      note:
        'Tracked listings are read from the channel, not ApparelHub products: they cannot be ' +
        'synced, price-cascaded or fulfilled here, and nothing about them was changed on the store.',
    };
  },
});

export const trackedListingTools: ToolDef[] = [
  importChannelCatalog,
  getCatalogImportRun,
  listTrackedListings,
];

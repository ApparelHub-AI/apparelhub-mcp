import { z } from 'zod';
import { defineTool, type ToolDef } from './registry.js';
import { AhError } from '../errors.js';
import { asArray, isRecord, num, str, viewUrl } from '../util/shape.js';
import { pickDimensions } from '../image/dimensions.js';
import { pricingFloor } from '../knowledge/garments.js';
import { resolveVariants, type MatrixVariant } from '../knowledge/variants.js';
import { runMockup } from '../image/mockup.js';
import { resolveImageUrl } from './design.js';
import type { ToolContext } from './context.js';

// Product workflows (tool spec §3 + §3.5). ship_product runs the full 7-phase pipeline with the
// scar-tissue baked in:
//   - Lesson 2: the create endpoint uses provider_uuid / product_ref_id / price / print_data,
//     which DIFFER from the mockup endpoint's field names (image/mockup.ts handles that side).
//   - Lesson 53: two-phase mockup poll (in runMockup).
//   - Variants BEFORE sync; fulfillment sync BEFORE ecommerce sync; DRAFT (never live) default.
//   - Pricing floors: refuse to create at a negative-margin price.
//   - Lesson 7: AQUA-vs-Navy variant guard (in resolveVariants).

const enc = encodeURIComponent;

interface GarmentInfo {
  matrix: MatrixVariant[];
  area: { area_width: number; area_height: number; provider_ref_id: string };
  baseCost: number | undefined;
}

function mapMatrix(raw: unknown): MatrixVariant[] {
  return asArray(raw).map((v) => ({
    provider_variant_id: num(v, 'id', 'variant_id', 'provider_variant_id') ?? 0,
    color: str(v, 'color', 'color_name'),
    size: str(v, 'size'),
    cost: num(v, 'cost', 'price'),
  }));
}

async function fetchGarment(
  ctx: ToolContext,
  providerUuid: string,
  productRefId: string,
  workspace?: string,
): Promise<GarmentInfo> {
  const raw = await ctx.api.get(
    `merchandise/${enc(providerUuid)}/product/${enc(productRefId)}`,
    { workspace, signal: ctx.signal },
  );
  const g = isRecord(raw) && isRecord(raw.product) ? raw.product : raw;
  const matrix = mapMatrix(isRecord(g) ? g.variants : undefined);
  const templates = asArray(
    isRecord(g) ? (g.templates ?? g.print_templates ?? g.print_areas) : undefined,
  );
  const front =
    templates.find((tpl) =>
      /front|default/i.test(str(tpl, 'placement', 'provider_ref_id', 'type') ?? ''),
    ) ?? templates[0];
  const area = {
    area_width: num(front, 'area_width', 'print_area_width') ?? 1800,
    area_height: num(front, 'area_height', 'print_area_height') ?? 2400,
    provider_ref_id: str(front, 'placement', 'provider_ref_id', 'type') ?? 'front',
  };
  const baseCost = num(g, 'base_cost', 'cost', 'price') ?? matrix.find((m) => m.cost)?.cost;
  return { matrix, area, baseCost };
}

function buildPrintData(
  area: GarmentInfo['area'],
  designUrl: string,
): Record<string, unknown>[] {
  // Default placement: a chest-fill print sized for a square design (the agent can refine with
  // the dimensions helper). Encodes "respect the print area so Printful doesn't crop".
  const dims = pickDimensions(1, 1, area.area_width, area.area_height, 'chest_fill');
  return [
    {
      provider_ref_id: area.provider_ref_id,
      area_width: area.area_width,
      area_height: area.area_height,
      width: dims.width,
      height: dims.height,
      top: dims.top,
      left: dims.left,
      image_url: designUrl,
    },
  ];
}

function enforcePricingFloor(baseCost: number | undefined, price: number): void {
  const floor = pricingFloor(baseCost);
  if (floor !== undefined && price < floor) {
    throw new AhError({
      code: 'pricing_floor',
      message: `Price $${price.toFixed(2)} is below the recommended minimum $${floor.toFixed(2)} for this garment (it would risk a negative margin).`,
      suggestion: `Set price >= $${floor.toFixed(2)}.`,
    });
  }
}

const garmentSchema = z.object({
  provider_uuid: z.string().min(1),
  product_ref_id: z.string().min(1),
});
const variantSchema = z.object({
  color: z.string().min(1),
  sizes: z.array(z.string().min(1)).min(1),
  price: z.number().positive().optional(),
  provider_variant_ids: z.array(z.number()).optional(),
});

export const shipProduct = defineTool({
  name: 'ship_product',
  description:
    'End-to-end: take a design, generate + verify a mockup, create the product with the correct field names, add all variants, associate with a store, sync to fulfillment, then (optionally) sync to sales channels as DRAFT. Enforces pricing floors and guards the AQUA-vs-Navy variant trap. Streams progress.',
  inputSchema: z.object({
    design_uuid: z.string().min(1),
    garment: garmentSchema,
    variants: z.array(variantSchema).min(1),
    pricing: z.object({ price: z.number().positive(), shipping_price: z.number().optional() }),
    product_meta: z.object({ name: z.string().min(1), description: z.string() }),
    store_uuid: z.string().optional().describe('Omit to create a standalone (unassociated) product.'),
    sync_to_channels: z
      .array(z.object({ integration_uuid: z.string(), state: z.enum(['draft', 'live']).optional() }))
      .optional(),
    generate_mockup: z.boolean().optional().describe('Default true.'),
    design_url: z.string().url().optional().describe('The design URL, if known (else resolved).'),
    workspace: z.string().optional(),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    const ws = input.workspace;
    const warnings: string[] = [];

    await ctx.progress.report(5, 'Resolving garment + variants...');
    const garment = await fetchGarment(ctx, input.garment.provider_uuid, input.garment.product_ref_id, ws);
    enforcePricingFloor(garment.baseCost, input.pricing.price);

    const resolvedR = resolveVariants(
      garment.matrix,
      input.variants.map((v) => ({
        color: v.color,
        sizes: v.sizes,
        provider_variant_ids: v.provider_variant_ids,
        price: v.price,
      })),
      input.garment.product_ref_id,
      input.pricing.price,
    );
    warnings.push(...resolvedR.warnings);
    if (!resolvedR.resolved.length) {
      throw new AhError({
        code: 'bad_request',
        message: 'No variants could be resolved for the requested colors/sizes.',
        suggestion: 'Check colors/sizes against get_garment_details, or pass provider_variant_ids.',
      });
    }
    if (resolvedR.unresolved.length) {
      warnings.push(
        `Skipped ${resolvedR.unresolved.length} unresolved variant(s): ${resolvedR.unresolved
          .map((u) => `${u.color}/${u.size}`)
          .join(', ')}.`,
      );
    }
    const variantIds = resolvedR.resolved.map((r) => r.provider_variant_id);

    const designUrl = input.design_url ?? (await resolveImageUrl(ctx, input.design_uuid, ws));
    const printData = buildPrintData(garment.area, designUrl);

    let previewJobUuid: string | undefined;
    if (input.generate_mockup ?? true) {
      const m = await runMockup(
        ctx.api,
        {
          merchandise_provider_uuid: input.garment.provider_uuid,
          generated_image_uuid: input.design_uuid,
          provider_product_ref_id: input.garment.product_ref_id,
          templates: printData,
          variant_ids: variantIds.slice(0, 5),
        },
        { progress: ctx.progress, signal: ctx.signal, workspace: ws },
      );
      previewJobUuid = m.job_uuid;
    }

    await ctx.progress.report(55, 'Creating product...');
    const created = await ctx.api.post('product/create', {
      body: {
        name: input.product_meta.name,
        description: input.product_meta.description,
        generated_image_uuid: input.design_uuid,
        preview_job_uuid: previewJobUuid,
        provider_uuid: input.garment.provider_uuid,
        product_ref_id: String(input.garment.product_ref_id),
        price: input.pricing.price,
        print_data: printData,
      },
      workspace: ws,
      signal: ctx.signal,
    });
    const productUuid = str(created, 'uuid', 'product_uuid') ?? '';
    if (!productUuid) {
      throw new AhError({ code: 'internal_error', message: 'Product create did not return a uuid.' });
    }

    await ctx.progress.report(70, `Adding ${resolvedR.resolved.length} variants...`);
    let added = 0;
    for (const v of resolvedR.resolved) {
      await ctx.api.post(`product/${enc(productUuid)}/variants`, {
        body: {
          name: v.color,
          price: v.price ?? input.pricing.price,
          color: v.color,
          size: v.size,
          provider_variant_id: v.provider_variant_id,
        },
        workspace: ws,
        signal: ctx.signal,
      });
      added += 1;
    }

    let fulfillmentStatus: 'synced' | 'pending' | 'failed' = 'pending';
    const channelResults: Record<string, unknown>[] = [];
    if (input.store_uuid) {
      await ctx.api.post(`store/${enc(input.store_uuid)}/products`, {
        body: { product_uuids: [productUuid] },
        workspace: ws,
        signal: ctx.signal,
      });
      await ctx.progress.report(85, 'Syncing to fulfillment...');
      try {
        await ctx.api.post(`store/${enc(input.store_uuid)}/products/${enc(productUuid)}/sync`, {
          query: { target: 'merchandise' },
          workspace: ws,
          signal: ctx.signal,
        });
        fulfillmentStatus = 'synced';
      } catch (err) {
        fulfillmentStatus = 'failed';
        warnings.push(`Fulfillment sync failed: ${err instanceof AhError ? err.message : String(err)}`);
      }

      // Only sync to sales channels AFTER fulfillment (lifecycle ordering).
      for (const ch of input.sync_to_channels ?? []) {
        const state = ch.state ?? 'draft';
        try {
          const r = await ctx.api.post(`store/${enc(input.store_uuid)}/products/${enc(productUuid)}/sync`, {
            query: { target: 'ecommerce', integration_uuid: ch.integration_uuid, listing_state: state },
            workspace: ws,
            signal: ctx.signal,
          });
          channelResults.push({
            integration_uuid: ch.integration_uuid,
            status: state === 'live' ? 'synced_as_live' : 'synced_as_draft',
            listing_url: str(r, 'listing_url', 'external_url', 'url'),
          });
        } catch (err) {
          channelResults.push({
            integration_uuid: ch.integration_uuid,
            status: 'failed',
            error: err instanceof AhError ? err.message : String(err),
          });
        }
      }
    }

    await ctx.progress.report(100, 'Done.');
    return {
      product_uuid: productUuid,
      product_url: viewUrl.product(productUuid),
      fulfillment_status: fulfillmentStatus,
      variants_added: added,
      channel_sync_results: channelResults,
      warnings,
    };
  },
});

// --- Split primitives ---

export const createProduct = defineTool({
  name: 'create_product',
  description:
    'Create a product from a design (split primitive). Applies the correct field names + pricing floor. Pass mockup_variant_ids to also generate a mockup; otherwise the design is used as the display image. Add variants with add_variants next.',
  inputSchema: z.object({
    design_uuid: z.string().min(1),
    garment: garmentSchema,
    pricing: z.object({ price: z.number().positive(), shipping_price: z.number().optional() }),
    product_meta: z.object({ name: z.string().min(1), description: z.string() }),
    generate_mockup: z.boolean().optional(),
    mockup_variant_ids: z.array(z.number()).optional().describe('Representative variant ids for the mockup preview.'),
    design_url: z.string().url().optional(),
    workspace: z.string().optional(),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    const ws = input.workspace;
    const garment = await fetchGarment(ctx, input.garment.provider_uuid, input.garment.product_ref_id, ws);
    enforcePricingFloor(garment.baseCost, input.pricing.price);
    const designUrl = input.design_url ?? (await resolveImageUrl(ctx, input.design_uuid, ws));
    const printData = buildPrintData(garment.area, designUrl);

    let previewJobUuid: string | undefined;
    let mockupStatus: 'generated' | 'skipped' = 'skipped';
    if ((input.generate_mockup ?? Boolean(input.mockup_variant_ids?.length)) && input.mockup_variant_ids?.length) {
      const m = await runMockup(
        ctx.api,
        {
          merchandise_provider_uuid: input.garment.provider_uuid,
          generated_image_uuid: input.design_uuid,
          provider_product_ref_id: input.garment.product_ref_id,
          templates: printData,
          variant_ids: input.mockup_variant_ids.slice(0, 5),
        },
        { progress: ctx.progress, signal: ctx.signal, workspace: ws },
      );
      previewJobUuid = m.job_uuid;
      mockupStatus = 'generated';
    }

    const created = await ctx.api.post('product/create', {
      body: {
        name: input.product_meta.name,
        description: input.product_meta.description,
        generated_image_uuid: input.design_uuid,
        preview_job_uuid: previewJobUuid,
        provider_uuid: input.garment.provider_uuid,
        product_ref_id: String(input.garment.product_ref_id),
        price: input.pricing.price,
        print_data: printData,
      },
      workspace: ws,
      signal: ctx.signal,
    });
    const productUuid = str(created, 'uuid', 'product_uuid') ?? '';
    return {
      product_uuid: productUuid,
      product_url: productUuid ? viewUrl.product(productUuid) : undefined,
      mockup_status: mockupStatus,
      warnings: [],
    };
  },
});

export const addVariants = defineTool({
  name: 'add_variants',
  description:
    'Add variants to an existing product (split primitive). Resolves provider_variant_ids by color+size from the product\'s provider options (or pass them explicitly). Warns on the AQUA-vs-Navy trap. Variants must exist before syncing.',
  inputSchema: z.object({
    product_uuid: z.string().min(1),
    variants: z.array(variantSchema).min(1),
    product_ref_id: z.string().optional().describe('Enables the AQUA-vs-Navy guard for BC 3001 ("71").'),
    workspace: z.string().optional(),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    const ws = input.workspace;
    const options = await ctx.api.get(`product/${enc(input.product_uuid)}/provider-options`, {
      workspace: ws,
      signal: ctx.signal,
    });
    const matrix = mapMatrix(
      Array.isArray(options)
        ? options
        : isRecord(options)
          ? (options.variants ?? options.options ?? options.provider_options)
          : undefined,
    );
    const resolvedR = resolveVariants(
      matrix,
      input.variants.map((v) => ({
        color: v.color,
        sizes: v.sizes,
        provider_variant_ids: v.provider_variant_ids,
        price: v.price,
      })),
      input.product_ref_id,
    );
    let added = 0;
    for (const v of resolvedR.resolved) {
      await ctx.api.post(`product/${enc(input.product_uuid)}/variants`, {
        body: { name: v.color, price: v.price, color: v.color, size: v.size, provider_variant_id: v.provider_variant_id },
        workspace: ws,
        signal: ctx.signal,
      });
      added += 1;
    }
    const warnings = [...resolvedR.warnings];
    if (resolvedR.unresolved.length) {
      warnings.push(
        `Unresolved: ${resolvedR.unresolved.map((u) => `${u.color}/${u.size}`).join(', ')}.`,
      );
    }
    return { product_uuid: input.product_uuid, variants_added: added, warnings };
  },
});

export const syncToFulfillment = defineTool({
  name: 'sync_to_fulfillment',
  description: 'Sync a product to its fulfillment provider (Printful/Printify). Do this before syncing to any sales channel.',
  inputSchema: z.object({
    product_uuid: z.string().min(1),
    store_uuid: z.string().min(1),
    workspace: z.string().optional(),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    await ctx.api.post(`store/${enc(input.store_uuid)}/products/${enc(input.product_uuid)}/sync`, {
      query: { target: 'merchandise' },
      workspace: input.workspace,
      signal: ctx.signal,
    });
    return { product_uuid: input.product_uuid, fulfillment_status: 'synced' };
  },
});

export const syncToChannel = defineTool({
  name: 'sync_to_channel',
  description: 'Sync a product to one sales channel. Defaults to DRAFT — only push live when the user explicitly asks.',
  inputSchema: z.object({
    product_uuid: z.string().min(1),
    store_uuid: z.string().min(1),
    integration_uuid: z.string().min(1),
    state: z.enum(['draft', 'live']).optional(),
    workspace: z.string().optional(),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    const state = input.state ?? 'draft';
    const r = await ctx.api.post(`store/${enc(input.store_uuid)}/products/${enc(input.product_uuid)}/sync`, {
      query: { target: 'ecommerce', integration_uuid: input.integration_uuid, listing_state: state },
      workspace: input.workspace,
      signal: ctx.signal,
    });
    return {
      product_uuid: input.product_uuid,
      integration_uuid: input.integration_uuid,
      sync_status: state === 'live' ? 'synced_as_live' : 'synced_as_draft',
      channel_url: str(r, 'listing_url', 'external_url', 'url'),
    };
  },
});

export const updateProduct = defineTool({
  name: 'update_product',
  description: 'Update a product (name, description, price). For a price change that must propagate to synced channels, prefer cascade_price_change.',
  inputSchema: z.object({
    product_uuid: z.string().min(1),
    changes: z.object({
      name: z.string().optional(),
      description: z.string().optional(),
      price: z.number().positive().optional(),
    }),
    workspace: z.string().optional(),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    const body: Record<string, unknown> = {};
    if (input.changes.name !== undefined) body.name = input.changes.name;
    if (input.changes.description !== undefined) body.description = input.changes.description;
    if (input.changes.price !== undefined) body.price = input.changes.price;
    if (Object.keys(body).length === 0) {
      throw new AhError({ code: 'bad_request', message: 'No changes provided.' });
    }
    await ctx.api.patch(`product/${enc(input.product_uuid)}`, {
      body,
      workspace: input.workspace,
      signal: ctx.signal,
    });
    return {
      product_uuid: input.product_uuid,
      changes_applied: Object.keys(body),
      product_url: viewUrl.product(input.product_uuid),
    };
  },
});

export const deleteProduct = defineTool({
  name: 'delete_product',
  description:
    'Delete (default) or archive a product. Hard delete cascades to variants; if the product is synced to channels, unsync it first (sync_to_channel / the web UI) to avoid orphan listings.',
  inputSchema: z.object({
    product_uuid: z.string().min(1),
    archive_only: z.boolean().optional().describe('Default false (hard delete).'),
    workspace: z.string().optional(),
  }),
  annotations: { destructiveHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    if (input.archive_only) {
      await ctx.api.patch(`product/${enc(input.product_uuid)}`, {
        body: { status: 'archived' },
        workspace: input.workspace,
        signal: ctx.signal,
      });
      return { product_uuid: input.product_uuid, deleted: false, archived: true };
    }
    await ctx.api.del(`product/${enc(input.product_uuid)}`, {
      workspace: input.workspace,
      signal: ctx.signal,
    });
    return { product_uuid: input.product_uuid, deleted: true };
  },
});

export const productTools: ToolDef[] = [
  shipProduct,
  createProduct,
  addVariants,
  syncToFulfillment,
  syncToChannel,
  updateProduct,
  deleteProduct,
];

import { z } from 'zod';
import { defineTool, type ToolDef } from './registry.js';
import { AhError } from '../errors.js';
import { asArray, isRecord, num, str, total } from '../util/shape.js';
import {
  garmentWarnings,
  pricingFloor,
  qualityTier,
  recommendGarment,
} from '../knowledge/garments.js';
import type { ToolContext } from './context.js';

// Catalog tools (tool spec §4). Wrap the fulfillment-provider catalog endpoints and add the
// garment-selection knowledge (pricing floors, quality tiers, variant traps).

// Provider selection is discovery-driven, NOT a hardcoded enum. Which fulfillment providers an
// account can use is an auth/entitlement decision that lives on the platform — GET /merchandise/providers
// is account-scoped and feature-flag-gated, so it returns exactly the providers THIS caller is entitled
// to. A stateless MCP can't know the caller's entitlement when tools/list is served, so a closed enum
// would be an authorization decision frozen into a JSON schema (and would silently reject any provider
// the account gains beyond the hardcoded set). We accept any name and validate it against the account's
// LIVE provider list, surfacing the real available names on no-match. See apparelhub-mcp#110.
const providerInput = z
  .string()
  .min(1)
  .describe(
    'The fulfillment provider to browse, by name (case-insensitive). Must be a provider this account has access to — call list_catalog_providers to see valid values (the set is account-specific). An unrecognized name returns the list of providers available to the account.',
  );

/**
 * Resolve a provider NAME to its provider_uuid via the account's LIVE GET /merchandise/providers list.
 * That endpoint is account-scoped and auth-gated, so it is the single source of truth for which
 * providers this caller may use. On no-match we enumerate the actual available names so the caller
 * can self-correct in one retry.
 */
async function resolveProviderUuid(
  ctx: ToolContext,
  providerName: string,
  workspace?: string,
): Promise<string> {
  const raw = await ctx.api.get('merchandise/providers', { workspace, signal: ctx.signal });
  const providers = asArray(raw, 'providers', 'merchandise_providers');
  const target = providerName.toLowerCase();
  for (const p of providers) {
    const name = (str(p, 'name', 'provider_name') ?? '').toLowerCase();
    if (name.includes(target)) {
      const uuid = str(p, 'uuid', 'provider_uuid');
      if (uuid) return uuid;
    }
  }
  const available = providers
    .map((p) => str(p, 'name', 'provider_name'))
    .filter((n): n is string => Boolean(n));
  throw new AhError({
    code: 'not_found',
    message: available.length
      ? `No fulfillment provider matching "${providerName}" is available to this account. Available providers: ${available.join(', ')}.`
      : 'No fulfillment providers are available to this account.',
    suggestion: available.length
      ? 'Use one of the listed provider names (case-insensitive). Provider availability is account-specific and set by the platform.'
      : 'Connect a fulfillment provider in ApparelHub first (see list_my_stores).',
  });
}

function mapGarment(raw: unknown): Record<string, unknown> {
  const variants = asArray(isRecord(raw) ? raw.variants : undefined);
  return {
    provider_ref_id: str(raw, 'provider_ref_id', 'ref_id', 'product_ref_id', 'id'),
    name: str(raw, 'name', 'title'),
    brand: str(raw, 'brand', 'brand_name'),
    category: str(raw, 'category', 'type', 'department'),
    base_cost: num(raw, 'base_cost', 'cost', 'price'),
    image_url: str(raw, 'image_url', 'thumbnail_url', 'image'),
    variant_count: num(raw, 'variant_count', 'variants_count') ?? (variants.length || undefined),
  };
}

export const browseCatalog = defineTool({
  name: 'browse_catalog',
  description:
    "Browse a fulfillment provider's catalog for garments to print on. The provider can be any fulfillment provider available to this account. Returns minimal listing fields. Read-only.",
  inputSchema: z.object({
    provider: providerInput,
    category: z.string().optional().describe('e.g. "t-shirts", "hoodies", "mugs".'),
    keyword: z.string().optional(),
    has_aop: z.boolean().optional().describe('All-over-print garments only.'),
    page: z.number().int().positive().optional(),
    per_page: z.number().int().positive().max(100).optional(),
    workspace: z.string().optional(),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const providerUuid = await resolveProviderUuid(ctx, input.provider, input.workspace);
    const raw = await ctx.api.get(`merchandise/${encodeURIComponent(providerUuid)}/products`, {
      query: {
        category: input.category,
        keyword: input.keyword,
        has_aop: input.has_aop,
        page: input.page,
        per_page: input.per_page,
      },
      workspace: input.workspace,
      signal: ctx.signal,
    });
    const garments = asArray(raw, 'products', 'garments').map(mapGarment);
    return { provider: input.provider, garments, total: total(raw, garments.length) };
  },
});

function mapVariant(raw: unknown): Record<string, unknown> {
  return {
    provider_variant_id: num(raw, 'id', 'variant_id', 'provider_variant_id', 'provider_ref_id'),
    color: str(raw, 'color', 'color_name'),
    color_hex: str(raw, 'color_hex', 'hex', 'color_code'),
    size: str(raw, 'size'),
    cost: num(raw, 'cost', 'price'),
  };
}

function mapTemplate(raw: unknown): Record<string, unknown> {
  return {
    placement: str(raw, 'placement', 'provider_location_ref_id', 'provider_ref_id', 'type'),
    area_width: num(raw, 'area_width', 'print_area_width'),
    area_height: num(raw, 'area_height', 'print_area_height'),
    recommended_image_size: {
      width: num(raw, 'width', 'template_width'),
      height: num(raw, 'height', 'template_height'),
    },
  };
}

export const getGarmentDetails = defineTool({
  name: 'get_garment_details',
  description:
    'Full detail for one garment: the variant matrix (colors/sizes/costs), print templates, ApparelHub pricing floor, and quality tier. Read-only.',
  inputSchema: z.object({
    provider: providerInput,
    product_ref_id: z
      .string()
      .min(1)
      .describe('The garment ref id from browse_catalog (a string).'),
    workspace: z.string().optional(),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const providerUuid = await resolveProviderUuid(ctx, input.provider, input.workspace);
    const raw = await ctx.api.get(
      `merchandise/${encodeURIComponent(providerUuid)}/product/${encodeURIComponent(input.product_ref_id)}`,
      { workspace: input.workspace, signal: ctx.signal },
    );
    const g = isRecord(raw) && isRecord(raw.product) ? raw.product : raw;
    const baseCost = num(g, 'base_cost', 'cost', 'price');
    const brand = str(g, 'brand', 'brand_name');
    const name = str(g, 'name', 'title');
    const variantsRaw = isRecord(g) ? g.variants : undefined;
    let templatesRaw = isRecord(g)
      ? (g.templates ?? g.template_details ?? g.print_templates ?? g.print_areas)
      : undefined;
    // Fall back to the variant's templates when the top-level list is empty OR
    // dimensionless. Printful carries templates per-variant; Gelato's top-level
    // template_details lists placements with NO area/template dims (the real dims live on
    // variants[].templates), so without this the print_templates come back with an empty
    // recommended_image_size for Gelato (apparelhub-mcp#111 follow-up).
    const topHasDims = asArray(templatesRaw).some(
      (t) =>
        isRecord(t) &&
        (num(t, 'area_width', 'print_area_width') || num(t, 'width', 'template_width')),
    );
    if (!topHasDims) {
      const firstVariant = asArray(variantsRaw)[0];
      if (isRecord(firstVariant) && asArray(firstVariant.templates).length) {
        templatesRaw = firstVariant.templates;
      }
    }

    return {
      garment: {
        provider_ref_id: input.product_ref_id,
        name,
        brand,
        category: str(g, 'category', 'type', 'department'),
        base_cost: baseCost,
        image_url: str(g, 'image_url', 'thumbnail_url', 'image'),
      },
      variants: asArray(variantsRaw).map(mapVariant),
      print_templates: asArray(templatesRaw).map(mapTemplate),
      pricing_floor: pricingFloor(baseCost),
      quality_tier: qualityTier(brand, name),
      warnings: garmentWarnings(input.product_ref_id),
    };
  },
});

export const recommendGarmentTool = defineTool({
  name: 'recommend_garment',
  description:
    "Recommend a garment type for a design/use-case, encoding ApparelHub's garment trade-offs (BC 3001 vs Comfort Colors, budget vs premium, pricing floors). Returns a pick + rationale + alternatives. Advisory / knowledge-based.",
  inputSchema: z.object({
    design_uuid: z
      .string()
      .optional()
      .describe(
        'Optional design for context. Design-content-based ranking is a future enhancement; not required today.',
      ),
    target_audience: z.enum(['young_adult', 'mom_dad', 'athleisure', 'premium', 'auto']).optional(),
    budget_tier: z.enum(['budget', 'standard', 'premium', 'auto']).optional(),
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: async (input) => {
    return recommendGarment({ budget_tier: input.budget_tier, audience: input.target_audience });
  },
});

export const listCatalogProviders = defineTool({
  name: 'list_catalog_providers',
  description:
    'List the fulfillment providers this account can browse catalogs from. Use this to discover valid `provider` values for browse_catalog / get_garment_details — the set is account-specific and auth-gated on the platform (a provider only appears if this account is entitled to it), so never assume a fixed list. Read-only.',
  inputSchema: z.object({
    workspace: z.string().optional(),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.get('merchandise/providers', {
      workspace: input.workspace,
      signal: ctx.signal,
    });
    const providers = asArray(raw, 'providers', 'merchandise_providers')
      .map((p) => ({
        name: str(p, 'name', 'provider_name'),
        uuid: str(p, 'uuid', 'provider_uuid'),
        active: isRecord(p) ? Boolean(p.active) : undefined,
        auth_mode: str(p, 'user_auth_mode'),
      }))
      .filter((p) => p.name);
    return { providers, total: providers.length };
  },
});

export const catalogTools: ToolDef[] = [
  browseCatalog,
  getGarmentDetails,
  recommendGarmentTool,
  listCatalogProviders,
];

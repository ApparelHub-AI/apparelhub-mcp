import { z } from 'zod';
import { defineTool, type ToolDef } from './registry.js';
import { AhError } from '../errors.js';
import { asArray, isRecord, num, str, total, variantRef } from '../util/shape.js';
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

/**
 * How a garment can be decorated, in provider-neutral terms (platform #758).
 *
 * Carried through EVERY catalog projection deliberately. The failure this comes
 * from: an agent found one provider's headwear was embroidery-only and reported
 * "no hat is possible" as settled fact, while the same account carried printed
 * caps elsewhere. It had no provider-agnostic way to ask "can this take a
 * photograph?", so it inferred one from a provider-specific string convention.
 *
 * `accepts_photoreal` is nullable and the null is load-bearing: it means nobody
 * could tell, NOT that the garment cannot take the design. Dropping the field
 * when absent (rather than coercing to false) is what keeps that distinction
 * intact through this layer.
 */
function decorationFields(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) return {};
  const methods = asArray(raw.decoration_method).filter(
    (m): m is string => typeof m === 'string',
  );
  const photoreal = raw.accepts_photoreal;
  return {
    ...(methods.length ? { decoration_method: methods } : {}),
    ...(str(raw, 'decoration_confidence')
      ? { decoration_confidence: str(raw, 'decoration_confidence') }
      : {}),
    ...(typeof photoreal === 'boolean' ? { accepts_photoreal: photoreal } : {}),
  };
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
    ...decorationFields(raw),
  };
}

export const browseCatalog = defineTool({
  name: 'browse_catalog',
  description:
    "Browse ONE fulfillment provider's catalog for garments to print on. `category` is resolved against THAT provider's own taxonomy (providers use different vocabularies for the same idea) and an unknown category is rejected with the valid list rather than quietly returning everything. `keyword` matches product names across the whole catalog. ALWAYS read `warnings` in the response: they tell you when your results are narrower than you asked for -- e.g. a category that only exists inside one department. Each garment carries `decoration_method` / `accepts_photoreal` (`accepts_photoreal` absent means the provider publishes no signal -- unchecked, NOT unsuitable). This searches a SINGLE provider: to ask what the whole account can do, or before concluding a garment cannot take a design, use find_garments. Read-only.",
  inputSchema: z.object({
    provider: providerInput,
    category: z.string().optional().describe('e.g. "t-shirts", "hoodies", "mugs".'),
    keyword: z.string().optional(),
    has_aop: z
      .boolean()
      .optional()
      .describe(
        'Filter to all-over-print garments. All-over print is the weakest part of the decoration signal (not every provider declares the technique, so some are recognised by name) and this searches ONE provider — use find_garments before concluding no provider carries it. Read the response warnings.',
      ),
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
    // Surface the platform's `warnings` verbatim. They carry the one thing a
    // filtered browse cannot convey on its own: that the result set is NARROWER
    // than asked for. e.g. Printful's only node named "Hats" lives under kids,
    // so category=hats returns a single product -- without the warning an agent
    // concludes "only one hat exists", which is the failure this whole area is
    // about. Dropping them here would strand the fix inside the API.
    const warnings = isRecord(raw) && Array.isArray(raw.warnings)
      ? (raw.warnings as unknown[]).filter((w): w is string => typeof w === 'string')
      : [];
    const applied = isRecord(raw) && isRecord(raw.filters_applied) ? raw.filters_applied : undefined;
    return {
      provider: input.provider,
      garments,
      total: total(raw, garments.length),
      ...(applied ? { filters_applied: applied } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  },
});

function mapVariant(raw: unknown): Record<string, unknown> {
  return {
    provider_variant_id: variantRef(
      raw,
      'id',
      'variant_id',
      'provider_variant_id',
      'provider_ref_id',
    ),
    color: str(raw, 'color', 'color_name'),
    color_hex: str(raw, 'color_hex', 'hex', 'color_code'),
    size: str(raw, 'size'),
    cost: num(raw, 'cost', 'price'),
    // Provenance of `cost`. Without it an agent cannot tell a live catalog price
    // from a snapshot captured the last time this blank was built, and would
    // compare providers as though both numbers were equally current.
    //   live        - read from the provider catalog on this request
    //   cached      - snapshot from a previous build; see cost_captured_at
    //   unavailable - no cost known, `cost` is absent
    cost_source: str(raw, 'cost_source'),
    cost_captured_at: str(raw, 'cost_captured_at'),
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
        ...decorationFields(g),
      },
      variants: asArray(variantsRaw).map(mapVariant),
      print_templates: asArray(templatesRaw).map(mapTemplate),
      pricing_floor: pricingFloor(baseCost),
      quality_tier: qualityTier(brand, name),
      warnings: garmentWarnings(input.product_ref_id),
    };
  },
});

export const findGarments = defineTool({
  name: 'find_garments',
  description:
    "Search EVERY fulfillment provider on the account at once for garments matching a capability. USE THIS BEFORE TELLING A USER AN ITEM CANNOT BE BUILT. A capability limit is almost always scoped to one provider, not to the category of garment: one provider carrying only embroidered headwear says nothing about another's printed caps. browse_catalog answers 'what does THIS provider carry'; this answers 'what on this ACCOUNT can take this design'. Provider scope defaults to every provider available — pass `providers` only to deliberately narrow it. Returns a compact ranked shortlist (confirmed capability first), plus `providers_searched` so you can state your coverage honestly rather than implying you checked everything. An empty result means nothing matched THESE filters on THESE providers; it is not proof the garment does not exist, and the warnings say so. Read-only.",
  inputSchema: z.object({
    category: z
      .string()
      .optional()
      .describe(
        'Garment kind, e.g. "hat", "t-shirt", "mug". Matched against product names across each provider\'s whole catalog, including the words providers actually use ("hat" also finds cap / beanie / snapback / trucker).',
      ),
    keyword: z.string().optional().describe('Extra substring match on name/brand.'),
    decoration_method: z
      .array(
        z.enum([
          'embroidery',
          'dtg',
          'dtf',
          'sublimation',
          'aop',
          'patch',
          'screen',
          'vinyl',
          'print',
        ]),
      )
      .optional()
      .describe('Any match qualifies. "print" means a print process the provider does not name more precisely.'),
    accepts_photoreal: z
      .boolean()
      .optional()
      .describe(
        'true for photographic / gradient-heavy / fine-detail artwork; false to find garments you can embroider. This is the filter that answers "can this design go on this thing".',
      ),
    providers: z
      .array(z.string())
      .optional()
      .describe(
        'Provider NAMES to restrict to. OMIT to search every provider on the account — that is the default and the recommended usage.',
      ),
    include_unknown: z
      .boolean()
      .optional()
      .describe(
        'Keep garments whose decoration method the provider never published. Default true: unclassified is not the same as unsuitable, and excluding them hides real options.',
      ),
    verify: z
      .boolean()
      .optional()
      .describe(
        'Confirm low-confidence matches with a per-garment lookup. Defaults on when filtering by capability. Bounded, so a very broad search may leave some unverified.',
      ),
    limit: z.number().int().positive().max(50).optional().describe('Default 20.'),
    workspace: z.string().optional(),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.get('merchandise/find-garments', {
      query: {
        category: input.category,
        keyword: input.keyword,
        // The platform takes csv; an array here would serialize per-key.
        decoration_method: input.decoration_method?.join(','),
        accepts_photoreal: input.accepts_photoreal,
        providers: input.providers?.join(','),
        include_unknown: input.include_unknown,
        verify: input.verify,
        limit: input.limit,
      },
      workspace: input.workspace,
      signal: ctx.signal,
    });

    const results = asArray(raw, 'results', 'garments').map((r) => ({
      provider: str(r, 'provider'),
      product_ref_id: str(r, 'product_ref_id', 'provider_ref_id'),
      name: str(r, 'name'),
      brand: str(r, 'brand'),
      image_url: str(r, 'image_url', 'image'),
      variant_count: num(r, 'variant_count'),
      ...decorationFields(r),
    }));

    // providers_searched / providers_unavailable / warnings are passed through
    // verbatim. They carry the only thing the result list cannot say on its own:
    // what was NOT looked at. An agent that reports "no printable hat exists"
    // after searching two of three providers is repeating the #757 mistake with
    // better data, so the coverage has to travel with the answer.
    const passthrough = (key: string) =>
      isRecord(raw) && Array.isArray(raw[key]) ? { [key]: raw[key] } : {};

    return {
      results,
      total_matched: isRecord(raw) && typeof raw.total_matched === 'number'
        ? raw.total_matched
        : results.length,
      ...passthrough('providers_searched'),
      ...passthrough('providers_unavailable'),
      ...(isRecord(raw) && isRecord(raw.filters_applied)
        ? { filters_applied: raw.filters_applied }
        : {}),
      ...passthrough('warnings'),
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
  findGarments,
  recommendGarmentTool,
  listCatalogProviders,
];

import { z } from 'zod';
import { defineTool, type ToolDef } from './registry.js';
import { asArray, bool, isRecord, num, str } from '../util/shape.js';
import { AhError } from '../errors.js';

// Tools for a connected SALES CHANNEL — everything specific to the channel
// rather than to the product itself. Two groups today:
//
//   * PERFORMANCE — what the channel reports about each listing.
//   * LISTING ATTRIBUTES — the channel-defined fields on a listing, and the
//     shop-wide settings behind them.
//
// Grouped by channel rather than split per feature, matching how product.ts
// holds everything product-shaped: a new channel-specific capability belongs
// here rather than in a file of its own.
//
// ---------------------------------------------------------------------------
// PERFORMANCE
// ---------------------------------------------------------------------------
//
// These expose what the SALES CHANNEL reports about each listing — impressions,
// clicks, click-through rate, add-to-carts — which the order-derived analytics
// tools cannot see. Those only know what SOLD, so a listing with heavy traffic
// and zero sales is invisible to them. That listing is usually the most valuable
// thing in the catalogue, and finding it is the point of these tools.
//
// ⛔ COVERAGE IS SPARSE AND THAT MATTERS.
// TikTok Shop reports a full funnel. WooCommerce core records no view data at
// all. A shop connected before its analytics scope was granted reports nothing
// until the merchant reconnects it. So a metric can be missing for three very
// different reasons, and every response carries a `coverage` block saying which.
//
// NEVER read a missing metric as zero. "Nobody saw it" and "we cannot see who
// saw it" lead to opposite decisions: the first is a dead listing, the second is
// unknown. Conflating them is how you archive a listing that was working.

const rangeShape = {
  start: z
    .string()
    .optional()
    .describe("Start date (YYYY-MM-DD), in the sales channel's own local dates. Defaults to 28 days back."),
  end: z
    .string()
    .optional()
    .describe("End date (YYYY-MM-DD), channel-local. Defaults to yesterday."),
  workspace: z
    .string()
    .optional()
    .describe('Workspace uuid to scope to (agency accounts). Omit for the Default workspace.'),
};

function mapCoverage(raw: unknown): Record<string, unknown> {
  return {
    provider: str(raw, 'provider'),
    integration_uuid: str(raw, 'integration_uuid'),
    supported: bool(raw, 'supported'),
    grain: str(raw, 'grain'),
    reported_metrics: asArray(isRecord(raw) ? raw.reported_metrics : undefined),
    unreported_metrics: asArray(isRecord(raw) ? raw.unreported_metrics : undefined),
    status: str(raw, 'status'),
    status_detail: str(raw, 'status_detail'),
    notes: str(raw, 'notes'),
  };
}

function mapListing(raw: unknown): Record<string, unknown> {
  return {
    channel_product_ref: str(raw, 'channel_product_ref'),
    // Which channel/store these numbers came from. A channel product id is only
    // unique WITHIN its channel, so never compare two rows without checking this.
    provider: str(raw, 'provider'),
    store_name: str(raw, 'store_name'),
    store_uuid: str(raw, 'store_uuid'),
    product_uuid: str(raw, 'product_uuid'),
    product_name: str(raw, 'product_name'),
    mapped_to_apparelhub: bool(raw, 'mapped_to_apparelhub'),
    state: str(raw, 'state'),
    action: str(raw, 'action'),
    reason: str(raw, 'reason'),
    impressions: num(raw, 'impressions'),
    clicks: num(raw, 'clicks'),
    units_sold: num(raw, 'units_sold'),
    ctr: num(raw, 'ctr'),
    exposure_percentile: num(raw, 'exposure_percentile'),
    days_observed: num(raw, 'days_observed'),
    metrics: isRecord(raw) && isRecord(raw.metrics) ? raw.metrics : undefined,
  };
}

function mapEnvelope(raw: unknown): Record<string, unknown> {
  return {
    range: isRecord(raw) && isRecord(raw.range) ? raw.range : undefined,
    date_basis: str(raw, 'date_basis'),
    date_basis_note: str(raw, 'date_basis_note'),
    coverage: asArray(isRecord(raw) ? raw.coverage : undefined).map(mapCoverage),
  };
}

export const channelPerformance = defineTool({
  name: 'channel_performance',
  description:
    "What the sales channel reports about each of your listings: impressions, clicks, " +
    'click-through rate and units sold, plus a state telling you what to do about it. ' +
    'Use this to find listings people SEE but do not BUY — the order-based analytics ' +
    'tools cannot show you those, because to them a listing with 5,000 views and no ' +
    'sales looks identical to one nobody has ever seen. ' +
    'States: winner (scale it), conversion_blocked (lots of views, few clicks — the ' +
    'listing card is losing them), pdp_blocked (they click but do not buy — the product ' +
    'page is losing them), starved (too few views to judge; needs discovery, NOT a ' +
    'rewrite), dead (no activity at all; the only state safe to archive), ' +
    'no_channel_data (synced to the channel, but the channel has never reported it — ' +
    'usually means it is not actually live; check the listing before anything else), ' +
    'insufficient_data (not enough signal, or this channel does not report it). ' +
    'READ `summary.shop` FIRST. If it says no_channel_traffic, the whole shop is barely ' +
    'being served and no per-listing state means anything yet — the problem is ' +
    'distribution, and editing titles or images cannot fix a listing nobody is shown. ' +
    'Each row says which channel and store it came from — always check that before ' +
    'comparing two rows, since a channel product id is only unique within its own channel. ' +
    'ALWAYS check the coverage block before treating a missing metric as zero. Read-only.',
  inputSchema: z.object({
    ...rangeShape,
    provider: z
      .string()
      .optional()
      .describe(
        'Only listings from this sales channel, by name (e.g. "TikTok Shop"). ' +
          'Case-insensitive. channels_present lists the channels that actually have data.',
      ),
    store: z.string().optional().describe('Only listings from this store uuid.'),
    state: z
      .string()
      .optional()
      .describe(
        'Filter to one state, e.g. "conversion_blocked" to list only proven-demand ' +
          'listings that are failing to convert.',
      ),
    limit: z.number().int().positive().max(200).optional().describe('Cap listings returned.'),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.get('analytics/channel/listings', {
      query: {
        start: input.start, end: input.end, state: input.state,
        provider: input.provider, store: input.store,
      },
      workspace: input.workspace,
      signal: ctx.signal,
    });
    const listings = asArray(isRecord(raw) ? raw.listings : undefined).map(mapListing);
    const limited = input.limit ? listings.slice(0, input.limit) : listings;
    const summary = isRecord(raw) && isRecord(raw.summary) ? raw.summary : undefined;
    return {
      // Hoisted out of `summary` deliberately: whether the shop is being served
      // at all reframes every per-listing state below it, so it must not be
      // something the caller has to go looking for.
      shop: summary && isRecord(summary.shop) ? summary.shop : undefined,
      ...mapEnvelope(raw),
      channels_present: asArray(isRecord(raw) ? raw.channels_present : undefined),
      listings: limited,
      listing_count: listings.length,
      summary,
    };
  },
});

export const channelOpportunities = defineTool({
  name: 'channel_opportunities',
  description:
    'The listings wasting the most demand: proven traffic, broken conversion, ranked by ' +
    'how many people saw them and did not buy. This is the natural starting point for an ' +
    'optimisation pass — fix these before touching anything else, because the demand is ' +
    'already there and only the listing is in the way. ' +
    'Also returns per-state counts and, separately, the listings that are genuinely inert ' +
    '(state "dead") and therefore safe to archive. Nothing else is safe to archive. ' +
    'READ `shop` BEFORE acting on anything else here. If the shop as a whole is getting ' +
    'almost no views, safe_to_archive will be empty and top_opportunities will be thin — ' +
    'not because the listings are fine, but because nothing has been seen enough to judge. ' +
    'That is a distribution problem and no listing edit will move it. ' +
    'Read-only.',
  inputSchema: z.object({ ...rangeShape,
    provider: z.string().optional().describe('Narrow to one sales channel, by name.'),
    store: z.string().optional().describe('Narrow to one store uuid.'),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.get('analytics/channel/summary', {
      query: {
        start: input.start, end: input.end,
        provider: input.provider, store: input.store,
      },
      workspace: input.workspace,
      signal: ctx.signal,
    });
    const summary = isRecord(raw) && isRecord(raw.summary) ? raw.summary : {};
    return {
      // First key on purpose. `safe_to_archive` being empty means two opposite
      // things depending on this: "nothing is dead" vs "nothing is measurable yet".
      shop: isRecord(summary.shop) ? summary.shop : undefined,
      ...mapEnvelope(raw),
      channels_present: asArray(isRecord(raw) ? raw.channels_present : undefined),
      counts: isRecord(summary.counts) ? summary.counts : undefined,
      total_listings: num(summary, 'total'),
      top_opportunities: asArray(summary.top_opportunities).map(mapListing),
      safe_to_archive: asArray(summary.archivable).map(mapListing),
    };
  },
});

export const channelCoverage = defineTool({
  name: 'channel_coverage',
  description:
    'Which of your connected sales channels report performance data, and which metrics ' +
    'each one supplies. Check this before concluding a listing has no traffic: a channel ' +
    'that reports nothing looks identical to a channel reporting zeros unless you look ' +
    'here. Also flags shops that must be RECONNECTED before performance data can flow. ' +
    'Read-only.',
  inputSchema: z.object({
    workspace: z.string().optional().describe('Workspace uuid to scope to.'),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.get('analytics/channel/coverage', {
      workspace: input.workspace,
      signal: ctx.signal,
    });
    const coverage = asArray(isRecord(raw) ? raw.coverage : undefined).map(mapCoverage);
    return {
      coverage,
      any_channel_reports_performance: coverage.some((c) => c.supported === true),
      needs_reconnect: coverage.filter((c) => c.status === 'reconnect_required'),
    };
  },
});

function mapIntervention(raw: unknown): Record<string, unknown> {
  return {
    uuid: str(raw, 'uuid'),
    kind: str(raw, 'kind'),
    occurred_at: str(raw, 'occurred_at'),
    before: str(raw, 'before'),
    after: str(raw, 'after'),
    // The signal state that motivated the change, when there was one. A tidy
    // edit made for its own reasons has none and is still recorded.
    signal_state: str(raw, 'signal_state'),
    note: str(raw, 'note'),
    actor_kind: str(raw, 'actor_kind'),
    product_uuid: str(raw, 'product_uuid'),
    product_name: str(raw, 'product_name'),
    channel_product_ref: str(raw, 'channel_product_ref'),
    target_metric: str(raw, 'target_metric'),
    verdict: str(raw, 'verdict'),
    verdict_reason: str(raw, 'verdict_reason'),
    evaluated_at: str(raw, 'evaluated_at'),
    evidence: isRecord(raw) && isRecord(raw.evidence) ? raw.evidence : undefined,
  };
}

export const listingChanges = defineTool({
  name: 'listing_changes',
  description:
    'What has been changed on your listings, and whether it worked. The other ' +
    'half of channel_performance: that says what to fix, this says whether the ' +
    'last fix landed.\n\n' +
    'Every shopper-visible change — title, description, images, price, search ' +
    'terms, variants, availability — is recorded automatically when it is made, ' +
    'along with the signal state that prompted it. Once the channel has finalised ' +
    'enough days either side, a verdict is computed on the ONE metric that change ' +
    'should have moved (a title is judged on click-through, not revenue).\n\n' +
    '⛔ `unmeasurable` IS THE DEFAULT VERDICT, NOT AN ERROR, and it does not mean ' +
    'the change had no effect. It means the data cannot support a conclusion — ' +
    'most often because the shop is not getting enough views for any single edit ' +
    'to register, in which case the answer is distribution and not more editing. ' +
    'Read `verdict_reason` before saying anything about a change: no_shop_traffic, ' +
    'window_not_final, metric_not_reported, no_baseline.\n\n' +
    '`confounded` means two changes landed close enough together that neither owns ' +
    'the result. Do not attribute it to whichever was most recent.\n\n' +
    'Read-only. Verdicts settle when read, so a window that closed since you last ' +
    'looked is already answered.',
  inputSchema: z.object({
    days: z.number().int().positive().max(365).optional()
      .describe('How far back to look. Default 90.'),
    product: z.string().optional()
      .describe("Limit to one product uuid — that listing's change history."),
    store: z.string().optional().describe('Limit to one store uuid.'),
    kind: z.string().optional()
      .describe('Limit to one kind of change, e.g. "title" or "price".'),
    verdict: z.string().optional()
      .describe('Limit to one verdict, e.g. "improved" or "worsened".'),
    workspace: z.string().optional().describe('Workspace uuid to scope to.'),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.get('analytics/interventions', {
      query: {
        days: input.days, product: input.product, store: input.store,
        kind: input.kind, verdict: input.verdict,
      },
      workspace: input.workspace,
      signal: ctx.signal,
    });
    const summary = isRecord(raw) && isRecord(raw.summary) ? raw.summary : undefined;
    return {
      // Hoisted: how many changes could be judged AT ALL reframes every count
      // beneath it. "3 improved of 4 judged" and "3 improved of 40 recorded,
      // 36 unjudgeable" are very different states and the second is the common one.
      measurable: summary ? num(summary, 'measurable') : undefined,
      headline: summary ? str(summary, 'headline') : undefined,
      changes: asArray(isRecord(raw) ? raw.interventions : undefined).map(mapIntervention),
      change_count: num(raw, 'count'),
      window_days: num(raw, 'window_days'),
      summary,
    };
  },
});

// ---------------------------------------------------------------------------
// LISTING ATTRIBUTES
// ---------------------------------------------------------------------------
// The extra, channel-defined fields every sales channel puts on a listing beyond
// name / price / images. TikTok calls them product attributes, eBay item
// specifics, Shopify category metafields, WooCommerce product attributes.
//
// Provider-neutral on purpose: `integration_uuid` selects the channel, so adding
// eBay later adds no tools.
//
// ⛔ WHY THESE EXIST. The platform consumed some of these fields for a while with
// no way to SET them, so merchant product compliance was blank on every live
// listing — and an agent had no way to learn the vocabulary, so it could only
// blind-write a guess and receive a silent skip. These are the discovery + write
// surface that makes the step drivable.

const enc = encodeURIComponent;

const REJECTION_NOTE =
  'A value the channel refuses comes back in `rejected` with a machine-readable ' +
  '`reason` and the allowed values echoed, so you can correct it in one more turn ' +
  'rather than guessing. Rejections are never dropped silently.';

const NEVER_INVENT =
  '⛔ NEVER INVENT A VALUE. Relay what the merchant told you. If you cannot get a ' +
  'value from them, leave it UNSET and say so — an unset field is honest, an ' +
  'invented one is not. Do not infer it from the product type, do not copy it from ' +
  'another shop, and do not pick the nearest allowed value because it looks close.';

/** Build the right route for the scope being addressed. */
function routeFor(input: {
  store_uuid: string;
  product_uuid?: string;
  integration_uuid?: string;
}): string {
  if (input.product_uuid) {
    return `store/${enc(input.store_uuid)}/products/${enc(input.product_uuid)}/listing-attributes`;
  }
  if (!input.integration_uuid) {
    // The shop-wide route addresses the integration directly, so without a product
    // there is nothing to resolve it from. Say which argument is missing rather
    // than failing on a malformed URL.
    throw new AhError({
      code: 'integration_uuid_required',
      message:
        'Pass `integration_uuid` to read or set shop-wide settings, or ' +
        '`product_uuid` for a single listing. Use list_my_stores / ' +
        'check_connection_status to find the integration.',
    });
  }
  return `store/${enc(input.store_uuid)}/integration/${enc(input.integration_uuid)}/listing-attributes`;
}

function normalizeRead(r: unknown) {
  if (!isRecord(r)) return { supported: false, fields: [], values: {} };
  return {
    integration_uuid: str(r.integration_uuid),
    provider: str(r.provider),
    supported: r.supported === true,
    allows_custom_fields: r.allows_custom_fields === true,
    resolved_for: r.resolved_for ?? null,
    fields: asArray(r.fields),
    values: r.values ?? {},
    unset_required: asArray(r.unset_required),
    rejected: asArray(r.rejected),
  };
}

function normalizeWrite(r: unknown) {
  if (!isRecord(r)) return { accepted: {}, rejected: [] };
  return {
    integration_uuid: str(r.integration_uuid),
    provider: str(r.provider),
    accepted: r.accepted ?? {},
    rejected: asArray(r.rejected),
    unset_required: asArray(r.unset_required),
    values: r.values ?? {},
    synced: r.synced ?? null,
  };
}

export const describeListingAttributes = defineTool({
  name: 'describe_listing_attributes',
  description:
    'Discover the channel-defined listing fields you can set — TikTok product ' +
    'attributes, eBay item specifics, WooCommerce product attributes — and what is ' +
    'currently set. READ-ONLY. Call this BEFORE set_listing_attributes or ' +
    'set_channel_settings: the field names and their allowed values are defined by ' +
    'the channel, so guessing them gets the value dropped.\n\n' +
    'Pass `product_uuid` for one listing, or `integration_uuid` alone for the ' +
    "shop-wide settings (compliance, brand, shipping and size-chart templates).\n\n" +
    'Each field carries `value_type`, `cardinality` (single vs multi), `free_text` ' +
    '(whether a value outside the list is accepted) and `requirement`. Those are ' +
    'separate on purpose: most fields are enumerated AND accept free text, so ' +
    'neither flag alone tells you what is legal. `requirement: "conditional"` means ' +
    'the field only becomes required once `required_when` holds — typically after ' +
    'you answer a related question one particular way.\n\n' +
    '`values` is what is LIVE ON THE CHANNEL, which is not the same as what was ' +
    'last written from here: platform auto-fills and merchant edits made directly ' +
    'in the channel\'s own admin show up here too. That drift is usually the most ' +
    'useful thing in the response.\n\n' +
    '`unset_required` lists fields that are required and empty. Those are NOT ' +
    'filled in for you, deliberately — several are legal attestations. Left unset, ' +
    'the channel picks its own default or grades the listing down, so they are ' +
    'worth resolving with the merchant.\n\n' +
    '⚠️ CHECK `resolved_for.resolution` when it is present. `explicit_override` ' +
    'means the merchant chose the category. `keyword_match` means it was GUESSED ' +
    'from the product name, and a wrong guess means these fields belong to a ' +
    'different kind of product entirely — setting attributes against it is worse ' +
    'than setting none. Treat keyword_match as unverified and say so.\n\n' +
    'Big value lists are omitted by default and reported as `allowed_values_count`; ' +
    'pass `include_values` to expand them (one real field carries 647 values).\n\n' +
    'A channel with no listing attributes answers `supported: false` with an empty ' +
    '`fields` — a real answer, not an error.',
  inputSchema: z.object({
    store_uuid: z.string().min(1),
    product_uuid: z
      .string()
      .optional()
      .describe('The listing to inspect. Omit for the shop-wide settings.'),
    integration_uuid: z
      .string()
      .optional()
      .describe(
        'Which connected sales channel. Required when `product_uuid` is omitted; ' +
          'otherwise only needed if the store has more than one channel connected.',
      ),
    include_values: z
      .string()
      .optional()
      .describe(
        "'all', or a comma-separated list of field keys, to inline allowed values " +
          'that are elided by default.',
      ),
    workspace: z.string().optional(),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const query: Record<string, string> = {};
    if (input.product_uuid && input.integration_uuid) {
      query.integration_uuid = input.integration_uuid;
    }
    if (input.include_values) query.include_values = input.include_values;
    const r = await ctx.api.get(routeFor(input), {
      query,
      workspace: input.workspace,
      signal: ctx.signal,
    });
    return normalizeRead(r);
  },
});

export const setListingAttributes = defineTool({
  name: 'set_listing_attributes',
  description:
    'Set channel-defined listing attributes on ONE product (Material, Style, ' +
    'Washing Instructions and similar). Call describe_listing_attributes first to ' +
    'learn the field keys and their allowed values.\n\n' +
    'A PARTIAL WRITE SUCCEEDS. Send four values with one bad and the three good ' +
    'ones are stored while the bad one is reported — you do not have to get them ' +
    'all right at once. ' +
    REJECTION_NOTE +
    '\n\n' +
    NEVER_INVENT +
    '\n\n' +
    'Setting a value does NOT change the live listing on its own — the channel is ' +
    'updated on the next sync. Pass `sync: true` to push it immediately, or run ' +
    'sync_to_channel afterwards.',
  inputSchema: z.object({
    store_uuid: z.string().min(1),
    product_uuid: z.string().min(1),
    values: z
      .record(z.string(), z.union([z.string(), z.array(z.string())]))
      .describe(
        'field key -> value. Use an array for a field whose `cardinality` is ' +
          '"multi". Values are relayed exactly as given.',
      ),
    remove: z
      .array(z.string())
      .optional()
      .describe('Field keys to clear.'),
    sync: z
      .boolean()
      .optional()
      .describe('Push the listing to the channel immediately after storing.'),
    integration_uuid: z
      .string()
      .optional()
      .describe('Only needed when the store has more than one connected channel.'),
    workspace: z.string().optional(),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    const query: Record<string, string> = {};
    if (input.integration_uuid) query.integration_uuid = input.integration_uuid;
    const r = await ctx.api.patch(
      `store/${enc(input.store_uuid)}/products/${enc(input.product_uuid)}/listing-attributes`,
      {
        query,
        body: {
          values: input.values,
          remove: input.remove,
          sync: input.sync ?? false,
        },
        workspace: input.workspace,
        signal: ctx.signal,
      },
    );
    return normalizeWrite(r);
  },
});

export const setChannelSettings = defineTool({
  name: 'set_channel_settings',
  description:
    'Set SHOP-WIDE listing settings for one connected sales channel: product ' +
    'compliance attestations, brand, shipping template, size-chart template. These ' +
    'apply to every listing on that channel, so they are set once rather than per ' +
    'product. Call describe_listing_attributes with `integration_uuid` (and no ' +
    '`product_uuid`) first to see which settings this channel defines and what each ' +
    'one accepts.\n\n' +
    '⛔ SOME OF THESE ARE LEGAL ATTESTATIONS. Product-compliance answers (for ' +
    'example California Proposition 65 questions) are statements the MERCHANT ' +
    'makes about their goods, and they carry legal weight. ' +
    NEVER_INVENT +
    ' In particular: do not answer "No" because it is usually "No", and do not ' +
    'reason from the product being printed apparel — Proposition 65 covers ' +
    'clothing, and some inks and finishes do contain listed chemicals. Ask the ' +
    'merchant, relay their answer, and if they do not have one, leave it unset and ' +
    'tell them it is outstanding.\n\n' +
    'Answering one of these questions "Yes" can make a follow-up field required — ' +
    'naming the specific chemicals, from a list of hundreds. That follow-up appears ' +
    'in `unset_required` and is never filled in for the merchant.\n\n' +
    REJECTION_NOTE +
    '\n\n' +
    'Existing listings pick these up on their next sync.',
  inputSchema: z.object({
    store_uuid: z.string().min(1),
    integration_uuid: z.string().min(1),
    values: z
      .record(z.string(), z.union([z.string(), z.array(z.string())]))
      .describe('setting key -> value, exactly as the merchant supplied it.'),
    remove: z
      .array(z.string())
      .optional()
      .describe('Setting keys to clear.'),
    workspace: z.string().optional(),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    const r = await ctx.api.patch(
      `store/${enc(input.store_uuid)}/integration/${enc(input.integration_uuid)}/listing-attributes`,
      {
        body: { values: input.values, remove: input.remove },
        workspace: input.workspace,
        signal: ctx.signal,
      },
    );
    return normalizeWrite(r);
  },
});

export const channelTools: ToolDef[] = [
  describeListingAttributes,
  setListingAttributes,
  setChannelSettings,
  channelPerformance,
  channelOpportunities,
  channelCoverage,
  listingChanges,
];

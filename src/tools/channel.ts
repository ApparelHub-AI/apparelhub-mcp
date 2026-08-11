import { z } from 'zod';
import { defineTool, type ToolDef } from './registry.js';
import { asArray, bool, isRecord, num, str } from '../util/shape.js';

// Channel performance tools (epic: sales-channel analytics).
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

export const channelTools: ToolDef[] = [
  channelPerformance,
  channelOpportunities,
  channelCoverage,
  listingChanges,
];

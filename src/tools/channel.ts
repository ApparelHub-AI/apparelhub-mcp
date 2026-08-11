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
    'insufficient_data (not enough signal, or this channel does not report it). ' +
    'ALWAYS check the coverage block before treating a missing metric as zero. Read-only.',
  inputSchema: z.object({
    ...rangeShape,
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
      query: { start: input.start, end: input.end, state: input.state },
      workspace: input.workspace,
      signal: ctx.signal,
    });
    const listings = asArray(isRecord(raw) ? raw.listings : undefined).map(mapListing);
    const limited = input.limit ? listings.slice(0, input.limit) : listings;
    return {
      ...mapEnvelope(raw),
      listings: limited,
      listing_count: listings.length,
      summary: isRecord(raw) && isRecord(raw.summary) ? raw.summary : undefined,
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
    'Read-only.',
  inputSchema: z.object(rangeShape),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.get('analytics/channel/summary', {
      query: { start: input.start, end: input.end },
      workspace: input.workspace,
      signal: ctx.signal,
    });
    const summary = isRecord(raw) && isRecord(raw.summary) ? raw.summary : {};
    return {
      ...mapEnvelope(raw),
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

export const channelTools: ToolDef[] = [
  channelPerformance,
  channelOpportunities,
  channelCoverage,
];

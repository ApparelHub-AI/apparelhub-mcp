import { z } from 'zod';
import { defineTool, type ToolDef } from './registry.js';
import { asArray, bool, isRecord, num, str } from '../util/shape.js';

// Analytics tools (tool spec — capability-gap set). Read-only projections over the
// /agents/v1/analytics/* endpoints (twins of api/analytics.py). These serve precomputed
// daily order/merch rollups with a live overlay for the current partial day.
//
// Gating: every route requires the `advanced_analytics` tier feature (Professional +
// Enterprise); the cross-client portfolio additionally requires an agency (Enterprise)
// account. When the caller lacks the feature the ApiClient throws an AhError (403) — we
// deliberately let that surface rather than swallowing it, so the agent sees why.
//
// Common filters (all optional, passed straight through as query params — the API defaults
// to the last 30 days ending today when start/end are omitted):
//   start / end : YYYY-MM-DD date bounds
//   store       : narrow to one store uuid (a store outside scope 404s)
//   currency    : pick the reporting currency (analytics segments currency, never sums it)
//   workspace   : workspace uuid for agency accounts (routed via the ?workspace= param)
//
// Mappers are tolerant: analytics payloads are structured, so we pass through the meaningful
// fields as-is and only normalize the envelope. A minor live-API shape change degrades to a
// missing field rather than a crash.

// The dimensions the breakdown endpoint accepts (VALID_DIMENSIONS in analytics_query.py).
const DIMENSIONS = [
  'product_type',
  'sales_channel',
  'fulfillment_provider',
  'product',
  'variant',
  'hold_reason',
] as const;

// Shared filter fields reused across the summary/timeseries/breakdown/ops tools.
const filterShape = {
  start: z
    .string()
    .optional()
    .describe('Start date (YYYY-MM-DD). Omit to default to 30 days before end.'),
  end: z
    .string()
    .optional()
    .describe('End date (YYYY-MM-DD). Omit to default to today (UTC).'),
  store: z
    .string()
    .optional()
    .describe('Store uuid to narrow to one store. Omit for all accessible stores.'),
  currency: z
    .string()
    .optional()
    .describe('Reporting currency (e.g. "USD"). Currencies are segmented, never summed.'),
  workspace: z
    .string()
    .optional()
    .describe('Workspace uuid to scope to (agency accounts). Omit for the Default workspace.'),
};

/** Build the query object shared by the filter-driven endpoints. undefined values are dropped
 *  by the ApiClient, so passing them through is safe and keeps the URL clean. */
function filterQuery(input: {
  start?: string;
  end?: string;
  store?: string;
  currency?: string;
}): Record<string, string | undefined> {
  return {
    start: input.start,
    end: input.end,
    store: input.store,
    currency: input.currency,
  };
}

// The KPI object returned by summarize(); pass through the meaningful headline fields.
function mapKpis(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw)) return undefined;
  const velocity = isRecord(raw.velocity)
    ? {
        payment_to_submit_avg_seconds: num(raw.velocity, 'payment_to_submit_avg_seconds'),
        submit_to_ship_avg_seconds: num(raw.velocity, 'submit_to_ship_avg_seconds'),
        ship_to_deliver_avg_seconds: num(raw.velocity, 'ship_to_deliver_avg_seconds'),
      }
    : undefined;
  return {
    gross_revenue: num(raw, 'gross_revenue'),
    order_count: num(raw, 'order_count'),
    units: num(raw, 'units'),
    aov: num(raw, 'aov'),
    subtotal: num(raw, 'subtotal'),
    shipping_collected: num(raw, 'shipping_collected'),
    tax_collected: num(raw, 'tax_collected'),
    cogs: num(raw, 'cogs'),
    gross_profit: num(raw, 'gross_profit'),
    avg_margin_pct: num(raw, 'avg_margin_pct'),
    avg_markup_pct: num(raw, 'avg_markup_pct'),
    margin_known_order_count: num(raw, 'margin_known_order_count'),
    margin_known_revenue: num(raw, 'margin_known_revenue'),
    margin_coverage: num(raw, 'margin_coverage'),
    all_order_count: num(raw, 'all_order_count'),
    cancelled_count: num(raw, 'cancelled_count'),
    refunded_count: num(raw, 'refunded_count'),
    held_count: num(raw, 'held_count'),
    cancellation_rate: num(raw, 'cancellation_rate'),
    refund_rate: num(raw, 'refund_rate'),
    hold_rate: num(raw, 'hold_rate'),
    ...(velocity ? { velocity } : {}),
  };
}

// The date-range + currency header every report echoes.
function mapRangeMeta(raw: unknown): Record<string, unknown> {
  return {
    start: str(raw, 'start'),
    end: str(raw, 'end'),
    currency: str(raw, 'currency'),
    currencies_present: asArray(isRecord(raw) ? raw.currencies_present : undefined),
  };
}

// ---------------------------------------------------------------------------
// analytics_summary — headline KPIs + prior-period deltas
// ---------------------------------------------------------------------------

export const analyticsSummary = defineTool({
  name: 'analytics_summary',
  description:
    'Headline order/merch KPIs for a date range (gross revenue, orders, units, AOV, COGS, ' +
    'gross profit, margin, cancel/refund/hold rates, fulfillment velocity) plus prior-period ' +
    'deltas. Defaults to the last 30 days. Requires an Advanced Analytics plan (Professional or ' +
    'Enterprise). Read-only.',
  inputSchema: z.object(filterShape),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.get('analytics/summary', {
      query: filterQuery(input),
      workspace: input.workspace,
      signal: ctx.signal,
    });
    return {
      ...mapRangeMeta(raw),
      kpis: mapKpis(isRecord(raw) ? raw.kpis : undefined),
      prior_period: isRecord(raw) && isRecord(raw.prior_period)
        ? {
            start: str(raw.prior_period, 'start'),
            end: str(raw.prior_period, 'end'),
            kpis: mapKpis(raw.prior_period.kpis),
          }
        : undefined,
      deltas: isRecord(raw) && isRecord(raw.deltas) ? raw.deltas : undefined,
      store_count: num(raw, 'store_count'),
    };
  },
});

// ---------------------------------------------------------------------------
// analytics_timeseries — KPI trend bucketed day/week/month
// ---------------------------------------------------------------------------

export const analyticsTimeseries = defineTool({
  name: 'analytics_timeseries',
  description:
    'KPI trend series over a date range, bucketed by day, week, or month (zero-filled). Each ' +
    'bucket carries gross revenue, gross profit, COGS, order count, units, AOV, average margin, ' +
    'and margin coverage. Requires an Advanced Analytics plan. Read-only.',
  inputSchema: z.object({
    ...filterShape,
    interval: z
      .enum(['day', 'week', 'month'])
      .optional()
      .describe('Bucket granularity (default day).'),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.get('analytics/timeseries', {
      query: { ...filterQuery(input), interval: input.interval },
      workspace: input.workspace,
      signal: ctx.signal,
    });
    return {
      ...mapRangeMeta(raw),
      interval: str(raw, 'interval') ?? input.interval ?? 'day',
      series: asArray(isRecord(raw) ? raw.series : undefined),
    };
  },
});

// ---------------------------------------------------------------------------
// analytics_breakdown — aggregate by dimension
// ---------------------------------------------------------------------------

export const analyticsBreakdown = defineTool({
  name: 'analytics_breakdown',
  description:
    'Aggregate KPIs broken down by one dimension: product_type, sales_channel, ' +
    'fulfillment_provider, product, variant, or hold_reason. Rows are sorted for display; ' +
    'overflow past the limit folds into an "(everything else)" row so totals still reconcile. ' +
    'Requires an Advanced Analytics plan. Read-only.',
  inputSchema: z.object({
    ...filterShape,
    dimension: z
      .enum(DIMENSIONS)
      .describe('The dimension to break down by (required).'),
    limit: z
      .number()
      .int()
      .positive()
      .max(500)
      .optional()
      .describe('Max rows before folding the rest into "(everything else)" (default 50).'),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.get('analytics/breakdown', {
      query: { ...filterQuery(input), dimension: input.dimension, limit: input.limit },
      workspace: input.workspace,
      signal: ctx.signal,
    });
    return {
      ...mapRangeMeta(raw),
      dimension: str(raw, 'dimension') ?? input.dimension,
      rows: asArray(isRecord(raw) ? raw.rows : undefined),
    };
  },
});

// ---------------------------------------------------------------------------
// analytics_ops — ops health: velocity + hold/cancel/refund rates
// ---------------------------------------------------------------------------

export const analyticsOps = defineTool({
  name: 'analytics_ops',
  description:
    'Operational health for a date range: fulfillment velocity (payment→submit→ship→deliver ' +
    'averages), order counts, and cancellation / refund / hold rates, plus a hold-reason ' +
    'breakdown. Requires an Advanced Analytics plan. Read-only.',
  inputSchema: z.object(filterShape),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.get('analytics/ops', {
      query: filterQuery(input),
      workspace: input.workspace,
      signal: ctx.signal,
    });
    return {
      start: str(raw, 'start'),
      end: str(raw, 'end'),
      currency: str(raw, 'currency'),
      velocity: isRecord(raw) && isRecord(raw.velocity) ? raw.velocity : undefined,
      all_order_count: num(raw, 'all_order_count'),
      cancelled_count: num(raw, 'cancelled_count'),
      refunded_count: num(raw, 'refunded_count'),
      held_count: num(raw, 'held_count'),
      cancellation_rate: num(raw, 'cancellation_rate'),
      refund_rate: num(raw, 'refund_rate'),
      hold_rate: num(raw, 'hold_rate'),
      hold_reasons: asArray(isRecord(raw) ? raw.hold_reasons : undefined),
    };
  },
});

// ---------------------------------------------------------------------------
// analytics_portfolio — cross-client (per-workspace) agency view
// ---------------------------------------------------------------------------

function mapClient(raw: unknown): Record<string, unknown> {
  return {
    workspace_uuid: str(raw, 'workspace_uuid', 'uuid'),
    name: str(raw, 'name'),
    is_default: bool(raw, 'is_default'),
    account_name: str(raw, 'account_name'),
    store_count: num(raw, 'store_count'),
    kpis: mapKpis(isRecord(raw) ? raw.kpis : undefined),
  };
}

export const analyticsPortfolio = defineTool({
  name: 'analytics_portfolio',
  description:
    'Cross-client portfolio: per-workspace (per-client) KPIs plus rolled-up totals — the ' +
    'agency view. Groups store rollups by each store\'s current workspace over every workspace ' +
    'you can view analytics in. Requires an agency (Enterprise) account with Advanced Analytics; ' +
    'other accounts get a feature_unavailable error. Read-only.',
  inputSchema: z.object({
    start: filterShape.start,
    end: filterShape.end,
    currency: filterShape.currency,
    workspace: filterShape.workspace,
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.get('analytics/portfolio', {
      query: { start: input.start, end: input.end, currency: input.currency },
      workspace: input.workspace,
      signal: ctx.signal,
    });
    const clients = asArray(isRecord(raw) ? raw.clients : undefined).map(mapClient);
    return {
      ...mapRangeMeta(raw),
      clients,
      totals: mapKpis(isRecord(raw) ? raw.totals : undefined),
      client_count: num(raw, 'client_count') ?? clients.length,
    };
  },
});

export const analyticsTools: ToolDef[] = [
  analyticsSummary,
  analyticsTimeseries,
  analyticsBreakdown,
  analyticsOps,
  analyticsPortfolio,
];

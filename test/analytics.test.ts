import { describe, it, expect } from 'vitest';
import {
  analyticsSummary,
  analyticsTimeseries,
  analyticsBreakdown,
  analyticsOps,
  analyticsPortfolio,
  analyticsTools,
} from '../src/tools/analytics.js';
import { ApiClient } from '../src/http/client.js';
import { fakeContext } from './helpers/ctx.js';
import { jsonResponse, queueFetch, noSleep } from './helpers/fakeFetch.js';

// Generic placeholders only (public repo — Rule 13): short ids (s1, w1), "Acme Co".

/** An ApiClient whose next request resolves to `raw` (status 200). */
function apiReturning(raw: unknown): ApiClient {
  const { fetchImpl } = queueFetch([jsonResponse(200, raw)]);
  return new ApiClient({
    apiKey: 'k',
    baseUrl: 'https://api.example.test/agents/v1',
    userAgent: 't',
    fetchImpl,
    sleepImpl: noSleep,
  });
}

/** An ApiClient that resolves to `raw` (default {}) and records the calls (for URL asserts). */
function recording(raw: unknown = {}): { api: ApiClient; calls: { url: string }[] } {
  const { fetchImpl, calls } = queueFetch([jsonResponse(200, raw)]);
  const api = new ApiClient({
    apiKey: 'k',
    baseUrl: 'https://api.example.test/agents/v1',
    userAgent: 't',
    fetchImpl,
    sleepImpl: noSleep,
  });
  return { api, calls };
}

describe('analytics_summary', () => {
  it('maps the KPI + prior-period + delta payload through', async () => {
    const raw = {
      start: '2026-06-01',
      end: '2026-06-30',
      currency: 'USD',
      currencies_present: ['USD', 'EUR'],
      kpis: {
        gross_revenue: 1234.5,
        order_count: 12,
        units: 30,
        aov: 102.88,
        gross_profit: 400.25,
        avg_margin_pct: 0.32,
        margin_coverage: 0.9,
        all_order_count: 14,
        cancelled_count: 1,
        velocity: {
          payment_to_submit_avg_seconds: 57600,
          submit_to_ship_avg_seconds: 480000,
          ship_to_deliver_avg_seconds: null,
        },
      },
      prior_period: {
        start: '2026-05-02',
        end: '2026-05-31',
        kpis: { gross_revenue: 1000, order_count: 10 },
      },
      deltas: { gross_revenue: 0.2345, order_count: 0.2 },
      store_count: 3,
    };
    const res = (await analyticsSummary.handler({}, fakeContext(apiReturning(raw)))) as any;
    expect(res).toMatchObject({
      start: '2026-06-01',
      end: '2026-06-30',
      currency: 'USD',
      store_count: 3,
    });
    expect(res.currencies_present).toEqual(['USD', 'EUR']);
    expect(res.kpis).toMatchObject({
      gross_revenue: 1234.5,
      order_count: 12,
      units: 30,
      aov: 102.88,
      gross_profit: 400.25,
      margin_coverage: 0.9,
    });
    expect(res.kpis.velocity).toEqual({
      payment_to_submit_avg_seconds: 57600,
      submit_to_ship_avg_seconds: 480000,
      ship_to_deliver_avg_seconds: undefined,
    });
    expect(res.prior_period).toMatchObject({ start: '2026-05-02', end: '2026-05-31' });
    expect(res.prior_period.kpis).toMatchObject({ gross_revenue: 1000, order_count: 10 });
    expect(res.deltas).toEqual({ gross_revenue: 0.2345, order_count: 0.2 });
  });

  it('passes start/end/store/currency filters through to the request URL', async () => {
    const { api, calls } = recording();
    await analyticsSummary.handler(
      { start: '2026-06-01', end: '2026-06-30', store: 's1', currency: 'USD' },
      fakeContext(api),
    );
    const url = calls[0]?.url ?? '';
    expect(url).toContain('analytics/summary');
    expect(url).toContain('start=2026-06-01');
    expect(url).toContain('end=2026-06-30');
    expect(url).toContain('store=s1');
    expect(url).toContain('currency=USD');
  });

  it('routes the workspace param and omits absent filters from the URL', async () => {
    const { api, calls } = recording();
    await analyticsSummary.handler({ workspace: 'w1' }, fakeContext(api));
    const url = calls[0]?.url ?? '';
    expect(url).toContain('workspace=w1');
    expect(url).not.toContain('start=');
    expect(url).not.toContain('store=');
  });
});

describe('analytics_timeseries', () => {
  it('passes the interval param through and returns the series + meta', async () => {
    const raw = {
      start: '2026-06-01',
      end: '2026-06-30',
      interval: 'week',
      currency: 'USD',
      currencies_present: ['USD'],
      series: [
        { bucket: '2026-06-01', gross_revenue: 100, order_count: 2 },
        { bucket: '2026-06-08', gross_revenue: 250, order_count: 5 },
      ],
    };
    const { fetchImpl, calls } = queueFetch([jsonResponse(200, raw)]);
    const api = new ApiClient({
      apiKey: 'k',
      baseUrl: 'https://api.example.test/agents/v1',
      userAgent: 't',
      fetchImpl,
      sleepImpl: noSleep,
    });
    const res = (await analyticsTimeseries.handler(
      { interval: 'week', start: '2026-06-01' },
      fakeContext(api),
    )) as any;
    expect(calls[0]?.url).toContain('analytics/timeseries');
    expect(calls[0]?.url).toContain('interval=week');
    expect(res.interval).toBe('week');
    expect(res.series).toHaveLength(2);
    expect(res.series[0]).toMatchObject({ bucket: '2026-06-01', gross_revenue: 100 });
  });

  it('defaults interval to day in the projection when the response omits it', async () => {
    const res = (await analyticsTimeseries.handler(
      {},
      fakeContext(apiReturning({ start: '2026-06-01', end: '2026-06-30', series: [] })),
    )) as any;
    expect(res.interval).toBe('day');
    expect(res.series).toEqual([]);
  });
});

describe('analytics_breakdown', () => {
  it('passes dimension + limit through and returns the rows', async () => {
    const raw = {
      start: '2026-06-01',
      end: '2026-06-30',
      dimension: 'product_type',
      currency: 'USD',
      rows: [
        { value: 't-shirt', revenue: 900, order_count: 9 },
        { value: '(everything else)', revenue: 100, order_count: 3 },
      ],
    };
    const { api, calls } = recording(raw);
    const res = (await analyticsBreakdown.handler(
      { dimension: 'product_type', limit: 10 },
      fakeContext(api),
    )) as any;
    const url = calls[0]?.url ?? '';
    expect(url).toContain('analytics/breakdown');
    expect(url).toContain('dimension=product_type');
    expect(url).toContain('limit=10');
    expect(res.dimension).toBe('product_type');
    expect(res.rows).toHaveLength(2);
    expect(res.rows[0]).toMatchObject({ value: 't-shirt', revenue: 900 });
  });

  it('accepts every valid dimension and rejects an unknown one', () => {
    for (const dim of [
      'product_type',
      'sales_channel',
      'fulfillment_provider',
      'product',
      'variant',
      'hold_reason',
    ]) {
      expect(analyticsBreakdown.inputSchema.safeParse({ dimension: dim }).success).toBe(true);
    }
    expect(analyticsBreakdown.inputSchema.safeParse({ dimension: 'nope' }).success).toBe(false);
    // dimension is required.
    expect(analyticsBreakdown.inputSchema.safeParse({}).success).toBe(false);
  });
});

describe('analytics_ops', () => {
  it('maps velocity + rate fields + hold_reasons through', async () => {
    const raw = {
      start: '2026-06-01',
      end: '2026-06-30',
      currency: 'USD',
      velocity: {
        payment_to_submit_avg_seconds: 57600,
        submit_to_ship_avg_seconds: 480000,
        ship_to_deliver_avg_seconds: 345600,
      },
      all_order_count: 14,
      cancelled_count: 1,
      refunded_count: 0,
      held_count: 2,
      cancellation_rate: 0.0714,
      refund_rate: 0,
      hold_rate: 0.1429,
      hold_reasons: [{ value: 'design_approval', count: 2 }],
    };
    const { api, calls } = recording(raw);
    const res = (await analyticsOps.handler({ store: 's1' }, fakeContext(api))) as any;
    expect(calls[0]?.url).toContain('analytics/ops');
    expect(calls[0]?.url).toContain('store=s1');
    expect(res.velocity).toEqual(raw.velocity);
    expect(res).toMatchObject({
      all_order_count: 14,
      cancelled_count: 1,
      held_count: 2,
      hold_rate: 0.1429,
    });
    expect(res.hold_reasons).toEqual([{ value: 'design_approval', count: 2 }]);
  });
});

describe('analytics_portfolio', () => {
  it('maps per-client rows + totals and routes the workspace param', async () => {
    const raw = {
      start: '2026-06-01',
      end: '2026-06-30',
      currency: 'USD',
      currencies_present: ['USD'],
      clients: [
        {
          workspace_uuid: 'w1',
          name: 'Acme Co',
          is_default: false,
          account_name: 'Acme Co',
          store_count: 2,
          kpis: { gross_revenue: 800, order_count: 8 },
        },
        {
          workspace_uuid: 'w2',
          name: 'Default',
          is_default: true,
          store_count: 1,
          kpis: { gross_revenue: 200, order_count: 2 },
        },
      ],
      totals: { gross_revenue: 1000, order_count: 10 },
      client_count: 2,
    };
    const { api, calls } = recording(raw);
    const res = (await analyticsPortfolio.handler({ workspace: 'w1' }, fakeContext(api))) as any;
    const url = calls[0]?.url ?? '';
    expect(url).toContain('analytics/portfolio');
    expect(url).toContain('workspace=w1');
    expect(res.client_count).toBe(2);
    expect(res.clients).toHaveLength(2);
    expect(res.clients[0]).toMatchObject({
      workspace_uuid: 'w1',
      name: 'Acme Co',
      is_default: false,
      store_count: 2,
    });
    expect(res.clients[0].kpis).toMatchObject({ gross_revenue: 800, order_count: 8 });
    expect(res.totals).toMatchObject({ gross_revenue: 1000, order_count: 10 });
  });

  it('lets a feature_unavailable 403 surface as an AhError instead of swallowing it', async () => {
    const { fetchImpl } = queueFetch([
      jsonResponse(403, {
        error: 'feature_unavailable',
        feature: 'client_portfolio',
        message: 'The cross-client portfolio requires an agency (Enterprise) account.',
      }),
    ]);
    const api = new ApiClient({
      apiKey: 'k',
      baseUrl: 'https://api.example.test/agents/v1',
      userAgent: 't',
      fetchImpl,
      sleepImpl: noSleep,
    });
    await expect(analyticsPortfolio.handler({}, fakeContext(api))).rejects.toThrow();
  });
});

describe('analyticsTools export', () => {
  it('exports the five analytics tools with read-only annotations', () => {
    const names = analyticsTools.map((t) => t.name);
    expect(names).toEqual([
      'analytics_summary',
      'analytics_timeseries',
      'analytics_breakdown',
      'analytics_ops',
      'analytics_portfolio',
    ]);
    for (const t of analyticsTools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.annotations?.openWorldHint).toBe(true);
    }
  });
});

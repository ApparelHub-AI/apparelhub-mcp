import { describe, it, expect } from 'vitest';
import {
  channelPerformance,
  channelOpportunities,
  channelCoverage,
  channelTools,
} from '../src/tools/channel.js';
import { findUnderperformers, type DemandSignal } from '../src/knowledge/insights.js';
import { ApiClient } from '../src/http/client.js';
import { fakeContext } from './helpers/ctx.js';
import { jsonResponse, queueFetch, noSleep } from './helpers/fakeFetch.js';

// Generic placeholders only (public repo): short ids, "Acme Co".

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

const LISTINGS_PAYLOAD = {
  date_basis: 'channel_local',
  date_basis_note: 'Channel-local dates.',
  range: { start: '2026-07-15', end: '2026-08-10' },
  row_count: 120,
  coverage: [
    {
      provider: 'TikTok Shop',
      supported: true,
      grain: 'product_day',
      reported_metrics: ['impressions', 'clicks', 'units_sold'],
      unreported_metrics: [],
      status: 'ok',
    },
    {
      provider: 'WooCommerce',
      supported: false,
      reported_metrics: [],
      unreported_metrics: ['impressions', 'clicks'],
      status: 'not_reported',
    },
  ],
  listings: [
    {
      channel_product_ref: '111',
      provider: 'TikTok Shop',
      store_name: 'Acme Apparel',
      store_uuid: 's1',
      product_uuid: 'p-hot',
      product_name: 'Acme Tee',
      mapped_to_apparelhub: true,
      state: 'conversion_blocked',
      action: 'fix_listing_card',
      reason: 'seen a lot, rarely clicked',
      impressions: 5420,
      clicks: 4,
      units_sold: 0,
      ctr: 0.0007,
      days_observed: 27,
    },
    {
      channel_product_ref: '222',
      product_uuid: 'p-dead',
      state: 'dead',
      action: 'archive',
      reason: 'no activity',
      impressions: 2,
      clicks: 0,
      units_sold: 0,
      days_observed: 27,
    },
  ],
  summary: { counts: { conversion_blocked: 1, dead: 1 }, total: 2 },
};

describe('channel_performance', () => {
  it('surfaces the seen-but-not-bought listing', async () => {
    const out = (await channelPerformance.handler(
      {},
      fakeContext(apiReturning(LISTINGS_PAYLOAD)),
    )) as Record<string, any>;
    const hot = out.listings.find((l: any) => l.product_uuid === 'p-hot');
    expect(hot.state).toBe('conversion_blocked');
    expect(hot.impressions).toBe(5420);
    expect(hot.units_sold).toBe(0);
  });

  it('carries coverage so a missing metric is never read as zero', async () => {
    const out = (await channelPerformance.handler(
      {},
      fakeContext(apiReturning(LISTINGS_PAYLOAD)),
    )) as Record<string, any>;
    const woo = out.coverage.find((c: any) => c.provider === 'WooCommerce');
    expect(woo.supported).toBe(false);
    expect(woo.unreported_metrics).toContain('impressions');
  });

  it('states the date basis, since it differs from the order analytics', async () => {
    const out = (await channelPerformance.handler(
      {},
      fakeContext(apiReturning(LISTINGS_PAYLOAD)),
    )) as Record<string, any>;
    expect(out.date_basis).toBe('channel_local');
  });

  it('passes the state filter through', async () => {
    const { api, calls } = recording(LISTINGS_PAYLOAD);
    await channelPerformance.handler({ state: 'conversion_blocked' }, fakeContext(api));
    expect(calls[0].url).toContain('analytics/channel/listings');
    expect(calls[0].url).toContain('state=conversion_blocked');
  });

  it('says which channel and store each row came from', () => {
    // A channel product id is only unique within its channel, so a row without
    // provenance cannot be safely compared to another.
    return channelPerformance
      .handler({}, fakeContext(apiReturning(LISTINGS_PAYLOAD)))
      .then((out: any) => {
        const hot = out.listings.find((l: any) => l.product_uuid === 'p-hot');
        expect(hot.provider).toBe('TikTok Shop');
        expect(hot.store_name).toBe('Acme Apparel');
      });
  });

  it('passes the channel and store filters through', async () => {
    const { api, calls } = recording(LISTINGS_PAYLOAD);
    await channelPerformance.handler(
      { provider: 'TikTok Shop', store: 's1' }, fakeContext(api));
    expect(calls[0].url).toContain('provider=TikTok+Shop');
    expect(calls[0].url).toContain('store=s1');
  });

  it('is read-only', () => {
    expect(channelPerformance.annotations?.readOnlyHint).toBe(true);
    expect(channelOpportunities.annotations?.readOnlyHint).toBe(true);
    expect(channelCoverage.annotations?.readOnlyHint).toBe(true);
  });
});

describe('channel_opportunities', () => {
  it('separates fixable opportunities from the archivable set', async () => {
    const payload = {
      ...LISTINGS_PAYLOAD,
      summary: {
        counts: { conversion_blocked: 1, dead: 1 },
        total: 2,
        top_opportunities: [LISTINGS_PAYLOAD.listings[0]],
        archivable: [LISTINGS_PAYLOAD.listings[1]],
      },
    };
    const out = (await channelOpportunities.handler(
      {},
      fakeContext(apiReturning(payload)),
    )) as Record<string, any>;
    expect(out.top_opportunities).toHaveLength(1);
    expect(out.top_opportunities[0].product_uuid).toBe('p-hot');
    // the high-traffic listing must NOT be offered as archivable
    expect(out.safe_to_archive.map((l: any) => l.product_uuid)).toEqual(['p-dead']);
  });
});

describe('channel_coverage', () => {
  it('flags shops that need reconnecting', async () => {
    const out = (await channelCoverage.handler(
      {},
      fakeContext(
        apiReturning({
          coverage: [
            { provider: 'TikTok Shop', supported: true, status: 'reconnect_required' },
            { provider: 'WooCommerce', supported: false, status: 'not_reported' },
          ],
        }),
      ),
    )) as Record<string, any>;
    expect(out.needs_reconnect).toHaveLength(1);
    expect(out.needs_reconnect[0].provider).toBe('TikTok Shop');
    expect(out.any_channel_reports_performance).toBe(true);
  });
});

describe('tool surface', () => {
  it('registers three read-only tools', () => {
    expect(channelTools.map((t) => t.name).sort()).toEqual([
      'channel_coverage',
      'channel_opportunities',
      'channel_performance',
    ]);
  });
});

// ---------------------------------------------------------------------------
// The archive bug. This is the reason the epic exists.
// ---------------------------------------------------------------------------
describe('findUnderperformers demand-awareness', () => {
  const products = [
    { product_uuid: 'p-hot', name: 'Acme Tee', status: 'active' },
    { product_uuid: 'p-dead', name: 'Acme Mug', status: 'active' },
  ];
  const orders: any[] = []; // nothing sold

  it('does NOT archive a listing with proven demand', () => {
    const signals = new Map<string, DemandSignal>([
      ['p-hot', { state: 'conversion_blocked', impressions: 5420, units_sold: 0 }],
      ['p-dead', { state: 'dead', impressions: 2, units_sold: 0 }],
    ]);
    const proposals = findUnderperformers(products as any, orders, signals);
    const hot = proposals.find((p) => p.product_uuid === 'p-hot');
    expect(hot?.action).toBe('optimize_listing');
    expect(hot?.action).not.toBe('pause');
  });

  it('archives only the genuinely inert listing', () => {
    const signals = new Map<string, DemandSignal>([
      ['p-hot', { state: 'conversion_blocked', impressions: 5420 }],
      ['p-dead', { state: 'dead', impressions: 2 }],
    ]);
    const paused = findUnderperformers(products as any, orders, signals).filter(
      (p) => p.action === 'pause',
    );
    expect(paused.map((p) => p.product_uuid)).toEqual(['p-dead']);
  });

  it('routes a starved listing to discovery, never to a rewrite or archive', () => {
    const signals = new Map<string, DemandSignal>([
      ['p-hot', { state: 'starved', impressions: 40 }],
    ]);
    const p = findUnderperformers(products as any, orders, signals).find(
      (x) => x.product_uuid === 'p-hot',
    );
    expect(p?.action).toBe('increase_discovery');
  });

  it('proposes nothing for a winner', () => {
    const signals = new Map<string, DemandSignal>([
      ['p-hot', { state: 'winner', impressions: 9000 }],
    ]);
    const refs = findUnderperformers(products as any, orders, signals).map(
      (p) => p.product_uuid,
    );
    expect(refs).not.toContain('p-hot');
  });

  it('NEVER falls back to archiving when there is no demand data', () => {
    // The critical degradation. Without a signal the old code archived
    // everything with zero sales; now it must refuse to judge.
    const proposals = findUnderperformers(products as any, orders, undefined);
    expect(proposals.every((p) => p.action === 'review')).toBe(true);
    expect(proposals.some((p) => p.action === 'pause')).toBe(false);
  });

  it('treats a product missing from the signal map as unjudgeable', () => {
    const signals = new Map<string, DemandSignal>([
      ['p-dead', { state: 'dead', impressions: 1 }],
    ]);
    const hot = findUnderperformers(products as any, orders, signals).find(
      (p) => p.product_uuid === 'p-hot',
    );
    expect(hot?.action).toBe('review');
  });
});

describe('the shop-level finding is not buried', () => {
  // An agent reading per-listing states on a shop nobody is being served will
  // reach confident conclusions about listings that never had a fair hearing.
  // The shop verdict has to sit where it cannot be scrolled past, which is why
  // it is hoisted out of `summary` rather than left nested inside it.
  const SHOP = {
    state: 'no_channel_traffic',
    peak_impressions: 26,
    summary: 'Nothing in this shop is getting enough views to judge listings.',
    suggested_focus: 'distribution',
  };

  it('channel_performance returns the shop verdict at the top level', async () => {
    const api = apiReturning({ ...LISTINGS_PAYLOAD, summary: { shop: SHOP } });
    const out: any = await channelPerformance.handler({} as any, fakeContext(api));
    expect(out.shop).toEqual(SHOP);
  });

  it('channel_opportunities returns the shop verdict at the top level', async () => {
    const api = apiReturning({ summary: { shop: SHOP, counts: {}, archivable: [] } });
    const out: any = await channelOpportunities.handler({} as any, fakeContext(api));
    expect(out.shop).toEqual(SHOP);
    // The pairing that matters: an empty archive list next to a shop with no
    // traffic means "unmeasurable", not "nothing is dead".
    expect(out.safe_to_archive).toEqual([]);
  });

  it('omits the shop key rather than inventing a verdict', async () => {
    const api = apiReturning({ ...LISTINGS_PAYLOAD });
    const out: any = await channelPerformance.handler({} as any, fakeContext(api));
    expect(out.shop).toBeUndefined();
  });
});

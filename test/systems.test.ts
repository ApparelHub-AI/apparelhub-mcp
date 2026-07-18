import { describe, it, expect } from 'vitest';
import {
  analyzeWhatWorks,
  autoOptimizeListings,
  cascadePriceChange,
  recoverFromOutage,
  setPricesByMargin,
} from '../src/tools/systems.js';
import { fakeContext } from './helpers/ctx.js';
import { apiSequence } from './helpers/fakeFetch.js';

describe('analyze_what_works', () => {
  it('returns insights from products + orders', async () => {
    const { api } = apiSequence([
      { products: [{ product_uuid: 'p1', name: 'Cactus Tee' }] },
      { orders: [{ order_uuid: 'o1', channel: 'Shopify', total: 30, items: [{ product_name: 'Cactus Tee' }] }] },
    ]);
    const res = (await analyzeWhatWorks.handler({}, fakeContext(api))) as any;
    expect(res.insights.length).toBeGreaterThan(0);
  });
});

describe('auto_optimize_listings', () => {
  it('defaults to a dry-run preview', async () => {
    const { api } = apiSequence([{ products: [{ product_uuid: 'p1', name: 'Dead Tee' }] }, { orders: [] }]);
    const res = (await autoOptimizeListings.handler({}, fakeContext(api))) as any;
    expect(res.executed).toBe(false);
    expect(res.proposed_actions[0].action).toBe('pause');
  });

  it('archives underperformers when applied', async () => {
    const { api, calls } = apiSequence([
      { products: [{ product_uuid: 'p1', name: 'Dead Tee' }] },
      { orders: [] },
      {}, // PATCH archive
    ]);
    const res = (await autoOptimizeListings.handler({ dry_run: false }, fakeContext(api))) as any;
    expect(res.executed).toBe(true);
    expect(res.results[0]).toMatchObject({ action: 'paused', status: 'ok' });
    expect(calls.find((c) => c.init?.method === 'PATCH')).toBeTruthy();
  });
});

describe('cascade_price_change', () => {
  it('reads the old price, patches the new one, and notes when store context is missing', async () => {
    const { api } = apiSequence([
      { product: { price: 27.99, channel_statuses: [{ integration_uuid: 'i1' }] } }, // GET
      {}, // PATCH price
    ]);
    const res = (await cascadePriceChange.handler(
      { product_uuid: 'p1', new_price: 32.99 },
      fakeContext(api),
    )) as any;
    expect(res.old_price).toBe(27.99);
    expect(res.new_price).toBe(32.99);
    expect(res.note).toContain('store_uuid');
  });
});

describe('set_prices_by_margin', () => {
  it('prices each variant to the target margin off its OWN cost, then re-syncs channels', async () => {
    const { api, calls } = apiSequence([
      // GET store/s1/products — per-variant cost lives here, not on product detail
      {
        products: [
          {
            uuid: 'p1',
            variants: [
              { uuid: 'v1', name: 'White / S', color: 'White', size: 'S', cost: 16.81, price: 19.99 },
              { uuid: 'v2', name: 'White / 2XL', color: 'White', size: '2XL', cost: 21.68, price: 19.99 },
            ],
            channel_statuses: [{ integration_uuid: 'i1' }],
          },
        ],
      },
      {}, // PUT v1
      {}, // PUT v2
      {}, // POST sync i1
    ]);
    const res = (await setPricesByMargin.handler(
      { product_uuid: 'p1', store_uuid: 's1', margin: 0.15 },
      fakeContext(api),
    )) as any;
    // price = cost / (1 - margin): 16.81/0.85 = 19.78, 21.68/0.85 = 25.51 (tiers by size)
    const priceByUuid = Object.fromEntries(res.variant_updates.map((u: any) => [u.variant_uuid, u.price]));
    expect(priceByUuid.v1).toBe(19.78);
    expect(priceByUuid.v2).toBe(25.51);
    expect(res.channel_updates).toHaveLength(1);
    expect(res.variants_missing_cost).toBeUndefined();
    // the PUT carried the computed per-variant price
    const putV2 = calls.find((c) => c.init?.method === 'PUT' && c.url.includes('/variants/v2'));
    expect(putV2).toBeTruthy();
    expect(JSON.parse(String(putV2!.init!.body)).price).toBe(25.51);
  });

  it('skips variants with no cost (not yet synced to fulfillment) and notes it', async () => {
    const { api } = apiSequence([
      {
        products: [
          {
            uuid: 'p1',
            variants: [
              { uuid: 'v1', name: 'S', cost: 16.81 },
              { uuid: 'v2', name: 'M' }, // no cost yet
            ],
          },
        ],
      },
      {}, // PUT v1 only
    ]);
    const res = (await setPricesByMargin.handler(
      { product_uuid: 'p1', store_uuid: 's1', margin: 0.2, also_update_channels: false },
      fakeContext(api),
    )) as any;
    expect(res.variant_updates).toHaveLength(1);
    expect(res.variants_missing_cost).toContain('M');
    expect(res.channel_updates).toHaveLength(0);
    expect(res.note).toContain('cost');
  });
});

describe('recover_from_outage', () => {
  it('diagnoses failed syncs without executing (dry-run default)', async () => {
    const { api } = apiSequence([
      {
        products: [
          {
            product_uuid: 'p1',
            fulfillment_status: { sync_status: 'Failed' },
            channel_statuses: [{ integration_uuid: 'i1', sync_status: 'failed' }],
          },
        ],
      },
    ]);
    const res = (await recoverFromOutage.handler({}, fakeContext(api))) as any;
    expect(res.executed).toBe(false);
    expect(res.issues_found).toHaveLength(2);
  });
});

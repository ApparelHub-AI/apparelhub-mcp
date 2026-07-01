import { describe, it, expect } from 'vitest';
import {
  analyzeWhatWorks,
  autoOptimizeListings,
  cascadePriceChange,
  recoverFromOutage,
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

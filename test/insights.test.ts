import { describe, it, expect } from 'vitest';
import { deriveInsights, findUnderperformers } from '../src/knowledge/insights.js';

describe('deriveInsights', () => {
  it('returns a low-confidence note when there are no orders', () => {
    const i = deriveInsights([{ product_uuid: 'p1', name: 'Tee' }], []);
    expect(i[0]?.category).toBe('sales');
    expect(i[0]?.confidence).toBe('low');
  });

  it('derives top product, top channel, and average order value', () => {
    const products = [{ product_uuid: 'p1', name: 'Cactus Tee' }];
    const orders = [
      { order_uuid: 'o1', channel: 'Shopify', total: 30, items: [{ product_name: 'Cactus Tee' }] },
      { order_uuid: 'o2', channel: 'Shopify', total: 60, items: [{ product_name: 'Cactus Tee' }] },
    ];
    const i = deriveInsights(products, orders);
    expect(i.find((x) => x.category === 'top_product')?.finding).toContain('Cactus Tee');
    expect(i.find((x) => x.category === 'channel_performance')?.finding).toContain('Shopify');
    expect(i.find((x) => x.category === 'pricing')?.finding).toContain('45.00');
  });
});

describe('findUnderperformers', () => {
  const products = [
    { product_uuid: 'p1', name: 'Sold Tee' },
    { product_uuid: 'p2', name: 'Dead Tee' },
  ];
  const orders = [{ order_uuid: 'o1', items: [{ product_name: 'Sold Tee' }] }];

  it('flags the product with no recorded sales', () => {
    const u = findUnderperformers(products, orders);
    expect(u.map((x) => x.product_uuid)).toEqual(['p2']);
  });

  it('will NOT archive on sales alone — that was the bug', () => {
    // This assertion used to read `toBe('pause')`. It encoded the defect: with
    // no demand data, "no sales" was treated as "no demand" and the listing was
    // archived autonomously. A listing with thousands of views and no sales is
    // the most valuable thing in a catalogue, and it was being deleted.
    //
    // With no signal supplied, the only honest answer is that we cannot judge.
    const u = findUnderperformers(products, orders);
    expect(u[0]?.action).toBe('review');
    expect(u.some((x) => x.action === 'pause')).toBe(false);
  });

  it('archives only when the channel confirms the listing is inert', () => {
    const signals = new Map([['p2', { state: 'dead', impressions: 1 }]]);
    const u = findUnderperformers(products, orders, signals);
    expect(u[0]?.action).toBe('pause');
  });

  it('sends a proven-demand listing to be fixed, not archived', () => {
    const signals = new Map([
      ['p2', { state: 'conversion_blocked', impressions: 4200 }],
    ]);
    const u = findUnderperformers(products, orders, signals);
    expect(u[0]?.action).toBe('optimize_listing');
  });
});

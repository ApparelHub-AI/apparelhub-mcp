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
  it('flags products with no recorded sales', () => {
    const products = [
      { product_uuid: 'p1', name: 'Sold Tee' },
      { product_uuid: 'p2', name: 'Dead Tee' },
    ];
    const orders = [{ order_uuid: 'o1', items: [{ product_name: 'Sold Tee' }] }];
    const u = findUnderperformers(products, orders);
    expect(u.map((x) => x.product_uuid)).toEqual(['p2']);
    expect(u[0]?.action).toBe('pause');
  });
});

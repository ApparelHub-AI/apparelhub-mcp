import { describe, it, expect } from 'vitest';
import {
  listMyDesigns,
  listMyProducts,
  listMyOrders,
  getOrderDetails,
} from '../src/tools/read.js';
import { fakeContext } from './helpers/ctx.js';
import { apiReturning, apiRecording } from './helpers/fakeFetch.js';

describe('list_my_designs', () => {
  it('maps generated images and applies default limit + sort', async () => {
    const raw = {
      images: [
        {
          uuid: 'd1',
          prompt: 'saguaro sunset',
          thumbnail_url: 'https://cdn.example/t.png',
          url: 'https://cdn.example/f.png',
          source: 'Nano Banana',
          created: '2026-06-01',
          products_using: 2,
        },
      ],
      total: 1,
    };
    const { api, calls } = apiRecording(raw);
    const res = (await listMyDesigns.handler({}, fakeContext(api))) as any;
    expect(res.total).toBe(1);
    expect(res.designs[0]).toMatchObject({
      design_uuid: 'd1',
      title: 'saguaro sunset',
      full_url: 'https://cdn.example/f.png',
      source: 'Nano Banana',
      products_using: 2,
    });
    const url = calls[0]?.url ?? '';
    expect(url).toContain('limit=20');
    expect(url).toContain('sort=newest');
  });
});

describe('list_my_products', () => {
  it('routes to the per-store endpoint when store_uuid is given and maps sync status', async () => {
    const raw = {
      products: [
        {
          uuid: 'p1',
          name: 'Cactus Tee',
          price: 27.99,
          display_image: 'https://cdn.example/p.png',
          status: 'active',
          fulfillment_status: { provider_name: 'Printful', sync_status: 'Synced' },
          channel_statuses: [
            { integration_uuid: 'i1', channel_name: 'Shopify', sync_status: 'Synced', external_id: '999' },
          ],
        },
      ],
    };
    const { api, calls } = apiRecording(raw);
    const res = (await listMyProducts.handler({ store_uuid: 's1' }, fakeContext(api))) as any;
    expect(calls[0]?.url).toContain('/store/s1/products');
    expect(res.products[0]).toMatchObject({
      product_uuid: 'p1',
      name: 'Cactus Tee',
      price: 27.99,
      view_url: 'https://apparelhub.ai/merchandise/my-products/p1',
    });
    expect(res.products[0].fulfillment_status).toEqual({ provider: 'Printful', sync_status: 'Synced' });
    expect(res.products[0].channel_statuses[0]).toMatchObject({
      integration_uuid: 'i1',
      channel_name: 'Shopify',
      sync_status: 'Synced',
    });
  });

  it('uses the all-products endpoint when no store_uuid', async () => {
    const { api, calls } = apiRecording({ products: [] });
    await listMyProducts.handler({}, fakeContext(api));
    expect(calls[0]?.url).toMatch(/\/agents\/v1\/product(\?|$)/);
  });
});

describe('list_my_orders', () => {
  it('maps orders with items, shipments, and a view_url', async () => {
    const raw = {
      orders: [
        {
          uuid: 'o1',
          external_display_id: '1776',
          total: 61.06,
          status: 'shipped',
          channel: 'WooCommerce',
          line_items: [{ product_name: 'Cactus Tee', quantity: 1, sku: 'AH-1' }],
          shipments: [{ carrier: 'USPS', tracking_number: 'TRK1', status: 'in_transit' }],
        },
      ],
    };
    const res = (await listMyOrders.handler({}, fakeContext(apiReturning(raw)))) as any;
    expect(res.orders[0]).toMatchObject({
      order_uuid: 'o1',
      order_number: '1776',
      total: 61.06,
      status: 'shipped',
      channel: 'WooCommerce',
      view_url: 'https://apparelhub.ai/orders/o1',
    });
    expect(res.orders[0].items[0]).toEqual({ product_name: 'Cactus Tee', quantity: 1, sku: 'AH-1' });
    expect(res.orders[0].shipments[0]).toMatchObject({ carrier: 'USPS', tracking_number: 'TRK1' });
  });
});

describe('get_order_details', () => {
  it('unwraps a {order:...} envelope and includes payment/fulfillment fields', async () => {
    const raw = {
      order: {
        uuid: 'o9',
        order_number: '1824',
        total: 25,
        status: 'pending',
        payment_status: 'paid',
        payment_method: 'sales_channel',
        fulfillment_substatus: 'design_approval_pending',
      },
    };
    const res = (await getOrderDetails.handler({ order_uuid: 'o9' }, fakeContext(apiReturning(raw)))) as any;
    expect(res.order).toMatchObject({
      order_uuid: 'o9',
      order_number: '1824',
      payment_status: 'paid',
      payment_method: 'sales_channel',
      fulfillment_substatus: 'design_approval_pending',
      view_url: 'https://apparelhub.ai/orders/o9',
    });
  });
});

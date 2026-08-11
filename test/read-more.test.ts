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
    // No filter unless asked for: omitted booleans must not appear at all.
    expect(url).not.toContain('on_products');
    expect(url).not.toContain('archived');
  });

  it('surfaces why a design failed, so an agent can tell retry from hopeless', async () => {
    // apparelhub-ai#886. Without these an agent sees a null full_url and no
    // reason, so it cannot distinguish a transient failure worth retrying from
    // a content block that will fail identically every time.
    const { api } = apiRecording({
      images: [
        {
          uuid: 'd-blocked',
          prompt: 'something the provider refused',
          url: null,
          processing_status: 'failed',
          processing_error: 'This prompt was blocked by the model provider.',
          processing_error_code: 'content_blocked',
        },
      ],
      total: 1,
    });
    const res = (await listMyDesigns.handler({}, fakeContext(api))) as any;
    expect(res.designs[0]).toMatchObject({
      design_uuid: 'd-blocked',
      processing_status: 'failed',
      processing_error: 'This prompt was blocked by the model provider.',
      processing_error_code: 'content_blocked',
    });
  });

  it('says a design is still in flight rather than looking like a failure', async () => {
    const { api } = apiRecording({
      images: [{ uuid: 'd-pending', url: null, processing_status: 'pending' }],
      total: 1,
    });
    const res = (await listMyDesigns.handler({}, fakeContext(api))) as any;
    expect(res.designs[0].processing_status).toBe('pending');
    // Nothing has gone wrong yet, so there is no reason to invent one.
    expect(res.designs[0]).not.toHaveProperty('processing_error');
  });

  it('keeps a healthy design lean — no failure keys at all', async () => {
    // The platform returns processing_status: null for a completed image.
    // Emitting the keys anyway would put three nulls on every row of every
    // design listing an agent reads.
    const { api } = apiRecording({
      images: [
        {
          uuid: 'd-ok',
          url: 'https://cdn.example/f.png',
          processing_status: null,
          processing_error: null,
          processing_error_code: null,
        },
      ],
      total: 1,
    });
    const res = (await listMyDesigns.handler({}, fakeContext(api))) as any;
    expect(res.designs[0].full_url).toBe('https://cdn.example/f.png');
    expect(res.designs[0]).not.toHaveProperty('processing_status');
    expect(res.designs[0]).not.toHaveProperty('processing_error');
    expect(res.designs[0]).not.toHaveProperty('processing_error_code');
  });

  it('passes on_products=false so orphan designs are discoverable', async () => {
    const { api, calls } = apiRecording({ images: [], total: 0 });
    await listMyDesigns.handler({ on_products: false }, fakeContext(api));
    // The backend compares the raw string, so it must serialize as "false", not "0"/"".
    expect(calls[0]?.url ?? '').toContain('on_products=false');
  });

  it('passes archived=true to list archived designs', async () => {
    const { api, calls } = apiRecording({ images: [], total: 0 });
    await listMyDesigns.handler({ archived: true }, fakeContext(api));
    expect(calls[0]?.url ?? '').toContain('archived=true');
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
          created: '2026-07-09T05:35:25',
          updated: '2026-07-09T06:00:00',
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
      created: '2026-07-09T05:35:25', // exposed so a reconciler can measure recency/stability
      updated: '2026-07-09T06:00:00',
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

// ---------------------------------------------------------------------------
// Listing health on channel statuses (apparelhub-ai#1024 / #1028).
//
// An agent that reads only `sync_status` will keep reporting a listing as fine
// after the channel has taken it down — the whole point of surfacing health.
// ---------------------------------------------------------------------------
describe('list_my_products — listing health', () => {
  const productWith = (channel: Record<string, unknown>) => ({
    products: [
      {
        uuid: 'p1',
        name: 'Root Cause Tee',
        channel_statuses: [
          {
            integration_uuid: 'i1',
            provider_name: 'TikTok Shop',
            sync_status: 'Not Synced',
            ...channel,
          },
        ],
      },
    ],
  });

  it('surfaces health so a removed listing is not read as merely un-synced', async () => {
    const { api } = apiRecording(productWith({ health: 'Removed' }));
    const res = (await listMyProducts.handler({}, fakeContext(api))) as any;
    expect(res.products[0].channel_statuses[0].health).toBe('Removed');
  });

  it("carries the channel's own takedown reason when it gave one", async () => {
    const { api } = apiRecording(
      productWith({ health: 'Removed', health_detail: { channel_reason: 'Prohibited product' } }),
    );
    const res = (await listMyProducts.handler({}, fakeContext(api))) as any;
    expect(res.products[0].channel_statuses[0].health_reason).toBe('Prohibited product');
  });

  it('omits health_reason rather than emitting an empty one', async () => {
    const { api } = apiRecording(productWith({ health: 'Removed', health_detail: {} }));
    const res = (await listMyProducts.handler({}, fakeContext(api))) as any;
    expect(res.products[0].channel_statuses[0]).not.toHaveProperty('health_reason');
  });

  it('keeps a large channel product id as a string', async () => {
    // TikTok product ids exceed 2^53; as a JS number this value corrupts.
    const { api } = apiRecording(
      productWith({ external_id: '1732547368555024494', health: 'In Sync' }),
    );
    const res = (await listMyProducts.handler({}, fakeContext(api))) as any;
    const ext = res.products[0].channel_statuses[0].external_id;
    expect(typeof ext).toBe('string');
    expect(ext).toBe('1732547368555024494');
  });

  it('a never-checked listing reports no health rather than a false healthy', async () => {
    const { api } = apiRecording(productWith({ sync_status: 'Synced' }));
    const res = (await listMyProducts.handler({}, fakeContext(api))) as any;
    const ch = res.products[0].channel_statuses[0];
    expect(ch.sync_status).toBe('Synced');
    expect(ch.health).toBeUndefined();
  });
});

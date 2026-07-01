import { describe, it, expect } from 'vitest';
import {
  shipProduct,
  addVariants,
  syncToChannel,
  updateProduct,
  deleteProduct,
} from '../src/tools/product.js';
import { ApiClient } from '../src/http/client.js';
import { fakeContext } from './helpers/ctx.js';
import { queueFetch, jsonResponse, noSleep } from './helpers/fakeFetch.js';

function apiFrom(bodies: unknown[]) {
  const { fetchImpl, calls } = queueFetch(bodies.map((b) => jsonResponse(200, b)));
  const api = new ApiClient({
    apiKey: 'k',
    baseUrl: 'https://api.example.test/agents/v1',
    userAgent: 't',
    fetchImpl,
    sleepImpl: noSleep,
  });
  return { api, calls };
}

const garmentDetail = {
  product: {
    name: 'Unisex Staple Tee',
    brand: 'Bella+Canvas',
    base_cost: 11.69,
    variants: [{ id: 4016, color: 'Black', size: 'S', cost: 11.69 }],
    print_templates: [{ placement: 'front', area_width: 1800, area_height: 2400 }],
  },
};

describe('ship_product', () => {
  it('runs the full pipeline in order and defaults channel sync to draft', async () => {
    const { api, calls } = apiFrom([
      garmentDetail, // GET garment detail
      { job_uuid: 'job1' }, // POST mockup preview
      { status: 'completed', previews: [{ preview_url: 'https://cdn.example/m.png' }] }, // GET job (2-phase)
      { uuid: 'p1' }, // POST product/create
      {}, // POST variants (S)
      {}, // POST store products (associate)
      {}, // POST sync target=merchandise
      { listing_url: 'https://shop.example/x' }, // POST sync target=ecommerce
    ]);
    const res = (await shipProduct.handler(
      {
        design_uuid: 'd1',
        design_url: 'https://cdn.example/d.png',
        garment: { provider_uuid: 'pf', product_ref_id: '71' },
        variants: [{ color: 'Black', sizes: ['S'] }],
        pricing: { price: 27.99 },
        product_meta: { name: 'Cactus Tee', description: 'nice' },
        store_uuid: 's1',
        sync_to_channels: [{ integration_uuid: 'i1' }],
      },
      fakeContext(api),
    )) as any;

    expect(res).toMatchObject({
      product_uuid: 'p1',
      product_url: 'https://apparelhub.ai/merchandise/my-products/p1',
      fulfillment_status: 'synced',
      variants_added: 1,
    });
    expect(res.channel_sync_results[0]).toMatchObject({ integration_uuid: 'i1', status: 'synced_as_draft' });

    // Correct field names on create (Lesson 2), and correct ordering.
    const createCall = calls.find((c) => c.url.endsWith('/product/create'));
    const body = JSON.parse(createCall?.init?.body as string);
    expect(body.provider_uuid).toBe('pf');
    expect(body.product_ref_id).toBe('71');
    expect(body.price).toBe(27.99);
    expect(body).toHaveProperty('print_data');
    expect(body).not.toHaveProperty('merchandise_provider_uuid');
    // ecommerce sync carried listing_state=draft.
    const ecomCall = calls.find((c) => c.url.includes('target=ecommerce'));
    expect(ecomCall?.url).toContain('listing_state=draft');
  });

  it('refuses a price below the garment pricing floor', async () => {
    const { api } = apiFrom([garmentDetail]);
    await expect(
      shipProduct.handler(
        {
          design_uuid: 'd1',
          design_url: 'https://cdn.example/d.png',
          garment: { provider_uuid: 'pf', product_ref_id: '71' },
          variants: [{ color: 'Black', sizes: ['S'] }],
          pricing: { price: 9.99 },
          product_meta: { name: 'x', description: '' },
        },
        fakeContext(api),
      ),
    ).rejects.toMatchObject({ code: 'pricing_floor' });
  });
});

describe('add_variants', () => {
  it('resolves ids from provider options and warns on the AQUA trap', async () => {
    const { api } = apiFrom([
      { variants: [{ id: 4021, color: 'Aqua', size: 'S' }] }, // provider-options
      {}, // POST variant
    ]);
    const res = (await addVariants.handler(
      {
        product_uuid: 'p1',
        product_ref_id: '71',
        variants: [{ color: 'Navy', sizes: ['S'], provider_variant_ids: [4021] }],
      },
      fakeContext(api),
    )) as any;
    expect(res.variants_added).toBe(1);
    expect(res.warnings[0]).toContain('AQUA');
  });
});

describe('sync_to_channel', () => {
  it('defaults to draft', async () => {
    const { api, calls } = apiFrom([{ listing_url: 'https://shop.example/y' }]);
    const res = (await syncToChannel.handler(
      { product_uuid: 'p1', store_uuid: 's1', integration_uuid: 'i1' },
      fakeContext(api),
    )) as any;
    expect(res.sync_status).toBe('synced_as_draft');
    expect(calls[0]?.url).toContain('listing_state=draft');
    expect(calls[0]?.url).toContain('target=ecommerce');
  });
});

describe('update_product', () => {
  it('PATCHes the provided fields', async () => {
    const { api, calls } = apiFrom([{}]);
    const res = (await updateProduct.handler(
      { product_uuid: 'p1', changes: { price: 29.99 } },
      fakeContext(api),
    )) as any;
    expect(res.changes_applied).toEqual(['price']);
    expect(calls[0]?.init?.method).toBe('PATCH');
  });
});

describe('delete_product', () => {
  it('hard-deletes by default', async () => {
    const { api, calls } = apiFrom([{}]);
    const res = (await deleteProduct.handler({ product_uuid: 'p1' }, fakeContext(api))) as any;
    expect(res.deleted).toBe(true);
    expect(calls[0]?.init?.method).toBe('DELETE');
  });

  it('archives when archive_only is set', async () => {
    const { api, calls } = apiFrom([{}]);
    const res = (await deleteProduct.handler(
      { product_uuid: 'p1', archive_only: true },
      fakeContext(api),
    )) as any;
    expect(res.archived).toBe(true);
    expect(calls[0]?.init?.method).toBe('PATCH');
  });
});

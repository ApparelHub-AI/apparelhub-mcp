import { describe, it, expect } from 'vitest';
import {
  shipProduct,
  createProduct,
  addVariants,
  syncToFulfillment,
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

describe('create_product', () => {
  it('generate_mockup:true renders a mockup by auto-deriving variants from the catalog (no mockup_variant_ids needed)', async () => {
    const { api, calls } = apiFrom([
      garmentDetail, // fetchGarment
      { job_uuid: 'j1' }, // POST mockup preview
      { status: 'completed', previews: [{ preview_url: 'https://cdn.example/m.png' }] }, // GET job poll
      { uuid: 'p1' }, // POST product/create
    ]);
    const res = (await createProduct.handler(
      {
        design_uuid: 'd1',
        design_url: 'https://cdn.example/d.png',
        garment: { provider_uuid: 'pf', product_ref_id: '71' },
        pricing: { price: 27.99 },
        product_meta: { name: 'Cactus Tee', description: 'nice' },
        generate_mockup: true,
      },
      fakeContext(api),
    )) as any;
    expect(res.mockup_status).toBe('generated');
    expect(res.product_uuid).toBe('p1');
    // The create body carries the preview_job_uuid so the mockup becomes the display image.
    const createCall = calls.find((c) => c.url.endsWith('/product/create'));
    const body = JSON.parse(createCall?.init?.body as string);
    expect(body.preview_job_uuid).toBe('j1');
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

  it('resolves Printify variant ids from provider_ref_id by color+size (no explicit ids)', async () => {
    // Printify's matrix carries the id under provider_ref_id (a numeric string), not id.
    // Before the fix this resolved to 0 and shipped a 0-usable-variant product.
    const { api, calls } = apiFrom([
      { variants: [{ provider_ref_id: '24830', color: 'White', size: 'S' }] }, // Printify-shaped provider-options
      {}, // POST variant
    ]);
    const res = (await addVariants.handler(
      { product_uuid: 'p1', variants: [{ color: 'White', sizes: ['S'] }] },
      fakeContext(api),
    )) as any;
    expect(res.variants_added).toBe(1);
    const variantCall = calls.find((c) => c.url.endsWith('/variants'));
    const body = JSON.parse(variantCall?.init?.body as string);
    expect(body.provider_variant_id).toBe(24830); // coerced from provider_ref_id, NOT 0
  });

  it('throws with the available options when nothing resolves (apparel sizes on a one-size garment)', async () => {
    // The Cap bug: hardcoded S/M/L/XL/2XL against a one-size garment resolves nothing. Fail loud,
    // do NOT create a 0-variant product.
    const { api, calls } = apiFrom([
      {
        variants: [
          { id: 9001, color: 'Black', size: 'One size' },
          { id: 9002, color: 'White', size: 'One size' },
        ],
      }, // provider-options
    ]);
    await expect(
      addVariants.handler(
        { product_uuid: 'p1', variants: [{ color: 'Black', sizes: ['S', 'M', 'L', 'XL', '2XL'] }] },
        fakeContext(api),
      ),
    ).rejects.toMatchObject({ code: 'bad_request' });
    expect(calls).toHaveLength(1); // only the provider-options GET; no variant POSTs
  });
});

describe('sync_to_fulfillment', () => {
  it('associates the product with the store BEFORE the merchandise sync', async () => {
    // A create_product product is standalone; the merchandise sync is addressed under the store's
    // product list, so the association must happen first (this was previously missing here).
    const { api, calls } = apiFrom([{}, {}]);
    const res = (await syncToFulfillment.handler(
      { product_uuid: 'p1', store_uuid: 's1' },
      fakeContext(api),
    )) as any;
    expect(res.fulfillment_status).toBe('synced');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.url.endsWith('/store/s1/products')).toBe(true); // associate
    expect(calls[1]?.url).toContain('target=merchandise'); // then fulfillment sync
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
    expect(res.warnings).toBeUndefined(); // happy path: no heal, no warning
    expect(calls).toHaveLength(1); // no extra associate/fulfillment work when it succeeds first try
    expect(calls[0]?.url).toContain('listing_state=draft');
    expect(calls[0]?.url).toContain('target=ecommerce');
  });

  it('self-heals when the product is not yet associated with the store, then retries once', async () => {
    // 1st ecommerce sync 400s ("product not associated with store"); the tool then associates +
    // fulfillment-syncs and retries the ecommerce sync, which succeeds.
    const { fetchImpl, calls } = queueFetch([
      jsonResponse(400, { error: 'bad_request', message: 'product not associated with store' }),
      jsonResponse(200, {}), // associate
      jsonResponse(200, {}), // merchandise (fulfillment) sync
      jsonResponse(200, { listing_url: 'https://shop.example/z' }), // ecommerce retry
    ]);
    const api = new ApiClient({
      apiKey: 'k',
      baseUrl: 'https://api.example.test/agents/v1',
      userAgent: 't',
      fetchImpl,
      sleepImpl: noSleep,
    });
    const res = (await syncToChannel.handler(
      { product_uuid: 'p1', store_uuid: 's1', integration_uuid: 'i1' },
      fakeContext(api),
    )) as any;

    expect(res.sync_status).toBe('synced_as_draft');
    expect(res.channel_url).toBe('https://shop.example/z');
    expect(res.warnings?.[0]).toContain('auto-associated');
    expect(calls).toHaveLength(4);
    expect(calls[0]?.url).toContain('target=ecommerce'); // failed first attempt
    expect(calls[1]?.url.endsWith('/store/s1/products')).toBe(true); // heal: associate
    expect(calls[2]?.url).toContain('target=merchandise'); // heal: fulfillment sync
    expect(calls[3]?.url).toContain('target=ecommerce'); // successful retry
  });

  it('does NOT self-heal a non-prerequisite error (e.g. 403) — it surfaces', async () => {
    const { fetchImpl, calls } = queueFetch([
      jsonResponse(403, { error: 'forbidden', message: 'nope' }),
    ]);
    const api = new ApiClient({
      apiKey: 'k',
      baseUrl: 'https://api.example.test/agents/v1',
      userAgent: 't',
      fetchImpl,
      sleepImpl: noSleep,
    });
    await expect(
      syncToChannel.handler(
        { product_uuid: 'p1', store_uuid: 's1', integration_uuid: 'i1' },
        fakeContext(api),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(calls).toHaveLength(1); // no heal attempt
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

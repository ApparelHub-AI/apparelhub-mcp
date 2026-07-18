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
import type { Imaging } from '../src/image/imaging.js';
import { fakeContext } from './helpers/ctx.js';
import { queueFetch, jsonResponse, noSleep } from './helpers/fakeFetch.js';

function stubImaging(overrides: Partial<Imaging> = {}): Imaging {
  return {
    downloadToTemp: async () => '/tmp/fake-design.png',
    makeTransparent: async () => {
      throw new Error('not expected in this test');
    },
    readBytes: async () => new Uint8Array([137, 80, 78, 71]),
    imageSize: async () => undefined,
    imageStats: async () => undefined,
    ocr: async () => ({ available: false, text: '' }),
    threadColors: async () => {
      throw new Error('not expected in this test');
    },
    ensureResolution: async () => ({ outputPath: '/tmp/fake-hires.png', upscaled: false }),
    cleanup: async () => {},
    ...overrides,
  };
}

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

// prepare-print-data mocks (mcp#101 / v0.4.0): the platform composes per-placement print_data.
const PREP_POST = { status: 'pending', job_uuid: 'pjob' };
function prepDone(
  provider_ref_id: string,
  area_width: number,
  area_height: number,
  extra: Record<string, unknown> = {},
) {
  return {
    status: 'completed',
    image_uuid: 'd1',
    image_url: 'https://cdn.example/d.png',
    print_style: 'placed',
    placements_covered: [provider_ref_id],
    warnings: [],
    print_data: [
      {
        provider_ref_id,
        area_width,
        area_height,
        width: area_width,
        height: area_height,
        top: 0,
        left: 0,
        image_url: 'https://cdn.example/d.png',
        ...extra,
      },
    ],
  };
}
const prepFront = () => prepDone('front', 1800, 2400);
const prepEmbroidery = () => prepDone('embroidery_front_large', 1888, 640);

describe('ship_product', () => {
  it('runs the full pipeline in order and defaults channel sync to draft', async () => {
    const { api, calls } = apiFrom([
      garmentDetail, // GET garment detail
      PREP_POST,
      prepFront(), // prepare-print-data POST + poll
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
    expect(res.channel_sync_results[0]).toMatchObject({
      integration_uuid: 'i1',
      status: 'synced_as_draft',
    });

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

  it('generates a mockup covering EACH imported color (one per color), not N shades of the first', async () => {
    const twoColorGarment = {
      product: {
        name: 'Tee',
        base_cost: 11.69,
        variants: [
          { id: 100, color: 'Black', size: 'S', cost: 11.69 },
          { id: 101, color: 'Black', size: 'M', cost: 11.69 },
          { id: 200, color: 'White', size: 'S', cost: 11.69 },
          { id: 201, color: 'White', size: 'M', cost: 11.69 },
        ],
        print_templates: [{ placement: 'front', area_width: 1800, area_height: 2400 }],
      },
    };
    const { api, calls } = apiFrom([
      twoColorGarment, // fetchGarment
      PREP_POST,
      prepFront(),
      { job_uuid: 'job1' }, // mockup preview POST
      { status: 'completed', previews: [{ preview_url: 'https://cdn.example/m.png' }] }, // job poll
      { uuid: 'p1' }, // create
      {},
      {},
      {},
      {}, // 4 variant POSTs
    ]);
    await shipProduct.handler(
      {
        design_uuid: 'd1',
        design_url: 'https://cdn.example/d.png',
        garment: { provider_uuid: 'pf', product_ref_id: '71' },
        variants: [
          { color: 'Black', sizes: ['S', 'M'] },
          { color: 'White', sizes: ['S', 'M'] },
        ],
        pricing: { price: 27.99 },
        product_meta: { name: 'x', description: 'y' },
      },
      fakeContext(api),
    );
    const mockupCall = calls.find((c) => c.url.endsWith('/merchandise/product/preview'));
    const body = JSON.parse(mockupCall?.init?.body as string);
    // One id per color (first Black + first White) — NOT [100, 101] (two blacks, no white mockup).
    expect(body.variant_ids).toEqual([100, 200]);
  });
});

// Shaped like the REAL raw payload for Printful 596 (Closed-Back Trucker Cap): NO top-level
// template keys; templates live per-VARIANT with the placement under provider_location_ref_id
// and a NUMERIC template id under provider_ref_id.
const capGarment = {
  product: {
    name: 'Closed-Back Trucker Cap | Flexfit 6511',
    variants: [
      {
        provider_ref_id: 15403,
        color: 'Black',
        size: 'One size',
        price: '15.99',
        templates: [
          {
            area_height: 640,
            area_width: 1888,
            left: 555,
            provider_location_ref_id: 'embroidery_front_large',
            provider_ref_id: 257169,
            template_height: 3000,
            template_width: 3000,
            top: 1176,
          },
        ],
      },
      {
        provider_ref_id: 15404,
        color: 'Black/White',
        size: 'One size',
        price: '15.99',
        templates: [
          {
            area_height: 640,
            area_width: 1888,
            left: 555,
            provider_location_ref_id: 'embroidery_front_large',
            provider_ref_id: 257170,
            template_height: 3000,
            template_width: 3000,
            top: 1176,
          },
        ],
      },
    ],
  },
};

describe('ship_product: embroidery garments (cap/beanie incident)', () => {
  it('routes the print to the embroidery placement with real dims and attaches thread colors on create (not on the mockup)', async () => {
    const { api, calls } = apiFrom([
      capGarment, // fetchGarment (raw 596 shape)
      PREP_POST,
      prepEmbroidery(),
      { job_uuid: 'j1' }, // mockup POST
      { status: 'completed', previews: [{ preview_url: 'https://cdn.example/cap.png' }] }, // poll
      { uuid: 'p1' }, // create
      {},
      {}, // 2 variant POSTs
      {}, // associate
      {}, // merchandise sync
    ]);
    const res = (await shipProduct.handler(
      {
        design_uuid: 'd1',
        design_url: 'https://cdn.example/d.png',
        garment: { provider_uuid: 'pf', product_ref_id: '596' },
        variants: [
          { color: 'Black', sizes: ['One size'] },
          { color: 'Black/White', sizes: ['One size'] },
        ],
        pricing: { price: 34.99 },
        product_meta: { name: 'WC26 QF - ARGENTINA - Cap', description: 'cap' },
        store_uuid: 's1',
        thread_colors: ['#3399ff', '#ffcc00'], // lowercase on purpose: normalized to palette case
      },
      fakeContext(api),
    )) as any;

    expect(res.print_style).toBe('placed');
    expect(res.thread_colors).toEqual(['#3399FF', '#FFCC00']);
    expect(res.fulfillment_status).toBe('synced');

    // The mockup targets the EMBROIDERY placement (was 'front' -> Printful rejected it) with the
    // variant template's real dims — and stays options-free.
    const mockupCall = calls.find((c) => c.url.endsWith('/merchandise/product/preview'));
    const mockupBody = JSON.parse(mockupCall?.init?.body as string);
    expect(mockupBody.templates[0].provider_ref_id).toBe('embroidery_front_large');
    expect(mockupBody.templates[0].area_width).toBe(1888);
    expect(mockupBody.templates[0].area_height).toBe(640);
    expect(mockupBody.templates[0].options).toBeUndefined();

    // The CREATE payload carries the thread-colors option (the platform hoists it to the
    // sync-variant level at Printful sync — Lesson 61), placement-suffixed.
    const createCall = calls.find((c) => c.url.endsWith('/product/create'));
    const createBody = JSON.parse(createCall?.init?.body as string);
    expect(createBody.print_data[0].provider_ref_id).toBe('embroidery_front_large');
    expect(createBody.print_data[0].options).toEqual([
      { id: 'thread_colors_front_large', value: ['#3399FF', '#FFCC00'] },
    ]);
  });

  it('derives thread colors from the design when none are passed', async () => {
    const { api, calls } = apiFrom([
      capGarment,
      PREP_POST,
      prepEmbroidery(),
      { job_uuid: 'j1' },
      { status: 'completed', previews: [{ preview_url: 'https://cdn.example/cap.png' }] },
      { uuid: 'p1' },
      {},
    ]);
    const res = (await shipProduct.handler(
      {
        design_uuid: 'd1',
        design_url: 'https://cdn.example/d.png',
        garment: { provider_uuid: 'pf', product_ref_id: '596' },
        variants: [{ color: 'Black', sizes: ['One size'] }],
        pricing: { price: 34.99 },
        product_meta: { name: 'x', description: 'y' },
      },
      fakeContext(api, stubImaging({ threadColors: async () => ['#CC3333', '#FFCC00'] })),
    )) as any;
    expect(res.thread_colors).toEqual(['#CC3333', '#FFCC00']);
    const createCall = calls.find((c) => c.url.endsWith('/product/create'));
    const createBody = JSON.parse(createCall?.init?.body as string);
    expect(createBody.print_data[0].options[0].value).toEqual(['#CC3333', '#FFCC00']);
  });

  it('reads the print front from VARIANT templates (real dims, not the 1800x2400 default) and prefers front over other placements', async () => {
    const teeViaVariantTemplates = {
      product: {
        name: 'Unisex Staple T-Shirt | Bella + Canvas 3001',
        variants: [
          {
            id: 4016,
            color: 'Black',
            size: 'S',
            cost: 11.69,
            templates: [
              // back first on purpose: the chooser must still pick 'front'.
              {
                area_height: 1346,
                area_width: 1010,
                provider_location_ref_id: 'back',
                provider_ref_id: 150552,
              },
              {
                area_height: 1346,
                area_width: 1010,
                provider_location_ref_id: 'front',
                provider_ref_id: 150551,
              },
            ],
          },
        ],
      },
    };
    const { api, calls } = apiFrom([
      teeViaVariantTemplates,
      PREP_POST,
      prepDone('front', 1010, 1346),
      { job_uuid: 'j1' },
      { status: 'completed', previews: [{ preview_url: 'https://cdn.example/t.png' }] },
      { uuid: 'p1' },
      {},
    ]);
    const res = (await shipProduct.handler(
      {
        design_uuid: 'd1',
        design_url: 'https://cdn.example/d.png',
        garment: { provider_uuid: 'pf', product_ref_id: '71' },
        variants: [{ color: 'Black', sizes: ['S'] }],
        pricing: { price: 27.99 },
        product_meta: { name: 'Tee', description: 't' },
      },
      fakeContext(api),
    )) as any;
    expect(res.print_style).toBe('placed'); // "Bella + Canvas" must NOT trip the canvas fill rule
    const createCall = calls.find((c) => c.url.endsWith('/product/create'));
    const body = JSON.parse(createCall?.init?.body as string);
    expect(body.print_data[0].provider_ref_id).toBe('front');
    expect(body.print_data[0].area_width).toBe(1010);
    expect(body.print_data[0].area_height).toBe(1346);
    expect(body.print_data[0].options).toBeUndefined();
  });
});

describe('create_product', () => {
  it('generate_mockup:true renders a mockup by auto-deriving variants from the catalog (no mockup_variant_ids needed)', async () => {
    const { api, calls } = apiFrom([
      garmentDetail, // fetchGarment
      PREP_POST,
      prepFront(),
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

  // Regression: Gelato variant ids are STRING productUids, not numbers. mapMatrix used to coerce
  // them to 0, so mockupIdsCoveringColors derived nothing and the mockup was silently skipped —
  // the product ended up with the raw design as its display image instead of a rendered mockup.
  it('generates a mockup for a Gelato garment using its STRING productUid variant id (not skipped)', async () => {
    const gelatoPhoneCase = {
      product: {
        name: 'Iphone 16 Phone Case',
        base_cost: 10.4,
        variants: [
          {
            provider_ref_id: 'phonecase_apple_iphone-16_tough_white_glossy',
            color: 'White',
            size: '',
            cost: 10.4,
          },
        ],
        print_templates: [{ placement: 'default', area_width: 1000, area_height: 2000 }],
      },
    };
    const { api, calls } = apiFrom([
      gelatoPhoneCase, // fetchGarment
      PREP_POST,
      prepDone('default', 1000, 2000),
      { job_uuid: 'jg' }, // POST mockup preview
      { status: 'completed', previews: [{ preview_url: 'https://cdn.example/case.png' }] }, // job poll
      { uuid: 'pg' }, // POST product/create
    ]);
    const res = (await createProduct.handler(
      {
        design_uuid: 'd1',
        design_url: 'https://cdn.example/d.png',
        garment: { provider_uuid: 'ge', product_ref_id: 'cGhv' },
        pricing: { price: 39.99 },
        product_meta: { name: 'Nebula Phone Case', description: 'cosmic' },
        generate_mockup: true,
      },
      fakeContext(api),
    )) as any;
    // Mockup GENERATED, not skipped.
    expect(res.mockup_status).toBe('generated');
    // The mockup preview POST carried the STRING productUid as the variant id (not 0/dropped).
    const mockupCall = calls.find((c) => c.url.endsWith('/merchandise/product/preview'));
    const mbody = JSON.parse(mockupCall?.init?.body as string);
    expect(mbody.variant_ids).toContain('phonecase_apple_iphone-16_tough_white_glossy');
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

describe('sync_to_fulfillment: thread-colors self-heal', () => {
  it('rewrites the option id Printful names in the error, PATCHes, and retries once', async () => {
    // Printful's expected id varies by placement/product; the error message is authoritative.
    // Real platform shape: the provider error rides as a STRING inside body.message.
    const printfulReject = jsonResponse(400, {
      message:
        '{"code":400,"result":"thread_colors option is missing or incorrect! Allowed values: #FFFFFF, #000000, #96A1A8"}',
    });
    const { fetchImpl, calls } = queueFetch([
      jsonResponse(200, {}), // associate
      printfulReject, // merchandise sync attempt 1
      jsonResponse(200, {
        product: {
          uuid: 'p1',
          print_files: [
            {
              provider_ref_id: 'embroidery_front',
              image_url: 'https://cdn.example/d.png',
              options: [{ id: 'thread_colors_front', value: ['#FFFFFF', '#000000'] }],
            },
          ],
        },
      }), // GET product
      jsonResponse(200, {}), // PATCH print_files
      jsonResponse(200, {}), // merchandise sync retry
    ]);
    const api = new ApiClient({
      apiKey: 'k',
      baseUrl: 'https://api.example.test/agents/v1',
      userAgent: 't',
      fetchImpl,
      sleepImpl: noSleep,
    });
    const res = (await syncToFulfillment.handler(
      { product_uuid: 'p1', store_uuid: 's1' },
      fakeContext(api),
    )) as any;

    expect(res.fulfillment_status).toBe('synced');
    expect(res.note).toContain('thread_colors');
    expect(calls).toHaveLength(5);
    const patchCall = calls[3];
    expect(patchCall?.init?.method).toBe('PATCH');
    const patched = JSON.parse(patchCall?.init?.body as string);
    expect(patched.print_files[0].options[0].id).toBe('thread_colors'); // rewritten to the expected id
    expect(patched.print_files[0].options[0].value).toEqual(['#FFFFFF', '#000000']); // values untouched
    expect(calls[4]?.url).toContain('target=merchandise'); // retried
  });

  it('does NOT heal when the product has no thread-colors options — the original error surfaces', async () => {
    const { fetchImpl, calls } = queueFetch([
      jsonResponse(200, {}), // associate
      jsonResponse(400, {
        message:
          '{"code":400,"result":"thread_colors option is missing or incorrect! Allowed values: #FFFFFF"}',
      }), // sync fails
      jsonResponse(200, {
        product: {
          uuid: 'p1',
          print_files: [{ provider_ref_id: 'front', image_url: 'https://x/y.png' }],
        },
      }), // GET product: pre-fix product, no options to rewrite
    ]);
    const api = new ApiClient({
      apiKey: 'k',
      baseUrl: 'https://api.example.test/agents/v1',
      userAgent: 't',
      fetchImpl,
      sleepImpl: noSleep,
    });
    await expect(
      syncToFulfillment.handler({ product_uuid: 'p1', store_uuid: 's1' }, fakeContext(api)),
    ).rejects.toBeTruthy();
    expect(calls).toHaveLength(3); // no PATCH, no blind retry
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

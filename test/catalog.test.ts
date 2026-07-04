import { describe, it, expect } from 'vitest';
import { browseCatalog, getGarmentDetails, recommendGarmentTool } from '../src/tools/catalog.js';
import { fakeContext } from './helpers/ctx.js';
import { apiSequence } from './helpers/fakeFetch.js';

describe('browse_catalog', () => {
  it('resolves the provider uuid, then lists + maps garments', async () => {
    const merchandise = {
      providers: [
        { uuid: 'pf-uuid', name: 'Printful' },
        { uuid: 'py-uuid', name: 'Printify' },
      ],
    };
    const products = {
      products: [
        {
          ref_id: '71',
          name: 'Unisex Staple Tee',
          brand: 'Bella+Canvas',
          category: 't-shirts',
          base_cost: 11.69,
          image_url: 'https://cdn.example/i.png',
          variant_count: 100,
        },
      ],
    };
    const { api, calls } = apiSequence([merchandise, products]);
    const res = (await browseCatalog.handler({ provider: 'Printful' }, fakeContext(api))) as any;
    expect(calls[0]?.url).toContain('/agents/v1/merchandise/providers');
    expect(calls[1]?.url).toContain('/merchandise/pf-uuid/products');
    expect(res.garments[0]).toMatchObject({
      provider_ref_id: '71',
      brand: 'Bella+Canvas',
      base_cost: 11.69,
      variant_count: 100,
    });
  });

  it('errors clearly when the provider is not connected', async () => {
    const { api } = apiSequence([{ providers: [] }]);
    await expect(
      browseCatalog.handler({ provider: 'Printful' }, fakeContext(api)),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('get_garment_details', () => {
  it('computes pricing_floor + quality_tier and surfaces the BC 3001 variant warning', async () => {
    const merchandise = { providers: [{ uuid: 'pf-uuid', name: 'Printful' }] };
    const detail = {
      product: {
        name: 'Unisex Staple Tee',
        brand: 'Bella+Canvas',
        category: 't-shirts',
        base_cost: 11.69,
        variants: [{ id: 4016, color: 'Black', size: 'S', cost: 11.69 }],
        print_templates: [
          { placement: 'front', area_width: 1800, area_height: 2400, width: 1584, height: 1056 },
        ],
      },
    };
    const { api } = apiSequence([merchandise, detail]);
    const res = (await getGarmentDetails.handler(
      { provider: 'Printful', product_ref_id: '71' },
      fakeContext(api),
    )) as any;
    expect(res.pricing_floor).toBe(21.99);
    expect(res.quality_tier).toBe('standard');
    expect(res.variants[0]).toMatchObject({ provider_variant_id: 4016, color: 'Black' });
    expect(res.print_templates[0]).toMatchObject({ placement: 'front', area_width: 1800 });
    expect(res.warnings[0]).toContain('AQUA');
  });
});

describe('recommend_garment', () => {
  it('recommends a premium tee for a premium audience', async () => {
    const res = (await recommendGarmentTool.handler(
      { target_audience: 'premium' },
      fakeContext(),
    )) as any;
    expect(res.recommendation.brand).toBe('Comfort Colors');
    expect(res.alternatives.length).toBeGreaterThan(0);
  });
});

// Shapes below mirror the LIVE platform responses observed 2026-07-04 (bare-array listing,
// numeric provider_ref_id, string prices, variant-level templates) — the fields the first
// remote-surface test (#38) caught the mappers missing. Generic placeholder values only.
describe('catalog mapping against live platform shapes', () => {
  it('browse_catalog maps a bare-array listing with numeric provider_ref_id', async () => {
    const merchandise = { providers: [{ uuid: 'pf-uuid', name: 'Printful' }] };
    const products = [
      {
        provider_ref_id: 938,
        name: 'Luggage Tag',
        brand: null,
        image: 'https://cdn.example/tag.jpg',
        variant_count: 1,
        variants: [],
      },
    ];
    const { api } = apiSequence([merchandise, products]);
    const res = (await browseCatalog.handler({ provider: 'Printful' }, fakeContext(api))) as any;
    expect(res.total).toBe(1);
    expect(res.garments[0]).toMatchObject({ provider_ref_id: '938', name: 'Luggage Tag' });
  });

  it('get_garment_details reads variant ids, string prices, and variant-level templates', async () => {
    const merchandise = { providers: [{ uuid: 'pf-uuid', name: 'Printful' }] };
    const detail = {
      name: 'Luggage Tag',
      provider_ref_id: 938,
      template_details: [],
      variants: [
        {
          provider_ref_id: 23889,
          provider_product_ref_id: 938,
          color: null,
          color_code: null,
          size: '4x6',
          price: '13.20',
          in_stock: true,
          templates: [
            {
              provider_location_ref_id: 'default',
              provider_ref_id: 101,
              area_width: 1622,
              area_height: 2677,
              template_width: 3000,
              template_height: 3000,
              left: 688,
              top: 161,
            },
          ],
        },
      ],
    };
    const { api } = apiSequence([merchandise, detail]);
    const res = (await getGarmentDetails.handler(
      { provider: 'Printful', product_ref_id: '938' },
      fakeContext(api),
    )) as any;
    expect(res.variants[0]).toMatchObject({ provider_variant_id: 23889, cost: 13.2 });
    expect(res.print_templates[0]).toMatchObject({ placement: 'default', area_width: 1622 });
    expect(res.print_templates[0].recommended_image_size).toEqual({ width: 3000, height: 3000 });
  });
});

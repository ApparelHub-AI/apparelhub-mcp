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
    expect(calls[0]?.url).toContain('/agents/v1/merchandise');
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
    await expect(browseCatalog.handler({ provider: 'Printful' }, fakeContext(api))).rejects.toMatchObject(
      { code: 'not_found' },
    );
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

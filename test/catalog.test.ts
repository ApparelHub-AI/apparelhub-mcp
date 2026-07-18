import { describe, it, expect } from 'vitest';
import {
  browseCatalog,
  getGarmentDetails,
  recommendGarmentTool,
  listCatalogProviders,
} from '../src/tools/catalog.js';
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

  // #110: provider access is auth-gated per account, so the tool must accept ANY provider the
  // live /merchandise/providers list returns — never a hardcoded Printful/Printify enum.
  it('accepts any provider the account is entitled to (no hardcoded enum)', async () => {
    const merchandise = {
      providers: [
        { uuid: 'pf-uuid', name: 'Printful' },
        { uuid: 'py-uuid', name: 'Printify' },
        { uuid: 'ge-uuid', name: 'Gelato' },
      ],
    };
    const products = { products: [{ ref_id: 'abc', name: 'Phone Case', variant_count: 1 }] };
    const { api, calls } = apiSequence([merchandise, products]);
    const res = (await browseCatalog.handler({ provider: 'Gelato' }, fakeContext(api))) as any;
    expect(calls[0]?.url).toContain('/agents/v1/merchandise/providers');
    expect(calls[1]?.url).toContain('/merchandise/ge-uuid/products');
    expect(res.provider).toBe('Gelato');
    expect(res.garments[0]).toMatchObject({ provider_ref_id: 'abc', name: 'Phone Case' });
  });

  it("unknown provider error enumerates the account's actual available providers", async () => {
    const merchandise = {
      providers: [
        { uuid: 'pf-uuid', name: 'Printful' },
        { uuid: 'py-uuid', name: 'Printify' },
      ],
    };
    const { api } = apiSequence([merchandise]);
    await expect(
      browseCatalog.handler({ provider: 'Nope' }, fakeContext(api)),
    ).rejects.toMatchObject({
      code: 'not_found',
      message: expect.stringContaining('Printful, Printify'),
    });
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

  // #111 follow-up: Gelato's top-level template_details lists placements with NO dims;
  // the real dims live on variants[].templates. print_templates must carry those dims,
  // not an empty recommended_image_size.
  it('falls back to variant templates when the top-level list is dimensionless (Gelato)', async () => {
    const merchandise = { providers: [{ uuid: 'ge-uuid', name: 'Gelato' }] };
    const detail = {
      name: 'Iphone 16 Phone Case',
      provider_ref_id: 'cGhv',
      template_details: [
        { detail_type: 'Location', name: 'Default', provider_ref_id: 'default', value: 'default' },
      ],
      variants: [
        {
          color: 'White',
          color_code: '#ffffff',
          price: 10.4,
          provider_ref_id: 'phonecase_apple_iphone-16_tough_white_glossy',
          size: '',
          templates: [
            {
              provider_location_ref_id: 'default',
              area_width: 1000,
              area_height: 2000,
              template_width: 1150,
              template_height: 2300,
              left: 75,
              top: 0,
            },
          ],
        },
      ],
    };
    const { api } = apiSequence([merchandise, detail]);
    const res = (await getGarmentDetails.handler(
      { provider: 'Gelato', product_ref_id: 'cGhv' },
      fakeContext(api),
    )) as any;
    expect(res.print_templates[0]).toMatchObject({
      placement: 'default',
      area_width: 1000,
      area_height: 2000,
    });
    expect(res.print_templates[0].recommended_image_size).toEqual({ width: 1150, height: 2300 });
    expect(res.variants[0]).toMatchObject({ color: 'White', cost: 10.4 });
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

describe('list_catalog_providers', () => {
  it("returns the account's entitled providers (incl. gated ones like Gelato)", async () => {
    const merchandise = {
      providers: [
        { uuid: 'pf-uuid', name: 'Printful', active: true, user_auth_mode: 'oauth' },
        { uuid: 'py-uuid', name: 'Printify', active: true, user_auth_mode: 'pat' },
        { uuid: 'ge-uuid', name: 'Gelato', active: true, user_auth_mode: 'pat' },
      ],
    };
    const { api, calls } = apiSequence([merchandise]);
    const res = (await listCatalogProviders.handler({}, fakeContext(api))) as any;
    expect(calls[0]?.url).toContain('/agents/v1/merchandise/providers');
    expect(res.total).toBe(3);
    expect(res.providers.map((p: any) => p.name)).toEqual(['Printful', 'Printify', 'Gelato']);
    expect(res.providers[2]).toMatchObject({
      name: 'Gelato',
      uuid: 'ge-uuid',
      active: true,
      auth_mode: 'pat',
    });
  });
});

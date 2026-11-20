import { describe, it, expect } from 'vitest';
import { whereItsListed, listingTools, mapRow, mapStorefront } from '../src/tools/listings.js';
import { allTools } from '../src/tools/index.js';
import { fakeContext } from './helpers/ctx.js';
import { apiRecording } from './helpers/fakeFetch.js';

// Generic placeholders only (public repo): short ids, "Acme Apparel".

const MATRIX = {
  all_workspaces: true,
  workspaces: [{ uuid: 'w-1', name: 'Default', is_default: true }],
  storefronts: [
    {
      key: 'woocommerce:shop.example.com',
      provider: 'WooCommerce',
      shop_url: 'shop.example.com',
      shop_label: 'shop.example.com',
      admin_url: 'https://shop.example.com/wp-admin/admin.php?page=wc-admin',
      stores: [
        {
          uuid: 's-1',
          name: 'Acme Apparel',
          workspace_uuid: 'w-1',
          workspace_name: 'Default',
          integration_uuid: 'i-1',
          is_primary_for_shop: true,
          last_import_at: '2026-11-20T00:00:00',
        },
        {
          uuid: 's-2',
          name: 'Acme Outlet',
          workspace_uuid: 'w-1',
          workspace_name: 'Default',
          integration_uuid: 'i-2',
          is_primary_for_shop: false,
          last_import_at: null,
        },
      ],
      listed: 2,
    },
  ],
  rows: [
    {
      kind: 'product',
      uuid: 'p-1',
      name: 'Acme Tee',
      thumbnail_url: null,
      product_uuid: 'p-1',
      in_no_store: false,
      stores: [
        { uuid: 's-1', name: 'Acme Apparel', workspace_uuid: 'w-1', workspace_name: 'Default' },
      ],
      cells: {
        'woocommerce:shop.example.com': {
          status: 'listed',
          managed_by: 'apparelhub',
          store_uuid: 's-1',
          workspace_uuid: 'w-1',
          integration_uuid: 'i-1',
          error: null,
        },
      },
    },
    {
      kind: 'tracked',
      uuid: 'tracked:t-1',
      name: 'Their Mug',
      thumbnail_url: 'https://shop.example.com/mug.jpg',
      product_uuid: null,
      external_id: '900',
      stores: [
        { uuid: 's-1', name: 'Acme Apparel', workspace_uuid: 'w-1', workspace_name: 'Default' },
      ],
      listing: {
        uuid: 't-1',
        store_uuid: 's-1',
        workspace_uuid: 'w-1',
        integration_uuid: 'i-1',
        bound: false,
        binding: null,
      },
      cells: {
        'woocommerce:shop.example.com': {
          status: 'listed',
          managed_by: 'channel',
          store_uuid: 's-1',
          workspace_uuid: 'w-1',
          integration_uuid: 'i-1',
          error: null,
        },
      },
    },
  ],
  total_rows: 2,
  limit: 200,
  offset: 0,
  totals: {
    products: 2,
    storefronts: 1,
    listed_nowhere: 0,
    failed: 0,
    external: 1,
    per_storefront: { 'woocommerce:shop.example.com': 2 },
  },
};

describe('where_its_listed', () => {
  it('is registered', () => {
    expect(listingTools.map((t) => t.name)).toEqual(['where_its_listed']);
    expect(allTools().some((t) => t.name === 'where_its_listed')).toBe(true);
  });

  it('asks for every workspace by default and returns storefronts with their stores and admin link', async () => {
    const { api, calls } = apiRecording(MATRIX);
    const res = (await whereItsListed.handler({}, fakeContext(api))) as Record<string, any>;
    expect(calls[0].url).toContain('/store/listings/matrix?');
    expect(calls[0].url).toContain('all_workspaces=true');
    expect(calls[0].url).not.toContain('workspace=w');
    expect(res.all_workspaces).toBe(true);
    expect(res.storefronts).toHaveLength(1);
    const sf = res.storefronts[0];
    expect(sf.admin_url).toBe('https://shop.example.com/wp-admin/admin.php?page=wc-admin');
    expect(sf.stores.map((s: any) => s.store_uuid)).toEqual(['s-1', 's-2']);
    expect(sf.stores[0].is_primary_for_shop).toBe(true);
    expect(res.totals.external).toBe(1);
  });

  it('keeps who manages each cell apart, and carries what binding needs on a tracked row', async () => {
    const { api } = apiRecording(MATRIX);
    const res = (await whereItsListed.handler({}, fakeContext(api))) as Record<string, any>;
    const [tee, mug] = res.rows;
    expect(tee.kind).toBe('product');
    expect(tee.cells['woocommerce:shop.example.com'].managed_by).toBe('apparelhub');
    expect(mug.kind).toBe('tracked');
    expect(mug.cells['woocommerce:shop.example.com'].managed_by).toBe('channel');
    expect(mug.listing).toEqual({
      listing_uuid: 't-1',
      store_uuid: 's-1',
      workspace_uuid: 'w-1',
      bound: false,
      binding: null,
    });
    expect(mug.external_id).toBe('900');
  });

  it('scopes to one workspace and passes the filters through', async () => {
    const { api, calls } = apiRecording({ ...MATRIX, all_workspaces: false });
    await whereItsListed.handler(
      {
        all_workspaces: false,
        workspace: 'w-1',
        provider: 'WooCommerce',
        filter: 'failed',
        q: 'tee',
        limit: 50,
        offset: 10,
      },
      fakeContext(api),
    );
    const url = calls[0].url;
    expect(url).toContain('all_workspaces=false');
    expect(url).toContain('workspace=w-1');
    expect(url).toContain('provider=WooCommerce');
    expect(url).toContain('filter=failed');
    expect(url).toContain('q=tee');
    expect(url).toContain('limit=50');
    expect(url).toContain('offset=10');
  });

  it('mappers survive empty input', () => {
    expect(mapStorefront({}).stores).toEqual([]);
    expect(mapRow({}).cells).toEqual({});
  });
});

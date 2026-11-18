import { describe, it, expect } from 'vitest';
import { browseCatalog, getGarmentDetails, listCatalogProviders } from '../src/tools/catalog.js';
import { listMyStores, getOrderDetails, listMyOrders, listMyProducts } from '../src/tools/read.js';
import { rerouteOrder, confirmOrder } from '../src/tools/orders.js';
import { checkFulfillmentConnection } from '../src/tools/setup.js';
import { shipsToField } from '../src/util/shape.js';
import { fakeContext } from './helpers/ctx.js';
import { apiSequence, apiRecording } from './helpers/fakeFetch.js';

// Provider shipping regions, destination holds and the reroute action (US-only providers such
// as Toolbox POD). Generic placeholders only (public repo): o1/o2 orders, p1 provider,
// s1 store, pr1/pr2 products, v1/v2 variants.

const PROVIDERS = {
  providers: [
    { uuid: 'pf', name: 'Printful', ships_to: null },
    { uuid: 'tb', name: 'ToolboxPOD', ships_to: ['US'] },
  ],
};

describe('ships_to', () => {
  it('is emitted only for a real limit: null, absent and [] all mean worldwide', () => {
    expect(shipsToField({ ships_to: ['US'] })).toEqual({ ships_to: ['US'] });
    expect(shipsToField({ ships_to: null })).toEqual({});
    expect(shipsToField({ ships_to: [] })).toEqual({});
    expect(shipsToField({})).toEqual({});
  });

  it('resolves the public name "Toolbox POD" to the platform provider "ToolboxPOD"', async () => {
    const { api, calls } = apiSequence([PROVIDERS, { products: [{ ref_id: 'G64000', name: 'Softstyle Tee', ships_to: ['US'] }] }]);
    const res = (await browseCatalog.handler({ provider: 'Toolbox POD' }, fakeContext(api))) as any;
    expect(calls[1]?.url).toContain('/merchandise/tb/products');
    expect(res.garments[0].ships_to).toEqual(['US']);
  });

  it('carries ships_to on garment detail and the provider list', async () => {
    const { api } = apiSequence([PROVIDERS, { name: 'Softstyle Tee', ships_to: ['US'], variants: [] }]);
    const res = (await getGarmentDetails.handler(
      { provider: 'toolboxpod', product_ref_id: 'G64000' },
      fakeContext(api),
    )) as any;
    expect(res.garment.ships_to).toEqual(['US']);

    const { api: api2 } = apiSequence([PROVIDERS]);
    const list = (await listCatalogProviders.handler({}, fakeContext(api2))) as any;
    expect(list.providers.find((p: any) => p.name === 'ToolboxPOD').ships_to).toEqual(['US']);
    expect(list.providers.find((p: any) => p.name === 'Printful').ships_to).toBeUndefined();
  });

  it('carries ships_to on products, from the product or its provider', async () => {
    const { api } = apiRecording({
      products: [
        { uuid: 'pr1', name: 'Tee', ships_to: ['US'] },
        { uuid: 'pr2', name: 'Hoodie', provider: { name: 'ToolboxPOD', ships_to: ['US'] } },
        { uuid: 'pr3', name: 'Mug' },
      ],
    });
    const res = (await listMyProducts.handler({}, fakeContext(api))) as any;
    expect(res.products.map((p: any) => p.ships_to)).toEqual([['US'], ['US'], undefined]);
  });
});

describe('store shipping_warnings', () => {
  it('passes the warnings and provider ships_to through', async () => {
    const warning = {
      code: 'channel_ships_beyond_provider',
      severity: 'warning',
      provider_name: 'ToolboxPOD',
      provider_ships_to: ['US'],
      channel: 'Shopify',
      message: 'Your Shopify store ships to 34 countries. Toolbox POD products can only be fulfilled for US orders.',
    };
    const { api } = apiRecording({
      stores: [{ uuid: 's1', name: 'Acme Apparel', providers: [{ uuid: 'tb', name: 'ToolboxPOD', ships_to: ['US'] }], shipping_warnings: [warning] }],
    });
    const res = (await listMyStores.handler({}, fakeContext(api))) as any;
    expect(res.stores[0].shipping_warnings).toEqual([warning]);
    expect(res.stores[0].fulfillment_providers[0].ships_to).toEqual(['US']);
  });

  it('omits shipping_warnings when there are none', async () => {
    const { api } = apiRecording({ stores: [{ uuid: 's1', name: 'Acme Apparel', providers: [] }] });
    const res = (await listMyStores.handler({}, fakeContext(api))) as any;
    expect(res.stores[0].shipping_warnings).toBeUndefined();
  });
});

const HOLD = {
  code: 'destination_unsupported',
  country: 'CA',
  provider_name: 'ToolboxPOD',
  ships_to: ['US'],
  order_item_uuids: [],
  product_variant_ids: ['v1'],
  message: 'Toolbox POD only ships to US addresses, and this order is going to Canada.',
  suggested_reroute: { product_uuid: 'pr2', product_name: 'Tee', provider_uuid: 'pf', provider_name: 'Printful' },
};

describe('destination holds on orders', () => {
  it('get_order_details surfaces hold_details, hold_reason and the line variant id', async () => {
    const { api } = apiRecording({
      uuid: 'o1',
      status: 'pending',
      requires_approval: true,
      hold_reason: 'Toolbox POD only ships to US addresses.',
      hold_details: HOLD,
      items: [{ name: 'Tee', quantity: 1, product_variant_id: 'v1' }],
    });
    const res = (await getOrderDetails.handler({ order_uuid: 'o1' }, fakeContext(api))) as any;
    expect(res.order.hold_details).toEqual(HOLD);
    expect(res.order.hold_reason).toContain('US');
    expect(res.order.requires_approval).toBe(true);
    expect(res.order.items[0].product_variant_id).toBe('v1');
  });

  it('list_my_orders carries hold_details too, and nothing on an ordinary order', async () => {
    const { api } = apiRecording({ orders: [{ uuid: 'o1', hold_details: HOLD }, { uuid: 'o2' }] });
    const res = (await listMyOrders.handler({}, fakeContext(api))) as any;
    expect(res.orders[0].hold_details.code).toBe('destination_unsupported');
    expect(res.orders[1].hold_details).toBeUndefined();
    expect(res.orders[1].hold_reason).toBeUndefined();
  });

  it('a lifecycle action that lands on a held order reports the hold', async () => {
    const { api } = apiRecording({ order: { uuid: 'o1', status: 'pending', hold_details: HOLD } });
    const res = (await confirmOrder.handler({ order_uuid: 'o1' }, fakeContext(api))) as any;
    expect(res.hold_details.code).toBe('destination_unsupported');
  });
});

describe('reroute_order', () => {
  it('POSTs the product_uuid and reports the NEW order', async () => {
    const { api, calls } = apiRecording({ uuid: 'o2', status: 'draft', rerouted_from: 'o1' });
    const res = (await rerouteOrder.handler({ order_uuid: 'o1', product_uuid: 'pr2' }, fakeContext(api))) as any;
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.url).toContain('/orders/o1/reroute');
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({ product_uuid: 'pr2' });
    expect(res).toMatchObject({ held_order_uuid: 'o1', order_uuid: 'o2', status: 'draft', rerouted_to_product_uuid: 'pr2' });
  });

  it('is a write, never advertised as read-only', () => {
    expect(rerouteOrder.annotations?.readOnlyHint).not.toBe(true);
  });
});

describe('check_fulfillment_connection', () => {
  it('relays the itemised report and the fixes', async () => {
    const report = {
      provider: 'ToolboxPOD',
      healthy: false,
      reason: 'action_required',
      mode: 'live',
      checks: { token: { ok: true }, purchasing: { ok: false, limits: [] } },
      fixes: ['Turn on purchasing for ApparelHub in ToolboxPOD and set a spending limit.'],
    };
    const { api, calls } = apiRecording(report);
    const res = (await checkFulfillmentConnection.handler(
      { store_uuid: 's1', provider_uuid: 'tb' },
      fakeContext(api),
    )) as any;
    expect(calls[0]?.url).toContain('/store/s1/merchandise_provider/tb/connection/health');
    expect(res.checks.purchasing.ok).toBe(false);
    expect(res.guidance).toContain('spending limit');
  });

  it('never asks for a reconnect on an unknown (null) result', async () => {
    const { api } = apiRecording({ healthy: null, reason: 'provider_unreachable' });
    const res = (await checkFulfillmentConnection.handler(
      { store_uuid: 's1', provider_uuid: 'tb' },
      fakeContext(api),
    )) as any;
    expect(res.guidance).toContain('do not ask the user to reconnect');
  });
});

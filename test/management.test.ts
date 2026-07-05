import { describe, it, expect } from 'vitest';
import {
  getStoreSettings,
  updateStoreSettings,
  createStore,
  archiveStore,
  unarchiveStore,
  activateStore,
  recordOrderPayment,
  markOrderNoPayment,
  setOrderPaymentMethod,
  syncOrders,
  estimateOrderCosts,
  getOrdersSummary,
  listPendingFulfillments,
  archiveProduct,
  restoreProduct,
  managementTools,
} from '../src/tools/management.js';
import { ApiClient } from '../src/http/client.js';
import { fakeContext } from './helpers/ctx.js';
import { jsonResponse, queueFetch, noSleep } from './helpers/fakeFetch.js';

// Generic placeholders only (public repo — Rule 13): short ids s1/o1/p1, "Acme Co" name,
// no real account data / hostnames / UUIDs.

function apiReturning(raw: unknown) {
  const { fetchImpl, calls } = queueFetch([jsonResponse(200, raw)]);
  const api = new ApiClient({
    apiKey: 'k',
    baseUrl: 'https://api.example.test/agents/v1',
    userAgent: 't',
    fetchImpl,
    sleepImpl: noSleep,
  });
  return { api, calls };
}

// ---------------------------------------------------------------------------
// Store settings
// ---------------------------------------------------------------------------

describe('get_store_settings', () => {
  it('GETs store/<id>/settings and projects the workflow fields', async () => {
    const { api, calls } = apiReturning({
      store_uuid: 's1',
      store_name: 'Acme Co',
      fulfillment_mode: 'review',
      approval_authority: 'human',
      auto_reconcile_orders: false,
      hold_orders_above_amount: 250,
    });
    const res = (await getStoreSettings.handler({ store_uuid: 's1' }, fakeContext(api))) as any;

    expect(calls[0]!.init!.method).toBe('GET');
    expect(calls[0]!.url).toContain('/store/s1/settings');
    expect(res.settings).toMatchObject({
      store_uuid: 's1',
      store_name: 'Acme Co',
      fulfillment_mode: 'review',
      auto_reconcile_orders: false,
      hold_orders_above_amount: 250,
    });
  });

  it('carries ?workspace= when provided', async () => {
    const { api, calls } = apiReturning({ store_uuid: 's1' });
    await getStoreSettings.handler({ store_uuid: 's1', workspace: 'w1' }, fakeContext(api));
    expect(calls[0]!.url).toContain('workspace=w1');
  });

  it('advertises read-only', () => {
    expect(getStoreSettings.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
  });
});

describe('update_store_settings', () => {
  it('PATCHes only the fields provided and reports which changed', async () => {
    const { api, calls } = apiReturning({
      store_uuid: 's1',
      fulfillment_mode: 'auto',
      hold_orders_above_amount: null,
    });
    const res = (await updateStoreSettings.handler(
      { store_uuid: 's1', fulfillment_mode: 'auto', hold_orders_above_amount: null },
      fakeContext(api),
    )) as any;

    const call = calls[0]!;
    expect(call.init!.method).toBe('PATCH');
    expect(call.url).toContain('/store/s1/settings');
    const body = JSON.parse(call.init!.body as string);
    // Only the two provided keys; store_uuid/workspace are NOT in the body.
    expect(body).toEqual({ fulfillment_mode: 'auto', hold_orders_above_amount: null });
    expect(res.updated.sort()).toEqual(['fulfillment_mode', 'hold_orders_above_amount']);
    expect(res.view_url).toBe('https://apparelhub.ai/stores/s1');
  });

  it('sends no settings keys when only store_uuid is given', async () => {
    const { api, calls } = apiReturning({ store_uuid: 's1' });
    await updateStoreSettings.handler({ store_uuid: 's1' }, fakeContext(api));
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Store lifecycle
// ---------------------------------------------------------------------------

describe('create_store', () => {
  it('POSTs to store with the name (and optional fields) in the body', async () => {
    const { api, calls } = apiReturning({ uuid: 's1', name: 'Acme Co', status: 'closed' });
    const res = (await createStore.handler(
      { name: 'Acme Co', description: 'desc', workspace: 'w1' },
      fakeContext(api),
    )) as any;

    const call = calls[0]!;
    expect(call.init!.method).toBe('POST');
    expect(call.url).toContain('/agents/v1/store');
    expect(call.url).toContain('workspace=w1');
    expect(JSON.parse(call.init!.body as string)).toEqual({ name: 'Acme Co', description: 'desc' });
    expect(res).toMatchObject({
      created: true,
      store: { store_uuid: 's1', name: 'Acme Co', view_url: 'https://apparelhub.ai/stores/s1' },
    });
  });
});

describe('archive_store', () => {
  it('POSTs archive with disconnect_provider when requested', async () => {
    const { api, calls } = apiReturning({ uuid: 's1', status: 'archived', disconnected_providers: ['Printful'] });
    const res = (await archiveStore.handler(
      { store_uuid: 's1', disconnect_provider: true },
      fakeContext(api),
    )) as any;
    expect(calls[0]!.init!.method).toBe('POST');
    expect(calls[0]!.url).toContain('/store/s1/archive');
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ disconnect_provider: true });
    expect(res.archived).toBe(true);
    expect(res.store.disconnected_providers).toEqual(['Printful']);
  });

  it('defaults to an empty body when disconnect_provider is not set', async () => {
    const { api, calls } = apiReturning({ uuid: 's1', status: 'archived' });
    await archiveStore.handler({ store_uuid: 's1' }, fakeContext(api));
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({});
  });
});

describe('unarchive_store', () => {
  it('POSTs to store/<id>/unarchive', async () => {
    const { api, calls } = apiReturning({ uuid: 's1', status: 'closed' });
    const res = (await unarchiveStore.handler({ store_uuid: 's1' }, fakeContext(api))) as any;
    expect(calls[0]!.init!.method).toBe('POST');
    expect(calls[0]!.url).toContain('/store/s1/unarchive');
    expect(res.unarchived).toBe(true);
  });
});

describe('activate_store', () => {
  it('POSTs to store/<id>/activate', async () => {
    const { api, calls } = apiReturning({ uuid: 's1', status: 'active' });
    const res = (await activateStore.handler({ store_uuid: 's1' }, fakeContext(api))) as any;
    expect(calls[0]!.init!.method).toBe('POST');
    expect(calls[0]!.url).toContain('/store/s1/activate');
    expect(res).toMatchObject({ activated: true, store: { status: 'active' } });
  });
});

// ---------------------------------------------------------------------------
// Order payment
// ---------------------------------------------------------------------------

describe('record_order_payment', () => {
  it('POSTs record-payment with the payment_method', async () => {
    const { api, calls } = apiReturning({
      success: true,
      payment_status: 'paid',
      order: { payment_method: 'sales_channel' },
    });
    const res = (await recordOrderPayment.handler(
      { order_uuid: 'o1', payment_method: 'sales_channel', amount: 25 },
      fakeContext(api),
    )) as any;

    const call = calls[0]!;
    expect(call.init!.method).toBe('POST');
    expect(call.url).toContain('/orders/o1/record-payment');
    expect(JSON.parse(call.init!.body as string)).toEqual({ payment_method: 'sales_channel', amount: 25 });
    expect(res).toMatchObject({
      order_uuid: 'o1',
      payment_status: 'paid',
      payment_method: 'sales_channel',
      payment_recorded: true,
      view_url: 'https://apparelhub.ai/orders/o1',
    });
  });

  it('omits amount from the body when not given', async () => {
    const { api, calls } = apiReturning({ payment_status: 'paid' });
    await recordOrderPayment.handler(
      { order_uuid: 'o1', payment_method: 'stripe' },
      fakeContext(api),
    );
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ payment_method: 'stripe' });
  });
});

describe('mark_order_no_payment', () => {
  it('POSTs mark-no-payment', async () => {
    const { api, calls } = apiReturning({ success: true, payment_status: 'no_payment' });
    const res = (await markOrderNoPayment.handler({ order_uuid: 'o1' }, fakeContext(api))) as any;
    expect(calls[0]!.init!.method).toBe('POST');
    expect(calls[0]!.url).toContain('/orders/o1/mark-no-payment');
    expect(res).toMatchObject({ no_payment: true, payment_status: 'no_payment' });
  });
});

describe('set_order_payment_method', () => {
  it('PATCHes payment-method with the new method', async () => {
    const { api, calls } = apiReturning({ success: true, payment_method: 'sales_channel' });
    const res = (await setOrderPaymentMethod.handler(
      { order_uuid: 'o1', payment_method: 'sales_channel' },
      fakeContext(api),
    )) as any;
    const call = calls[0]!;
    expect(call.init!.method).toBe('PATCH');
    expect(call.url).toContain('/orders/o1/payment-method');
    expect(JSON.parse(call.init!.body as string)).toEqual({ payment_method: 'sales_channel' });
    expect(res).toMatchObject({ payment_method: 'sales_channel', payment_method_updated: true });
  });
});

// ---------------------------------------------------------------------------
// Order ops
// ---------------------------------------------------------------------------

describe('sync_orders', () => {
  it('POSTs orders/sync scoped to a store', async () => {
    const { api, calls } = apiReturning({ message: 'Sync complete.', synced_count: 3, errors: [] });
    const res = (await syncOrders.handler({ store_uuid: 's1' }, fakeContext(api))) as any;
    expect(calls[0]!.init!.method).toBe('POST');
    expect(calls[0]!.url).toContain('/orders/sync');
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ store_uuid: 's1' });
    expect(res).toMatchObject({ synced_count: 3, errors: [] });
  });

  it('sends an empty body (all stores) when no store_uuid', async () => {
    const { api, calls } = apiReturning({ synced_count: 0, errors: [] });
    await syncOrders.handler({}, fakeContext(api));
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({});
  });
});

describe('estimate_order_costs', () => {
  it('POSTs the store, recipient and items and projects the cost breakdown', async () => {
    const { api, calls } = apiReturning({
      currency: 'USD',
      subtotal: 11.69,
      shipping: 5.99,
      tax: 1.18,
      total: 18.86,
      provider_name: 'Printful',
    });
    const res = (await estimateOrderCosts.handler(
      {
        store_uuid: 's1',
        recipient: { country_code: 'US', state_code: 'CA' },
        items: [{ variant_uuid: 'v1', quantity: 1 }],
      },
      fakeContext(api),
    )) as any;

    const call = calls[0]!;
    expect(call.init!.method).toBe('POST');
    expect(call.url).toContain('/orders/estimate-costs');
    const body = JSON.parse(call.init!.body as string);
    expect(body.store_uuid).toBe('s1');
    expect(body.recipient).toEqual({ country_code: 'US', state_code: 'CA' });
    expect(body.items).toEqual([{ variant_uuid: 'v1', quantity: 1 }]);
    expect(res).toMatchObject({ total: 18.86, shipping: 5.99, provider_name: 'Printful' });
  });

  it('advertises read-only', () => {
    expect(estimateOrderCosts.annotations).toMatchObject({ readOnlyHint: true });
  });
});

describe('get_orders_summary', () => {
  it('GETs orders/dashboard/summary and returns the counts', async () => {
    const { api, calls } = apiReturning({
      pending_approval: 2,
      awaiting_payment: 1,
      in_fulfillment: 3,
      shipped_today: 0,
      total_revenue_today: 55.5,
      total_profit_today: 12.3,
      orders_by_store: [],
      orders_by_status: { pending: 2 },
    });
    const res = (await getOrdersSummary.handler({}, fakeContext(api))) as any;
    expect(calls[0]!.init!.method).toBe('GET');
    expect(calls[0]!.url).toContain('/orders/dashboard/summary');
    expect(res).toMatchObject({
      pending_approval: 2,
      in_fulfillment: 3,
      total_revenue_today: 55.5,
      orders_by_status: { pending: 2 },
    });
  });
});

describe('list_pending_fulfillments', () => {
  it('GETs pending-fulfillments/<store> and projects each row', async () => {
    const { api, calls } = apiReturning({
      pending: [
        { order_uuid: 'o1', order_display_id: '1776', fulfillment_status: 'pending', total_price: 27.99 },
      ],
      total: 1,
    });
    const res = (await listPendingFulfillments.handler({ store_uuid: 's1' }, fakeContext(api))) as any;
    expect(calls[0]!.init!.method).toBe('GET');
    expect(calls[0]!.url).toContain('/orders/pending-fulfillments/s1');
    expect(res.total).toBe(1);
    expect(res.pending[0]).toMatchObject({
      order_uuid: 'o1',
      order_display_id: '1776',
      view_url: 'https://apparelhub.ai/orders/o1',
    });
  });
});

// ---------------------------------------------------------------------------
// Product archive
// ---------------------------------------------------------------------------

describe('archive_product', () => {
  it('POSTs product/<id>/archive and surfaces channel_failures', async () => {
    const { api, calls } = apiReturning({
      message: 'Product archived successfully',
      channel_failures: [{ integration_uuid: 'i1', reason: 'auth_failed' }],
    });
    const res = (await archiveProduct.handler({ product_uuid: 'p1' }, fakeContext(api))) as any;
    expect(calls[0]!.init!.method).toBe('POST');
    expect(calls[0]!.url).toContain('/product/p1/archive');
    expect(res).toMatchObject({
      product_uuid: 'p1',
      archived: true,
      view_url: 'https://apparelhub.ai/merchandise/my-products/p1',
    });
    expect(res.channel_failures).toEqual([{ integration_uuid: 'i1', reason: 'auth_failed' }]);
  });

  it('omits channel_failures when the archive was clean', async () => {
    const { api } = apiReturning({ message: 'Product archived successfully', channel_failures: [] });
    const res = (await archiveProduct.handler({ product_uuid: 'p1' }, fakeContext(api))) as any;
    expect(res).not.toHaveProperty('channel_failures');
  });
});

describe('restore_product', () => {
  it('POSTs product/<id>/restore', async () => {
    const { api, calls } = apiReturning({ message: 'Product restored successfully' });
    const res = (await restoreProduct.handler({ product_uuid: 'p1' }, fakeContext(api))) as any;
    expect(calls[0]!.init!.method).toBe('POST');
    expect(calls[0]!.url).toContain('/product/p1/restore');
    expect(res).toMatchObject({ product_uuid: 'p1', restored: true });
  });
});

// ---------------------------------------------------------------------------
// Group export
// ---------------------------------------------------------------------------

describe('managementTools', () => {
  it('exports all 15 tools with unique names', () => {
    expect(managementTools).toHaveLength(15);
    const names = managementTools.map((t) => t.name);
    expect(new Set(names).size).toBe(15);
  });

  it('read tools carry readOnlyHint; write tools do not', () => {
    const readOnly = new Set(['get_store_settings', 'estimate_order_costs', 'get_orders_summary', 'list_pending_fulfillments']);
    for (const t of managementTools) {
      if (readOnly.has(t.name)) {
        expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      } else {
        expect(t.annotations?.readOnlyHint, t.name).not.toBe(true);
      }
      expect(t.annotations?.openWorldHint, t.name).toBe(true);
    }
  });
});

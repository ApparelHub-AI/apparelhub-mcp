import { describe, it, expect } from 'vitest';
import {
  approveOrder,
  unapproveOrder,
  holdOrder,
  cancelOrder,
  confirmOrder,
  submitOrderToFulfillment,
  checkOrderStatus,
  reconcileOrder,
  listOrderHolds,
  approveOrderHold,
  requestHoldChanges,
} from '../src/tools/orders.js';
import { ApiClient } from '../src/http/client.js';
import { fakeContext } from './helpers/ctx.js';
import { jsonResponse, queueFetch, noSleep, type RecordedCall } from './helpers/fakeFetch.js';

// Generic placeholders only (public repo — Rule 13): short ids o1/h1/s1/i1, no real account data.

function apiFrom(bodies: unknown[]): { api: ApiClient; calls: RecordedCall[] } {
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

/** An ApiClient that returns a body with a non-200 (but 2xx) status, e.g. a 202 deferred hold. */
function apiStatus(status: number, body: unknown): { api: ApiClient; calls: RecordedCall[] } {
  const { fetchImpl, calls } = queueFetch([jsonResponse(status, body)]);
  const api = new ApiClient({
    apiKey: 'k',
    baseUrl: 'https://api.example.test/agents/v1',
    userAgent: 't',
    fetchImpl,
    sleepImpl: noSleep,
  });
  return { api, calls };
}

describe('approve_order', () => {
  it('POSTs to the approve route and projects the fulfillment status + view_url', async () => {
    const { api, calls } = apiFrom([{ status: 'approved', auto_submitted: true }]);
    const res = (await approveOrder.handler({ order_uuid: 'o1' }, fakeContext(api))) as any;
    expect(res).toMatchObject({
      order_uuid: 'o1',
      view_url: 'https://apparelhub.ai/orders/o1',
      status: 'approved',
      auto_submitted: true,
    });
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.url).toContain('/orders/o1/approve');
  });

  it('passes workspace= through to the request', async () => {
    const { api, calls } = apiFrom([{}]);
    await approveOrder.handler({ order_uuid: 'o1', workspace: 'w1' }, fakeContext(api));
    expect(calls[0]?.url).toContain('workspace=w1');
  });
});

describe('unapprove_order', () => {
  it('POSTs to the unapprove route', async () => {
    const { api, calls } = apiFrom([{ success: true, status: 'pending' }]);
    const res = (await unapproveOrder.handler({ order_uuid: 'o1' }, fakeContext(api))) as any;
    expect(res.status).toBe('pending');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.url).toContain('/orders/o1/unapprove');
  });
});

describe('hold_order', () => {
  it('sends the reason in the request body when provided', async () => {
    const { api, calls } = apiFrom([{ status: 'on_hold' }]);
    const res = (await holdOrder.handler(
      { order_uuid: 'o1', reason: 'checking the address' },
      fakeContext(api),
    )) as any;
    expect(res.order_uuid).toBe('o1');
    expect(calls[0]?.url).toContain('/orders/o1/hold');
    const body = JSON.parse(calls[0]?.init?.body as string);
    expect(body).toEqual({ reason: 'checking the address' });
  });

  it('sends an empty body when no reason is given (server defaults it)', async () => {
    const { api, calls } = apiFrom([{}]);
    await holdOrder.handler({ order_uuid: 'o1' }, fakeContext(api));
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({});
  });
});

describe('cancel_order', () => {
  it('is marked destructive and POSTs to the cancel route', async () => {
    expect(cancelOrder.annotations?.destructiveHint).toBe(true);
    const { api, calls } = apiFrom([{ status: 'cancelled' }]);
    const res = (await cancelOrder.handler({ order_uuid: 'o1' }, fakeContext(api))) as any;
    expect(res.status).toBe('cancelled');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.url).toContain('/orders/o1/cancel');
  });
});

describe('confirm_order', () => {
  it('POSTs to confirm and relays the provider_response', async () => {
    const { api, calls } = apiFrom([
      { message: 'Order confirmed successfully', provider_response: { ok: true } },
    ]);
    const res = (await confirmOrder.handler({ order_uuid: 'o1' }, fakeContext(api))) as any;
    expect(res.message).toBe('Order confirmed successfully');
    expect(res.provider_response).toEqual({ ok: true });
    expect(calls[0]?.url).toContain('/orders/o1/confirm');
  });
});

describe('submit_order_to_fulfillment', () => {
  it('POSTs to submit-fulfillment and surfaces the provider external id', async () => {
    const { api, calls } = apiFrom([
      { success: true, auto_submitted: true, fulfillment: { external_id: '164539194' } },
    ]);
    const res = (await submitOrderToFulfillment.handler(
      { order_uuid: 'o1' },
      fakeContext(api),
    )) as any;
    expect(res.auto_submitted).toBe(true);
    expect(res.provider_external_id).toBe('164539194');
    expect(calls[0]?.url).toContain('/orders/o1/submit-fulfillment');
  });
});

describe('check_order_status', () => {
  it('POSTs to check-status and projects the substatus', async () => {
    const { api, calls } = apiFrom([
      { status: 'in_production', fulfillment_substatus: 'design_approval_pending' },
    ]);
    const res = (await checkOrderStatus.handler({ order_uuid: 'o1' }, fakeContext(api))) as any;
    expect(res).toMatchObject({
      status: 'in_production',
      fulfillment_substatus: 'design_approval_pending',
    });
    expect(calls[0]?.url).toContain('/orders/o1/check-status');
    expect(checkOrderStatus.annotations?.idempotentHint).toBe(true);
  });
});

describe('reconcile_order', () => {
  it('projects the structured reconcile result', async () => {
    const { api, calls } = apiFrom([
      {
        reconcilable: true,
        reason: null,
        provider: 'WooCommerce',
        applied_count: 1,
        changes: [{ field: 'tracking', direction: 'push', applied: true }],
        errors: [],
      },
    ]);
    const res = (await reconcileOrder.handler({ order_uuid: 'o1' }, fakeContext(api))) as any;
    expect(res).toMatchObject({
      order_uuid: 'o1',
      reconcilable: true,
      provider: 'WooCommerce',
      applied_count: 1,
    });
    expect(res.changes).toHaveLength(1);
    expect(res.errors).toEqual([]);
    expect(calls[0]?.url).toContain('/orders/o1/reconcile');
  });

  it('relays reconcilable=false for a native (non-channel) order', async () => {
    const { api } = apiFrom([{ reconcilable: false, reason: 'not_a_sales_channel_order' }]);
    const res = (await reconcileOrder.handler({ order_uuid: 'o1' }, fakeContext(api))) as any;
    expect(res.reconcilable).toBe(false);
    expect(res.reason).toBe('not_a_sales_channel_order');
    expect(res.applied_count).toBe(0);
  });
});

describe('list_order_holds', () => {
  it('is read-only and maps holds + supports_workflow', async () => {
    expect(listOrderHolds.annotations?.readOnlyHint).toBe(true);
    const { api, calls } = apiFrom([
      {
        supports_workflow: true,
        fulfillment_substatus: 'design_approval_pending',
        holds: [
          {
            uuid: 'h1',
            kind: 'design_approval',
            state: 'active',
            reason_text: 'Approve the artwork',
          },
        ],
      },
    ]);
    const res = (await listOrderHolds.handler({ order_uuid: 'o1' }, fakeContext(api))) as any;
    expect(res.supports_workflow).toBe(true);
    expect(res.total).toBe(1);
    expect(res.holds[0]).toMatchObject({ hold_uuid: 'h1', kind: 'design_approval', state: 'active' });
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.url).toContain('/orders/o1/holds');
    expect(calls[0]?.url).not.toContain('refresh=');
  });

  it('adds refresh=true to the query when requested', async () => {
    const { api, calls } = apiFrom([{ holds: [] }]);
    await listOrderHolds.handler({ order_uuid: 'o1', refresh: true }, fakeContext(api));
    expect(calls[0]?.url).toContain('refresh=true');
  });
});

describe('approve_order_hold', () => {
  it('builds the /holds/{hold_uuid}/approve path and reports success', async () => {
    const { api, calls } = apiFrom([{ success: true, hold_uuid: 'h1' }]);
    const res = (await approveOrderHold.handler(
      { order_uuid: 'o1', hold_uuid: 'h1' },
      fakeContext(api),
    )) as any;
    expect(res).toMatchObject({ order_uuid: 'o1', hold_uuid: 'h1', approved: true });
    expect(res).not.toHaveProperty('deferred');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.url).toContain('/orders/o1/holds/h1/approve');
  });

  it('surfaces the deferred envelope (202 + dashboard_url) without faking success', async () => {
    const { api } = apiStatus(202, {
      deferred: true,
      dashboard_url: 'https://provider.example/approve',
      message: 'Open the provider dashboard to approve.',
      hold_uuid: 'h1',
    });
    const res = (await approveOrderHold.handler(
      { order_uuid: 'o1', hold_uuid: 'h1' },
      fakeContext(api),
    )) as any;
    expect(res.deferred).toBe(true);
    expect(res.dashboard_url).toBe('https://provider.example/approve');
    expect(res).not.toHaveProperty('approved');
  });
});

describe('request_hold_changes', () => {
  it('sends change_kind + notes in the body and builds the request-changes path', async () => {
    const { api, calls } = apiFrom([{ success: true, hold_uuid: 'h1', change_kind: 'minor' }]);
    const res = (await requestHoldChanges.handler(
      { order_uuid: 'o1', hold_uuid: 'h1', change_kind: 'minor', notes: 'nudge the logo up' },
      fakeContext(api),
    )) as any;
    expect(res).toMatchObject({ order_uuid: 'o1', hold_uuid: 'h1', change_kind: 'minor', changes_requested: true });
    expect(calls[0]?.url).toContain('/orders/o1/holds/h1/request-changes');
    const body = JSON.parse(calls[0]?.init?.body as string);
    expect(body).toEqual({ change_kind: 'minor', notes: 'nudge the logo up' });
  });

  it('surfaces the deferred envelope for request-changes', async () => {
    const { api } = apiStatus(202, {
      deferred: true,
      dashboard_url: 'https://provider.example/changes',
      hold_uuid: 'h1',
      change_kind: 'full_replacement',
    });
    const res = (await requestHoldChanges.handler(
      { order_uuid: 'o1', hold_uuid: 'h1', change_kind: 'full_replacement' },
      fakeContext(api),
    )) as any;
    expect(res.deferred).toBe(true);
    expect(res.change_kind).toBe('full_replacement');
    expect(res).not.toHaveProperty('changes_requested');
  });

  it('rejects change_kind outside the allowed enum via the input schema', () => {
    const parsed = requestHoldChanges.inputSchema.safeParse({
      order_uuid: 'o1',
      hold_uuid: 'h1',
      change_kind: 'bogus',
    });
    expect(parsed.success).toBe(false);
  });
});

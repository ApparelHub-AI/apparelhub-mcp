import { z } from 'zod';
import { defineTool, type ToolDef } from './registry.js';
import { asArray, isRecord, num, str, total, viewUrl } from '../util/shape.js';

// Order lifecycle + design-approval holds (capability-gap tools). Thin, clean projections over
// the /agents/v1/orders/{uuid}/... endpoints. Each tool takes an order_uuid (from list_my_orders)
// plus an optional workspace uuid for agency accounts.
//
// Contract notes (validated against api/orders.py):
//   - All routes are POST except list_order_holds (GET).
//   - hold_order takes an optional {reason}; the server defaults it to "Manual hold".
//   - request_hold_changes takes {change_kind: 'minor'|'full_replacement', notes} — NOT a free
//     {message}. notes are REQUIRED when change_kind='minor' (the server rejects otherwise).
//   - approve_order_hold + request_hold_changes may return a DEFERRED envelope (HTTP 202) with a
//     dashboard_url when the provider's public API can't flip the hold itself (Printful today).
//     The HTTP client treats any 2xx as success, so we surface {deferred, dashboard_url} rather
//     than pretend a success. The hold stays active until the provider's release webhook fires.
//   - reconcile_order returns a structured result (never raises for the not-reconcilable /
//     locked / integration-missing cases); we relay reconcilable/reason/changes/applied_count.
//
// Mappers are deliberately tolerant of field-name variants so a minor live-API shape difference
// degrades to a missing field rather than a crash.

const enc = encodeURIComponent;

const orderInput = z.object({
  order_uuid: z.string().min(1).describe('The order uuid (from list_my_orders / get_order_details).'),
  workspace: z.string().optional().describe('Workspace uuid to scope to (agency accounts). Omit for Default.'),
});

const holdInput = z.object({
  order_uuid: z.string().min(1).describe('The order uuid the hold belongs to.'),
  hold_uuid: z.string().min(1).describe('The hold uuid (from list_order_holds).'),
  workspace: z.string().optional().describe('Workspace uuid (agency accounts).'),
});

/** Read the fulfillment fields most callers care about from any order-shaped result. */
function fulfillmentSummary(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const status = str(raw, 'status', 'fulfillment_status');
  if (status !== undefined) out.status = status;
  const fulfillment = str(raw, 'fulfillment_status');
  if (fulfillment !== undefined) out.fulfillment_status = fulfillment;
  const substatus = str(raw, 'fulfillment_substatus');
  if (substatus !== undefined) out.fulfillment_substatus = substatus;
  const payment = str(raw, 'payment_status');
  if (payment !== undefined) out.payment_status = payment;
  const externalId = str(raw, 'provider_external_id', 'external_id');
  if (externalId !== undefined) out.provider_external_id = externalId;
  const message = str(raw, 'message');
  if (message !== undefined) out.message = message;
  return out;
}

/** Unwrap a `{order: {...}}` envelope if present. */
function orderPayload(raw: unknown): unknown {
  return isRecord(raw) && isRecord(raw.order) ? raw.order : raw;
}

/** Build the standard {order_uuid, view_url, ...fulfillment} projection for a lifecycle action. */
function actionResult(orderUuid: string, raw: unknown): Record<string, unknown> {
  return {
    order_uuid: orderUuid,
    view_url: viewUrl.order(orderUuid),
    ...fulfillmentSummary(orderPayload(raw)),
  };
}

function mapHold(raw: unknown): Record<string, unknown> {
  return {
    hold_uuid: str(raw, 'uuid', 'hold_uuid'),
    kind: str(raw, 'kind'),
    state: str(raw, 'state'),
    reason_code: str(raw, 'reason_code'),
    reason_text: str(raw, 'reason_text'),
    provider_hold_id: str(raw, 'provider_hold_id'),
    submitted_design_url: str(raw, 'submitted_design_url'),
    recommended_design_url: str(raw, 'recommended_design_url'),
    approval_sheet_url: str(raw, 'approval_sheet_url'),
    created: str(raw, 'created', 'created_at'),
    released_at: str(raw, 'released_at'),
  };
}

// ---------------------------------------------------------------------------
// Approval / lifecycle
// ---------------------------------------------------------------------------

export const approveOrder = defineTool({
  name: 'approve_order',
  description:
    'Approve an order that is awaiting approval, releasing it for fulfillment. For sales-channel (webhook) orders this also auto-submits the order to the fulfillment provider (Printful/Printify). Use when an order is held for review and the user wants to let it proceed.',
  inputSchema: orderInput,
  annotations: { idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.post(`orders/${enc(input.order_uuid)}/approve`, {
      workspace: input.workspace,
      signal: ctx.signal,
    });
    const out = actionResult(input.order_uuid, raw);
    if (isRecord(raw) && raw.auto_submitted !== undefined) out.auto_submitted = raw.auto_submitted;
    return out;
  },
});

export const unapproveOrder = defineTool({
  name: 'unapprove_order',
  description:
    'Revert an approved order back to pending so it can be reviewed / re-approved. Only works if the order has NOT yet been submitted to the fulfillment provider. Use to undo an approve_order that was done too early.',
  inputSchema: orderInput,
  annotations: { idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.post(`orders/${enc(input.order_uuid)}/unapprove`, {
      workspace: input.workspace,
      signal: ctx.signal,
    });
    return actionResult(input.order_uuid, raw);
  },
});

export const holdOrder = defineTool({
  name: 'hold_order',
  description:
    'Put an order on hold with an optional reason, pausing it before it is submitted to fulfillment. Use when the user wants to stop an order from proceeding (e.g. to double-check the design or address). Release it later with approve_order.',
  inputSchema: z.object({
    order_uuid: z.string().min(1).describe('The order uuid to hold.'),
    reason: z.string().optional().describe('Why the order is being held (defaults to "Manual hold").'),
    workspace: z.string().optional().describe('Workspace uuid (agency accounts).'),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.post(`orders/${enc(input.order_uuid)}/hold`, {
      body: input.reason !== undefined ? { reason: input.reason } : {},
      workspace: input.workspace,
      signal: ctx.signal,
    });
    return actionResult(input.order_uuid, raw);
  },
});

export const cancelOrder = defineTool({
  name: 'cancel_order',
  description:
    'Cancel an order. Cancels it locally and, where possible, cancels the draft/order at the fulfillment provider (Printful/Printify). This does NOT refund the customer on the sales channel — the channel is the source of payment. Destructive: only cancel when the user explicitly asks.',
  inputSchema: orderInput,
  annotations: { destructiveHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.post(`orders/${enc(input.order_uuid)}/cancel`, {
      workspace: input.workspace,
      signal: ctx.signal,
    });
    return actionResult(input.order_uuid, raw);
  },
});

export const confirmOrder = defineTool({
  name: 'confirm_order',
  description:
    'Confirm a DRAFT order to send it into production at the fulfillment provider. Only works for orders in "draft" status that have already been submitted to a provider (have a provider order id). Use after submit_order_to_fulfillment on a "prepare, then I confirm" store.',
  inputSchema: orderInput,
  annotations: { idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.post(`orders/${enc(input.order_uuid)}/confirm`, {
      workspace: input.workspace,
      signal: ctx.signal,
    });
    const out = actionResult(input.order_uuid, raw);
    if (isRecord(raw) && raw.provider_response !== undefined) out.provider_response = raw.provider_response;
    return out;
  },
});

export const submitOrderToFulfillment = defineTool({
  name: 'submit_order_to_fulfillment',
  description:
    'Manually submit an order to its fulfillment provider (Printful/Printify) as a DRAFT. For sales-channel orders this auto-fetches the recipient from the channel. Use to un-stick a paid order that never got submitted; confirm it afterward with confirm_order if the store requires confirmation.',
  inputSchema: orderInput,
  annotations: { idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.post(`orders/${enc(input.order_uuid)}/submit-fulfillment`, {
      workspace: input.workspace,
      signal: ctx.signal,
    });
    const out = actionResult(input.order_uuid, raw);
    const payload = orderPayload(raw);
    const fulfillment = isRecord(raw) ? raw.fulfillment : undefined;
    if (isRecord(raw) && raw.auto_submitted !== undefined) out.auto_submitted = raw.auto_submitted;
    const externalId =
      str(fulfillment, 'external_id') ?? str(payload, 'external_id', 'provider_external_id');
    if (externalId !== undefined) out.provider_external_id = externalId;
    return out;
  },
});

export const checkOrderStatus = defineTool({
  name: 'check_order_status',
  description:
    'Poll the fulfillment provider for the latest status of an order and update it locally (including any design-approval holds). Read-mostly refresh — safe to call repeatedly. Use to see whether an order has shipped or is on hold at the provider.',
  inputSchema: orderInput,
  annotations: { idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.post(`orders/${enc(input.order_uuid)}/check-status`, {
      workspace: input.workspace,
      signal: ctx.signal,
    });
    return actionResult(input.order_uuid, raw);
  },
});

export const reconcileOrder = defineTool({
  name: 'reconcile_order',
  description:
    'Reconcile a sales-channel order with the channel it came from: pull payment / cancellation FROM the channel and push fulfillment status + tracking TO it. Only sales-channel orders can be reconciled (native orders return reconcilable=false). Use to re-sync an order that drifted (e.g. tracking not relayed to the storefront).',
  inputSchema: orderInput,
  annotations: { idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.post(`orders/${enc(input.order_uuid)}/reconcile`, {
      workspace: input.workspace,
      signal: ctx.signal,
    });
    const out: Record<string, unknown> = {
      order_uuid: input.order_uuid,
      view_url: viewUrl.order(input.order_uuid),
      reconcilable: (isRecord(raw) ? raw.reconcilable : undefined) ?? true,
      reason: str(raw, 'reason') ?? null,
      provider: str(raw, 'provider'),
      applied_count: num(raw, 'applied_count') ?? 0,
      changes: asArray(isRecord(raw) ? raw.changes : undefined),
      errors: asArray(isRecord(raw) ? raw.errors : undefined),
    };
    return out;
  },
});

// ---------------------------------------------------------------------------
// Design-approval holds
// ---------------------------------------------------------------------------

export const listOrderHolds = defineTool({
  name: 'list_order_holds',
  description:
    "List the design-approval holds on an order (active and released). Set refresh=true to also poll the fulfillment provider for newly-discovered holds. Read-only. Use to see why an order is stuck at the provider and get the hold_uuid for approve_order_hold / request_hold_changes.",
  inputSchema: z.object({
    order_uuid: z.string().min(1).describe('The order uuid to list holds for.'),
    refresh: z.boolean().optional().describe('Also poll the provider for new holds (default false).'),
    workspace: z.string().optional().describe('Workspace uuid (agency accounts).'),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.get(`orders/${enc(input.order_uuid)}/holds`, {
      query: { refresh: input.refresh ? 'true' : undefined },
      workspace: input.workspace,
      signal: ctx.signal,
    });
    const holds = asArray(isRecord(raw) ? raw.holds : undefined).map(mapHold);
    return {
      order_uuid: input.order_uuid,
      supports_workflow: (isRecord(raw) ? raw.supports_workflow : undefined) ?? false,
      fulfillment_substatus: str(raw, 'fulfillment_substatus') ?? null,
      holds,
      total: total(raw, holds.length),
    };
  },
});

export const approveOrderHold = defineTool({
  name: 'approve_order_hold',
  description:
    "Approve a design-approval hold on an order so the provider can proceed. If the provider can't flip the hold via its API (Printful today), the result is deferred with a dashboard_url to finish the approval manually — the hold stays active until the provider's release fires. Get the hold_uuid from list_order_holds.",
  inputSchema: holdInput,
  annotations: { idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.post(
      `orders/${enc(input.order_uuid)}/holds/${enc(input.hold_uuid)}/approve`,
      { workspace: input.workspace, signal: ctx.signal },
    );
    const out: Record<string, unknown> = {
      order_uuid: input.order_uuid,
      hold_uuid: str(raw, 'hold_uuid') ?? input.hold_uuid,
      view_url: viewUrl.order(input.order_uuid),
    };
    if (isRecord(raw) && raw.deferred) {
      out.deferred = true;
      out.dashboard_url = str(raw, 'dashboard_url');
      const message = str(raw, 'message');
      if (message !== undefined) out.message = message;
    } else {
      out.approved = true;
    }
    return out;
  },
});

export const requestHoldChanges = defineTool({
  name: 'request_hold_changes',
  description:
    "Request design changes on a held shipment instead of approving it. change_kind is 'minor' (notes REQUIRED — describe the edit) or 'full_replacement' (re-do the design). If the provider can't action it via API (Printful today), the result is deferred with a dashboard_url. Get the hold_uuid from list_order_holds.",
  inputSchema: z.object({
    order_uuid: z.string().min(1).describe('The order uuid the hold belongs to.'),
    hold_uuid: z.string().min(1).describe('The hold uuid (from list_order_holds).'),
    change_kind: z
      .enum(['minor', 'full_replacement'])
      .describe("'minor' = tweak the current design (notes required); 'full_replacement' = new design."),
    notes: z
      .string()
      .optional()
      .describe("What to change. Required when change_kind='minor'."),
    workspace: z.string().optional().describe('Workspace uuid (agency accounts).'),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.post(
      `orders/${enc(input.order_uuid)}/holds/${enc(input.hold_uuid)}/request-changes`,
      {
        body: { change_kind: input.change_kind, notes: input.notes },
        workspace: input.workspace,
        signal: ctx.signal,
      },
    );
    const out: Record<string, unknown> = {
      order_uuid: input.order_uuid,
      hold_uuid: str(raw, 'hold_uuid') ?? input.hold_uuid,
      change_kind: str(raw, 'change_kind') ?? input.change_kind,
      view_url: viewUrl.order(input.order_uuid),
    };
    if (isRecord(raw) && raw.deferred) {
      out.deferred = true;
      out.dashboard_url = str(raw, 'dashboard_url');
      const message = str(raw, 'message');
      if (message !== undefined) out.message = message;
    } else {
      out.changes_requested = true;
    }
    return out;
  },
});

export const orderTools: ToolDef[] = [
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
];

import { z } from 'zod';
import { defineTool, type ToolDef } from './registry.js';
import { asArray, bool, isRecord, num, str, total, viewUrl } from '../util/shape.js';

// Tier-2 management tools (store settings + lifecycle, order payment + ops, product archive).
// Thin, tolerant projections over the /agents/v1 endpoints. Every mapper reads field-name
// variants defensively so a minor live-API shape difference degrades to a missing field
// rather than a crash.
//
// Contracts validated against the platform backend (api/store.py, api/orders.py, api/product.py, and
// the /agents/v1 delegations in api/agents.py):
//   - update_store_settings PATCH store/{s}/settings accepts a partial body; the server updates
//     only the keys present. The fulfillment-workflow fields are: fulfillment_mode
//     (auto|confirm|review), approval_authority (human|agent|rules), auto_fulfill_on_payment,
//     require_payment_before_fulfill, hold_orders_above_amount (float|null), hold_below_margin_pct
//     (float|null), hold_on_negative_margin, hold_first_time_customer, auto_reconcile_orders,
//     notify_on_new_order, notify_on_shipment. Response = the full settings dict.
//   - create_store POST store requires {name}; optional {description, logo, status}. It lands in
//     the workspace the key is scoped to (?workspace=). New stores start CLOSED — connect a
//     fulfillment provider then activate_store to make them ACTIVE.
//   - record_order_payment POST orders/{uuid}/record-payment needs {payment_method} and only
//     works while payment_status='pending'. The amount is derived from the order, so `amount` is
//     accepted for the caller's intent but the server ignores it (see Rule 10 — for a storefront
//     order use payment_method='sales_channel').
//   - set_order_payment_method PATCH orders/{uuid}/payment-method needs {payment_method}.
//   - sync_orders POST orders/sync takes an optional {store_uuid} (omit = all stores).
//   - estimate_order_costs POST orders/estimate-costs needs {store_uuid, recipient{country_code},
//     items[{variant_uuid, quantity}]}; read-only against the provider (no order created).
//   - archive_product / restore_product POST product/{uuid}/archive|restore take no body.
//     archive returns 409 with blocking_orders[] if pending orders reference its variants.

const enc = encodeURIComponent;

const workspaceField = z
  .string()
  .optional()
  .describe('Workspace uuid to scope to (agency accounts). Omit for the Default workspace.');

// ---------------------------------------------------------------------------
// Shared mappers
// ---------------------------------------------------------------------------

/** Project the store-settings dict the API returns (a tolerant subset of the fields it exposes). */
function mapStoreSettings(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {
    store_uuid: str(raw, 'store_uuid'),
    store_name: str(raw, 'store_name'),
    fulfillment_mode: str(raw, 'fulfillment_mode'),
    approval_authority: str(raw, 'approval_authority'),
    auto_fulfill_on_payment: bool(raw, 'auto_fulfill_on_payment'),
    require_payment_before_fulfill: bool(raw, 'require_payment_before_fulfill'),
    hold_orders_above_amount: num(raw, 'hold_orders_above_amount'),
    hold_below_margin_pct: num(raw, 'hold_below_margin_pct'),
    hold_on_negative_margin: bool(raw, 'hold_on_negative_margin'),
    hold_first_time_customer: bool(raw, 'hold_first_time_customer'),
    auto_reconcile_orders: bool(raw, 'auto_reconcile_orders'),
    notify_on_new_order: bool(raw, 'notify_on_new_order'),
    notify_on_shipment: bool(raw, 'notify_on_shipment'),
  };
  // Drop undefined keys so a partial live response reads clean.
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

/** Project a store record (create/archive/unarchive/activate all return the store dict + message). */
function mapStore(raw: unknown): Record<string, unknown> {
  const uuid = str(raw, 'uuid', 'store_uuid') ?? '';
  const out: Record<string, unknown> = {
    store_uuid: uuid,
    name: str(raw, 'name'),
    status: str(raw, 'status'),
  };
  const message = str(raw, 'message');
  if (message !== undefined) out.message = message;
  const disconnected = isRecord(raw) ? raw.disconnected_providers : undefined;
  if (Array.isArray(disconnected)) out.disconnected_providers = disconnected;
  if (uuid) out.view_url = viewUrl.store(uuid);
  return out;
}

/** Unwrap a `{order: {...}}` envelope if present. */
function orderPayload(raw: unknown): unknown {
  return isRecord(raw) && isRecord(raw.order) ? raw.order : raw;
}

/** Project the order-shaped payment result the payment endpoints return. */
function mapPaymentResult(orderUuid: string, raw: unknown): Record<string, unknown> {
  const order = orderPayload(raw);
  const out: Record<string, unknown> = {
    order_uuid: orderUuid,
    view_url: viewUrl.order(orderUuid),
    payment_status: str(raw, 'payment_status') ?? str(order, 'payment_status'),
    payment_method: str(raw, 'payment_method') ?? str(order, 'payment_method'),
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

// ---------------------------------------------------------------------------
// Store settings
// ---------------------------------------------------------------------------

export const getStoreSettings = defineTool({
  name: 'get_store_settings',
  description:
    "Read a store's fulfillment workflow + notification settings: fulfillment_mode " +
    '(auto/confirm/review), approval_authority (human/agent/rules), the margin / high-value / ' +
    'first-time-customer hold guardrails, auto-reconcile, and payment settings. Read-only.',
  inputSchema: z.object({
    store_uuid: z.string().min(1).describe('The store uuid (from list_my_stores).'),
    workspace: workspaceField,
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.get(`store/${enc(input.store_uuid)}/settings`, {
      workspace: input.workspace,
      signal: ctx.signal,
    });
    return { settings: mapStoreSettings(raw) };
  },
});

export const updateStoreSettings = defineTool({
  name: 'update_store_settings',
  description:
    "Update a store's fulfillment workflow / notification settings. Only the fields you pass are " +
    'changed. fulfillment_mode: "auto" (auto-pilot: paid -> draft -> auto-confirm -> production), ' +
    '"confirm" (auto-draft, you confirm each order), "review" (held before submission for approval). ' +
    'The hold_* guardrails escalate an otherwise-auto/confirm order to a pre-submission review. Set ' +
    'hold_orders_above_amount / hold_below_margin_pct to null to disable that guardrail.',
  inputSchema: z.object({
    store_uuid: z.string().min(1).describe('The store uuid to update.'),
    fulfillment_mode: z
      .enum(['auto', 'confirm', 'review'])
      .optional()
      .describe('Automation level: auto (auto-pilot), confirm (you confirm each), review (approve before submit).'),
    approval_authority: z
      .enum(['human', 'agent', 'rules'])
      .optional()
      .describe('Who decides when a review is required: human (UI queue), agent (API/callback), rules (auto unless a guardrail trips).'),
    auto_fulfill_on_payment: z.boolean().optional().describe('Auto-submit to the provider once payment clears.'),
    require_payment_before_fulfill: z.boolean().optional().describe('Block fulfillment until the order is paid.'),
    hold_orders_above_amount: z
      .number()
      .nullable()
      .optional()
      .describe('Auto-hold orders whose total exceeds this amount. null disables the guardrail.'),
    hold_below_margin_pct: z
      .number()
      .nullable()
      .optional()
      .describe('Auto-hold orders below this profit-margin percent. null disables the guardrail.'),
    hold_on_negative_margin: z.boolean().optional().describe('Auto-hold orders that would lose money.'),
    hold_first_time_customer: z.boolean().optional().describe('Auto-hold the first order from a new customer.'),
    auto_reconcile_orders: z
      .boolean()
      .optional()
      .describe('Periodically re-sync open sales-channel orders with their channel (manual reconcile always works regardless).'),
    notify_on_new_order: z.boolean().optional().describe('Send a notification when a new order arrives.'),
    notify_on_shipment: z.boolean().optional().describe('Send a notification when an order ships.'),
    workspace: workspaceField,
  }),
  annotations: { idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const { store_uuid, workspace, ...rest } = input;
    // Send only the keys the caller actually provided (undefined omitted); the server
    // updates each present key in place.
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) body[k] = v;
    const raw = await ctx.api.patch(`store/${enc(store_uuid)}/settings`, {
      body,
      workspace,
      signal: ctx.signal,
    });
    return {
      store_uuid,
      updated: Object.keys(body),
      settings: mapStoreSettings(raw),
      view_url: viewUrl.store(store_uuid),
    };
  },
});

// ---------------------------------------------------------------------------
// Store lifecycle
// ---------------------------------------------------------------------------

export const createStore = defineTool({
  name: 'create_store',
  description:
    'Create a new ApparelHub store. Only a name is required. The store starts CLOSED — connect a ' +
    'fulfillment provider (Printful/Printify), then call activate_store to make it ACTIVE. In an ' +
    'agency account pass workspace=<uuid> to create it in a specific client workspace.',
  inputSchema: z.object({
    name: z.string().min(1).describe('Store name (must be unique within the account).'),
    description: z.string().optional().describe('Optional store description.'),
    logo: z.string().optional().describe('Optional logo image URL.'),
    workspace: workspaceField,
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    const body: Record<string, unknown> = { name: input.name };
    if (input.description !== undefined) body.description = input.description;
    if (input.logo !== undefined) body.logo = input.logo;
    const raw = await ctx.api.post('store', {
      body,
      workspace: input.workspace,
      signal: ctx.signal,
    });
    return { store: mapStore(raw), created: true };
  },
});

export const archiveStore = defineTool({
  name: 'archive_store',
  description:
    'Archive a store (use instead of delete for stores with order history — order records are ' +
    'kept for accounting, but the store is hidden from the default listing and stops ingesting new ' +
    'orders). Restore it later with unarchive_store. Set disconnect_provider=true to also disconnect ' +
    'every connected fulfillment provider and remove its stored credentials.',
  inputSchema: z.object({
    store_uuid: z.string().min(1).describe('The store uuid to archive.'),
    disconnect_provider: z
      .boolean()
      .optional()
      .describe('Also disconnect connected fulfillment providers and remove their credentials (default false).'),
    workspace: workspaceField,
  }),
  annotations: { idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.post(`store/${enc(input.store_uuid)}/archive`, {
      body: input.disconnect_provider ? { disconnect_provider: true } : {},
      workspace: input.workspace,
      signal: ctx.signal,
    });
    return { store: mapStore(raw), archived: true };
  },
});

export const unarchiveStore = defineTool({
  name: 'unarchive_store',
  description:
    'Restore an archived store. It comes back as CLOSED (or ACTIVE if a fulfillment provider is still ' +
    'connected); if it landed CLOSED, connect a provider and call activate_store to reopen it.',
  inputSchema: z.object({
    store_uuid: z.string().min(1).describe('The store uuid to unarchive.'),
    workspace: workspaceField,
  }),
  annotations: { idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.post(`store/${enc(input.store_uuid)}/unarchive`, {
      workspace: input.workspace,
      signal: ctx.signal,
    });
    return { store: mapStore(raw), unarchived: true };
  },
});

export const activateStore = defineTool({
  name: 'activate_store',
  description:
    'Activate a store so it can list products and ingest orders. Requires at least one fulfillment ' +
    'provider (e.g. Printful) to be connected first — otherwise this fails. Use after create_store or ' +
    'unarchive_store once a provider is connected.',
  inputSchema: z.object({
    store_uuid: z.string().min(1).describe('The store uuid to activate.'),
    workspace: workspaceField,
  }),
  annotations: { idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.post(`store/${enc(input.store_uuid)}/activate`, {
      workspace: input.workspace,
      signal: ctx.signal,
    });
    return { store: mapStore(raw), activated: true };
  },
});

// ---------------------------------------------------------------------------
// Order payment
// ---------------------------------------------------------------------------

export const recordOrderPayment = defineTool({
  name: 'record_order_payment',
  description:
    'Record a manual payment on an order that is awaiting payment (payment_status="pending"). Use ' +
    'payment_method="sales_channel" for an order already paid on its storefront (Shopify/WooCommerce/' +
    'Wix — the channel is the source of payment), or "stripe" for an order taken through ApparelHub\'s ' +
    'own card flow. This marks the order paid; it does not charge a card.',
  inputSchema: z.object({
    order_uuid: z.string().min(1).describe('The order uuid (from list_my_orders).'),
    payment_method: z
      .string()
      .min(1)
      .describe('e.g. "sales_channel" (paid on the storefront) or "stripe" (ApparelHub card flow).'),
    amount: z
      .number()
      .optional()
      .describe('Optional amount for the caller\'s intent; the recorded amount comes from the order total.'),
    workspace: workspaceField,
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    const body: Record<string, unknown> = { payment_method: input.payment_method };
    if (input.amount !== undefined) body.amount = input.amount;
    const raw = await ctx.api.post(`orders/${enc(input.order_uuid)}/record-payment`, {
      body,
      workspace: input.workspace,
      signal: ctx.signal,
    });
    return { ...mapPaymentResult(input.order_uuid, raw), payment_recorded: true };
  },
});

export const markOrderNoPayment = defineTool({
  name: 'mark_order_no_payment',
  description:
    'Mark an order as having no payment expected (e.g. a free / comp / sample order). Sets its ' +
    'payment status to "no payment". Use when an order should proceed without a recorded payment.',
  inputSchema: z.object({
    order_uuid: z.string().min(1).describe('The order uuid to mark as no-payment.'),
    workspace: workspaceField,
  }),
  annotations: { idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.post(`orders/${enc(input.order_uuid)}/mark-no-payment`, {
      workspace: input.workspace,
      signal: ctx.signal,
    });
    return { ...mapPaymentResult(input.order_uuid, raw), no_payment: true };
  },
});

export const setOrderPaymentMethod = defineTool({
  name: 'set_order_payment_method',
  description:
    'Change the recorded payment method on an order that already has a payment recorded (e.g. correct ' +
    '"stripe" to "sales_channel"). This is a bookkeeping label change; it does not move any money.',
  inputSchema: z.object({
    order_uuid: z.string().min(1).describe('The order uuid to update.'),
    payment_method: z.string().min(1).describe('The new payment method label (e.g. "sales_channel", "stripe").'),
    workspace: workspaceField,
  }),
  annotations: { idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.patch(`orders/${enc(input.order_uuid)}/payment-method`, {
      body: { payment_method: input.payment_method },
      workspace: input.workspace,
      signal: ctx.signal,
    });
    return { ...mapPaymentResult(input.order_uuid, raw), payment_method_updated: true };
  },
});

// ---------------------------------------------------------------------------
// Order ops
// ---------------------------------------------------------------------------

export const syncOrders = defineTool({
  name: 'sync_orders',
  description:
    'Pull the latest orders from connected fulfillment providers. Pass store_uuid to sync one store; ' +
    'omit it to sync all of your stores. Use to refresh orders that have not come through yet.',
  inputSchema: z.object({
    store_uuid: z.string().optional().describe('Scope the sync to one store (omit for all stores).'),
    workspace: workspaceField,
  }),
  annotations: { idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const body: Record<string, unknown> = {};
    if (input.store_uuid !== undefined) body.store_uuid = input.store_uuid;
    const raw = await ctx.api.post('orders/sync', {
      body,
      workspace: input.workspace,
      signal: ctx.signal,
    });
    return {
      synced_count: num(raw, 'synced_count') ?? 0,
      errors: asArray(isRecord(raw) ? raw.errors : undefined),
      message: str(raw, 'message'),
    };
  },
});

export const estimateOrderCosts = defineTool({
  name: 'estimate_order_costs',
  description:
    'Estimate shipping + tax + total for an order WITHOUT creating it (read-only against the ' +
    'fulfillment provider, no order placed). Give the store, the recipient (country_code required), and ' +
    'the variants + quantities. Use to preview costs before placing an order.',
  inputSchema: z.object({
    store_uuid: z.string().min(1).describe('The store the order would be placed in.'),
    recipient: z
      .object({
        country_code: z.string().min(1).describe('ISO country code, e.g. "US" (required).'),
        state_code: z.string().optional().describe('State / province code, e.g. "CA".'),
        city: z.string().optional(),
        zip: z.string().optional(),
        address1: z.string().optional().describe('Street address (optional but improves accuracy).'),
        name: z.string().optional(),
      })
      .describe('Ship-to details. country_code is required; more fields improve accuracy.'),
    items: z
      .array(
        z.object({
          variant_uuid: z.string().min(1).describe('A synced product variant uuid.'),
          quantity: z.number().int().positive().describe('How many of this variant.'),
        }),
      )
      .min(1)
      .describe('Line items to price.'),
    currency: z.string().optional().describe('Currency code (defaults to USD).'),
    workspace: workspaceField,
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const body: Record<string, unknown> = {
      store_uuid: input.store_uuid,
      recipient: input.recipient,
      items: input.items,
    };
    if (input.currency !== undefined) body.currency = input.currency;
    const raw = await ctx.api.post('orders/estimate-costs', {
      body,
      workspace: input.workspace,
      signal: ctx.signal,
    });
    const out: Record<string, unknown> = {
      currency: str(raw, 'currency'),
      subtotal: num(raw, 'subtotal'),
      shipping: num(raw, 'shipping'),
      tax: num(raw, 'tax'),
      vat: num(raw, 'vat'),
      total: num(raw, 'total', 'total_amount'),
      provider_name: str(raw, 'provider_name', 'provider'),
    };
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
  },
});

export const getOrdersSummary = defineTool({
  name: 'get_orders_summary',
  description:
    'Aggregated stats for the orders dashboard: counts of orders pending approval / awaiting payment / ' +
    "in fulfillment / shipped today, plus today's revenue and profit, and a per-store breakdown. Read-only.",
  inputSchema: z.object({ workspace: workspaceField }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.get('orders/dashboard/summary', {
      workspace: input.workspace,
      signal: ctx.signal,
    });
    return {
      pending_approval: num(raw, 'pending_approval') ?? 0,
      awaiting_payment: num(raw, 'awaiting_payment') ?? 0,
      in_fulfillment: num(raw, 'in_fulfillment') ?? 0,
      shipped_today: num(raw, 'shipped_today') ?? 0,
      total_revenue_today: num(raw, 'total_revenue_today') ?? 0,
      total_profit_today: num(raw, 'total_profit_today') ?? 0,
      orders_by_store: asArray(isRecord(raw) ? raw.orders_by_store : undefined),
      orders_by_status: (isRecord(raw) ? raw.orders_by_status : undefined) ?? {},
    };
  },
});

export const listPendingFulfillments = defineTool({
  name: 'list_pending_fulfillments',
  description:
    'List orders in a store that have pending fulfillment data needing attention (used by the ' +
    'reconciliation view). Read-only. Use to find orders that stalled before reaching the provider.',
  inputSchema: z.object({
    store_uuid: z.string().min(1).describe('The store uuid to check.'),
    workspace: workspaceField,
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.get(`orders/pending-fulfillments/${enc(input.store_uuid)}`, {
      workspace: input.workspace,
      signal: ctx.signal,
    });
    const pending = asArray(isRecord(raw) ? raw.pending : undefined).map((p) => {
      const uuid = str(p, 'order_uuid', 'uuid') ?? '';
      const out: Record<string, unknown> = {
        order_uuid: uuid,
        order_display_id: str(p, 'order_display_id', 'external_display_id'),
        fulfillment_status: str(p, 'fulfillment_status'),
        total_price: num(p, 'total_price'),
      };
      if (uuid) out.view_url = viewUrl.order(uuid);
      return out;
    });
    return { pending, total: total(raw, pending.length) };
  },
});

// ---------------------------------------------------------------------------
// Product archive
// ---------------------------------------------------------------------------

export const archiveProduct = defineTool({
  name: 'archive_product',
  description:
    'Archive a product: unsync it from every connected sales channel and its fulfillment provider, ' +
    'then hide it. Fails (returns blocking_orders) if any pending order still references its variants — ' +
    'cancel or fulfill those first. Restore it later with restore_product. Use archive rather than ' +
    'delete_product when a product has order history.',
  inputSchema: z.object({
    product_uuid: z.string().min(1).describe('The product uuid to archive.'),
    workspace: workspaceField,
  }),
  annotations: { idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.post(`product/${enc(input.product_uuid)}/archive`, {
      workspace: input.workspace,
      signal: ctx.signal,
    });
    const out: Record<string, unknown> = {
      product_uuid: input.product_uuid,
      archived: true,
      view_url: viewUrl.product(input.product_uuid),
    };
    // Best-effort remote-delete failures the server surfaces so the caller can mop up.
    const failures = asArray(isRecord(raw) ? raw.channel_failures : undefined);
    if (failures.length) out.channel_failures = failures;
    const message = str(raw, 'message');
    if (message !== undefined) out.message = message;
    return out;
  },
});

export const restoreProduct = defineTool({
  name: 'restore_product',
  description:
    'Restore a previously archived product (sets it back to active). It is not re-synced to any sales ' +
    'channel automatically — sync it again afterward if you want it live. Use to undo archive_product.',
  inputSchema: z.object({
    product_uuid: z.string().min(1).describe('The product uuid to restore.'),
    workspace: workspaceField,
  }),
  annotations: { idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.post(`product/${enc(input.product_uuid)}/restore`, {
      workspace: input.workspace,
      signal: ctx.signal,
    });
    return {
      product_uuid: input.product_uuid,
      restored: true,
      view_url: viewUrl.product(input.product_uuid),
      message: str(raw, 'message'),
    };
  },
});

export const managementTools: ToolDef[] = [
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
];

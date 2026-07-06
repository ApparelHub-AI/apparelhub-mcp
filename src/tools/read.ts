import { z } from 'zod';
import { defineTool, type ToolDef } from './registry.js';
import { asArray, bool, isRecord, num, str, total, viewUrl } from '../util/shape.js';

// Read tools (tool spec §5). Thin, clean projections over the /agents/v1 read endpoints.
// Mappers are deliberately tolerant of field-name variants (uuid vs *_uuid, channel vs
// provider_name, etc.) so a minor live-API shape difference degrades to a missing field
// rather than a crash. Optional filters are passed as query params (server honors what it
// supports); no misleading client-side filtering of a single page. Validate the field names
// against a live key before the first published release.

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

function mapProvider(raw: unknown): Record<string, unknown> {
  return {
    provider_uuid: str(raw, 'uuid', 'provider_uuid'),
    name: str(raw, 'name', 'provider_name'),
  };
}

function mapIntegration(raw: unknown): Record<string, unknown> {
  return {
    integration_uuid: str(raw, 'uuid', 'integration_uuid'),
    channel: str(raw, 'provider_name', 'channel', 'name'),
    shop_identifier: str(raw, 'shop_identifier', 'shop_url', 'store_url'),
    is_active: bool(raw, 'is_active') ?? true,
    is_locked: bool(raw, 'is_locked') ?? false,
  };
}

function mapStore(raw: unknown): Record<string, unknown> {
  const uuid = str(raw, 'uuid', 'store_uuid') ?? '';
  // The platform store payload carries the fulfillment provider(s) under `providers`
  // (Printful/Printify) and connected sales channels under `active_integrations`. Older
  // names kept as fallbacks. A store always has a fulfillment provider by design, so an
  // empty `fulfillment_providers` here means we read the wrong key (regression guard).
  const providersRaw = isRecord(raw)
    ? (raw.providers ?? raw.merchandise_providers ?? raw.fulfillment_providers)
    : undefined;
  const integrationsRaw = isRecord(raw)
    ? (raw.active_integrations ?? raw.ecommerce_integrations ?? raw.integrations)
    : undefined;
  const workspaceUuid = str(raw, 'workspace_uuid');

  const store: Record<string, unknown> = {
    store_uuid: uuid,
    name: str(raw, 'name'),
    fulfillment_providers: asArray(providersRaw).map(mapProvider),
    ecommerce_integrations: asArray(integrationsRaw).map(mapIntegration),
  };
  if (workspaceUuid) {
    store.workspace = {
      uuid: workspaceUuid,
      name: str(raw, 'workspace_name'),
      is_default: bool(raw, 'workspace_is_default'),
    };
  }
  if (uuid) store.view_url = viewUrl.store(uuid);
  return store;
}

export const listMyStores = defineTool({
  name: 'list_my_stores',
  description:
    "List the merchant's ApparelHub stores, each with its fulfillment providers (Printful/Printify) and connected sales channels (Shopify/WooCommerce/Wix). Read-only.",
  inputSchema: z.object({
    workspace: z
      .string()
      .optional()
      .describe('Workspace uuid to scope to (agency accounts). Omit for the Default workspace.'),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.get('store', { workspace: input.workspace, signal: ctx.signal });
    const stores = asArray(raw, 'stores').map(mapStore);
    return { stores, total: total(raw, stores.length) };
  },
});

// ---------------------------------------------------------------------------
// Designs
// ---------------------------------------------------------------------------

function mapDesign(raw: unknown): Record<string, unknown> {
  const uuid = str(raw, 'uuid', 'design_uuid', 'id') ?? '';
  const out: Record<string, unknown> = {
    design_uuid: uuid,
    title: str(raw, 'title', 'name', 'prompt'),
    thumbnail_url: str(raw, 'thumbnail_url'),
    full_url: str(raw, 'url', 'full_url', 'image_url'),
    source: str(raw, 'source', 'source_name'),
    created: str(raw, 'created', 'created_at', 'created_on'),
  };
  const products = num(raw, 'products_using', 'products_count', 'product_count');
  if (products !== undefined) out.products_using = products;
  return out;
}

export const listMyDesigns = defineTool({
  name: 'list_my_designs',
  description:
    "List the merchant's generated design images (newest first). Read-only. Use these design_uuids with the design/product tools.",
  inputSchema: z.object({
    limit: z.number().int().positive().max(100).optional().describe('Max results (default 20).'),
    sort: z.enum(['newest', 'oldest']).optional().describe('Sort order (default newest).'),
    source: z
      .string()
      .optional()
      .describe('Filter by AI source name where supported (e.g. "Nano Banana").'),
    search: z.string().optional().describe('Match title/prompt where supported.'),
    workspace: z.string().optional().describe('Workspace uuid (agency accounts).'),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.get('images/generated', {
      query: {
        limit: input.limit ?? 20,
        sort: input.sort ?? 'newest',
        source: input.source,
        search: input.search,
      },
      workspace: input.workspace,
      signal: ctx.signal,
    });
    const designs = asArray(raw, 'images', 'generated', 'designs').map(mapDesign);
    return { designs, total: total(raw, designs.length) };
  },
});

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

function mapFulfillmentStatus(raw: unknown): Record<string, unknown> | undefined {
  const fs = isRecord(raw) ? raw.fulfillment_status : undefined;
  if (!isRecord(fs)) return undefined;
  return {
    provider: str(fs, 'provider_name', 'provider'),
    sync_status: str(fs, 'sync_status', 'status'),
  };
}

function mapChannelStatuses(raw: unknown): Record<string, unknown>[] {
  const list = isRecord(raw)
    ? (raw.channel_statuses ?? raw.ecommerce_statuses ?? raw.ecommerce_sync_history)
    : undefined;
  return asArray(list).map((c) => ({
    integration_uuid: str(c, 'integration_uuid', 'uuid'),
    channel_name: str(c, 'channel_name', 'provider_name', 'channel'),
    sync_status: str(c, 'sync_status', 'status'),
    external_id: str(c, 'external_id'),
  }));
}

function mapProductListItem(raw: unknown): Record<string, unknown> {
  const uuid = str(raw, 'uuid', 'product_uuid') ?? '';
  const item: Record<string, unknown> = {
    product_uuid: uuid,
    name: str(raw, 'name'),
    price: num(raw, 'price', 'retail_price'),
    thumbnail_url: str(raw, 'thumbnail_url', 'display_image'),
    status: str(raw, 'status'),
    fulfillment_status: mapFulfillmentStatus(raw),
    channel_statuses: mapChannelStatuses(raw),
  };
  if (uuid) item.view_url = viewUrl.product(uuid);
  return item;
}

export const listMyProducts = defineTool({
  name: 'list_my_products',
  description:
    "List the merchant's products with their fulfillment and sales-channel sync status. Pass store_uuid to scope to one store; omit for all products. Read-only.",
  inputSchema: z.object({
    store_uuid: z.string().optional().describe('Scope to one store (omit for all products).'),
    status: z.enum(['active', 'draft', 'archived']).optional(),
    search: z.string().optional(),
    sync_state: z.enum(['synced', 'unsynced', 'failed']).optional(),
    limit: z.number().int().positive().max(100).optional(),
    workspace: z.string().optional(),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const path = input.store_uuid
      ? `store/${encodeURIComponent(input.store_uuid)}/products`
      : 'product';
    const raw = await ctx.api.get(path, {
      query: {
        status: input.status,
        search: input.search,
        sync_state: input.sync_state,
        limit: input.limit,
      },
      workspace: input.workspace,
      signal: ctx.signal,
    });
    const products = asArray(raw, 'products').map(mapProductListItem);
    return { products, total: total(raw, products.length) };
  },
});

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

function mapOrderItem(raw: unknown): Record<string, unknown> {
  return {
    product_name: str(raw, 'product_name', 'name'),
    quantity: num(raw, 'quantity', 'qty'),
    sku: str(raw, 'sku'),
  };
}

function mapShipment(raw: unknown): Record<string, unknown> {
  return {
    carrier: str(raw, 'carrier'),
    tracking_number: str(raw, 'tracking_number', 'tracking'),
    status: str(raw, 'status'),
  };
}

function mapOrderListItem(raw: unknown): Record<string, unknown> {
  const uuid = str(raw, 'uuid', 'order_uuid') ?? '';
  const out: Record<string, unknown> = {
    order_uuid: uuid,
    order_number: str(raw, 'order_number', 'external_display_id', 'external_id'),
    total: num(raw, 'total', 'total_amount', 'amount'),
    status: str(raw, 'status', 'fulfillment_status'),
    channel: str(raw, 'channel', 'provider_name', 'sales_channel'),
    items: asArray(isRecord(raw) ? (raw.items ?? raw.line_items) : undefined).map(mapOrderItem),
  };
  const customer = str(raw, 'customer_name', 'recipient_name');
  if (customer) out.customer_name = customer;
  const shipments = asArray(isRecord(raw) ? raw.shipments : undefined);
  if (shipments.length) out.shipments = shipments.map(mapShipment);
  if (uuid) out.view_url = viewUrl.order(uuid);
  return out;
}

function mapOrderDetail(raw: unknown): Record<string, unknown> {
  return {
    ...mapOrderListItem(raw),
    payment_status: str(raw, 'payment_status'),
    payment_method: str(raw, 'payment_method'),
    fulfillment_substatus: str(raw, 'fulfillment_substatus'),
    provider: str(raw, 'provider_name', 'provider'),
    created: str(raw, 'created', 'created_at'),
    updated: str(raw, 'updated', 'updated_at'),
  };
}

export const listMyOrders = defineTool({
  name: 'list_my_orders',
  description: "List the merchant's recent orders across channels. Read-only.",
  inputSchema: z.object({
    status: z
      .enum(['pending', 'in_production', 'shipped', 'delivered', 'cancelled'])
      .optional(),
    store_uuid: z.string().optional(),
    since: z.string().optional().describe('ISO date lower bound where supported.'),
    limit: z.number().int().positive().max(100).optional(),
    workspace: z.string().optional(),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.get('orders', {
      query: {
        status: input.status,
        store_uuid: input.store_uuid,
        since: input.since,
        limit: input.limit,
      },
      workspace: input.workspace,
      signal: ctx.signal,
    });
    const orders = asArray(raw, 'orders').map(mapOrderListItem);
    return { orders, total: total(raw, orders.length) };
  },
});

export const getOrderDetails = defineTool({
  name: 'get_order_details',
  description:
    'Full detail for one order: line items, payment + fulfillment status, and shipments/tracking. Read-only.',
  inputSchema: z.object({
    order_uuid: z.string().min(1).describe('The order uuid (from list_my_orders).'),
    workspace: z.string().optional(),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.get(`orders/${encodeURIComponent(input.order_uuid)}`, {
      workspace: input.workspace,
      signal: ctx.signal,
    });
    const order = isRecord(raw) && isRecord(raw.order) ? raw.order : raw;
    return { order: mapOrderDetail(order) };
  },
});

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export const listMyWorkspaces = defineTool({
  name: 'list_my_workspaces',
  description:
    "List the workspaces this account can act in, each with its uuid. Agency / multi-brand " +
    'accounts have more than one (e.g. a workspace per client); a single account just has ' +
    'Default. The store / product / order / design tools operate on the Default workspace ' +
    'unless you pass workspace=<uuid>. Use this FIRST to resolve a workspace by name (e.g. a ' +
    "client's name) to the uuid those tools need. Read-only.",
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (_input, ctx) => {
    const raw = await ctx.api.get('workspaces', { signal: ctx.signal });
    const workspaces = asArray(raw, 'workspaces').map((w) => {
      const out: Record<string, unknown> = {
        workspace_uuid: str(w, 'uuid', 'workspace_uuid', 'id'),
        name: str(w, 'name'),
      };
      const role = str(w, 'role');
      if (role) out.role = role;
      const agency = bool(w, 'agency_enabled');
      if (agency !== undefined) out.agency_enabled = agency;
      return out;
    });
    return { workspaces, total: total(raw, workspaces.length) };
  },
});

export const readTools: ToolDef[] = [
  listMyWorkspaces,
  listMyStores,
  listMyDesigns,
  listMyProducts,
  listMyOrders,
  getOrderDetails,
];

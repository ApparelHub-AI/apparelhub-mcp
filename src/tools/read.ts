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

  // A design that is still being worked on, or that failed, has no usable
  // full_url. Without these an agent sees a null url and no way to tell a
  // transient failure it should retry from a content block it never will, so
  // it either gives up on a recoverable design or retries a hopeless one
  // forever. The platform started returning the reason in apparelhub-ai#886.
  //
  // Only emitted when there is something to say: a healthy design carries a
  // null processing_status and stays as lean as it is today.
  const processing = str(raw, 'processing_status', 'status');
  if (processing) {
    out.processing_status = processing;
    const reason = str(raw, 'processing_error', 'error');
    if (reason) out.processing_error = reason;
    const code = str(raw, 'processing_error_code', 'error_code');
    if (code) out.processing_error_code = code;
  }
  return out;
}

export const listMyDesigns = defineTool({
  name: 'list_my_designs',
  description:
    "List the merchant's generated design images (newest first). Read-only. Use these design_uuids with the design/product tools. " +
    'Pass on_products=false to find orphan designs (designs not used by any live product), the ' +
    'supported way to audit a workspace for unused designs before archiving them. Pass ' +
    'archived=true to list already-archived designs. ' +
    'A design with no full_url carries processing_status: "pending"/"processing" means it is ' +
    'still being made and is worth polling, while "failed" means it gave up and processing_error ' +
    'says why. Branch on processing_error_code rather than matching the message text, and do not ' +
    'retry a design whose failure is a content block — it will fail the same way every time.',
  inputSchema: z.object({
    limit: z.number().int().positive().max(100).optional().describe('Max results (default 20).'),
    sort: z.enum(['newest', 'oldest']).optional().describe('Sort order (default newest).'),
    // The description no longer hedges with "where supported": the platform now
    // reads this param, and an unrecognised value is refused rather than dropped.
    // Previously nothing read it, so a filtered-looking result was the full list.
    source: z
      .string()
      .optional()
      .describe(
        'Filter by AI source name, e.g. "Nano Banana". Comma-separated for several; ' +
          'case-insensitive. An unrecognised name is rejected with the list of valid ' +
          'sources, so a result set that comes back is genuinely filtered.',
      ),
    search: z.string().optional().describe('Match title/prompt where supported.'),
    on_products: z
      .boolean()
      .optional()
      .describe(
        'false returns only designs NOT used by any live product (orphans, safe to archive). ' +
          'true returns only designs in use. Omit for no filter.',
      ),
    archived: z
      .boolean()
      .optional()
      .describe('true returns archived designs instead of active ones (default false).'),
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
        on_products: input.on_products,
        archived: input.archived,
      },
      workspace: input.workspace,
      signal: ctx.signal,
    });
    const designs = asArray(raw, 'images', 'generated', 'designs').map(mapDesign);
    return { designs, total: total(raw, designs.length) };
  },
});

function mapCollectionDesign(raw: unknown): Record<string, unknown> {
  return {
    design_uuid: str(raw, 'uuid', 'design_uuid') ?? '',
    // The product name and retail description the model wrote for this concept. Either may be
    // null when the model wrote none, and they are passed through as-is, never filled in.
    title: str(raw, 'title') ?? null,
    concept_description: str(raw, 'concept_description') ?? null,
    full_url: str(raw, 'url', 'full_url'),
    thumbnail_url: str(raw, 'thumbnail_url'),
    background_state: str(raw, 'background_state') ?? null,
  };
}

export const getDesignCollection = defineTool({
  name: 'get_design_collection',
  description:
    'List the OTHER designs that came out of the same generation as this one. When generate_image ' +
    'is called with concepts > 1, one generation produces a themed set; every design is saved ' +
    'separately and this is how you find its siblings. The design you ask about is never included, ' +
    'and the list is oldest first. An ordinary design returns an empty list, which is the honest ' +
    'answer, not an error (an inaccessible or unknown uuid also reads as empty, so an empty list ' +
    'does not prove the design exists). Read-only and not metered. ' +
    'Each entry carries title and concept_description: the product name and retail description ' +
    'the model wrote for that concept. Use them to build products without asking the merchant to ' +
    'retype copy the model already produced; either may be null and must never be invented. ' +
    'background_state says whether the design can be lifted off its background: transparent is ' +
    'ready to place, opaque_box can be keyed automatically (process_transparency), opaque_varied ' +
    'cannot be separated and will print WITH its background. Asked for a set, the model often ' +
    'answers with pictures of finished garments rather than flat art, and building a product from ' +
    'one prints a garment onto a garment, so do NOT build a product from an opaque_varied design ' +
    'without telling the user it will print with its background. Do not describe it as "a ' +
    'photograph" either: legitimately textured art reports opaque_varied too.',
  inputSchema: z.object({
    design_uuid: z
      .string()
      .min(1)
      .describe('Any design from the generation (usually the image_uuid generate_image returned).'),
    workspace: z.string().optional().describe('Workspace uuid (agency accounts).'),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.get(
      `images/generated/${encodeURIComponent(input.design_uuid)}/collection`,
      { workspace: input.workspace, signal: ctx.signal },
    );
    const collection = asArray(raw, 'collection').map(mapCollectionDesign);
    const out: Record<string, unknown> = {
      design_uuid: input.design_uuid,
      collection,
      total: collection.length,
    };
    const prints = collection.filter((d) => d.background_state === 'opaque_varied').length;
    if (prints > 0) {
      out.warning =
        `${prints} of ${collection.length} will print with their background (background_state ` +
        'opaque_varied). Look at each before building a product from it, and tell the user.';
    }
    return out;
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
  return asArray(list).map((c) => {
    const detail = isRecord(c) && isRecord(c.health_detail) ? c.health_detail : undefined;
    const entry: Record<string, unknown> = {
      integration_uuid: str(c, 'integration_uuid', 'uuid'),
      channel_name: str(c, 'channel_name', 'provider_name', 'channel'),
      sync_status: str(c, 'sync_status', 'status'),
      // Always a string. Channel product ids can exceed 2^53 (TikTok's do), so
      // treating one as a JS number silently corrupts it.
      external_id: str(c, 'external_id'),
      // What the CHANNEL last said about the listing, as opposed to what we
      // believe we published. A sales channel can remove or deactivate a
      // listing at any time without being asked, so a product that synced
      // successfully is not guaranteed to still be live — an agent that reads
      // only sync_status will keep reporting a dead listing as fine.
      //   'Removed'         - gone from the channel (deleted or taken down)
      //   'Needs Attention' - still there but not visible to buyers
      //   'Unknown'         - we could not reach the channel; NOT a problem claim
      //   absent            - never checked, which is not the same as healthy
      health: str(c, 'health'),
    };
    // The channel's own explanation, when it gave one. It arrives only on the
    // channel's push notification — a later poll reads status alone and cannot
    // recover it — so it is often the only actionable detail available.
    const reason = detail ? str(detail, 'channel_reason') : undefined;
    if (reason) entry.health_reason = reason;
    const checkedAt = str(c, 'health_checked_at');
    if (checkedAt) entry.health_checked_at = checkedAt;
    return entry;
  });
}

function mapProductListItem(raw: unknown): Record<string, unknown> {
  const uuid = str(raw, 'uuid', 'product_uuid') ?? '';
  const item: Record<string, unknown> = {
    product_uuid: uuid,
    name: str(raw, 'name'),
    price: num(raw, 'price', 'retail_price'),
    thumbnail_url: str(raw, 'thumbnail_url', 'display_image'),
    status: str(raw, 'status'),
    // created/updated let a caller reason about recency — e.g. a reconciler deciding whether the
    // product set has been stable long enough to self-terminate (nothing built/rebuilt recently).
    created: str(raw, 'created', 'created_at', 'created_on'),
    updated: str(raw, 'updated', 'updated_at'),
    fulfillment_status: mapFulfillmentStatus(raw),
    channel_statuses: mapChannelStatuses(raw),
  };
  if (uuid) item.view_url = viewUrl.product(uuid);
  return item;
}

export const listMyProducts = defineTool({
  name: 'list_my_products',
  description:
    "List the merchant's products with their fulfillment and sales-channel sync status. Each channel entry also carries `health` — what the channel last said about the listing. A channel can remove or deactivate a listing at any time, so check `health`, not just `sync_status`: a product can read 'Synced' historically and still be gone. Pass store_uuid to scope to one store; omit for all products. Read-only.",
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
  // apparelhub-ai#1302: the server flags an order the merchant must act on
  // (provider failed or cancelled it, buyer cancelled after production started,
  // or it was paid but never sent to production). Passed through untouched so
  // an agent can tell the user instead of reading an ordinary "cancelled".
  const attention = isRecord(raw) ? raw.needs_attention : undefined;
  if (isRecord(attention)) out.needs_attention = attention;
  // apparelhub-ai#1322: the sales channel's ship-by deadline (UTC). TikTok Shop
  // sets one on every order and counts a late shipping update against the shop.
  const shipBy = str(raw, 'ship_by_at');
  if (shipBy) out.ship_by_at = shipBy;
  // apparelhub-ai#1330: 'merchant' marks an order for the merchant's own
  // products (listings brought in from their channel, not made in ApparelHub).
  // Their store fulfils it; ApparelHub only records it.
  const fulfilledBy = str(raw, 'fulfilled_by');
  if (fulfilledBy) out.fulfilled_by = fulfilledBy;
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
  description:
    "List the merchant's recent orders across channels. An order with `fulfilled_by: 'merchant'` is for the merchant's own products (brought in from their sales channel, not made in ApparelHub): their store fulfils it, ApparelHub only records it, and approve / submit / confirm / cancel / hold / record-payment refuse it with `fulfilled_by_merchant`; tell the user to act on it in their store. Pass fulfilled_by to list only those ('merchant') or only ApparelHub-fulfilled orders ('apparelhub'). An order carrying `needs_attention` is one the merchant must act on (the fulfillment provider failed or cancelled it, the buyer cancelled after production started, it was paid but never sent to production, the sales channel's ship-by deadline is close or missed, or the channel refused the tracking): always tell the user about those, with the `message`. `ship_by_at` is the channel's ship-by deadline (UTC) when it has one. Read-only.",
  inputSchema: z.object({
    status: z
      .enum(['pending', 'in_production', 'shipped', 'delivered', 'cancelled'])
      .optional(),
    store_uuid: z.string().optional(),
    since: z.string().optional().describe('ISO date lower bound where supported.'),
    fulfilled_by: z
      .enum(['merchant', 'apparelhub'])
      .optional()
      .describe("'merchant' = orders for the merchant's own products, fulfilled by their store; 'apparelhub' = orders ApparelHub fulfils. Omit for both."),
    limit: z.number().int().positive().max(100).optional(),
    workspace: z.string().optional(),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.get('orders', {
      query: {
        status: input.status,
        store_uuid: input.store_uuid,
        fulfilled_by: input.fulfilled_by,
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
    'Full detail for one order: line items, payment + fulfillment status, shipments/tracking, and `ship_by_at` (the sales channel\'s ship-by deadline, UTC) when the channel has one. If `needs_attention` is present the order will not complete on its own; tell the user its `title` and `message`. Read-only.',
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
  getDesignCollection,
  listMyProducts,
  listMyOrders,
  getOrderDetails,
];

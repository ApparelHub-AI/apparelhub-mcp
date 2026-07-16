import { z } from 'zod';
import { defineTool, type ToolDef } from './registry.js';
import { AhError } from '../errors.js';
import { asArray, bool, isRecord, num, str, total, viewUrl } from '../util/shape.js';

// Collection (store-category) management (capability-gap tools). These wrap the
// /agents/v1/store/{store}/collections/* endpoints. Backend facts confirmed against
// the platform backend api/collections.py + common/models/store_collections.py:
//   - The stored/serialized name field is `title` (NOT `name`). create_collection REQUIRES
//     `title`; update accepts `title`. We expose a friendly `name` on the tool input and send
//     it to the backend as `title`, and map `title` back to `name` on the way out.
//   - add_products_to_collection body is { product_uuids: string[] }.
//   - remove_product_from_collection is a DELETE on .../products/{product_uuid} (no body).
//   - sync_collection needs `integration_uuid` as a QUERY param (which channel to sync to);
//     it is NOT a body field.
// All routes are store-scoped and honor ?workspace=<uuid> (api-contract §4b).

const enc = encodeURIComponent;

const storeInput = {
  store_uuid: z.string().min(1),
  workspace: z.string().optional(),
};

/** Light, variant-tolerant projection of a collection. */
function mapCollection(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {
    collection_uuid: str(raw, 'uuid', 'collection_uuid'),
    // Backend field is `title`; keep `name` as the agent-facing key (with tolerant fallbacks).
    name: str(raw, 'title', 'name'),
    description: str(raw, 'description'),
    product_count: num(raw, 'product_count', 'products_count'),
    collection_type: str(raw, 'collection_type', 'type'),
    sort_order: num(raw, 'sort_order'),
    published: bool(raw, 'published'),
  };
  // Sync statuses (present on list/get) are useful context for "is this live on my channels?".
  if (isRecord(raw) && Array.isArray(raw.ecommerce_statuses)) {
    out.ecommerce_statuses = raw.ecommerce_statuses.map((s) => ({
      integration_uuid: str(s, 'integration_uuid'),
      channel: str(s, 'provider_name', 'channel'),
      sync_status: str(s, 'sync_status'),
      external_id: str(s, 'external_id', 'external_reference_id'),
    }));
  }
  return out;
}

export const listCollections = defineTool({
  name: 'list_collections',
  description:
    'List a store\'s product collections (categories/groups), each with its product count and per-channel sync status. Read-only.',
  inputSchema: z.object({ ...storeInput }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.get(`store/${enc(input.store_uuid)}/collections`, {
      workspace: input.workspace,
      signal: ctx.signal,
    });
    const collections = asArray(raw, 'collections').map(mapCollection);
    return { collections, total: total(raw, collections.length) };
  },
});

export const getCollection = defineTool({
  name: 'get_collection',
  description:
    'Get a single collection by uuid, including its member products and per-channel sync status. Read-only.',
  inputSchema: z.object({ ...storeInput, collection_uuid: z.string().min(1) }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.get(
      `store/${enc(input.store_uuid)}/collections/${enc(input.collection_uuid)}`,
      { workspace: input.workspace, signal: ctx.signal },
    );
    const collection = mapCollection(raw);
    const products = asArray(isRecord(raw) ? raw.products : undefined).map((p) => ({
      product_uuid: str(p, 'uuid', 'product_uuid'),
      name: str(p, 'name', 'title'),
      display_image: str(p, 'display_image'),
      position: num(p, 'position'),
    }));
    return { collection, products };
  },
});

export const createCollection = defineTool({
  name: 'create_collection',
  description:
    'Create a new (empty) collection in a store. Provide a name (sent to the platform as the collection title) and an optional description. Add products with add_products_to_collection, then sync_collection to push it to a sales channel.',
  inputSchema: z.object({
    ...storeInput,
    name: z.string().min(1),
    description: z.string().optional(),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    // The create endpoint requires `title` (not `name`); map the friendly input across.
    const body: Record<string, unknown> = { title: input.name };
    if (input.description !== undefined) body.description = input.description;
    const raw = await ctx.api.post(`store/${enc(input.store_uuid)}/collections`, {
      body,
      workspace: input.workspace,
      signal: ctx.signal,
    });
    return { collection: mapCollection(raw) };
  },
});

export const updateCollection = defineTool({
  name: 'update_collection',
  description:
    'Update a collection\'s name and/or description. A name change is sent to the platform as the collection title. Editing a synced collection marks it for re-sync.',
  inputSchema: z.object({
    ...storeInput,
    collection_uuid: z.string().min(1),
    name: z.string().min(1).optional(),
    description: z.string().optional(),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    const body: Record<string, unknown> = {};
    if (input.name !== undefined) body.title = input.name; // backend field is `title`
    if (input.description !== undefined) body.description = input.description;
    if (Object.keys(body).length === 0) {
      throw new AhError({
        code: 'bad_request',
        message: 'No changes provided.',
        suggestion: 'Pass a new name and/or description.',
      });
    }
    const raw = await ctx.api.patch(
      `store/${enc(input.store_uuid)}/collections/${enc(input.collection_uuid)}`,
      { body, workspace: input.workspace, signal: ctx.signal },
    );
    return { collection: mapCollection(raw), changes_applied: Object.keys(body) };
  },
});

export const deleteCollection = defineTool({
  name: 'delete_collection',
  description:
    'Delete a collection. If it is synced to any sales channel, the platform unsyncs it there first. The member products are NOT deleted, only the grouping.',
  inputSchema: z.object({ ...storeInput, collection_uuid: z.string().min(1) }),
  annotations: { destructiveHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    await ctx.api.del(
      `store/${enc(input.store_uuid)}/collections/${enc(input.collection_uuid)}`,
      { workspace: input.workspace, signal: ctx.signal },
    );
    return { collection_uuid: input.collection_uuid, deleted: true };
  },
});

export const addProductsToCollection = defineTool({
  name: 'add_products_to_collection',
  description:
    'Add one or more products (by uuid) to a collection. The products must already be associated with the store. If the collection is synced to a channel, the products are added there too.',
  inputSchema: z.object({
    ...storeInput,
    collection_uuid: z.string().min(1),
    product_uuids: z.array(z.string().min(1)).min(1),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.post(
      `store/${enc(input.store_uuid)}/collections/${enc(input.collection_uuid)}/products`,
      { body: { product_uuids: input.product_uuids }, workspace: input.workspace, signal: ctx.signal },
    );
    return {
      collection_uuid: input.collection_uuid,
      message: str(raw, 'message'),
      errors: isRecord(raw) && Array.isArray(raw.errors) ? raw.errors : undefined,
    };
  },
});

export const removeProductFromCollection = defineTool({
  name: 'remove_product_from_collection',
  description:
    'Remove a single product from a collection (the product itself is not deleted). If the collection is synced to a channel, the product is removed there too.',
  inputSchema: z.object({
    ...storeInput,
    collection_uuid: z.string().min(1),
    product_uuid: z.string().min(1),
  }),
  annotations: { destructiveHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.del(
      `store/${enc(input.store_uuid)}/collections/${enc(input.collection_uuid)}/products/${enc(input.product_uuid)}`,
      { workspace: input.workspace, signal: ctx.signal },
    );
    return {
      collection_uuid: input.collection_uuid,
      product_uuid: input.product_uuid,
      removed: true,
      remote_errors: isRecord(raw) && Array.isArray(raw.remote_errors) ? raw.remote_errors : undefined,
    };
  },
});

export const syncCollection = defineTool({
  name: 'sync_collection',
  description:
    'Sync a collection to a sales channel (creates/updates the channel-side category and places all products in it that are already synced there). integration_uuid selects which channel; not all channels support collections (e.g. TikTok Shop), which returns a clear "collections_unsupported" error.',
  inputSchema: z.object({
    ...storeInput,
    collection_uuid: z.string().min(1),
    integration_uuid: z
      .string()
      .min(1)
      .describe('The sales-channel integration to sync this collection to (required by the platform).'),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    // integration_uuid is a QUERY param on this endpoint, not a body field.
    const raw = await ctx.api.post(
      `store/${enc(input.store_uuid)}/collections/${enc(input.collection_uuid)}/sync`,
      {
        query: { integration_uuid: input.integration_uuid },
        workspace: input.workspace,
        signal: ctx.signal,
      },
    );
    return {
      collection_uuid: input.collection_uuid,
      integration_uuid: input.integration_uuid,
      view_url: viewUrl.store(input.store_uuid),
      message: str(raw, 'message'),
      external_id: str(raw, 'external_id', 'external_reference_id'),
      products_added: num(raw, 'products_added'),
      products_skipped: num(raw, 'products_skipped'),
    };
  },
});

export const collectionTools: ToolDef[] = [
  listCollections,
  getCollection,
  createCollection,
  updateCollection,
  deleteCollection,
  addProductsToCollection,
  removeProductFromCollection,
  syncCollection,
];

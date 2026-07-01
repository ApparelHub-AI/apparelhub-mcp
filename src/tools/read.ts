import { z } from 'zod';
import { defineTool, type ToolDef } from './registry.js';
import { asArray, bool, isRecord, str, viewUrl } from '../util/shape.js';

// Read tools (tool spec §5). Thin, clean projections over the /agents/v1 read endpoints.
// Mappers are deliberately tolerant of field-name variants (uuid vs *_uuid, channel vs
// provider_name, etc.) so a minor live-API shape difference degrades to a missing field
// rather than a crash. Validate field names against a live key before the first release.

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
  const providersRaw = isRecord(raw)
    ? (raw.merchandise_providers ?? raw.fulfillment_providers)
    : undefined;
  const integrationsRaw = isRecord(raw)
    ? (raw.ecommerce_integrations ?? raw.integrations)
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

const listMyStoresInput = z.object({
  workspace: z
    .string()
    .optional()
    .describe('Workspace uuid to scope to (agency accounts). Omit for the Default workspace.'),
});
type ListMyStoresInput = z.infer<typeof listMyStoresInput>;

export const listMyStores = defineTool({
  name: 'list_my_stores',
  description:
    "List the merchant's ApparelHub stores, each with its fulfillment providers (Printful/Printify) and connected sales channels (Shopify/WooCommerce/Wix). Read-only.",
  inputSchema: listMyStoresInput,
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input: ListMyStoresInput, ctx) => {
    const raw = await ctx.api.get('store', { workspace: input.workspace, signal: ctx.signal });
    const stores = asArray(raw, 'stores').map(mapStore);
    return { stores, total: stores.length };
  },
});

// The read-tool set. Ticket #13 adds list_my_designs / list_my_products / list_my_orders /
// get_order_details alongside list_my_stores here.
export const readTools: ToolDef[] = [listMyStores];

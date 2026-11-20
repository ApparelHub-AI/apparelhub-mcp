import { z } from 'zod';
import { defineTool, type ToolDef } from './registry.js';
import { asArray, bool, isRecord, num, str } from '../util/shape.js';

// Where everything is listed, by STOREFRONT, across every store and workspace (an internal
// platform epic). The platform builds the whole table server-side and the merchant's own
// "Where it's listed" page reads the same result, so what an agent is told matches what the
// merchant sees.
//
// A storefront is one real shop (provider + shop), however many ApparelHub stores are
// connected to it: one WooCommerce shop connected under five stores is ONE column, naming all
// five. A product ApparelHub made is one row however many stores hold it; a listing the
// merchant made on the channel (tracked) is one row per shop however many stores imported it.

const workspaceField = z
  .string()
  .optional()
  .describe(
    'Workspace uuid. Only used with all_workspaces=false. Omit to see every workspace you can reach.',
  );

function mapStoreRef(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {
    store_uuid: str(raw, 'uuid'),
    name: str(raw, 'name'),
    workspace_uuid: str(raw, 'workspace_uuid') ?? null,
    workspace_name: str(raw, 'workspace_name') ?? null,
  };
  const integ = str(raw, 'integration_uuid');
  if (integ !== undefined) {
    out.integration_uuid = integ;
    out.is_primary_for_shop = bool(raw, 'is_primary_for_shop') ?? false;
    out.last_import_at = str(raw, 'last_import_at') ?? null;
  }
  return out;
}

export function mapStorefront(raw: unknown): Record<string, unknown> {
  return {
    key: str(raw, 'key'),
    provider: str(raw, 'provider'),
    shop_label: str(raw, 'shop_label') ?? str(raw, 'shop_url') ?? null,
    shop_url: str(raw, 'shop_url') ?? null,
    admin_url: str(raw, 'admin_url') ?? null,
    stores: asArray(isRecord(raw) ? raw.stores : undefined).map(mapStoreRef),
    listed: num(raw, 'listed') ?? 0,
  };
}

function mapCell(raw: unknown): Record<string, unknown> {
  return {
    status: str(raw, 'status') ?? 'not_listed',
    managed_by: str(raw, 'managed_by') ?? 'apparelhub',
    store_uuid: str(raw, 'store_uuid') ?? null,
    workspace_uuid: str(raw, 'workspace_uuid') ?? null,
    integration_uuid: str(raw, 'integration_uuid') ?? null,
    error: str(raw, 'error') ?? null,
  };
}

export function mapRow(raw: unknown): Record<string, unknown> {
  const cellsRaw = isRecord(raw) && isRecord(raw.cells) ? raw.cells : {};
  const cells: Record<string, unknown> = {};
  for (const [key, cell] of Object.entries(cellsRaw)) cells[key] = mapCell(cell);
  const kind = str(raw, 'kind') ?? 'product';
  const out: Record<string, unknown> = {
    kind,
    uuid: str(raw, 'uuid'),
    name: str(raw, 'name'),
    thumbnail_url: str(raw, 'thumbnail_url') ?? null,
    product_uuid: str(raw, 'product_uuid') ?? null,
    stores: asArray(isRecord(raw) ? raw.stores : undefined).map(mapStoreRef),
    cells,
  };
  if (bool(raw, 'in_no_store')) out.in_no_store = true;
  if (kind === 'tracked') {
    out.external_id = str(raw, 'external_id') ?? null;
    const listing = isRecord(raw) && isRecord(raw.listing) ? raw.listing : undefined;
    out.listing = listing
      ? {
          listing_uuid: str(listing, 'uuid'),
          store_uuid: str(listing, 'store_uuid'),
          workspace_uuid: str(listing, 'workspace_uuid') ?? null,
          bound: bool(listing, 'bound') ?? false,
          binding: isRecord(listing.binding) ? listing.binding : null,
        }
      : null;
  }
  return out;
}

export const whereItsListed = defineTool({
  name: 'where_its_listed',
  description:
    "Where every product is listed, by storefront, across all of the merchant's stores and (by " +
    'default) all of their workspaces. One table: `storefronts` are the real shops (provider + ' +
    "shop) with every ApparelHub store connected to each and the shop's `admin_url`; `rows` are " +
    'products ApparelHub made (`kind: product`, one row however many stores hold it) and the ' +
    "merchant's own channel listings (`kind: tracked`, one row per shop); each `cells[<storefront " +
    'key>]` gives the status there (listed / in_progress / failed / not_listed / draft / archived) ' +
    'and `managed_by`: `apparelhub` (ApparelHub made and syncs it) or `channel` (the merchant made ' +
    'it on the channel and manages it there; it is on sale but cannot be changed from ApparelHub). ' +
    'A missing cell means the product is in no store connected to that shop. Use this instead of ' +
    'composing stores x products x tracked listings yourself; it is the same data the merchant sees ' +
    "on their Where it's listed page. Rows are paged; `totals` and `storefronts` describe the whole " +
    'filtered set. Read-only.',
  inputSchema: z.object({
    all_workspaces: z
      .boolean()
      .optional()
      .describe(
        'Default true: every workspace you can reach. false = one workspace (see `workspace`).',
      ),
    workspace: workspaceField,
    store: z
      .string()
      .optional()
      .describe('Only this store uuid and the storefronts it is connected to.'),
    provider: z
      .string()
      .optional()
      .describe(
        'Only storefronts on this sales channel, by name (e.g. "WooCommerce", "TikTok Shop").',
      ),
    q: z.string().optional().describe('Product name contains this text.'),
    filter: z
      .enum(['all', 'nowhere', 'failed', 'external'])
      .optional()
      .describe(
        '"nowhere" = listed on no storefront; "failed" = a failed sync somewhere; "external" = only ' +
          "the merchant's own channel listings. Default all.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe('Rows per page, 1-1000. Default 200.'),
    offset: z.number().int().min(0).optional().describe('Rows to skip. Default 0.'),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const all = input.all_workspaces !== false && !input.workspace;
    const raw = await ctx.api.get('store/listings/matrix', {
      query: {
        all_workspaces: all ? 'true' : 'false',
        store: input.store,
        provider: input.provider,
        q: input.q,
        filter: input.filter,
        limit: input.limit,
        offset: input.offset,
      },
      workspace: all ? undefined : input.workspace,
      signal: ctx.signal,
    });
    const storefronts = asArray(isRecord(raw) ? raw.storefronts : undefined).map(mapStorefront);
    const rows = asArray(isRecord(raw) ? raw.rows : undefined).map(mapRow);
    const totalsRaw = isRecord(raw) && isRecord(raw.totals) ? raw.totals : {};
    return {
      all_workspaces: all,
      workspaces: asArray(isRecord(raw) ? raw.workspaces : undefined).map((w) => ({
        workspace_uuid: str(w, 'uuid'),
        name: str(w, 'name'),
        is_default: bool(w, 'is_default') ?? false,
      })),
      storefronts,
      rows,
      total_rows: num(raw, 'total_rows') ?? rows.length,
      limit: num(raw, 'limit') ?? input.limit ?? 200,
      offset: num(raw, 'offset') ?? input.offset ?? 0,
      totals: {
        products: num(totalsRaw, 'products') ?? rows.length,
        storefronts: num(totalsRaw, 'storefronts') ?? storefronts.length,
        listed_nowhere: num(totalsRaw, 'listed_nowhere') ?? 0,
        failed: num(totalsRaw, 'failed') ?? 0,
        external: num(totalsRaw, 'external') ?? 0,
        per_storefront: isRecord(totalsRaw.per_storefront) ? totalsRaw.per_storefront : {},
      },
      note:
        'A cell managed_by "channel" is a listing the merchant made on the channel: ApparelHub shows ' +
        'it but cannot change it; bind_tracked_listing makes ApparelHub fulfil it. To act on a ' +
        'listed product, use the store_uuid the cell names.',
    };
  },
});

export const listingTools: ToolDef[] = [whereItsListed];

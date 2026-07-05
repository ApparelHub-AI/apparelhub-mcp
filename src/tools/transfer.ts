import { z } from 'zod';
import { defineTool, type ToolDef } from './registry.js';
import { asArray, bool, isRecord, str, viewUrl } from '../util/shape.js';

// Cross-workspace copy/move for agency accounts (platform epic #410 / #424,
// api-contract asset-transfer). These fill the capability gap where an agency
// managing several client workspaces needs to reuse a product or a design in
// another workspace.
//
// Platform contract (confirmed against api/product.py, api/images.py,
// common/services/asset_transfer.py):
//   - The DESTINATION workspace is the field `workspace_uuid`. For copy/move it
//     is a POST *body* field; for move-eligibility it is a *query* param.
//   - Reading / acting on an asset that lives in a workspace OTHER than the
//     account's active (Default) one requires scoping the request to that
//     SOURCE workspace via `?workspace=<source>` (workspace_scope_mode=enforce).
//     So a transfer needs BOTH: `source_workspace` -> the ApiClient `workspace`
//     option (?workspace=), and `destination_workspace` -> `workspace_uuid`.
//   - copy = a non-destructive DRAFT duplicate (the original is untouched; an
//     image copy also duplicates the underlying file). It has no in-use guards.
//   - move = re-stamps the asset's workspace. It is guarded server-side: if the
//     asset is mapped to a store (`asset_in_use`) or referenced by orders
//     (`asset_has_orders`) the platform returns 409 with a `blocking` list. The
//     ApiClient turns a 409 into an AhError, which we let surface (the message +
//     details tell the agent to copy instead). move is NOT destructive to the
//     source, so it is annotated openWorldHint only (not destructiveHint).
//   - move-eligibility is a read-only GET dry run returning {eligible, blockers}
//     so the agent can check before attempting a move.

const enc = encodeURIComponent;

const DEST_WORKSPACE = z
  .string()
  .min(1)
  .describe(
    'Destination workspace uuid to copy/move into. Get it from list_my_workspaces (resolve a client/brand name to its uuid).',
  );
const SOURCE_WORKSPACE = z
  .string()
  .optional()
  .describe(
    'The workspace the asset currently lives in. Omit only if it is in your Default workspace; otherwise you must pass it (the platform scopes reads to a single workspace).',
  );

// Explicit per-asset input shapes. A computed-key factory (`[assetKey]: ...`)
// would widen the asset uuid to `string | undefined` (TS can't resolve a dynamic
// key), which then fails everywhere a concrete string is required.
const productTransferInput = z.object({
  product_uuid: z.string().min(1).describe('The product to transfer.'),
  destination_workspace: DEST_WORKSPACE,
  source_workspace: SOURCE_WORKSPACE,
});
const designTransferInput = z.object({
  design_uuid: z.string().min(1).describe('The design to transfer.'),
  destination_workspace: DEST_WORKSPACE,
  source_workspace: SOURCE_WORKSPACE,
});

/** The copy/move endpoints wrap the entity under `product`/`image`; unwrap it. */
function unwrapEntity(raw: unknown, key: 'product' | 'image'): unknown {
  return isRecord(raw) && isRecord(raw[key]) ? raw[key] : raw;
}

/** Normalize an eligibility payload to {eligible, blockers:[{reason}...]}. */
function mapEligibility(raw: unknown): { eligible: boolean; blockers: Record<string, unknown>[] } {
  const blockers = asArray(isRecord(raw) ? raw.blockers : undefined).map((b) => {
    const out: Record<string, unknown> = { reason: str(b, 'reason', 'code') };
    const detail = str(b, 'message', 'detail');
    if (detail) out.message = detail;
    const storeUuid = str(b, 'store_uuid');
    if (storeUuid) out.store_uuid = storeUuid;
    const storeName = str(b, 'store_name');
    if (storeName) out.store_name = storeName;
    return out;
  });
  const eligible = bool(raw, 'eligible') ?? blockers.length === 0;
  return { eligible, blockers };
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export const copyProductToWorkspace = defineTool({
  name: 'copy_product_to_workspace',
  description:
    'Copy a product into another workspace (agency accounts). Non-destructive: the original is untouched and the copy lands as an unsynced DRAFT (no store mapping, fresh variants). Use list_my_workspaces to get the destination workspace uuid. If the product lives in a non-Default workspace, pass source_workspace too.',
  inputSchema: productTransferInput,
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.post(`product/${enc(input.product_uuid)}/copy`, {
      body: { workspace_uuid: input.destination_workspace },
      workspace: input.source_workspace,
      signal: ctx.signal,
    });
    const product = unwrapEntity(raw, 'product');
    const newUuid = str(product, 'uuid', 'product_uuid') ?? '';
    return {
      new_product_uuid: newUuid,
      source_product_uuid: input.product_uuid,
      destination_workspace: input.destination_workspace,
      ...(newUuid ? { view_url: viewUrl.product(newUuid) } : {}),
    };
  },
});

export const moveProductToWorkspace = defineTool({
  name: 'move_product_to_workspace',
  description:
    'Move a product to another workspace (agency accounts) by re-stamping its workspace. Fails with a 409 (blocking list) if the product is mapped to a store or has orders — copy it instead in that case (check first with check_product_move). Use list_my_workspaces for the destination uuid; pass source_workspace if the product is not in your Default workspace.',
  inputSchema: productTransferInput,
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.post(`product/${enc(input.product_uuid)}/move`, {
      body: { workspace_uuid: input.destination_workspace },
      workspace: input.source_workspace,
      signal: ctx.signal,
    });
    const product = unwrapEntity(raw, 'product');
    const uuid = str(product, 'uuid', 'product_uuid') ?? input.product_uuid;
    return {
      product_uuid: uuid,
      moved: true,
      destination_workspace: input.destination_workspace,
      view_url: viewUrl.product(uuid),
    };
  },
});

export const checkProductMove = defineTool({
  name: 'check_product_move',
  description:
    'Dry run: report whether a product can be MOVED to another workspace, without changing anything. Returns {eligible, blockers} — a non-empty blockers list (e.g. asset_in_use, asset_has_orders, forbidden_source/destination) means move would fail, so copy instead. Read-only.',
  inputSchema: z.object({
    product_uuid: z.string().min(1).describe('The product to check.'),
    destination_workspace: z
      .string()
      .min(1)
      .describe('Destination workspace uuid (from list_my_workspaces).'),
    source_workspace: z
      .string()
      .optional()
      .describe('The product\'s current workspace uuid; omit only if it is in your Default workspace.'),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.get(`product/${enc(input.product_uuid)}/move-eligibility`, {
      query: { workspace_uuid: input.destination_workspace },
      workspace: input.source_workspace,
      signal: ctx.signal,
    });
    return mapEligibility(raw);
  },
});

// ---------------------------------------------------------------------------
// Designs (generated images)
// ---------------------------------------------------------------------------

export const copyDesignToWorkspace = defineTool({
  name: 'copy_design_to_workspace',
  description:
    'Copy a generated design image into another workspace (agency accounts). Non-destructive: the original stays put and the copy gets its own duplicated image file. Use list_my_workspaces for the destination uuid; pass source_workspace if the design is not in your Default workspace.',
  inputSchema: designTransferInput,
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.post(`images/generated/${enc(input.design_uuid)}/copy`, {
      body: { workspace_uuid: input.destination_workspace },
      workspace: input.source_workspace,
      signal: ctx.signal,
    });
    const image = unwrapEntity(raw, 'image');
    const newUuid = str(image, 'uuid', 'design_uuid') ?? '';
    return {
      new_design_uuid: newUuid,
      source_design_uuid: input.design_uuid,
      destination_workspace: input.destination_workspace,
      view_url: viewUrl.designs(),
    };
  },
});

export const moveDesignToWorkspace = defineTool({
  name: 'move_design_to_workspace',
  description:
    'Move a generated design image to another workspace (agency accounts). Fails with a 409 (blocking list) if a product that uses the design is mapped to a store or has orders — copy it instead in that case (check first with check_design_move). Use list_my_workspaces for the destination uuid; pass source_workspace if the design is not in your Default workspace.',
  inputSchema: designTransferInput,
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.post(`images/generated/${enc(input.design_uuid)}/move`, {
      body: { workspace_uuid: input.destination_workspace },
      workspace: input.source_workspace,
      signal: ctx.signal,
    });
    const image = unwrapEntity(raw, 'image');
    const uuid = str(image, 'uuid', 'design_uuid') ?? input.design_uuid;
    return {
      design_uuid: uuid,
      moved: true,
      destination_workspace: input.destination_workspace,
      view_url: viewUrl.designs(),
    };
  },
});

export const checkDesignMove = defineTool({
  name: 'check_design_move',
  description:
    'Dry run: report whether a generated design can be MOVED to another workspace, without changing anything. Returns {eligible, blockers} — a non-empty blockers list (a product using the design is in use, or forbidden_source/destination) means move would fail, so copy instead. Read-only.',
  inputSchema: z.object({
    design_uuid: z.string().min(1).describe('The design to check.'),
    destination_workspace: z
      .string()
      .min(1)
      .describe('Destination workspace uuid (from list_my_workspaces).'),
    source_workspace: z
      .string()
      .optional()
      .describe('The design\'s current workspace uuid; omit only if it is in your Default workspace.'),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.get(`images/generated/${enc(input.design_uuid)}/move-eligibility`, {
      query: { workspace_uuid: input.destination_workspace },
      workspace: input.source_workspace,
      signal: ctx.signal,
    });
    return mapEligibility(raw);
  },
});

export const transferTools: ToolDef[] = [
  copyProductToWorkspace,
  moveProductToWorkspace,
  checkProductMove,
  copyDesignToWorkspace,
  moveDesignToWorkspace,
  checkDesignMove,
];

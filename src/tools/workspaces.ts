import { z } from 'zod';
import { defineTool, type ToolDef } from './registry.js';
import { bool, isRecord, str } from '../util/shape.js';

// Workspace & team management for agency (Enterprise) accounts. Agent twins of
// the platform's account/workspace routes (api/account.py + api/store.py). These
// let an agency create client workspaces, invite/assign teammates, and organize
// stores WITHOUT dropping to the web UI.
//
// Platform contract (api/agents.py):
//   - All routes here require an ACCOUNT-WIDE api key + the agency feature. A
//     workspace-scoped key gets 403 account_wide_key_required; a tier without the
//     feature gets 403 feature_unavailable. accept_invite is the exception — the
//     invitee side, allowed on any tier / any key.
//   - Discover workspace uuids with list_my_workspaces; member public_ids and
//     invite uuids come from list_account_members / list_invites.
//   - Roles: workspace roles are director|creator|merchandiser|operator|viewer;
//     account roles are admin|member.

const enc = encodeURIComponent;

const WORKSPACE_UUID = z
  .string()
  .min(1)
  .describe('Workspace uuid (from list_my_workspaces).');

const workspaceRole = z
  .enum(['director', 'creator', 'merchandiser', 'operator', 'viewer'])
  .describe(
    'Workspace role: director (full control), creator (design/build), merchandiser (price/publish), operator (post-sale), viewer (read-only).',
  );

/** Clean a workspace object to the shape the agent already sees from list_my_workspaces. */
function mapWorkspace(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {
    workspace_uuid: str(raw, 'uuid', 'workspace_uuid', 'id'),
    name: str(raw, 'name'),
    is_default: bool(raw, 'is_default'),
    archived: bool(raw, 'archived'),
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

/** The account/team payloads are already agent-clean; return them as an object. */
function rec(raw: unknown): Record<string, unknown> {
  return isRecord(raw) ? raw : { result: raw };
}

function unwrapWorkspace(raw: unknown): unknown {
  return isRecord(raw) && isRecord(raw.workspace) ? raw.workspace : raw;
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export const createWorkspace = defineTool({
  name: 'create_workspace',
  description:
    'Create a new workspace in the account (agency / Enterprise). Name must be unique within the account. Needs an account-wide key; a tier without the agency feature gets feature_unavailable. Returns the new workspace uuid.',
  inputSchema: z.object({
    name: z.string().min(1).describe('Workspace name (unique within the account, max 128 chars).'),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.post('workspaces', { body: { name: input.name }, signal: ctx.signal });
    return { workspace: mapWorkspace(unwrapWorkspace(raw)), created: true };
  },
});

export const updateWorkspace = defineTool({
  name: 'update_workspace',
  description:
    'Rename a workspace or archive/unarchive it (agency / Enterprise). The Default workspace cannot be archived. Needs an account-wide key.',
  inputSchema: z.object({
    workspace_uuid: WORKSPACE_UUID,
    name: z.string().min(1).optional().describe('New name (max 128 chars).'),
    archived: z.boolean().optional().describe('Archive (true) or unarchive (false). Ignored for the Default workspace.'),
  }),
  annotations: { idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const body: Record<string, unknown> = {};
    if (input.name !== undefined) body.name = input.name;
    if (input.archived !== undefined) body.archived = input.archived;
    const raw = await ctx.api.patch(`workspaces/${enc(input.workspace_uuid)}`, {
      body,
      signal: ctx.signal,
    });
    return { workspace: mapWorkspace(unwrapWorkspace(raw)), updated: true };
  },
});

export const checkWorkspaceDeletion = defineTool({
  name: 'check_workspace_deletion',
  description:
    'Dry run: preview deleting a workspace (agency / Enterprise) — the stores that would move to the Default workspace and the members whose assignment would be revoked. Changes nothing. Read-only.',
  inputSchema: z.object({ workspace_uuid: WORKSPACE_UUID }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.get(`workspaces/${enc(input.workspace_uuid)}/deletion-impact`, {
      signal: ctx.signal,
    });
    return rec(raw);
  },
});

export const deleteWorkspace = defineTool({
  name: 'delete_workspace',
  description:
    'Delete a workspace (agency / Enterprise). Its stores are reassigned to the Default workspace and member assignments revoked first. The Default workspace cannot be deleted. Preview with check_workspace_deletion. Needs an account-wide key.',
  inputSchema: z.object({ workspace_uuid: WORKSPACE_UUID }),
  annotations: { destructiveHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.del(`workspaces/${enc(input.workspace_uuid)}`, { signal: ctx.signal });
    return { deleted: true, ...rec(raw) };
  },
});

export const assignWorkspaceMember = defineTool({
  name: 'assign_workspace_member',
  description:
    'Assign an account member to a workspace with a role, or update their existing role (agency / Enterprise). The target must already be a member of the account (invite_member first). Needs an account-wide key.',
  inputSchema: z.object({
    workspace_uuid: WORKSPACE_UUID,
    user_public_id: z.string().min(1).describe("The member's user public_id (from list_account_members)."),
    role: workspaceRole,
  }),
  annotations: { idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.post(`workspaces/${enc(input.workspace_uuid)}/assignments`, {
      body: { user_public_id: input.user_public_id, role: input.role },
      signal: ctx.signal,
    });
    return { assigned: true, ...rec(raw) };
  },
});

export const unassignWorkspaceMember = defineTool({
  name: 'unassign_workspace_member',
  description:
    "Revoke a member's assignment to a workspace (agency / Enterprise). The account owner cannot be unassigned from the Default workspace. Needs an account-wide key.",
  inputSchema: z.object({
    workspace_uuid: WORKSPACE_UUID,
    user_public_id: z.string().min(1).describe("The member's user public_id."),
  }),
  annotations: { destructiveHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.del(
      `workspaces/${enc(input.workspace_uuid)}/assignments/${enc(input.user_public_id)}`,
      { signal: ctx.signal },
    );
    return { unassigned: true, ...rec(raw) };
  },
});

export const moveStoreToWorkspace = defineTool({
  name: 'move_store_to_workspace',
  description:
    "Move a store into one of the account's workspaces (agency / Enterprise). This changes who can access the store, so it needs account owner/admin + an account-wide key.",
  inputSchema: z.object({
    store_uuid: z.string().min(1).describe('The store to move (from list_my_stores).'),
    workspace_uuid: WORKSPACE_UUID.describe('Destination workspace uuid (in the same account).'),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.patch(`store/${enc(input.store_uuid)}/workspace`, {
      body: { workspace_uuid: input.workspace_uuid },
      signal: ctx.signal,
    });
    return { moved: true, ...rec(raw) };
  },
});

// ---------------------------------------------------------------------------
// Team / account
// ---------------------------------------------------------------------------

export const getAccountOverview = defineTool({
  name: 'get_account_overview',
  description:
    'Account name, your role, whether the agency feature is enabled, and seat accounting (used / included / billable). Agency / Enterprise; needs an account-wide key. Read-only.',
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (_input, ctx) => rec(await ctx.api.get('account', { signal: ctx.signal })),
});

export const getRoleMatrix = defineTool({
  name: 'get_role_matrix',
  description:
    'The workspace roles and the role → capability matrix, so you can pick a role before assigning a member. Agency / Enterprise; needs an account-wide key. Read-only.',
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (_input, ctx) => rec(await ctx.api.get('account/role-matrix', { signal: ctx.signal })),
});

export const listAccountMembers = defineTool({
  name: 'list_account_members',
  description:
    'List account members and their per-workspace assignments (agency / Enterprise). Filterable + paginated. Needs an account-wide key. Read-only.',
  inputSchema: z.object({
    q: z.string().optional().describe('Free-text match on email/username.'),
    in_workspace: z.string().optional().describe('Only members assigned to this workspace uuid.'),
    account_role: z.enum(['owner', 'admin', 'member']).optional().describe('Filter by account role.'),
    workspace_role: z
      .enum(['director', 'creator', 'merchandiser', 'operator', 'viewer'])
      .optional()
      .describe('Members holding this workspace role (combine with in_workspace for "role in that workspace").'),
    page: z.number().int().positive().optional().describe('Page number (default 1).'),
    per_page: z.number().int().positive().max(100).optional().describe('Page size (default 50, max 100).'),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const query: Record<string, string | number | undefined> = {
      q: input.q,
      in_workspace: input.in_workspace,
      account_role: input.account_role,
      workspace_role: input.workspace_role,
      page: input.page,
      per_page: input.per_page,
    };
    return rec(await ctx.api.get('account/members', { query, signal: ctx.signal }));
  },
});

export const removeMember = defineTool({
  name: 'remove_member',
  description:
    'Remove a member from the account entirely (agency / Enterprise): all their workspace assignments are revoked and seat billing synced. The account owner cannot be removed. Needs an account-wide key.',
  inputSchema: z.object({
    user_public_id: z.string().min(1).describe("The member's user public_id (from list_account_members)."),
  }),
  annotations: { destructiveHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.del(`account/members/${enc(input.user_public_id)}`, { signal: ctx.signal });
    return { removed: true, ...rec(raw) };
  },
});

export const inviteMember = defineTool({
  name: 'invite_member',
  description:
    'Invite someone to the account by email, optionally pre-assigning a workspace + role (agency / Enterprise). An existing ApparelHub user is auto-added immediately; a new email gets a pending invite. Needs an account-wide key.',
  inputSchema: z.object({
    email: z.string().min(3).describe('Email to invite.'),
    account_role: z.enum(['admin', 'member']).optional().describe('Account role (default member).'),
    workspace_uuid: z.string().optional().describe('Optional: pre-assign to this workspace uuid.'),
    role: workspaceRole.optional().describe('Workspace role (required when workspace_uuid is set).'),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    const body: Record<string, unknown> = { email: input.email };
    if (input.account_role !== undefined) body.account_role = input.account_role;
    if (input.workspace_uuid !== undefined) body.workspace_uuid = input.workspace_uuid;
    if (input.role !== undefined) body.role = input.role;
    return rec(await ctx.api.post('account/members/invite', { body, signal: ctx.signal }));
  },
});

export const listInvites = defineTool({
  name: 'list_invites',
  description:
    'List the account’s pending invites, each with the target workspace name and a copyable accept URL (agency / Enterprise). Needs an account-wide key. Read-only.',
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (_input, ctx) => rec(await ctx.api.get('account/invites', { signal: ctx.signal })),
});

export const revokeInvite = defineTool({
  name: 'revoke_invite',
  description:
    'Revoke a pending invite so its token can no longer be used (agency / Enterprise). Needs an account-wide key.',
  inputSchema: z.object({
    invite_uuid: z.string().min(1).describe('The pending invite uuid (from list_invites).'),
  }),
  annotations: { destructiveHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = await ctx.api.del(`account/invites/${enc(input.invite_uuid)}`, { signal: ctx.signal });
    return { revoked: true, ...rec(raw) };
  },
});

export const resendInvite = defineTool({
  name: 'resend_invite',
  description:
    'Re-send a pending invite’s email with the SAME token and extend its TTL 14 days (agency / Enterprise). Needs an account-wide key.',
  inputSchema: z.object({
    invite_uuid: z.string().min(1).describe('The pending invite uuid (from list_invites).'),
  }),
  annotations: { idempotentHint: true, openWorldHint: true },
  handler: async (input, ctx) =>
    rec(await ctx.api.post(`account/invites/${enc(input.invite_uuid)}/resend`, { signal: ctx.signal })),
});

export const acceptInvite = defineTool({
  name: 'accept_invite',
  description:
    'Accept a pending invite by token. The authenticated key-holder’s email must match the invite. Works on any tier and with a workspace-scoped key (the invitee side). Returns the account + workspace you were added to.',
  inputSchema: z.object({
    token: z.string().min(1).describe('The invite token (from the invite email / accept URL).'),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) =>
    rec(await ctx.api.post('account/invites/accept', { body: { token: input.token }, signal: ctx.signal })),
});

export const workspaceTools: ToolDef[] = [
  createWorkspace,
  updateWorkspace,
  checkWorkspaceDeletion,
  deleteWorkspace,
  assignWorkspaceMember,
  unassignWorkspaceMember,
  moveStoreToWorkspace,
  getAccountOverview,
  getRoleMatrix,
  listAccountMembers,
  removeMember,
  inviteMember,
  listInvites,
  revokeInvite,
  resendInvite,
  acceptInvite,
];

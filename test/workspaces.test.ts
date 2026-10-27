import { describe, it, expect } from 'vitest';
import {
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
  checkWorkspaceDeletion,
  assignWorkspaceMember,
  moveStoreToWorkspace,
  inviteMember,
  listAccountMembers,
  acceptInvite,
  workspaceTools,
} from '../src/tools/workspaces.js';
import { fakeContext } from './helpers/ctx.js';
import { apiRecording } from './helpers/fakeFetch.js';

// Generic placeholders only (public repo — Rule 13): short ids, no real account
// data. w1/s1 = uuids, u1 = member public_id, i1 = invite uuid, "Acme Co" name,
// acme@example.com email.

describe('create_workspace', () => {
  it('POSTs the name and returns the new workspace uuid', async () => {
    const { api, calls } = apiRecording({ message: 'Workspace created', workspace: { uuid: 'w1', name: 'Acme Co', is_default: false } });
    const res = (await createWorkspace.handler({ name: 'Acme Co' }, fakeContext(api))) as any;
    const call = calls[0]!;
    expect(call.init?.method).toBe('POST');
    expect(call.url).toContain('/workspaces');
    expect(JSON.parse(call.init?.body as string)).toEqual({ name: 'Acme Co' });
    expect(res).toMatchObject({ created: true, workspace: { workspace_uuid: 'w1', name: 'Acme Co', is_default: false } });
  });
});

describe('update_workspace', () => {
  it('PATCHes only the provided fields', async () => {
    const { api, calls } = apiRecording({ workspace: { uuid: 'w1', name: 'Renamed', archived: true } });
    await updateWorkspace.handler({ workspace_uuid: 'w1', name: 'Renamed', archived: true }, fakeContext(api));
    const call = calls[0]!;
    expect(call.init?.method).toBe('PATCH');
    expect(call.url).toContain('/workspaces/w1');
    expect(JSON.parse(call.init?.body as string)).toEqual({ name: 'Renamed', archived: true });
  });

  it('omits fields that were not supplied', async () => {
    const { api, calls } = apiRecording({ workspace: { uuid: 'w1' } });
    await updateWorkspace.handler({ workspace_uuid: 'w1', archived: false }, fakeContext(api));
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ archived: false });
  });
});

describe('delete_workspace + check_workspace_deletion', () => {
  it('deletes via DELETE and surfaces the counts', async () => {
    const { api, calls } = apiRecording({ message: 'Workspace deleted', moved_store_count: 2, revoked_member_count: 1 });
    const res = (await deleteWorkspace.handler({ workspace_uuid: 'w1' }, fakeContext(api))) as any;
    expect(calls[0]!.init?.method).toBe('DELETE');
    expect(calls[0]!.url).toContain('/workspaces/w1');
    expect(res).toMatchObject({ deleted: true, moved_store_count: 2, revoked_member_count: 1 });
  });

  it('deletion-impact is a GET dry run', async () => {
    const { api, calls } = apiRecording({ stores: [{ uuid: 's1', name: 'Acme Store' }], members: [] });
    const res = (await checkWorkspaceDeletion.handler({ workspace_uuid: 'w1' }, fakeContext(api))) as any;
    expect(calls[0]!.init?.method ?? 'GET').toBe('GET');
    expect(calls[0]!.url).toContain('/workspaces/w1/deletion-impact');
    expect(res.stores).toEqual([{ uuid: 's1', name: 'Acme Store' }]);
  });
});

describe('assign_workspace_member', () => {
  it('POSTs user_public_id + role to the workspace assignments', async () => {
    const { api, calls } = apiRecording({ message: 'Assignment saved' });
    await assignWorkspaceMember.handler({ workspace_uuid: 'w1', user_public_id: 'u1', role: 'director' }, fakeContext(api));
    expect(calls[0]!.url).toContain('/workspaces/w1/assignments');
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ user_public_id: 'u1', role: 'director' });
  });
});

describe('move_store_to_workspace', () => {
  it('PATCHes the store workspace with workspace_uuid in the body', async () => {
    const { api, calls } = apiRecording({ message: 'Store moved to workspace', workspace_uuid: 'w1' });
    await moveStoreToWorkspace.handler({ store_uuid: 's1', workspace_uuid: 'w1' }, fakeContext(api));
    expect(calls[0]!.init?.method).toBe('PATCH');
    expect(calls[0]!.url).toContain('/store/s1/workspace');
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ workspace_uuid: 'w1' });
  });
});

describe('invite_member', () => {
  it('sends email + only the optional fields provided', async () => {
    const { api, calls } = apiRecording({ message: 'Invitation sent', email_sent: true });
    await inviteMember.handler({ email: 'acme@example.com', workspace_uuid: 'w1', role: 'creator' }, fakeContext(api));
    expect(calls[0]!.url).toContain('/account/members/invite');
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ email: 'acme@example.com', workspace_uuid: 'w1', role: 'creator' });
  });

  it('sends just the email when nothing else is supplied', async () => {
    const { api, calls } = apiRecording({ message: 'Invitation sent' });
    await inviteMember.handler({ email: 'acme@example.com' }, fakeContext(api));
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ email: 'acme@example.com' });
  });
});

describe('list_account_members', () => {
  it('passes filters as query params and drops the absent ones', async () => {
    const { api, calls } = apiRecording({ members: [], total: 0, page: 2, per_page: 25 });
    await listAccountMembers.handler({ page: 2, per_page: 25, account_role: 'admin' }, fakeContext(api));
    const url = calls[0]!.url;
    expect(url).toContain('/account/members');
    expect(url).toContain('page=2');
    expect(url).toContain('per_page=25');
    expect(url).toContain('account_role=admin');
    expect(url).not.toContain('q=');
    expect(url).not.toContain('workspace_role=');
  });
});

describe('accept_invite', () => {
  it('POSTs the token to the accept endpoint', async () => {
    const { api, calls } = apiRecording({ message: 'Invitation accepted', account_uuid: 'a1', workspace_uuid: 'w1' });
    const res = (await acceptInvite.handler({ token: 'tok123' }, fakeContext(api))) as any;
    expect(calls[0]!.url).toContain('/account/invites/accept');
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual({ token: 'tok123' });
    expect(res).toMatchObject({ message: 'Invitation accepted', account_uuid: 'a1' });
  });
});

describe('workspace tool surface', () => {
  it('exports 16 tools with unique names + valid object schemas', () => {
    expect(workspaceTools).toHaveLength(16);
    const names = workspaceTools.map((t) => t.name);
    expect(new Set(names).size).toBe(16);
    // accept_invite is the only one that is not agency-gated server-side, but all
    // are still declared here.
    expect(names).toContain('create_workspace');
    expect(names).toContain('accept_invite');
  });
});

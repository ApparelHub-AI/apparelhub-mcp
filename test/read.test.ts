import { describe, it, expect } from 'vitest';
import { listMyStores, listMyWorkspaces } from '../src/tools/read.js';
import { ApiClient } from '../src/http/client.js';
import { fakeContext } from './helpers/ctx.js';
import { jsonResponse, queueFetch, noSleep } from './helpers/fakeFetch.js';

function apiReturning(raw: unknown): ApiClient {
  const { fetchImpl } = queueFetch([jsonResponse(200, raw)]);
  return new ApiClient({
    apiKey: 'k',
    baseUrl: 'https://api.example.test/agents/v1',
    userAgent: 't',
    fetchImpl,
    sleepImpl: noSleep,
  });
}

describe('list_my_stores', () => {
  it('maps a bare-array response to the clean shape with view_url + workspace', async () => {
    // Generic placeholders only (public repo — Rule 13): no real account data.
    const raw = [
      {
        uuid: 's1',
        name: 'Acme Apparel',
        merchandise_providers: [{ uuid: 'p1', name: 'Printful' }],
        ecommerce_integrations: [
          {
            uuid: 'i1',
            provider_name: 'Shopify',
            shop_identifier: 'your-store.myshopify.com',
            is_active: true,
            is_locked: false,
          },
        ],
        workspace_uuid: 'w1',
        workspace_name: 'Acme Co',
        workspace_is_default: false,
      },
    ];
    const res = (await listMyStores.handler({}, fakeContext(apiReturning(raw)))) as any;
    expect(res.total).toBe(1);
    expect(res.stores[0]).toMatchObject({
      store_uuid: 's1',
      name: 'Acme Apparel',
      view_url: 'https://apparelhub.ai/stores/s1',
    });
    expect(res.stores[0].fulfillment_providers[0]).toEqual({
      provider_uuid: 'p1',
      name: 'Printful',
    });
    expect(res.stores[0].ecommerce_integrations[0]).toMatchObject({
      integration_uuid: 'i1',
      channel: 'Shopify',
      shop_identifier: 'your-store.myshopify.com',
      is_active: true,
      is_locked: false,
    });
    expect(res.stores[0].workspace).toEqual({ uuid: 'w1', name: 'Acme Co', is_default: false });
  });

  it('handles a {stores:[...]} envelope and the store_uuid alt field', async () => {
    const raw = { stores: [{ store_uuid: 's2', name: 'Store Two' }] };
    const res = (await listMyStores.handler({}, fakeContext(apiReturning(raw)))) as any;
    expect(res.stores[0].store_uuid).toBe('s2');
    expect(res.stores[0].fulfillment_providers).toEqual([]);
    expect(res.stores[0].ecommerce_integrations).toEqual([]);
    expect(res.stores[0]).not.toHaveProperty('workspace');
  });

  it('passes workspace= through to the request', async () => {
    const { fetchImpl, calls } = queueFetch([jsonResponse(200, [])]);
    const api = new ApiClient({
      apiKey: 'k',
      baseUrl: 'https://api.example.test/agents/v1',
      userAgent: 't',
      fetchImpl,
      sleepImpl: noSleep,
    });
    await listMyStores.handler({ workspace: 'ws-9' }, fakeContext(api));
    expect(calls[0]?.url).toContain('workspace=ws-9');
  });
});

describe('list_my_workspaces', () => {
  it('projects workspaces to uuid + name so a name can be resolved to a uuid', async () => {
    // Generic placeholders only (public repo — Rule 13): no real account data.
    const raw = [
      { uuid: 'w-default', name: 'Default', role: null, agency_enabled: null },
      { uuid: 'w-acme', name: 'Acme Co', role: 'director', agency_enabled: true },
    ];
    const res = (await listMyWorkspaces.handler({}, fakeContext(apiReturning(raw)))) as any;
    expect(res.total).toBe(2);
    expect(res.workspaces[0]).toMatchObject({ workspace_uuid: 'w-default', name: 'Default' });
    expect(res.workspaces).toContainEqual({
      workspace_uuid: 'w-acme',
      name: 'Acme Co',
      role: 'director',
      agency_enabled: true,
    });
  });

  it('handles a {workspaces:[...]} envelope', async () => {
    const raw = { workspaces: [{ uuid: 'w1', name: 'Default' }] };
    const res = (await listMyWorkspaces.handler({}, fakeContext(apiReturning(raw)))) as any;
    expect(res.total).toBe(1);
    expect(res.workspaces[0]).toEqual({ workspace_uuid: 'w1', name: 'Default' });
  });
});

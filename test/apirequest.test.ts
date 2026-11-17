import { describe, it, expect } from 'vitest';
import {
  getApiReference,
  apiGet,
  apiCreate,
  apiUpdate,
  apiDelete,
  __test,
} from '../src/tools/apirequest.js';
import { allTools } from '../src/tools/index.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { SERVER_VERSION } from '../src/version.js';
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

describe('safeRelPath (escape-hatch guard)', () => {
  it('accepts plain relative paths and strips leading slashes', () => {
    expect(__test.safeRelPath('orders')).toBe('orders');
    expect(__test.safeRelPath('/store/s1/settings')).toBe('store/s1/settings');
    expect(__test.safeRelPath('  product/p1/archive  ')).toBe('product/p1/archive');
  });

  it.each([
    ['empty', ''],
    ['full url', 'https://evil.example/x'],
    ['protocol-relative', '//evil.example/x'],
    ['scheme mid-path', 'orders/https://evil.example'],
    ['parent traversal', '../admin/users'],
    ['nested traversal', 'orders/../../auth/login'],
  ])('rejects %s', (_label, input) => {
    expect(() => __test.safeRelPath(input)).toThrow();
  });
});

describe('get_api_reference', () => {
  it('projects the OpenAPI paths into a compact endpoint index', async () => {
    const spec = {
      info: { title: 'ApparelHub Agent API', version: '1.0' },
      paths: {
        '/orders': { get: { summary: 'List orders' } },
        '/orders/{uuid}/approve': { post: { summary: 'Approve an order' } },
        '/store/{s}/collections': { get: {}, post: { summary: 'Create collection' } },
      },
    };
    const res = (await getApiReference.handler({}, fakeContext(apiReturning(spec)))) as any;
    expect(res.title).toBe('ApparelHub Agent API');
    expect(res.total).toBe(3);
    const approve = res.endpoints.find((e: any) => e.path === '/orders/{uuid}/approve');
    expect(approve).toMatchObject({ methods: ['POST'], summary: 'Approve an order' });
    const coll = res.endpoints.find((e: any) => e.path === '/store/{s}/collections');
    expect(coll.methods.sort()).toEqual(['GET', 'POST']);
  });

  it('filters endpoints by substring', async () => {
    const spec = { paths: { '/orders': { get: {} }, '/store/x/collections': { get: {} } } };
    const res = (await getApiReference.handler(
      { filter: 'collections' },
      fakeContext(apiReturning(spec)),
    )) as any;
    expect(res.total).toBe(1);
    expect(res.endpoints[0].path).toBe('/store/x/collections');
  });
});

function recordingApi() {
  const { fetchImpl, calls } = queueFetch([jsonResponse(200, { echoed: true })]);
  const api = new ApiClient({
    apiKey: 'k',
    baseUrl: 'https://api.example.test/agents/v1',
    userAgent: 't',
    fetchImpl,
    sleepImpl: noSleep,
  });
  return { api, calls };
}

// #217: the escape hatch is four tools, each fixed to ONE kind of method, so a client
// can trust its hints. These guard that a tool can only ever send its own method.
describe('api_get / api_create / api_update / api_delete (#217)', () => {
  it('api_get sends GET with path, query and workspace, and returns the data', async () => {
    const { api, calls } = recordingApi();
    const res = (await apiGet.handler(
      { path: '/orders', query: { limit: 5 }, workspace: 'w1' },
      fakeContext(api),
    )) as any;
    expect(res).toMatchObject({ ok: true, method: 'GET', path: 'orders', data: { echoed: true } });
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].url).toContain('/agents/v1/orders');
    expect(calls[0].url).toContain('limit=5');
    expect(calls[0].url).toContain('workspace=w1');
  });

  it('api_get has no way to send a body or pick another method', () => {
    const shape = (apiGet.inputSchema as any).shape;
    expect(Object.keys(shape).sort()).toEqual(['path', 'query', 'workspace']);
  });

  it('api_create always sends POST with the body', async () => {
    const { api, calls } = recordingApi();
    const res = (await apiCreate.handler(
      { path: 'orders/o1/approve', body: { note: 'x' } },
      fakeContext(api),
    )) as any;
    expect(res.method).toBe('POST');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ note: 'x' });
  });

  it('api_update defaults to PATCH, accepts PUT, and refuses anything else', async () => {
    const parsed = apiUpdate.inputSchema.parse({ path: 'product/p1' }) as any;
    expect(parsed.method).toBe('PATCH');
    expect(apiUpdate.inputSchema.safeParse({ path: 'product/p1', method: 'PUT' }).success).toBe(
      true,
    );
    for (const m of ['GET', 'POST', 'DELETE']) {
      expect(apiUpdate.inputSchema.safeParse({ path: 'product/p1', method: m }).success, m).toBe(
        false,
      );
    }
    const { api, calls } = recordingApi();
    await apiUpdate.handler(
      { path: 'product/p1', method: 'PUT', body: { name: 'n' } } as any,
      fakeContext(api),
    );
    expect(calls[0].init.method).toBe('PUT');
  });

  it('api_delete always sends DELETE', async () => {
    const { api, calls } = recordingApi();
    const res = (await apiDelete.handler({ path: 'collection/c1' }, fakeContext(api))) as any;
    expect(res.method).toBe('DELETE');
    expect(calls[0].init.method).toBe('DELETE');
  });

  it('only api_get is read-only; the others are marked as changing data', () => {
    expect(apiGet.annotations?.readOnlyHint).toBe(true);
    for (const t of [apiCreate, apiUpdate, apiDelete]) {
      expect(t.annotations?.readOnlyHint, t.name).not.toBe(true);
      expect(t.annotations?.destructiveHint, t.name).toBe(true);
    }
  });

  it('every description names the API it calls (directory requirement)', () => {
    for (const t of [apiGet, apiCreate, apiUpdate, apiDelete]) {
      expect(t.description, t.name).toMatch(/ApparelHub Agent API/);
      expect(t.description, t.name).toMatch(/https:\/\/apparelhub\.ai\/developer\/api-docs/);
    }
  });

  it('the catch-all api_request tool is gone', () => {
    expect(allTools().map((t) => t.name)).not.toContain('api_request');
  });

  it.each([
    ['api_get', () => apiGet.handler({ path: '../../auth/login' }, fakeContext(apiReturning({})))],
    [
      'api_create',
      () => apiCreate.handler({ path: 'https://evil.example/x' }, fakeContext(apiReturning({}))),
    ],
    [
      'api_update',
      () =>
        apiUpdate.handler(
          { path: '//evil.example', method: 'PATCH' } as any,
          fakeContext(apiReturning({})),
        ),
    ],
    [
      'api_delete',
      () => apiDelete.handler({ path: 'orders/../../admin' }, fakeContext(apiReturning({}))),
    ],
  ])('%s refuses a path that escapes /agents/v1', async (_n, call) => {
    await expect(call()).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Connector self-report.
//
// A client whose tool list is stale cannot call any tool added after that list
// was fetched — so the ONLY place this can usefully live is a tool the agent
// already has. That is the design constraint, and it is what these guard.
//
// Exercised THROUGH THE REGISTRY, because that is the real path: the names are
// injected at call time rather than imported, and a test that calls the handler
// directly would prove nothing about whether that injection happens.
// ---------------------------------------------------------------------------
describe('connector self-report', () => {
  const spec = {
    info: { title: 'ApparelHub Agent API', version: '1' },
    paths: {
      '/orders': { get: { summary: 'List orders' } },
    },
  };

  function registryWith(api: ReturnType<typeof apiReturning>) {
    const registry = new ToolRegistry();
    registry.registerAll(allTools());
    return { registry, ctx: fakeContext(api) };
  }

  it('reports the running version and every tool this server serves', async () => {
    const { registry, ctx } = registryWith(apiReturning(spec));
    const res = (await registry.dispatch('get_api_reference', {}, ctx)) as any;
    expect(res.connector.server_version).toBe(SERVER_VERSION);
    expect(res.connector.tool_count).toBe(allTools().length);
    expect(res.connector.tool_names).toContain('import_size_measurements');
    // Sorted, so a client can diff against its own list without normalising.
    expect(res.connector.tool_names).toEqual([...res.connector.tool_names].sort());
  });

  it('the count and the names cannot disagree', async () => {
    // A count that drifts from the list sends an agent chasing a phantom.
    const { registry, ctx } = registryWith(apiReturning(spec));
    const res = (await registry.dispatch('get_api_reference', {}, ctx)) as any;
    expect(res.connector.tool_names.length).toBe(res.connector.tool_count);
  });

  it('survives a `filter`, because a stale client asks narrow questions', async () => {
    // The staleness signal must not be gated behind asking the right question:
    // an agent hunting one namespace is exactly the one about to conclude a
    // feature is missing.
    const { registry, ctx } = registryWith(apiReturning(spec));
    const res = (await registry.dispatch(
      'get_api_reference',
      { filter: 'collections' },
      ctx,
    )) as any;
    expect(res.endpoints.length).toBe(0);
    expect(res.connector.tool_count).toBe(allTools().length);
  });

  it('tells the agent what to conclude and what to tell the user', async () => {
    const { registry, ctx } = registryWith(apiReturning(spec));
    const res = (await registry.dispatch('get_api_reference', {}, ctx)) as any;
    // Not decoration: without this an agent reads a missing tool as an unbuilt
    // feature, which is the wrong report to give a user.
    expect(res.connector.self_check).toMatch(/stale/i);
    expect(res.connector.if_stale).toMatch(/reconnect/i);
    expect(res.connector.if_stale).toMatch(/api_get/i);
  });

  it('says nothing rather than claiming zero tools when it cannot enumerate', async () => {
    // Called outside a registry. `tool_count: 0` would read as "the server has
    // FEWER tools than you" — worse than admitting it does not know.
    const res = (await getApiReference.handler({}, fakeContext(apiReturning(spec)))) as any;
    expect(res.connector.server_version).toBe(SERVER_VERSION);
    expect(res.connector.tool_count).toBeUndefined();
    expect(res.connector.tool_names_unavailable).toBeTruthy();
  });
});

import { describe, it, expect } from 'vitest';
import { getApiReference, apiRequest, __test } from '../src/tools/apirequest.js';
import { allTools } from '../src/tools/index.js';
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
    const res = (await getApiReference.handler({ filter: 'collections' }, fakeContext(apiReturning(spec)))) as any;
    expect(res.total).toBe(1);
    expect(res.endpoints[0].path).toBe('/store/x/collections');
  });
});

describe('api_request', () => {
  it('sends the given method + relative path and returns the data', async () => {
    const { fetchImpl, calls } = queueFetch([jsonResponse(200, { echoed: true })]);
    const api = new ApiClient({
      apiKey: 'k',
      baseUrl: 'https://api.example.test/agents/v1',
      userAgent: 't',
      fetchImpl,
      sleepImpl: noSleep,
    });
    const res = (await apiRequest.handler(
      { method: 'POST', path: '/orders/o1/approve', body: { note: 'x' }, workspace: 'w1' },
      fakeContext(api),
    )) as any;
    expect(res).toMatchObject({ ok: true, method: 'POST', path: 'orders/o1/approve' });
    expect(res.data).toEqual({ echoed: true });
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].url).toContain('/agents/v1/orders/o1/approve');
    expect(calls[0].url).toContain('workspace=w1');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ note: 'x' });
  });

  it('refuses a path that escapes /agents/v1', async () => {
    await expect(
      apiRequest.handler({ method: 'GET', path: '../../auth/login' }, fakeContext(apiReturning({}))),
    ).rejects.toThrow();
  });
});


// ---------------------------------------------------------------------------
// Connector self-report.
//
// A client whose tool list is stale cannot call any tool added after that list
// was fetched — so the ONLY place this can usefully live is a tool the agent
// already has. That is the whole design constraint, and it is what these guard.
// ---------------------------------------------------------------------------
describe('connector self-report', () => {
  const spec = { info: { title: 'ApparelHub Agent API', version: '1' }, paths: {
    '/orders': { get: { summary: 'List orders' } },
  } };

  it('reports the running version and every tool this server serves', async () => {
    const res = (await getApiReference.handler({}, fakeContext(apiReturning(spec)))) as any;
    expect(res.connector.server_version).toBe(SERVER_VERSION);
    expect(res.connector.tool_count).toBe(allTools().length);
    expect(res.connector.tool_names).toContain('import_size_measurements');
    // Sorted, so a client can diff it against its own list without normalising.
    expect(res.connector.tool_names).toEqual([...res.connector.tool_names].sort());
  });

  it('the count and the names cannot disagree', async () => {
    // A count that drifts from the list would send an agent chasing a phantom.
    const res = (await getApiReference.handler({}, fakeContext(apiReturning(spec)))) as any;
    expect(res.connector.tool_names.length).toBe(res.connector.tool_count);
  });

  it('survives a `filter`, because a stale client asks narrow questions', async () => {
    // The staleness signal must not be gated behind asking the right question:
    // an agent hunting one namespace still needs to learn its list is old.
    const res = (await getApiReference.handler(
      { filter: 'collections' }, fakeContext(apiReturning(spec)))) as any;
    expect(res.endpoints.length).toBe(0);
    expect(res.connector.tool_count).toBe(allTools().length);
  });

  it('tells the agent what to conclude and what to tell the user', async () => {
    const res = (await getApiReference.handler({}, fakeContext(apiReturning(spec)))) as any;
    // Not decoration: without this an agent reads a missing tool as an unbuilt
    // feature, which is exactly the wrong report to give a user.
    expect(res.connector.self_check).toMatch(/stale/i);
    expect(res.connector.if_stale).toMatch(/reconnect/i);
    expect(res.connector.if_stale).toMatch(/api_request/i);
  });
});

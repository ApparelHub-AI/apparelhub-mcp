import { describe, it, expect } from 'vitest';
import { getApiReference, apiRequest, __test } from '../src/tools/apirequest.js';
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

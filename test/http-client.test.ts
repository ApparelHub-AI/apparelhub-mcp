import { describe, it, expect } from 'vitest';
import { ApiClient } from '../src/http/client.js';
import { jsonResponse, queueFetch, noSleep } from './helpers/fakeFetch.js';

function client(over: Partial<ConstructorParameters<typeof ApiClient>[0]> = {}): ApiClient {
  return new ApiClient({
    apiKey: 'k',
    baseUrl: 'https://api.example.test/agents/v1',
    userAgent: 'test',
    sleepImpl: noSleep,
    ...over,
  });
}

describe('ApiClient', () => {
  it('throws auth_required when no key is configured', async () => {
    const c = new ApiClient({ apiKey: undefined, baseUrl: 'https://x/agents/v1', userAgent: 't' });
    await expect(c.get('store')).rejects.toMatchObject({ code: 'auth_required' });
  });

  it('GET returns parsed JSON and builds the URL', async () => {
    const { fetchImpl, calls } = queueFetch([jsonResponse(200, { ok: true })]);
    const r = await client({ fetchImpl }).get('store');
    expect(r).toEqual({ ok: true });
    expect(calls[0]?.url).toBe('https://api.example.test/agents/v1/store');
  });

  it('appends query params and workspace', async () => {
    const { fetchImpl, calls } = queueFetch([jsonResponse(200, [])]);
    await client({ fetchImpl }).get('orders', { query: { limit: 5, drop: undefined }, workspace: 'ws1' });
    const url = calls[0]?.url ?? '';
    expect(url).toContain('limit=5');
    expect(url).toContain('workspace=ws1');
    expect(url).not.toContain('drop=');
  });

  it('sends x-api-key + JSON content-type on POST', async () => {
    const { fetchImpl, calls } = queueFetch([jsonResponse(200, {})]);
    await client({ fetchImpl }).post('product/create', { body: { name: 'x' } });
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('k');
    expect(headers['content-type']).toBe('application/json');
  });

  it('retries a transient 503 then succeeds', async () => {
    const { fetchImpl, calls } = queueFetch([
      jsonResponse(503, { error: 'busy' }),
      jsonResponse(200, { ok: 1 }),
    ]);
    const r = await client({ fetchImpl }).get('store');
    expect(r).toEqual({ ok: 1 });
    expect(calls.length).toBe(2);
  });

  it('maps a 404 to a not_found AhError', async () => {
    const { fetchImpl } = queueFetch([jsonResponse(404, { error: 'nope' })]);
    await expect(client({ fetchImpl }).get('store/x')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('returns undefined for 204', async () => {
    const { fetchImpl } = queueFetch([jsonResponse(204)]);
    const r = await client({ fetchImpl }).del('store/x/products/y');
    expect(r).toBeUndefined();
  });

  it('gives up after the retry cap and surfaces upstream_unavailable', async () => {
    const responses = Array.from({ length: 6 }, () => jsonResponse(503, { error: 'busy' }));
    const { fetchImpl } = queueFetch(responses);
    await expect(client({ fetchImpl }).get('store')).rejects.toMatchObject({
      code: 'upstream_unavailable',
    });
  });
});

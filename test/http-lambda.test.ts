import { beforeEach, describe, it, expect } from 'vitest';
import {
  _clearResolveCacheForTests,
  makeHandler,
  type FunctionUrlEvent,
} from '../src/http/lambda.js';
import { jsonResponse, queueFetch } from './helpers/fakeFetch.js';

// Generic placeholders only (public repo — Rule: no real account data in tests).
const SECRET = 'a'.repeat(64);
const ENV = {
  APPARELHUB_API_KEY: 'test-key',
  MCP_BEARER: SECRET,
  MCP_STATIC_BEARER_ENABLED: 'true',
  APPARELHUB_MCP_TELEMETRY: 'off',
} as NodeJS.ProcessEnv;

const OAUTH_ENV = {
  APPARELHUB_API_KEY: 'deploy-key-must-not-be-used',
  MCP_OAUTH_ISSUER: 'https://auth.example.test',
  MCP_SERVICE_KEY: 'svc-key-1',
  APPARELHUB_MCP_TELEMETRY: 'off',
} as NodeJS.ProcessEnv;

function postEvent(body: unknown, opts: { path?: string; bearer?: string } = {}): FunctionUrlEvent {
  const headers: Record<string, string> = {
    host: 'example.lambda-url.us-east-1.on.aws',
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  return {
    rawPath: opts.path ?? '/mcp',
    headers,
    body: JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { http: { method: 'POST' } },
  };
}

const initializeReq = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '0.0.0' },
  },
};
const toolsListReq = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

describe('lambda handler auth gate', () => {
  it('serves /healthz without auth and without leaking anything', async () => {
    const handle = makeHandler({}, {} as NodeJS.ProcessEnv);
    const res = await handle({
      rawPath: '/healthz',
      requestContext: { http: { method: 'GET' } },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it('fails closed (503) when MCP_BEARER is unset or too short', async () => {
    const handle = makeHandler({}, { MCP_BEARER: 'short' } as NodeJS.ProcessEnv);
    const res = await handle(postEvent(initializeReq, { bearer: 'short' }));
    expect(res.statusCode).toBe(503);
  });

  it('rejects requests with no credentials', async () => {
    const handle = makeHandler({}, ENV);
    const res = await handle(postEvent(initializeReq));
    expect(res.statusCode).toBe(401);
  });

  it('rejects a wrong bearer', async () => {
    const handle = makeHandler({}, ENV);
    const res = await handle(postEvent(initializeReq, { bearer: 'b'.repeat(64) }));
    expect(res.statusCode).toBe(401);
  });

  it('rejects a wrong path secret', async () => {
    const handle = makeHandler({}, ENV);
    const res = await handle(postEvent(initializeReq, { path: `/${'b'.repeat(64)}/mcp` }));
    expect(res.statusCode).toBe(401);
  });
});

describe('lambda handler MCP flow (stateless, JSON responses)', () => {
  it('answers initialize with server info via the Authorization header', async () => {
    const handle = makeHandler({}, ENV);
    const res = await handle(postEvent(initializeReq, { bearer: SECRET }));
    expect(res.statusCode).toBe(200);
    const rpc = JSON.parse(res.body);
    expect(rpc.jsonrpc).toBe('2.0');
    expect(rpc.result.serverInfo.name).toBeTruthy();
  });

  it('answers tools/list on a fresh instance via the path secret (no prior initialize)', async () => {
    const handle = makeHandler({}, ENV);
    const res = await handle(postEvent(toolsListReq, { path: `/${SECRET}/mcp` }));
    expect(res.statusCode).toBe(200);
    const rpc = JSON.parse(res.body);
    const names = rpc.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('list_my_products');
    expect(names).toContain('generate_image');
  });

  it('executes a read tool end to end against an injected fetch', async () => {
    const { fetchImpl, calls } = queueFetch([jsonResponse(200, [])]);
    const handle = makeHandler({ fetchImpl }, ENV);
    const res = await handle(
      postEvent(
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'list_my_products', arguments: {} },
        },
        { bearer: SECRET },
      ),
    );
    expect(res.statusCode).toBe(200);
    const rpc = JSON.parse(res.body);
    expect(rpc.result.isError ?? false).toBe(false);
    const payload = JSON.parse(rpc.result.content[0].text);
    expect(payload.total).toBe(0);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].url).toContain('/product');
  });
});

describe('lambda handler OAuth bearer resolution (#41)', () => {
  beforeEach(() => _clearResolveCacheForTests());

  function toolCall(bearer?: string): FunctionUrlEvent {
    return postEvent(
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'list_my_products', arguments: {} },
      },
      { bearer },
    );
  }

  function resolveOk(): Response {
    return jsonResponse(200, {
      api_key: 'user-key-123',
      user_public_id: 'u-1',
      scopes: 'mcp',
      expires_at: '2099-01-01T00:00:00Z',
    });
  }

  it('serves protected-resource metadata when OAuth is configured', async () => {
    const handle = makeHandler({}, OAUTH_ENV);
    const res = await handle({
      rawPath: '/.well-known/oauth-protected-resource',
      headers: { host: 'mcp.example.test' },
      requestContext: { http: { method: 'GET' } },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.authorization_servers).toEqual(['https://auth.example.test']);
    expect(body.resource).toBe('https://mcp.example.test');
  });

  it('404s the metadata when OAuth is not configured', async () => {
    const handle = makeHandler({}, ENV);
    const res = await handle({
      rawPath: '/.well-known/oauth-protected-resource',
      requestContext: { http: { method: 'GET' } },
    });
    expect(res.statusCode).toBe(404);
  });

  it('resolves a bearer, uses the RESOLVED key downstream, and caches', async () => {
    const { fetchImpl, calls } = queueFetch([
      resolveOk(),
      jsonResponse(200, []),
      jsonResponse(200, []),
    ]);
    const handle = makeHandler({ fetchImpl }, OAUTH_ENV);

    const res1 = await handle(toolCall('opaque-token-1'));
    expect(res1.statusCode).toBe(200);
    expect(calls[0].url).toContain('/service/connector/resolve-token');
    expect(JSON.stringify(calls[0].init?.headers)).toContain('svc-key-1');
    // Downstream platform call carries the user connector key, not the deploy key.
    expect(JSON.stringify(calls[1])).toContain('user-key-123');
    expect(JSON.stringify(calls[1])).not.toContain('deploy-key-must-not-be-used');

    // Second request with the same token: cache hit — no second resolve call.
    const res2 = await handle(toolCall('opaque-token-1'));
    expect(res2.statusCode).toBe(200);
    const resolveCalls = calls.filter((c) => c.url.includes('resolve-token'));
    expect(resolveCalls.length).toBe(1);
  });

  it('maps a resolve rejection to 401 with the discovery challenge', async () => {
    const { fetchImpl } = queueFetch([jsonResponse(401, { error: 'expired_token' })]);
    const handle = makeHandler({ fetchImpl }, OAUTH_ENV);
    const res = await handle(toolCall('opaque-token-expired'));
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe('expired_token');
    expect(res.headers['www-authenticate']).toContain('/.well-known/oauth-protected-resource');
  });

  it('401s with the discovery challenge when no bearer is presented', async () => {
    const handle = makeHandler({}, OAUTH_ENV);
    const res = await handle(toolCall(undefined));
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain('resource_metadata');
  });

  it('fails closed (503) when OAuth is advertised but the resolver credential is missing', async () => {
    const env = { ...OAUTH_ENV, MCP_SERVICE_KEY: '' } as NodeJS.ProcessEnv;
    const handle = makeHandler({}, env);
    const res = await handle(toolCall('some-token'));
    expect(res.statusCode).toBe(503);
  });

  it('rejects the static path secret when the static flag is off', async () => {
    const handle = makeHandler({}, OAUTH_ENV);
    const res = await handle(postEvent(toolsListReq, { path: `/${SECRET}/mcp` }));
    expect(res.statusCode).toBe(401);
  });
});

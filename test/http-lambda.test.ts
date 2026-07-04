import { describe, it, expect } from 'vitest';
import { makeHandler, type FunctionUrlEvent } from '../src/http/lambda.js';
import { jsonResponse, queueFetch } from './helpers/fakeFetch.js';

// Generic placeholders only (public repo — Rule: no real account data in tests).
const SECRET = 'a'.repeat(64);
const ENV = {
  APPARELHUB_API_KEY: 'test-key',
  MCP_BEARER: SECRET,
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

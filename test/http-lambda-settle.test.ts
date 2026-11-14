import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  _clearResolveCacheForTests,
  makeHandler,
  type FunctionUrlEvent,
} from '../src/http/lambda.js';

// An internal platform ticket: the hosted Lambda died with Runtime.NodeJsExit ("a Promise that was never
// settled") a few ms after START, with no access line. Every test here is shaped so that the
// pre-fix behavior shows up as a hang, which vitest reports as a timeout on the named test.
// Generic placeholders only (public repo).

const SECRET = 'b'.repeat(64);
const STATIC_ENV = {
  APPARELHUB_API_KEY: 'test-key',
  MCP_BEARER: SECRET,
  MCP_STATIC_BEARER_ENABLED: 'true',
  APPARELHUB_MCP_TELEMETRY: 'off',
} as NodeJS.ProcessEnv;
const OAUTH_ENV = {
  MCP_OAUTH_ISSUER: 'https://auth.example.test',
  MCP_SERVICE_KEY: 'svc-key-1',
  APPARELHUB_MCP_TELEMETRY: 'off',
} as NodeJS.ProcessEnv;

/** The request a Streamable HTTP client sends right after initialize to open its SSE stream. */
function sseGet(bearer = SECRET, path = '/'): FunctionUrlEvent {
  return {
    rawPath: path,
    headers: {
      host: 'example.lambda-url.us-east-1.on.aws',
      accept: 'text/event-stream',
      authorization: `Bearer ${bearer}`,
      'mcp-protocol-version': '2025-06-18',
    },
    requestContext: { http: { method: 'GET' } },
  };
}

function toolsListPost(bearer = SECRET): FunctionUrlEvent {
  return {
    rawPath: '/',
    headers: {
      host: 'example.lambda-url.us-east-1.on.aws',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    isBase64Encoded: false,
    requestContext: { http: { method: 'POST' } },
  };
}

/** Collect the structured lines the handler writes, so a test can assert what was logged. */
function captureLogs(): { lines: () => Record<string, unknown>[] } {
  const seen: Record<string, unknown>[] = [];
  const grab = (msg: unknown): void => {
    if (typeof msg !== 'string') return;
    try {
      const parsed = JSON.parse(msg) as Record<string, unknown>;
      if (!('_aws' in parsed)) seen.push(parsed);
    } catch {
      /* not one of our structured lines */
    }
  };
  vi.spyOn(console, 'log').mockImplementation(grab);
  vi.spyOn(console, 'error').mockImplementation(grab);
  return { lines: () => seen };
}

beforeEach(() => _clearResolveCacheForTests());
afterEach(() => vi.restoreAllMocks());

describe('authenticated GET (the SSE stream open) settles instead of hanging', () => {
  it('answers 405 with an Allow header, and writes the access line', async () => {
    const logs = captureLogs();
    const handle = makeHandler({}, STATIC_ENV);
    const res = await handle(sseGet());
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe('POST, DELETE, OPTIONS');
    expect(JSON.parse(res.body).error.code).toBe(-32000);
    expect(logs.lines()).toContainEqual(expect.objectContaining({ method: 'GET', status: 405 }));
  });

  it('settles on the /mcp path and over OAuth too', async () => {
    const resolve = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ api_key: 'k', user_public_id: 'u', expires_at: '2099-01-01T00:00:00Z' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const handle = makeHandler({ fetchImpl: resolve as unknown as typeof fetch }, OAUTH_ENV);
    const res = await handle(sseGet('opaque-access-token', '/mcp'));
    expect(res.statusCode).toBe(405);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('still challenges an unauthenticated GET with 401 (auth order unchanged)', async () => {
    const handle = makeHandler({}, OAUTH_ENV);
    const res = await handle({ ...sseGet(), headers: { accept: 'text/event-stream' } });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain('resource_metadata=');
  });

  it('leaves /healthz and the protected-resource metadata GETs working', async () => {
    const handle = makeHandler({}, OAUTH_ENV);
    const health = await handle({
      rawPath: '/healthz',
      requestContext: { http: { method: 'GET' } },
    });
    expect(health.statusCode).toBe(200);
    const meta = await handle({
      rawPath: '/.well-known/oauth-protected-resource',
      headers: { host: 'mcp.example.test' },
      requestContext: { http: { method: 'GET' } },
    });
    expect(meta.statusCode).toBe(200);
  });
});

describe('last-resort guard: every invocation settles with a logged error', () => {
  it('a promise that never settles becomes a logged 504 JSON-RPC error before the deadline', async () => {
    const logs = captureLogs();
    // The resolver call never answers: the same shape as the stream nobody closes.
    const never = vi.fn(() => new Promise<Response>(() => undefined));
    const handle = makeHandler({ fetchImpl: never as unknown as typeof fetch }, OAUTH_ENV);
    const started = Date.now();
    const res = await handle(toolsListPost('opaque-access-token'), {
      getRemainingTimeInMillis: () => 1150,
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(res.statusCode).toBe(504);
    const body = JSON.parse(res.body);
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.code).toBe(-32603);
    expect(body.error.message).toMatch(/retry/);
    expect(logs.lines()).toContainEqual(
      expect.objectContaining({
        event: 'request_failed',
        reason: 'deadline_exceeded',
        method: 'POST',
      }),
    );
    expect(logs.lines()).toContainEqual(
      expect.objectContaining({ method: 'POST', status: 504, failure: 'deadline_exceeded' }),
    );
  });

  it('an unexpected throw becomes a logged 500 JSON-RPC error, not a rejected invocation', async () => {
    const logs = captureLogs();
    const handle = makeHandler({}, STATIC_ENV);
    const event = toolsListPost();
    // A header bag that blows up when read: stands in for any path nobody anticipated.
    Object.defineProperty(event.headers as object, 'x-forwarded-host', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    const res = await handle(event);
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toEqual({
      code: -32603,
      message: 'Internal error, please retry.',
    });
    expect(logs.lines()).toContainEqual(
      expect.objectContaining({
        event: 'request_failed',
        reason: 'unhandled_error',
        message: 'boom',
      }),
    );
  });

  it('refuses to drain an event-stream answer from the transport', async () => {
    const logs = captureLogs();
    let cancelled = false;
    vi.spyOn(WebStandardStreamableHTTPServerTransport.prototype, 'handleRequest').mockResolvedValue(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    );
    const handle = makeHandler({}, STATIC_ENV);
    const res = await handle(toolsListPost());
    expect(res.statusCode).toBe(500);
    expect(cancelled).toBe(true);
    expect(logs.lines()).toContainEqual(
      expect.objectContaining({
        reason: 'unhandled_error',
        message: expect.stringMatching(/event stream/),
      }),
    );
  });

  it('does not touch a normal request (tools/list still answers 200)', async () => {
    const handle = makeHandler({}, STATIC_ENV);
    const res = await handle(toolsListPost(), { getRemainingTimeInMillis: () => 300_000 });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).result.tools.length).toBeGreaterThan(0);
  });
});

import { vi } from 'vitest';
import { ApiClient, type FetchLike } from '../../src/http/client.js';

export function jsonResponse(
  status: number,
  body?: unknown,
  headers: Record<string, string> = {},
): Response {
  const init: ResponseInit = { status, headers: { 'content-type': 'application/json', ...headers } };
  if (status === 204 || body === undefined) return new Response(null, init);
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), init);
}

export interface RecordedCall {
  url: string;
  init?: RequestInit;
}

/** A fetch stub that returns queued responses in order and records each call. */
export function queueFetch(queue: Response[]): { fetchImpl: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = queue.shift();
    if (!next) throw new Error('queueFetch: no more responses queued');
    return next;
  }) as unknown as FetchLike;
  return { fetchImpl, calls };
}

export const noSleep = async (_ms: number): Promise<void> => {};

/** An ApiClient whose next request resolves to `raw` (status 200). */
export function apiReturning(raw: unknown): ApiClient {
  const { fetchImpl } = queueFetch([jsonResponse(200, raw)]);
  return new ApiClient({
    apiKey: 'k',
    baseUrl: 'https://api.example.test/agents/v1',
    userAgent: 't',
    fetchImpl,
    sleepImpl: noSleep,
  });
}

/** An ApiClient that resolves to `raw` and records the calls it received (for URL asserts). */
export function apiRecording(raw: unknown): { api: ApiClient; calls: RecordedCall[] } {
  const { fetchImpl, calls } = queueFetch([jsonResponse(200, raw)]);
  const api = new ApiClient({
    apiKey: 'k',
    baseUrl: 'https://api.example.test/agents/v1',
    userAgent: 't',
    fetchImpl,
    sleepImpl: noSleep,
  });
  return { api, calls };
}

/** An ApiClient that resolves a SEQUENCE of JSON bodies (status 200), one per request, and
 *  records the calls — for tools that make several API calls (resolve provider, then fetch). */
export function apiSequence(bodies: unknown[]): { api: ApiClient; calls: RecordedCall[] } {
  const { fetchImpl, calls } = queueFetch(bodies.map((b) => jsonResponse(200, b)));
  const api = new ApiClient({
    apiKey: 'k',
    baseUrl: 'https://api.example.test/agents/v1',
    userAgent: 't',
    fetchImpl,
    sleepImpl: noSleep,
  });
  return { api, calls };
}

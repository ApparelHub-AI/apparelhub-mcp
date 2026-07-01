import { vi } from 'vitest';
import type { FetchLike } from '../../src/http/client.js';

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

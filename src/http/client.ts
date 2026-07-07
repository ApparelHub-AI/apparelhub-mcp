import { AhError, mapHttpError } from '../errors.js';

export type FetchLike = typeof fetch;

export interface RequestOptions {
  /** Query params (undefined values are dropped). */
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON request body. Ignored when `multipart` is set. */
  body?: unknown;
  /** Multipart body for the transform endpoint (fetch sets the boundary + content-type). */
  multipart?: FormData;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Convenience for ?workspace=<uuid> (api-contract §4b). */
  workspace?: string;
  /** Override the transient-retry cap (default 5, per api-contract §5). */
  maxRetries?: number;
}

const TRANSIENT_STATUS = new Set([429, 502, 503, 504]);
const DEFAULT_MAX_RETRIES = 5;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8000;

export interface ApiClientInit {
  apiKey: string | undefined;
  baseUrl: string;
  userAgent: string;
  /** Injectable for tests. */
  fetchImpl?: FetchLike;
  /** Injectable for tests (so retry/backoff runs instantly). */
  sleepImpl?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function parseResponseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Thin, retry-aware client for the ApparelHub Agent REST API. */
export class ApiClient {
  constructor(private readonly init: ApiClientInit) {}

  private get fetchImpl(): FetchLike {
    return this.init.fetchImpl ?? fetch;
  }

  private sleep(ms: number): Promise<void> {
    return (this.init.sleepImpl ?? defaultSleep)(ms);
  }

  private buildUrl(
    path: string,
    query?: RequestOptions['query'],
    workspace?: string,
  ): string {
    const base = this.init.baseUrl.replace(/\/+$/, '');
    const rel = path.replace(/^\/+/, '');
    const url = new URL(`${base}/${rel}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    if (workspace) url.searchParams.set('workspace', workspace);
    return url.toString();
  }

  private async backoff(attempt: number, retryAfterSec?: number): Promise<void> {
    const ms =
      retryAfterSec !== undefined
        ? retryAfterSec * 1000
        : Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS);
    await this.sleep(ms);
  }

  async request<T = unknown>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    if (!this.init.apiKey) {
      throw new AhError({
        code: 'auth_required',
        message: 'No ApparelHub API key configured.',
        suggestion:
          'Set APPARELHUB_API_KEY in the MCP server environment (generate a key at https://apparelhub.ai/developer/api-keys).',
      });
    }

    const url = this.buildUrl(path, options.query, options.workspace);
    const headers: Record<string, string> = {
      'x-api-key': this.init.apiKey,
      accept: 'application/json',
      'user-agent': this.init.userAgent,
      ...(options.headers ?? {}),
    };

    let bodyInit: string | FormData | undefined;
    if (options.multipart) {
      bodyInit = options.multipart; // fetch sets multipart/form-data + boundary
    } else if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      bodyInit = JSON.stringify(options.body);
    }

    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    let attempt = 0;

    for (;;) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers,
          body: bodyInit,
          signal: options.signal,
        });
      } catch (err) {
        if (isAbortError(err)) {
          throw new AhError({ code: 'cancelled', message: 'The request was cancelled.' });
        }
        if (attempt < maxRetries) {
          await this.backoff(attempt++);
          continue;
        }
        // The fetch itself rejected (DNS / connection refused / reset) even after retries: no
        // HTTP response ever arrived, so NOTHING here can be attributed to ApparelHub — it is a
        // transport failure at or near the caller. Named request_not_sent so an agent can never
        // mistake it for an ApparelHub rate limit or outage (epic #66 phase 2).
        throw new AhError({
          code: 'request_not_sent',
          message: `No response was received from ApparelHub — the request did not complete (${errMessage(err)}).`,
          suggestion:
            'This is a connectivity or transport failure at or near the caller, not an ApparelHub error or rate limit. Never report ApparelHub as rate-limited or down from this alone. Retry; if several unrelated tools are failing at the same moment, the calling agent\'s own runtime or network is the likely constraint.',
        });
      }

      if (TRANSIENT_STATUS.has(res.status) && attempt < maxRetries) {
        const retryAfter = parseRetryAfterHeader(res.headers.get('retry-after'));
        await this.backoff(attempt++, retryAfter);
        continue;
      }

      if (!res.ok) {
        const parsed = await parseResponseBody(res);
        throw mapHttpError(res.status, parsed, res.headers.get('retry-after'));
      }

      if (res.status === 204) return undefined as T;
      return (await parseResponseBody(res)) as T;
    }
  }

  get<T = unknown>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('GET', path, options);
  }
  post<T = unknown>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('POST', path, options);
  }
  patch<T = unknown>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('PATCH', path, options);
  }
  del<T = unknown>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('DELETE', path, options);
  }
}

function parseRetryAfterHeader(header: string | null): number | undefined {
  if (!header) return undefined;
  const n = Number(header);
  return Number.isFinite(n) ? Math.max(0, n) : undefined;
}

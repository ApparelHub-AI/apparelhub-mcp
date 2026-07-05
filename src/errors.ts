// Structured error contract (tool spec §9). Tools never throw raw exceptions across
// the MCP boundary — every failure becomes one of these shapes. Error codes are kept
// intentionally BROAD (spec §12 Q2): enough for an agent to decide "retry vs. surface
// to the user", not 40 codes nobody remembers.

export interface ToolErrorShape {
  code: string;
  message: string;
  retry_after?: number;
  suggestion?: string;
}

export interface AhErrorInit {
  code: string;
  message: string;
  retryAfter?: number;
  suggestion?: string;
  httpStatus?: number;
}

export class AhError extends Error {
  readonly code: string;
  readonly retryAfter?: number;
  readonly suggestion?: string;
  readonly httpStatus?: number;

  constructor(init: AhErrorInit) {
    super(init.message);
    this.name = 'AhError';
    this.code = init.code;
    this.retryAfter = init.retryAfter;
    this.suggestion = init.suggestion;
    this.httpStatus = init.httpStatus;
  }

  toPayload(): { error: ToolErrorShape } {
    const error: ToolErrorShape = { code: this.code, message: this.message };
    if (this.retryAfter !== undefined) error.retry_after = this.retryAfter;
    if (this.suggestion) error.suggestion = this.suggestion;
    return { error };
  }
}

export function toErrorPayload(err: unknown): { error: ToolErrorShape } {
  if (err instanceof AhError) return err.toPayload();
  const message = err instanceof Error ? err.message : String(err);
  return { error: { code: 'internal_error', message } };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function extractField(body: unknown, key: string): string | undefined {
  if (isRecord(body) && typeof body[key] === 'string') {
    const s = (body[key] as string).trim();
    return s || undefined;
  }
  return undefined;
}

function extractMessage(body: unknown): string | undefined {
  if (typeof body === 'string' && body.trim()) return body.trim();
  if (isRecord(body)) {
    for (const k of ['message', 'error', 'detail', 'description']) {
      const v = body[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return undefined;
}

export function parseRetryAfter(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const asNumber = Number(header);
  if (Number.isFinite(asNumber)) return Math.max(0, asNumber);
  const asDate = Date.parse(header);
  if (!Number.isNaN(asDate)) return Math.max(0, Math.round((asDate - Date.now()) / 1000));
  return undefined;
}

// Map an HTTP status + parsed body into a broad, memorable AhError (api-contract §5).
export function mapHttpError(
  status: number,
  body: unknown,
  retryAfterHeader?: string | null,
): AhError {
  const message = extractMessage(body);
  const errorCode = extractField(body, 'error'); // sometimes a code string like "workspace_forbidden"
  const capability = extractField(body, 'capability');

  if (status === 400) {
    return new AhError({
      httpStatus: status,
      code: 'bad_request',
      message: message ?? 'The request was rejected as malformed.',
      suggestion: 'Check field names and values; the API usually names the offending field.',
    });
  }
  if (status === 401) {
    return new AhError({
      httpStatus: status,
      code: 'auth_required',
      message: message ?? 'API key missing or invalid.',
      suggestion:
        'Verify APPARELHUB_API_KEY (generate one at https://apparelhub.ai/developer/api-keys). Keys are environment-scoped.',
    });
  }
  if (status === 403 && errorCode === 'workspace_forbidden') {
    return new AhError({
      httpStatus: status,
      code: 'workspace_forbidden',
      message: 'This key or account cannot act in the requested workspace.',
      suggestion: 'Target a workspace this account can act in (see list_my_workspaces).',
    });
  }
  if (status === 403 && (errorCode === 'forbidden' || capability)) {
    return new AhError({
      httpStatus: status,
      code: 'forbidden',
      message: capability
        ? `This key's workspace role lacks the "${capability}" capability.`
        : (message ?? 'Forbidden.'),
      suggestion: 'The role assigned to this key does not permit this action.',
    });
  }
  if (status === 403) {
    return new AhError({
      httpStatus: status,
      code: 'forbidden',
      message: message ?? 'Forbidden.',
      suggestion: 'This key lacks scope for the requested operation.',
    });
  }
  if (status === 404 && errorCode === 'workspace_not_found') {
    return new AhError({
      httpStatus: status,
      code: 'workspace_not_found',
      message: 'The requested workspace does not exist.',
      suggestion: 'Resolve the workspace uuid from list_my_workspaces before scoping with workspace=.',
    });
  }
  if (status === 404) {
    return new AhError({
      httpStatus: status,
      code: 'not_found',
      message: message ?? 'The requested resource was not found.',
    });
  }
  if (status === 409) {
    return new AhError({
      httpStatus: status,
      code: 'conflict',
      message: message ?? errorCode ?? 'The request conflicts with the current state.',
      suggestion: 'Inspect the conflict and surface it to the user; do not force past it.',
    });
  }
  if (status === 422) {
    return new AhError({
      httpStatus: status,
      code: 'unprocessable',
      message: message ?? 'The request was semantically rejected.',
    });
  }
  if (status === 429) {
    return new AhError({
      httpStatus: status,
      code: 'rate_limited',
      message: 'Rate limited by the ApparelHub API.',
      retryAfter: parseRetryAfter(retryAfterHeader) ?? 1,
      suggestion: 'Back off and retry.',
    });
  }
  if (status >= 500) {
    return new AhError({
      httpStatus: status,
      code: 'upstream_unavailable',
      message: message ?? `The ApparelHub API returned ${status}.`,
      suggestion: 'Transient upstream issue; retry shortly.',
    });
  }
  return new AhError({
    httpStatus: status,
    code: 'http_error',
    message: message ?? `Unexpected HTTP ${status}.`,
  });
}

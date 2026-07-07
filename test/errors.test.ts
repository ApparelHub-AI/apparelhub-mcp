import { describe, it, expect } from 'vitest';
import { AhError, toErrorPayload, mapHttpError, parseRetryAfter } from '../src/errors.js';

describe('AhError.toPayload', () => {
  it('includes retry_after + suggestion when present', () => {
    const e = new AhError({
      code: 'platform_rate_limited',
      message: 'slow down',
      retryAfter: 5,
      suggestion: 'wait',
    });
    expect(e.toPayload()).toEqual({
      error: {
        code: 'platform_rate_limited',
        message: 'slow down',
        retry_after: 5,
        suggestion: 'wait',
      },
    });
  });

  it('includes source when present (model rate limits)', () => {
    const e = new AhError({
      code: 'model_rate_limited',
      message: 'throttled',
      source: 'Nano Banana',
    });
    expect(e.toPayload()).toEqual({
      error: { code: 'model_rate_limited', message: 'throttled', source: 'Nano Banana' },
    });
  });

  it('omits optional fields when absent', () => {
    const e = new AhError({ code: 'not_found', message: 'gone' });
    expect(e.toPayload()).toEqual({ error: { code: 'not_found', message: 'gone' } });
  });
});

describe('toErrorPayload', () => {
  it('passes AhError through', () => {
    expect(toErrorPayload(new AhError({ code: 'x', message: 'y' }))).toEqual({
      error: { code: 'x', message: 'y' },
    });
  });
  it('wraps a generic Error as internal_error', () => {
    expect(toErrorPayload(new Error('boom'))).toEqual({
      error: { code: 'internal_error', message: 'boom' },
    });
  });
});

describe('mapHttpError', () => {
  it('400 -> bad_request', () => {
    expect(mapHttpError(400, { error: 'bad field' }).code).toBe('bad_request');
  });
  it('401 -> auth_required', () => {
    expect(mapHttpError(401, {}).code).toBe('auth_required');
  });
  it('403 workspace_forbidden -> workspace_forbidden', () => {
    expect(mapHttpError(403, { error: 'workspace_forbidden' }).code).toBe('workspace_forbidden');
  });
  it('403 with capability -> forbidden and names the capability', () => {
    const e = mapHttpError(403, { error: 'forbidden', capability: 'design.generate' });
    expect(e.code).toBe('forbidden');
    expect(e.message).toContain('design.generate');
  });
  it('404 workspace_not_found -> workspace_not_found', () => {
    expect(mapHttpError(404, { error: 'workspace_not_found' }).code).toBe('workspace_not_found');
  });
  it('404 -> not_found', () => {
    expect(mapHttpError(404, { error: 'no such order' }).code).toBe('not_found');
  });
  it('409 -> conflict and surfaces the body message', () => {
    const e = mapHttpError(409, { error: 'sales_channel_uniqueness' });
    expect(e.code).toBe('conflict');
    expect(e.message).toContain('sales_channel_uniqueness');
  });
  it('422 -> unprocessable', () => {
    expect(mapHttpError(422, { error: 'edit not supported on this source' }).code).toBe(
      'unprocessable',
    );
  });
  it('429 with a model_rate_limited body -> model_rate_limited carrying source + retry_after', () => {
    const e = mapHttpError(429, {
      error: 'model_rate_limited',
      source: 'Nano Banana',
      retry_after: 25,
      message: 'Nano Banana throttled by provider',
    });
    expect(e.code).toBe('model_rate_limited');
    expect(e.source).toBe('Nano Banana');
    expect(e.retryAfter).toBe(25);
    expect(e.message).toContain('Nano Banana');
    expect(e.suggestion).toMatch(/different source/i);
  });

  it('429 model_rate_limited falls back to the Retry-After header when the body has no retry_after', () => {
    const e = mapHttpError(429, { error: 'model_rate_limited', source: 'Flux 2 Pro' }, '9');
    expect(e.code).toBe('model_rate_limited');
    expect(e.retryAfter).toBe(9);
  });

  it('plain 429 -> platform_rate_limited: back off, switching models will not help', () => {
    const e = mapHttpError(429, {}, '3');
    expect(e.code).toBe('platform_rate_limited');
    expect(e.retryAfter).toBe(3);
    expect(e.suggestion).toMatch(/back off/i);
    expect(e.suggestion).toMatch(/switching models will not help/i);
  });
  it('500 -> upstream_unavailable', () => {
    expect(mapHttpError(503, {}).code).toBe('upstream_unavailable');
  });
});

describe('parseRetryAfter', () => {
  it('parses numeric seconds', () => {
    expect(parseRetryAfter('7')).toBe(7);
  });
  it('returns undefined for null', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

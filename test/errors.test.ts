import { describe, it, expect } from 'vitest';
import { AhError, toErrorPayload, mapHttpError, parseRetryAfter } from '../src/errors.js';

describe('AhError.toPayload', () => {
  it('includes retry_after + suggestion when present', () => {
    const e = new AhError({
      code: 'rate_limited',
      message: 'slow down',
      retryAfter: 5,
      suggestion: 'wait',
    });
    expect(e.toPayload()).toEqual({
      error: { code: 'rate_limited', message: 'slow down', retry_after: 5, suggestion: 'wait' },
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
  it('429 -> rate_limited with retry_after from header', () => {
    const e = mapHttpError(429, {}, '3');
    expect(e.code).toBe('rate_limited');
    expect(e.retryAfter).toBe(3);
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

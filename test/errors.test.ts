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
  // A suspended account is a plan problem, and where the owner fixes it depends
  // on who bills them. Pointing a Shopify-billed merchant at ApparelHub billing
  // is a dead end: we never took their card (epic apparelhub-ai#729).
  it('402 -> account_suspended, and says do not retry', () => {
    const e = mapHttpError(402, {
      error: 'account_suspended', tier: 'Enterprise',
      message: "This account's Enterprise trial has ended.",
      billing_provider: 'stripe',
      billing_url: 'https://apparelhub.ai/billing/subscription',
    });
    expect(e.code).toBe('account_suspended');
    expect(e.suggestion).toContain('Do not retry');
    expect(e.suggestion).toContain('Billing on ApparelHub');
    expect(e.suggestion).toContain('https://apparelhub.ai/billing/subscription');
  });
  it('402 for a Shopify-billed account points at the Shopify admin', () => {
    const e = mapHttpError(402, {
      error: 'account_suspended', billing_provider: 'shopify',
      billing_url: 'https://admin.shopify.com/store/s/charges/apparelhub-ai/pricing_plans',
    });
    expect(e.suggestion).toContain('Shopify admin');
    expect(e.suggestion).not.toContain('Billing on ApparelHub');
  });
  it('402 with no billing url still names where to go', () => {
    const e = mapHttpError(402, { error: 'account_suspended', billing_provider: 'shopify' });
    expect(e.suggestion).toContain('Shopify admin');
  });
  // Seats are a plan limit, not a permission. The generic 403 advice ("this key
  // lacks scope") would send the caller looking in the wrong place entirely.
  it('403 seat_limit_reached -> seat_limit_reached, not a scope problem', () => {
    const e = mapHttpError(403, {
      error: 'seat_limit_reached', current: 50, limit: 50,
      message: 'Your plan includes 50 seats and you have used 50.',
    });
    expect(e.code).toBe('seat_limit_reached');
    expect(e.message).toContain('50 seats');
    expect(e.suggestion).toContain('Remove a member');
    expect(e.suggestion).not.toContain('scope');
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

// Structured 400s (apparelhub-ai#814/#870/#791). These are refusals that name a
// condition and return the data to satisfy it — NOT malformed requests. Telling an
// agent to "check field names" for a knitted garment with an unreadable design
// sends it looking for a bug that does not exist.
describe('structured 400 refusals keep their code', () => {
  const cases: Array<[string, RegExp]> = [
    ['empty_variant_selection', /available_variants/i],
    ['no_buildable_variants', /available_colors/i],
    ['placement_constraint', /fewer placements/i],
    ['knit_options_unavailable', /knitted/i],
  ];

  for (const [code, suggestionRe] of cases) {
    it(`preserves ${code} instead of collapsing to bad_request`, () => {
      const err = mapHttpError(400, { error: code, message: 'platform prose' });
      expect(err.code).toBe(code);
      expect(err.message).toBe('platform prose');
      expect(err.suggestion).toMatch(suggestionRe);
      // The generic advice is wrong for these — there is no offending field.
      expect(err.suggestion).not.toMatch(/check field names/i);
    });
  }

  it('an ordinary 400 still maps to bad_request', () => {
    const err = mapHttpError(400, { message: 'missing required field' });
    expect(err.code).toBe('bad_request');
    expect(err.suggestion).toMatch(/check field names/i);
  });

  it('an unrecognised error code still maps to bad_request', () => {
    const err = mapHttpError(400, { error: 'something_new', message: 'x' });
    expect(err.code).toBe('bad_request');
  });
});

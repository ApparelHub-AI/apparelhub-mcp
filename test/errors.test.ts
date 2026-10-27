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
  // The API's own 403s always carry an `error` code. A 403 carrying ONLY a message is
  // an edge layer (WAF / CDN / gateway) dropping the request before it reaches the API.
  // Reporting that as a key-scope problem sent a real user to audit permissions that
  // were never involved, while the request was being blocked upstream.
  it('403 with no error code -> blocked_upstream, not a scope problem', () => {
    const e = mapHttpError(403, { message: 'Forbidden' });
    expect(e.code).toBe('blocked_upstream');
    expect(e.suggestion).toContain('NOT a key or permissions problem');
    expect(e.suggestion).not.toContain('lacks scope');
  });
  it('403 blocked_upstream tells the caller not to retry identically', () => {
    const e = mapHttpError(403, { message: 'Forbidden' });
    expect(e.suggestion).toContain('keep failing');
    // The dominant real-world trigger, so the hint has to be actionable.
    expect(e.suggestion).toContain('upload');
  });
  it('403 with a bare string body is still treated as an edge block', () => {
    expect(mapHttpError(403, 'Forbidden').code).toBe('blocked_upstream');
  });
  // A capability-only body is still a real permissions refusal, so the more specific
  // branch must win over the edge-block one.
  it('403 with capability but no error code stays forbidden', () => {
    const e = mapHttpError(403, { capability: 'design.generate' });
    expect(e.code).toBe('forbidden');
    expect(e.message).toContain('design.generate');
  });
  // A plan gate, not a permission. Same class of misdirection as seat_limit_reached.
  it('403 feature_unavailable -> feature_unavailable, not a scope problem', () => {
    const e = mapHttpError(403, {
      error: 'feature_unavailable',
      message: 'The cross-client portfolio requires an agency (Enterprise) account.',
    });
    expect(e.code).toBe('feature_unavailable');
    expect(e.message).toContain('agency (Enterprise)');
    expect(e.suggestion).toContain('upgrade');
    expect(e.suggestion).not.toContain('lacks scope');
  });
  // An unrecognized code should report what the API said rather than asserting a cause.
  it('403 with an unrecognized error code does not claim a definite cause', () => {
    const e = mapHttpError(403, { error: 'some_new_gate', message: 'Nope.' });
    expect(e.code).toBe('forbidden');
    expect(e.suggestion).toContain('some_new_gate');
    expect(e.suggestion).not.toContain('lacks scope');
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
  it('409 keeps the broad conflict code so existing callers still match', () => {
    // upload's resume path treats a 409 as benign by matching code === 'conflict'.
    // Narrowing the code to the API's own would silently reroute that.
    const e = mapHttpError(409, { error: 'replacement_exists', message: 'already exists' });
    expect(e.code).toBe('conflict');
  });
  it('409 preserves the API error code in apiCode, under either spelling', () => {
    // Without this the discriminator was unrecoverable: it was folded into
    // `message` only when the body had NO message of its own.
    const withMessage = mapHttpError(409, {
      error_code: 'images_version_conflict',
      message: 'stale version',
      current_version: 9,
    });
    expect(withMessage.apiCode).toBe('images_version_conflict');
    expect(withMessage.message).toBe('stale version');

    const legacySpelling = mapHttpError(409, { error: 'images_version_conflict', message: 'x' });
    expect(legacySpelling.apiCode).toBe('images_version_conflict');
  });
  it('409 with no code leaves apiCode unset', () => {
    expect(mapHttpError(409, { message: 'something conflicted' }).apiCode).toBeUndefined();
  });
  it('apiCode is internal: it does not leak into the agent-facing error payload', () => {
    const payload = mapHttpError(409, {
      error_code: 'images_version_conflict',
      message: 'stale',
    }).toPayload();
    expect(payload.error).not.toHaveProperty('apiCode');
    expect(payload.error.code).toBe('conflict');
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

  // apparelhub-ai#1168: a FULFILLMENT PROVIDER throttling a credential check is a
  // third, distinct 429. Reading it as platform_rate_limited tells the agent to
  // back off its own key, which is not the thing being throttled.
  it('429 provider_rate_limited is attributed to the provider, not this key', () => {
    const e = mapHttpError(
      429,
      { error: 'provider_rate_limited', provider: 'Printify', retry_after: 30 },
      undefined,
    );
    expect(e.code).toBe('provider_rate_limited');
    expect(e.code).not.toBe('platform_rate_limited');
    expect(e.source).toBe('Printify');
    expect(e.retryAfter).toBe(30);
    expect(e.message).toMatch(/Printify/);
  });

  it('429 provider_rate_limited never reads as a bad credential', () => {
    // The whole point of #1168: a throttle must not send anyone to replace a
    // token that was fine.
    const e = mapHttpError(429, { error: 'provider_rate_limited', provider: 'Printify' }, '12');
    expect(e.suggestion).toMatch(/not a bad token/i);
    expect(e.suggestion).not.toMatch(/switching models/i);
    expect(e.retryAfter).toBe(12); // falls back to the Retry-After header
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

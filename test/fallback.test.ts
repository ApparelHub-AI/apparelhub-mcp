import { describe, it, expect } from 'vitest';
import { runGenerationWithFallback } from '../src/image/generate.js';
import {
  generateImage,
  designApparel,
  iterateDesign,
} from '../src/tools/design.js';
import { ApiClient, type FetchLike } from '../src/http/client.js';
import { AhError } from '../src/errors.js';
import { VALID_SOURCES, EDIT_CAPABLE_SOURCES, providerOf } from '../src/knowledge/sources.js';
import { fakeContext } from './helpers/ctx.js';
import { jsonResponse, noSleep } from './helpers/fakeFetch.js';

// A fetch stub that decides its response from the `source` in the POST body, so a fallback ladder
// can be exercised (fail model A, succeed model B). 500 -> upstream_unavailable (fallbackable, and
// NOT retried by the client so it surfaces after one request); 403 -> forbidden (non-fallbackable).
type PerSource = (source: string) => Response;
function sourceAwareFetch(decide: PerSource): { fetchImpl: FetchLike; sources: string[] } {
  const sources: string[] = [];
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as { source?: string }) : {};
    const source = body.source ?? '';
    sources.push(source);
    return decide(source);
  }) as unknown as FetchLike;
  return { fetchImpl, sources };
}

function apiWith(fetchImpl: FetchLike): ApiClient {
  return new ApiClient({
    apiKey: 'k',
    baseUrl: 'https://api.example.test/agents/v1',
    userAgent: 't',
    fetchImpl,
    sleepImpl: noSleep,
  });
}

describe('runGenerationWithFallback', () => {
  it('falls back to the next model on a transient failure and records the trail', async () => {
    const { fetchImpl, sources } = sourceAwareFetch((source) =>
      source === 'Nano Banana'
        ? jsonResponse(500, { message: 'model overloaded' }) // fallbackable
        : jsonResponse(200, { image_uuid: 'gB', url: 'https://cdn.example/b.png' }),
    );
    const res = await runGenerationWithFallback(
      apiWith(fetchImpl),
      { prompt: 'x', source: 'Nano Banana', sources: ['Nano Banana', 'Flux 1.1 Pro', 'OpenAI'] },
      { sleep: noSleep },
    );
    expect(res).toMatchObject({ image_uuid: 'gB', image_url: 'https://cdn.example/b.png', source_used: 'Flux 1.1 Pro' });
    expect(res.fallback_trail).toHaveLength(1);
    expect(res.fallback_trail[0]).toMatchObject({ source: 'Nano Banana' });
    expect(res.fallback_trail[0]!.reason).toContain('upstream_unavailable');
    // proves it actually tried A then B (not just B)
    expect(sources).toEqual(['Nano Banana', 'Flux 1.1 Pro']);
  });

  it('has an empty trail when the first model succeeds', async () => {
    const { fetchImpl, sources } = sourceAwareFetch(() =>
      jsonResponse(200, { image_uuid: 'gA', url: 'https://cdn.example/a.png' }),
    );
    const res = await runGenerationWithFallback(
      apiWith(fetchImpl),
      { prompt: 'x', source: 'Nano Banana', sources: ['Nano Banana', 'Flux 1.1 Pro', 'OpenAI'] },
      { sleep: noSleep },
    );
    expect(res.source_used).toBe('Nano Banana');
    expect(res.fallback_trail).toEqual([]);
    expect(sources).toEqual(['Nano Banana']); // did NOT touch the other models
  });

  it('rethrows a NON-fallbackable error immediately without cycling models', async () => {
    const { fetchImpl, sources } = sourceAwareFetch(() =>
      jsonResponse(403, { error: 'forbidden' }),
    );
    await expect(
      runGenerationWithFallback(
        apiWith(fetchImpl),
        { prompt: 'x', source: 'Nano Banana', sources: ['Nano Banana', 'Flux 1.1 Pro', 'OpenAI'] },
        { sleep: noSleep },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(sources).toEqual(['Nano Banana']); // stopped after the first — did not fall back
  });

  it('rethrows a 400 validation error immediately (no fallback)', async () => {
    const { fetchImpl, sources } = sourceAwareFetch(() =>
      jsonResponse(400, { message: 'bad prompt' }),
    );
    await expect(
      runGenerationWithFallback(
        apiWith(fetchImpl),
        { prompt: 'x', source: 'Nano Banana', sources: ['Nano Banana', 'OpenAI'] },
        { sleep: noSleep },
      ),
    ).rejects.toMatchObject({ code: 'bad_request' });
    expect(sources).toEqual(['Nano Banana']);
  });

  it('throws a single error whose detail lists the full trail when every model fails', async () => {
    const { fetchImpl, sources } = sourceAwareFetch(() =>
      jsonResponse(500, { message: 'all providers down' }),
    );
    let caught: unknown;
    try {
      await runGenerationWithFallback(
        apiWith(fetchImpl),
        { prompt: 'x', source: 'Nano Banana', sources: ['Nano Banana', 'Flux 1.1 Pro', 'OpenAI'] },
        { sleep: noSleep },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AhError);
    const e = caught as AhError;
    expect(e.message).toContain('every fallback model');
    // every rung is named in the final error detail
    expect(e.message).toContain('Nano Banana');
    expect(e.message).toContain('Flux 1.1 Pro');
    expect(e.message).toContain('OpenAI');
    expect(sources).toEqual(['Nano Banana', 'Flux 1.1 Pro', 'OpenAI']); // exhausted the whole ladder
  });

  it('the async structured model_rate_limited failure triggers the ladder via the precise code', async () => {
    // The primary (async) model 202s, then its poll fails with the exact platform contract string;
    // the ladder must classify it as model_rate_limited (code, not message heuristic) and fall back.
    const sources: string[] = [];
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/images/upload/')) {
        return jsonResponse(200, {
          processing_status: 'failed',
          error: 'model_rate_limited: Nano Banana throttled by provider (retry_after=25s)',
        });
      }
      const body = init?.body ? (JSON.parse(String(init.body)) as { source?: string }) : {};
      const source = body.source ?? '';
      sources.push(source);
      if (source === 'Nano Banana') {
        return jsonResponse(202, { image_uuid: 'gA', processing_status: 'pending' });
      }
      return jsonResponse(200, { image_uuid: 'gB', url: 'https://cdn.example/b.png' });
    }) as unknown as FetchLike;

    const res = await runGenerationWithFallback(
      apiWith(fetchImpl),
      { prompt: 'x', source: 'Nano Banana', sources: ['Nano Banana', 'Flux 1.1 Pro', 'OpenAI'] },
      { sleep: noSleep, intervalMs: 0 },
    );
    expect(res.source_used).toBe('Flux 1.1 Pro');
    expect(res.fallback_trail).toHaveLength(1);
    expect(res.fallback_trail[0]).toMatchObject({
      source: 'Nano Banana',
      code: 'model_rate_limited',
    });
    expect(sources).toEqual(['Nano Banana', 'Flux 1.1 Pro']);
  });

  // apparelhub-ai#825: the platform now distinguishes three failure kinds that used to be one
  // opaque string. They have three different remedies, and crucially two of the three are worth
  // another model while the third is not.
  const asyncFailure = (errorCode: string, message: string) => {
    const sources: string[] = [];
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/images/upload/')) {
        return jsonResponse(200, {
          processing_status: 'failed',
          error: message,
          error_code: errorCode,
        });
      }
      const body = init?.body ? (JSON.parse(String(init.body)) as { source?: string }) : {};
      const source = body.source ?? '';
      sources.push(source);
      if (source === 'Nano Banana') {
        return jsonResponse(202, { image_uuid: 'gA', processing_status: 'pending' });
      }
      return jsonResponse(200, { image_uuid: 'gB', url: 'https://cdn.example/b.png' });
    }) as unknown as FetchLike;
    return { fetchImpl, sources };
  };

  // Every model refuses — for exercising the terminal state and the full sweep.
  const asyncFailureAll = (errorCode: string, message: string) => {
    const sources: string[] = [];
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/images/upload/')) {
        return jsonResponse(200, {
          processing_status: 'failed',
          error: message,
          error_code: errorCode,
        });
      }
      const body = init?.body ? (JSON.parse(String(init.body)) as { source?: string }) : {};
      sources.push(body.source ?? '');
      return jsonResponse(202, { image_uuid: 'gX', processing_status: 'pending' });
    }) as unknown as FetchLike;
    return { fetchImpl, sources };
  };

  const BLOCK_MSG = 'Image generation was blocked. The prompt may contain copyrighted characters.';

  // NOTE: this suite previously asserted content_blocked did NOT fall back, reasoning that "the
  // prompt caused it, so every model refuses the same request". Production disproved that. Guards
  // are provider-specific: an agent hit a recitation block, reworded the same idea six times, was
  // refused every time, and abandoned the design — while nine other models sat untried.
  it('content_blocked now falls back — a different provider renders what one refused', async () => {
    const { fetchImpl, sources } = asyncFailure('content_blocked', BLOCK_MSG);
    const res = await runGenerationWithFallback(
      apiWith(fetchImpl),
      { prompt: 'x', source: 'Nano Banana', sources: ['Nano Banana'] },
      { sleep: noSleep, intervalMs: 0 },
    );
    expect(res.fallback_trail[0]).toMatchObject({
      source: 'Nano Banana',
      code: 'content_blocked',
    });
    expect(sources.length).toBeGreaterThan(1);
  });

  it('leaves the refusing provider immediately rather than walking its siblings', async () => {
    const { fetchImpl, sources } = asyncFailure('content_blocked', BLOCK_MSG);
    await runGenerationWithFallback(
      apiWith(fetchImpl),
      // Ladder of one, so the order under test is the SWEEP's, not the ladder's.
      { prompt: 'x', source: 'Nano Banana', sources: ['Nano Banana'] },
      { sleep: noSleep, intervalMs: 0 },
    );
    expect(providerOf(sources[0]!)).toBe('google');
    // A sibling on the host that just refused is the same guard — the least useful next move.
    expect(providerOf(sources[1]!)).not.toBe('google');
    expect(providerOf(sources[1]!)).toBe('replicate');
  });

  it('sweeps the FULL model set, not the short 3-rung ladder', async () => {
    const { fetchImpl, sources } = asyncFailureAll('content_blocked', BLOCK_MSG);
    await runGenerationWithFallback(
      apiWith(fetchImpl),
      { prompt: 'x', source: 'Nano Banana', sources: ['Nano Banana', 'Flux 1.1 Pro', 'OpenAI'] },
      { sleep: noSleep, intervalMs: 0 },
    ).catch((e) => e);
    // Every model, exactly once. The 3-rung cap exists to bound slow rate-limit retries; a refusal
    // is FASTER than a success, so that rationale does not apply here.
    expect(new Set(sources)).toEqual(new Set(VALID_SOURCES));
    expect(sources.length).toBe(VALID_SOURCES.length);
  });

  it('when every model refuses, the terminal error says exactly that', async () => {
    const { fetchImpl } = asyncFailureAll('content_blocked', BLOCK_MSG);
    const err = await runGenerationWithFallback(
      apiWith(fetchImpl),
      { prompt: 'x', source: 'Nano Banana', sources: ['Nano Banana'] },
      { sleep: noSleep, intervalMs: 0 },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(AhError);
    const e = err as AhError;
    // A DISTINCT terminal code: this is the only signal that abandoning the design is legitimate,
    // and it must not read the same as one model saying no.
    expect(e.code).toBe('content_blocked_all_models');
    expect(e.message).toMatch(/every available image model refused/i);
    expect(e.message).toMatch(/provider/i);
    expect(e.suggestion).toMatch(/exhausted/i);
  });

  it('restricts the sweep to edit-capable models on an edit', async () => {
    const { fetchImpl, sources } = asyncFailureAll('content_blocked', BLOCK_MSG);
    await runGenerationWithFallback(
      apiWith(fetchImpl),
      { prompt: 'x', source: 'Nano Banana', sources: ['Nano Banana'], sourceImageUuid: 'src' },
      { sleep: noSleep, intervalMs: 0 },
    ).catch((e) => e);
    // A text-to-image-only model can never rescue an edit; offering one spends a rung on a
    // guaranteed rejection.
    expect(sources).not.toContain('Google Imagen 4');
    expect(sources).not.toContain('Flux 1.1 Pro');
    for (const s of sources) expect(EDIT_CAPABLE_SOURCES.has(s)).toBe(true);
  });

  it('no_fallback still fails on the chosen source alone, with the plain block code', async () => {
    const { fetchImpl, sources } = asyncFailure('content_blocked', BLOCK_MSG);
    const err = await runGenerationWithFallback(
      apiWith(fetchImpl),
      { prompt: 'x', source: 'Nano Banana', sources: ['Nano Banana'], noFallback: true },
      { sleep: noSleep, intervalMs: 0 },
    ).catch((e) => e);
    expect((err as AhError).code).toBe('content_blocked');
    expect(sources).toEqual(['Nano Banana']);
  });

  it('a mixed sweep is NOT reported as "every model refused"', async () => {
    // One content block, then rate limits. Claiming the sweep was exhausted would tell the agent to
    // abandon a design the later models never actually refused.
    const sources: string[] = [];
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      if (String(input).includes('/images/upload/')) {
        return jsonResponse(200, {
          processing_status: 'failed',
          error: BLOCK_MSG,
          error_code: 'content_blocked',
        });
      }
      const body = init?.body ? (JSON.parse(String(init.body)) as { source?: string }) : {};
      const source = body.source ?? '';
      sources.push(source);
      if (source === 'Nano Banana') {
        return jsonResponse(202, { image_uuid: 'gA', processing_status: 'pending' });
      }
      return jsonResponse(429, { error: 'model_rate_limited', source, retry_after: 5 });
    }) as unknown as FetchLike;
    const err = await runGenerationWithFallback(
      apiWith(fetchImpl),
      { prompt: 'x', source: 'Nano Banana', sources: ['Nano Banana'] },
      { sleep: noSleep, intervalMs: 0 },
    ).catch((e) => e);
    expect((err as AhError).code).not.toBe('content_blocked_all_models');
  });

  it('no_image_returned DOES fall back — it is model-specific, not caused by the prompt', async () => {
    const { fetchImpl, sources } = asyncFailure(
      'no_image_returned',
      'Image generation did not return an image.',
    );
    const res = await runGenerationWithFallback(
      apiWith(fetchImpl),
      { prompt: 'x', source: 'Nano Banana', sources: ['Nano Banana', 'Flux 1.1 Pro'] },
      { sleep: noSleep, intervalMs: 0 },
    );
    expect(res.source_used).toBe('Flux 1.1 Pro');
    expect(res.fallback_trail[0]).toMatchObject({
      source: 'Nano Banana',
      code: 'no_image_returned',
    });
    expect(sources).toEqual(['Nano Banana', 'Flux 1.1 Pro']);
  });

  it('text_response_instead_of_image DOES fall back, and says to rephrase', async () => {
    const { fetchImpl } = asyncFailure(
      'text_response_instead_of_image',
      'the AI model returned a text response instead of an image.',
    );
    const res = await runGenerationWithFallback(
      apiWith(fetchImpl),
      { prompt: 'x', source: 'Nano Banana', sources: ['Nano Banana', 'Flux 1.1 Pro'] },
      { sleep: noSleep, intervalMs: 0 },
    );
    expect(res.source_used).toBe('Flux 1.1 Pro');
    expect(res.fallback_trail[0]).toMatchObject({ code: 'text_response_instead_of_image' });
  });

  it('a failure with no error_code still behaves as before (older platform builds)', async () => {
    const sources: string[] = [];
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      if (String(input).includes('/images/upload/')) {
        return jsonResponse(200, { processing_status: 'failed', error: 'something went wrong' });
      }
      const body = init?.body ? (JSON.parse(String(init.body)) as { source?: string }) : {};
      sources.push(body.source ?? '');
      return jsonResponse(202, { image_uuid: 'gA', processing_status: 'pending' });
    }) as unknown as FetchLike;
    const err = await runGenerationWithFallback(
      apiWith(fetchImpl),
      { prompt: 'x', source: 'Nano Banana', sources: ['Nano Banana', 'Flux 1.1 Pro'] },
      { sleep: noSleep, intervalMs: 0 },
    ).catch((e) => e);
    expect((err as AhError).code).toBe('generation_failed');
    expect(sources).toEqual(['Nano Banana']);
  });

  it('platform_rate_limited does NOT fall back — the per-key throttle is model-independent', async () => {
    const { fetchImpl, sources } = sourceAwareFetch(() =>
      jsonResponse(429, {}, { 'retry-after': '3' }),
    );
    await expect(
      runGenerationWithFallback(
        apiWith(fetchImpl),
        { prompt: 'x', source: 'Nano Banana', sources: ['Nano Banana', 'Flux 1.1 Pro', 'OpenAI'] },
        { sleep: noSleep },
      ),
    ).rejects.toMatchObject({ code: 'platform_rate_limited', retryAfter: 3 });
    // Only the FIRST source was ever attempted (the client's own transient 429 retries repeat it);
    // no other model was tried, because switching models cannot escape a per-key throttle.
    expect(new Set(sources)).toEqual(new Set(['Nano Banana']));
  });

  it('all models provider-throttled -> final error keeps code model_rate_limited + back-off guidance', async () => {
    const { fetchImpl, sources } = sourceAwareFetch((source) =>
      jsonResponse(429, { error: 'model_rate_limited', source, retry_after: 25 }),
    );
    let caught: unknown;
    try {
      await runGenerationWithFallback(
        apiWith(fetchImpl),
        { prompt: 'x', source: 'Nano Banana', sources: ['Nano Banana', 'Flux 1.1 Pro', 'OpenAI'] },
        { sleep: noSleep },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AhError);
    const e = caught as AhError;
    expect(e.code).toBe('model_rate_limited');
    expect(e.message).toContain("every fallback model's provider is currently rate limiting");
    expect(e.suggestion).toMatch(/back off/i);
    // The honest attribution: providers throttled, NOT ApparelHub's own request throttle.
    expect(e.suggestion).toMatch(/not apparelhub's request throttle/i);
    expect(new Set(sources)).toEqual(new Set(['Nano Banana', 'Flux 1.1 Pro', 'OpenAI']));
  });

  it('no_fallback: tries only the first source and rethrows its error', async () => {
    const { fetchImpl, sources } = sourceAwareFetch((source) =>
      source === 'Nano Banana'
        ? jsonResponse(500, { message: 'overloaded' }) // would be fallbackable, but noFallback blocks it
        : jsonResponse(200, { image_uuid: 'gB', url: 'https://cdn.example/b.png' }),
    );
    await expect(
      runGenerationWithFallback(
        apiWith(fetchImpl),
        {
          prompt: 'x',
          source: 'Nano Banana',
          sources: ['Nano Banana', 'Flux 1.1 Pro', 'OpenAI'],
          noFallback: true,
        },
        { sleep: noSleep },
      ),
    ).rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect(sources).toEqual(['Nano Banana']); // never reached the fallback models
  });
});

describe('generate_image fallback wiring', () => {
  it('substitutes a model on a transient failure and surfaces the trail', async () => {
    const { fetchImpl } = sourceAwareFetch((source) =>
      source === 'Nano Banana'
        ? jsonResponse(500, { message: 'overloaded' })
        : jsonResponse(200, { image_uuid: 'gB', url: 'https://cdn.example/b.png' }),
    );
    const res = (await generateImage.handler({ prompt: 'a cactus' }, fakeContext(apiWith(fetchImpl)))) as any;
    expect(res.source_used).toBe('Flux 1.1 Pro');
    expect(res.fallback_trail).toHaveLength(1);
    expect(res.fallback_trail[0].source).toBe('Nano Banana');
  });

  it('no_fallback surfaces the pinned-source failure immediately', async () => {
    const { fetchImpl, sources } = sourceAwareFetch(() => jsonResponse(500, { message: 'overloaded' }));
    await expect(
      generateImage.handler(
        { prompt: 'a cactus', source: 'Flux 1.1 Pro', no_fallback: true },
        fakeContext(apiWith(fetchImpl)),
      ),
    ).rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect(sources).toEqual(['Flux 1.1 Pro']);
  });

  it('an explicit source still falls back (a produced design beats none), recorded in the trail', async () => {
    const { fetchImpl } = sourceAwareFetch((source) =>
      source === 'Flux 1.1 Pro'
        ? jsonResponse(500, { message: 'overloaded' })
        : jsonResponse(200, { image_uuid: 'gN', url: 'https://cdn.example/n.png' }),
    );
    const res = (await generateImage.handler(
      { prompt: 'a cactus', source: 'Flux 1.1 Pro' },
      fakeContext(apiWith(fetchImpl)),
    )) as any;
    // Flux (pinned, first) failed, so it fell back to Nano Banana (next in the default ladder).
    expect(res.source_used).toBe('Nano Banana');
    expect(res.fallback_trail[0].source).toBe('Flux 1.1 Pro');
  });
});

describe('design_apparel fallback wiring', () => {
  it('attaches the fallback trail per design', async () => {
    // Nano Banana (default first) fails; OpenAI succeeds. Skip transparency + text to keep it to the
    // generate call only.
    const { fetchImpl } = sourceAwareFetch((source) =>
      source === 'Nano Banana'
        ? jsonResponse(500, { message: 'overloaded' })
        : jsonResponse(200, { image_uuid: 'gB', url: 'https://cdn.example/b.png' }),
    );
    const res = (await designApparel.handler(
      { prompt: 'stay wild cactus', needs_transparency: false, verify_text: false },
      fakeContext(apiWith(fetchImpl)),
    )) as any;
    expect(res.designs).toHaveLength(1);
    expect(res.designs[0].source_used).toBe('Flux 1.1 Pro');
    expect(res.designs[0].fallback_trail[0].source).toBe('Nano Banana');
  });
});

describe('iterate_design fallback wiring', () => {
  it('falls back to the other edit-capable model (Nano Banana -> OpenAI)', async () => {
    const { fetchImpl, sources } = sourceAwareFetch((source) =>
      source === 'Nano Banana'
        ? jsonResponse(500, { message: 'overloaded' })
        : jsonResponse(200, { image_uuid: 'g9', url: 'https://cdn.example/v.png' }),
    );
    const res = (await iterateDesign.handler(
      { source_design_uuid: 'g1', change_description: 'make it blue' },
      fakeContext(apiWith(fetchImpl)),
    )) as any;
    expect(res.source_used).toBe('OpenAI');
    expect(res.fallback_trail[0].source).toBe('Nano Banana');
    // edit ladder is ONLY the two edit-capable models (never a Replicate source)
    expect(sources).toEqual(['Nano Banana', 'OpenAI']);
  });

  it('still hard-rejects a text-to-image-only source (Google Imagen 4)', async () => {
    await expect(
      iterateDesign.handler(
        { source_design_uuid: 'g1', change_description: 'blue', source: 'Google Imagen 4' },
        fakeContext(),
      ),
    ).rejects.toMatchObject({ code: 'unprocessable' });
  });
});

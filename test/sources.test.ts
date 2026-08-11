import { describe, it, expect } from 'vitest';
import {
  pickSource,
  normalizeSource,
  augmentPromptForTransparency,
  buildIterationPrompt,
  fallbackLadder,
  isFallbackableError,
  EDIT_CAPABLE_SOURCES,
  VALID_SOURCES,
  contentBlockSweep,
  isContentBlockError,
  providerOf,
} from '../src/knowledge/sources.js';
import { AhError } from '../src/errors.js';

describe('pickSource', () => {
  it('defaults to Nano Banana and never prefers OpenAI (operator directive)', () => {
    expect(pickSource({})).toBe('Nano Banana');
    expect(pickSource({ style: 'abstract' })).toBe('Nano Banana');
  });
});

describe('normalizeSource', () => {
  it('returns canonical names unchanged', () => {
    expect(normalizeSource('Nano Banana')).toBe('Nano Banana');
    expect(normalizeSource('Flux 1.1 Pro')).toBe('Flux 1.1 Pro');
  });
  it('normalizes case/whitespace variants to the canonical spelling', () => {
    expect(normalizeSource('seedream 4.5')).toBe('Seedream 4.5');
    expect(normalizeSource('SeeDream 4.5')).toBe('Seedream 4.5'); // the reported near-miss
    expect(normalizeSource('  openai ')).toBe('OpenAI');
  });
  it('rejects an unknown source with a bad_request that lists valid sources + a suggestion', () => {
    let caught: AhError | undefined;
    try {
      normalizeSource('Flux 1.1'); // the reported near-miss (missing " Pro")
    } catch (e) {
      caught = e as AhError;
    }
    expect(caught).toBeInstanceOf(AhError);
    expect(caught?.code).toBe('bad_request');
    expect(caught?.suggestion).toContain('Flux 1.1 Pro'); // nearest-match "did you mean"
    expect(caught?.suggestion).toContain('Nano Banana'); // valid-source list
  });
});

describe('augmentPromptForTransparency', () => {
  it('adds the green-background hint and is idempotent', () => {
    const a = augmentPromptForTransparency('a saguaro cactus');
    expect(a).toContain('#00FF00');
    expect(augmentPromptForTransparency(a)).toBe(a);
  });
  it('leaves a prompt that already asks for a green background alone', () => {
    expect(augmentPromptForTransparency('cactus on a solid green background')).not.toContain('#00FF00');
  });
});

describe('buildIterationPrompt', () => {
  it('includes the change and the preserve list', () => {
    const p = buildIterationPrompt('make it blue', ['composition', 'subject']);
    expect(p).toContain('make it blue');
    expect(p).toContain('composition, subject');
  });
});

describe('EDIT_CAPABLE_SOURCES', () => {
  it('is most sources; NOT Google Imagen 4 (text-only) or Flux 1.1 Pro (Redux)', () => {
    for (const s of [
      'Nano Banana', 'OpenAI', 'GPT Image 2', 'Seedream 4.0', 'Seedream 4.5',
      'Flux 2 Pro', 'Grok Imagine', 'Wan 2.7',
    ]) {
      expect(EDIT_CAPABLE_SOURCES.has(s)).toBe(true);
    }
    expect(EDIT_CAPABLE_SOURCES.has('Google Imagen 4')).toBe(false);
    expect(EDIT_CAPABLE_SOURCES.has('Flux 1.1 Pro')).toBe(false); // Flux Redux != editing
  });
});

describe('fallbackLadder', () => {
  it('defaults to Nano Banana -> Flux 1.1 Pro -> OpenAI', () => {
    expect(fallbackLadder()).toEqual(['Nano Banana', 'Flux 1.1 Pro', 'OpenAI']);
    expect(fallbackLadder({ style: 'photoreal' })).toEqual(['Nano Banana', 'Flux 1.1 Pro', 'OpenAI']);
  });

  it('uses the abstract ladder (OpenAI last) for abstract art', () => {
    expect(fallbackLadder({ style: 'abstract' })).toEqual(['Nano Banana', 'Flux 2 Pro', 'OpenAI']);
  });

  it('restricts to the two edit-capable models for edits', () => {
    expect(fallbackLadder({ edit: true })).toEqual(['Nano Banana', 'OpenAI']);
  });

  it('puts an explicit source first, then appends the rest (deduped)', () => {
    expect(fallbackLadder({ source: 'OpenAI' })).toEqual(['OpenAI', 'Nano Banana', 'Flux 1.1 Pro']);
    // already-first source is not duplicated
    expect(fallbackLadder({ source: 'Nano Banana' })).toEqual(['Nano Banana', 'Flux 1.1 Pro', 'OpenAI']);
  });

  it('filters a text-to-image-only source out of the edit ladder', () => {
    // Google Imagen 4 is the ONLY text-only source now -> dropped from an edit ladder.
    expect(fallbackLadder({ source: 'Google Imagen 4', edit: true })).toEqual(['Nano Banana', 'OpenAI']);
    // A pinned edit-capable source still leads.
    expect(fallbackLadder({ source: 'OpenAI', edit: true })).toEqual(['OpenAI', 'Nano Banana']);
  });

  it('honors an explicit edit on any edit-capable source, but keeps the auto ladder conservative', () => {
    // Replicate + GPT Image 2 edits are now honored (apparelhub-ai#705/#702).
    expect(fallbackLadder({ source: 'Seedream 4.5', edit: true })).toEqual(['Seedream 4.5', 'Nano Banana', 'OpenAI']);
    expect(fallbackLadder({ source: 'GPT Image 2', edit: true })).toEqual(['GPT Image 2', 'Nano Banana', 'OpenAI']);
    // ...but the DEFAULT edit ladder stays the two reliable, provider-diverse models.
    expect(fallbackLadder({ edit: true })).toEqual(['Nano Banana', 'OpenAI']);
  });
});

describe('isFallbackableError', () => {
  const yes = (code: string, message = 'x') => new AhError({ code, message });
  it('is true for per-model rate-limit / transient classes', () => {
    expect(isFallbackableError(yes('model_rate_limited'))).toBe(true);
    expect(isFallbackableError(yes('upstream_unavailable'))).toBe(true);
    expect(isFallbackableError(yes('request_not_sent'))).toBe(true);
    expect(isFallbackableError(yes('network_error'))).toBe(true); // legacy alias, no longer emitted
    expect(isFallbackableError(yes('generation_timeout'))).toBe(true);
  });

  it('is FALSE for platform_rate_limited — the per-key throttle is endpoint-wide, so cycling models cannot help', () => {
    expect(isFallbackableError(yes('platform_rate_limited'))).toBe(false);
  });

  it('is false for validation / auth / forbidden / not_found', () => {
    expect(isFallbackableError(yes('bad_request'))).toBe(false);
    expect(isFallbackableError(yes('unprocessable'))).toBe(false);
    expect(isFallbackableError(yes('auth_required'))).toBe(false);
    expect(isFallbackableError(yes('forbidden'))).toBe(false);
    expect(isFallbackableError(yes('not_found'))).toBe(false);
  });

  it('treats generation_failed as fallbackable ONLY when rate-limit-shaped', () => {
    expect(isFallbackableError(yes('generation_failed', 'content policy blocked'))).toBe(false);
    expect(isFallbackableError(yes('generation_failed', 'Rate limit exceeded'))).toBe(true);
    expect(isFallbackableError(yes('generation_failed', 'resource exhausted'))).toBe(true);
    expect(isFallbackableError(yes('generation_failed', 'HTTP 429 too many requests'))).toBe(true);
  });

  it('is false for a non-AhError', () => {
    expect(isFallbackableError(new Error('boom'))).toBe(false);
    expect(isFallbackableError('nope')).toBe(false);
  });

  it('is FALSE for content_blocked — it has its own, WIDER path, not this one', () => {
    // Kept out of FALLBACKABLE_CODES deliberately so the two behaviours stay separately tunable:
    // that set walks a short capped ladder, a content block sweeps everything.
    expect(isFallbackableError(new AhError({ code: 'content_blocked', message: 'x' }))).toBe(false);
    expect(isContentBlockError(new AhError({ code: 'content_blocked', message: 'x' }))).toBe(true);
    expect(isContentBlockError(new AhError({ code: 'model_rate_limited', message: 'x' }))).toBe(false);
    expect(isContentBlockError(new Error('boom'))).toBe(false);
  });
});

describe('contentBlockSweep', () => {
  it('covers every model when nothing is excluded', () => {
    expect(new Set(contentBlockSweep())).toEqual(new Set(VALID_SOURCES));
  });

  it('never repeats a model already queued or tried', () => {
    const sweep = contentBlockSweep({ exclude: ['Nano Banana', 'Flux 1.1 Pro'] });
    expect(sweep).not.toContain('Nano Banana');
    expect(sweep).not.toContain('Flux 1.1 Pro');
    expect(new Set(sweep).size).toBe(sweep.length);
  });

  it('leads with a provider other than the one that just refused', () => {
    // After Google refuses, the first rung must change guard — that is where nearly all the value
    // is. A sibling on the same host is the same guard that just said no.
    const sweep = contentBlockSweep({ exclude: ['Nano Banana'] });
    expect(providerOf(sweep[0]!)).not.toBe('google');
  });

  it('puts the OpenAI family last', () => {
    // Standing operator directive (OpenAI is least-preferred), and it costs nothing here: OpenAI's
    // moderation guard is the same CLASS as Replicate's per-model safety checkers, so it adds no
    // guard diversity a Replicate model has not already supplied.
    const sweep = contentBlockSweep();
    const openaiPositions = sweep
      .map((s, i) => (providerOf(s) === 'openai' ? i : -1))
      .filter((i) => i >= 0);
    const lastNonOpenai = Math.max(
      ...sweep.map((s, i) => (providerOf(s) === 'openai' ? -1 : i)),
    );
    expect(Math.min(...openaiPositions)).toBeGreaterThan(lastNonOpenai);
  });

  it('restricts to edit-capable models for an edit', () => {
    const sweep = contentBlockSweep({ edit: true });
    for (const s of sweep) expect(EDIT_CAPABLE_SOURCES.has(s)).toBe(true);
    // The two text-to-image-only models can never rescue an edit.
    expect(sweep).not.toContain('Google Imagen 4');
    expect(sweep).not.toContain('Flux 1.1 Pro');
  });

  it('maps every valid source to a provider', () => {
    // A model with no provider would silently break the diversity ordering rather than fail loudly.
    for (const s of VALID_SOURCES) expect(providerOf(s)).toBeTruthy();
  });
});

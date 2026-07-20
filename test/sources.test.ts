import { describe, it, expect } from 'vitest';
import {
  pickSource,
  normalizeSource,
  augmentPromptForTransparency,
  buildIterationPrompt,
  fallbackLadder,
  isFallbackableError,
  EDIT_CAPABLE_SOURCES,
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
  it('is Nano Banana + OpenAI only', () => {
    expect(EDIT_CAPABLE_SOURCES.has('Nano Banana')).toBe(true);
    expect(EDIT_CAPABLE_SOURCES.has('OpenAI')).toBe(true);
    expect(EDIT_CAPABLE_SOURCES.has('Seedream 4.0')).toBe(false);
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

  it('filters an explicit non-edit source out of the edit ladder', () => {
    // A pinned Replicate source cannot edit, so it is dropped and the edit ladder stands.
    expect(fallbackLadder({ source: 'Flux 1.1 Pro', edit: true })).toEqual(['Nano Banana', 'OpenAI']);
    // A pinned edit-capable source still leads.
    expect(fallbackLadder({ source: 'OpenAI', edit: true })).toEqual(['OpenAI', 'Nano Banana']);
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
});

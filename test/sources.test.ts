import { describe, it, expect } from 'vitest';
import {
  pickSource,
  isAsyncSource,
  augmentPromptForTransparency,
  buildIterationPrompt,
  fallbackLadder,
  isFallbackableError,
  EDIT_CAPABLE_SOURCES,
} from '../src/knowledge/sources.js';
import { AhError } from '../src/errors.js';

describe('pickSource', () => {
  it('defaults to Nano Banana and picks OpenAI for abstract', () => {
    expect(pickSource({})).toBe('Nano Banana');
    expect(pickSource({ style: 'abstract' })).toBe('OpenAI');
  });
});

describe('isAsyncSource', () => {
  it('flags the slow (async-pipeline) models', () => {
    expect(isAsyncSource('Nano Banana')).toBe(true);
    expect(isAsyncSource('Flux 2 Pro')).toBe(true);
    expect(isAsyncSource('OpenAI')).toBe(false);
    expect(isAsyncSource('Flux 1.1 Pro')).toBe(false);
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

  it('uses the abstract ladder (OpenAI first) for abstract art', () => {
    expect(fallbackLadder({ style: 'abstract' })).toEqual(['OpenAI', 'Nano Banana']);
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
  it('is true for rate-limit / transient classes', () => {
    expect(isFallbackableError(yes('rate_limited'))).toBe(true);
    expect(isFallbackableError(yes('upstream_unavailable'))).toBe(true);
    expect(isFallbackableError(yes('network_error'))).toBe(true);
    expect(isFallbackableError(yes('generation_timeout'))).toBe(true);
    expect(isFallbackableError(yes('model_rate_limited'))).toBe(true); // Phase 3 forward-compat
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

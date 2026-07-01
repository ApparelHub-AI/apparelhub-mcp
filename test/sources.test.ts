import { describe, it, expect } from 'vitest';
import {
  pickSource,
  isAsyncSource,
  augmentPromptForTransparency,
  buildIterationPrompt,
  EDIT_CAPABLE_SOURCES,
} from '../src/knowledge/sources.js';

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

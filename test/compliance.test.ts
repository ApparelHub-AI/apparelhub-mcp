import { describe, it, expect } from 'vitest';
import { scanText } from '../src/knowledge/compliance.js';

describe('scanText', () => {
  it('warns (not blocks) on a trademark term', () => {
    const f = scanText('a cool disney mickey mouse shirt', []);
    expect(f.some((x) => x.category === 'trademark')).toBe(true);
    expect(f.every((x) => x.severity !== 'block')).toBe(true);
  });

  it('blocks a prohibited term', () => {
    const f = scanText('a nazi flag design', []);
    expect(f.some((x) => x.severity === 'block' && x.category === 'prohibited')).toBe(true);
  });

  it('returns no flags for clean text', () => {
    expect(scanText('a saguaro cactus at sunset', [])).toHaveLength(0);
  });

  it('adds an Etsy-specific note when a trademark hits and Etsy is targeted', () => {
    const f = scanText('nike logo tee', ['Etsy']);
    expect(f.some((x) => x.category === 'channel_specific')).toBe(true);
  });
});

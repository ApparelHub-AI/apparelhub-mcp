import { describe, it, expect } from 'vitest';
import {
  expectedThreadColorsIdFromError,
  isEmbroideryPlacement,
  normalizeThreadColors,
  threadColorsOptionId,
  PRINTFUL_THREAD_PALETTE,
} from '../src/knowledge/embroidery.js';

describe('embroidery knowledge', () => {
  it('maps placements to Printful thread-color option ids (all three shapes live-verified)', () => {
    expect(threadColorsOptionId('embroidery_front_large')).toBe('thread_colors_front_large');
    // The PLAIN front placement uses the BARE id (beanie 266, verified against a live sync).
    expect(threadColorsOptionId('embroidery_front')).toBe('thread_colors');
    expect(threadColorsOptionId('embroidery_chest_left')).toBe('thread_colors_chest_left');
    expect(threadColorsOptionId('addon_embroidery_front')).toBe('thread_colors');
  });

  it('extracts the expected option id from Printful sync errors (self-heal input)', () => {
    const beanieError =
      '{"code":400,"result":"thread_colors option is missing or incorrect! Allowed values: #FFFFFF, #000000"}';
    expect(expectedThreadColorsIdFromError(beanieError)).toBe('thread_colors');
    expect(
      expectedThreadColorsIdFromError('thread_colors_chest_left option is missing or incorrect!'),
    ).toBe('thread_colors_chest_left');
    expect(expectedThreadColorsIdFromError('No valid variants found to sync.')).toBeUndefined();
  });

  it('detects embroidery placements', () => {
    expect(isEmbroideryPlacement('embroidery_front_large')).toBe(true);
    expect(isEmbroideryPlacement('addon_embroidery_front')).toBe(true);
    expect(isEmbroideryPlacement('front')).toBe(false);
    expect(isEmbroideryPlacement(undefined)).toBe(false);
  });

  it('normalizes palette colors: uppercase, dedupe, cap at 6', () => {
    expect(normalizeThreadColors(['#ffcc00', '#FFCC00', '#3399ff'])).toEqual(['#FFCC00', '#3399FF']);
    expect(normalizeThreadColors([...PRINTFUL_THREAD_PALETTE.slice(0, 8)])).toHaveLength(6);
  });

  it('rejects off-palette colors, naming the palette', () => {
    expect(() => normalizeThreadColors(['#123456'])).toThrowError(/palette/i);
    expect(() => normalizeThreadColors([])).toThrowError();
  });
});

import { describe, it, expect } from 'vitest';
import {
  isEmbroideryPlacement,
  normalizeThreadColors,
  threadColorsOptionId,
  PRINTFUL_THREAD_PALETTE,
} from '../src/knowledge/embroidery.js';
import { printStyleFor } from '../src/knowledge/garments.js';

describe('embroidery knowledge', () => {
  it('maps placements to Printful thread-color option ids (the verified suffixed shape)', () => {
    expect(threadColorsOptionId('embroidery_front_large')).toBe('thread_colors_front_large');
    expect(threadColorsOptionId('embroidery_front')).toBe('thread_colors_front');
    expect(threadColorsOptionId('embroidery_chest_left')).toBe('thread_colors_chest_left');
    expect(threadColorsOptionId('addon_embroidery_front')).toBe('thread_colors_front');
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

describe('printStyleFor: face goods default to fill, apparel stays placed', () => {
  it.each([
    ['Canvas', 'fill'],
    ['Enhanced Matte Paper Poster', 'fill'],
    ['Laptop Backpack', 'fill'],
    ['All-Over Print Duffle Bag', 'fill'],
    ['Crew Socks', 'fill'],
    ['Beach Towel', 'fill'],
    ['Throw Pillow', 'fill'],
    ['Tough Case for iPhone®', 'fill'],
    ['Spiral Notebook', 'fill'],
    ['Drawstring Bag', 'fill'],
    ['Fleece Blanket', 'fill'],
  ] as const)('%s -> %s', (name, want) => {
    expect(printStyleFor(name)).toBe(want);
  });

  it.each([
    // Brand collision: "Bella + Canvas" contains "canvas" — apparel MUST win.
    ['Unisex Staple T-Shirt | Bella + Canvas 3001', 'placed'],
    ['Unisex Sponge Fleece Hoodie | Bella + Canvas 3719', 'placed'],
    ['Unisex Tank Top', 'placed'],
    ['Unisex Long Sleeve Tee', 'placed'],
    ['Closed-Back Trucker Cap | Flexfit 6511', 'placed'],
    ['Cuffed Beanie | Yupoong 1501KC', 'placed'],
    ['White Glossy Mug', 'placed'],
    ['Stainless Steel Water Bottle', 'placed'],
    ['Whiskey Rocks Glass', 'placed'],
  ] as const)('%s -> %s', (name, want) => {
    expect(printStyleFor(name)).toBe(want);
  });

  it('defaults to placed when the name is unknown', () => {
    expect(printStyleFor(undefined)).toBe('placed');
  });
});

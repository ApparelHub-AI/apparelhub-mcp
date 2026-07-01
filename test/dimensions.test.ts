import { describe, it, expect } from 'vitest';
import { pickDimensions } from '../src/image/dimensions.js';

describe('pickDimensions', () => {
  it('all_over fills the entire area', () => {
    expect(pickDimensions(1000, 1000, 2717, 2717, 'all_over')).toMatchObject({
      width: 2717,
      height: 2717,
      left: 0,
      top: 0,
    });
  });

  it('chest_fill scales down to respect area height + reserves collar padding', () => {
    // BC 3001 front area 728x376, square design -> height-constrained.
    const d = pickDimensions(1000, 1000, 728, 376, 'chest_fill');
    expect(d.width).toBe(328);
    expect(d.height).toBe(328);
    expect(d.top).toBe(48); // trunc(376 * 0.13)
    expect(d.strategy).toBe('height_constrained');
  });

  it('chest_emblem centers a smaller badge print', () => {
    const d = pickDimensions(1000, 1000, 728, 376, 'chest_emblem');
    expect(d.width).toBe(254);
    expect(d.left).toBe(237);
    expect(d.strategy).toBe('emblem_centered');
  });

  it('throws on non-positive dimensions', () => {
    expect(() => pickDimensions(0, 1, 1, 1)).toThrow();
    expect(() => pickDimensions(1, 1, 0, 1)).toThrow();
  });
});

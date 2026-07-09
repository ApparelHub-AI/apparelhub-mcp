import { describe, it, expect } from 'vitest';
import {
  extremeAspectWarning,
  faceLayoutFor,
  placedStyleFor,
  pricingFloor,
  qualityTier,
  recommendGarment,
} from '../src/knowledge/garments.js';

describe('pricingFloor', () => {
  it('returns a positive-margin floor for a known cost', () => {
    // (11.69 + 5.90) / (1 - 0.039) * 1.20 -> 21.99
    expect(pricingFloor(11.69)).toBe(21.99);
  });
  it('returns undefined when cost is unknown or zero', () => {
    expect(pricingFloor(undefined)).toBeUndefined();
    expect(pricingFloor(0)).toBeUndefined();
  });
});

describe('qualityTier', () => {
  it('classifies by brand', () => {
    expect(qualityTier('Comfort Colors', '1717')).toBe('premium');
    expect(qualityTier('Bella+Canvas', '3001')).toBe('standard');
    expect(qualityTier('Gildan', '5000')).toBe('budget');
  });
});

describe('recommendGarment', () => {
  it('defaults to a standard tee', () => {
    const r = recommendGarment({});
    expect(r.recommendation.category).toBe('t-shirts');
    expect(r.recommendation.quality_tier).toBe('standard');
    expect(r.alternatives.length).toBeGreaterThan(0);
    expect(r.rationale).toContain('generic recommendation');
  });
  it('picks a premium body for a premium audience', () => {
    expect(recommendGarment({ audience: 'premium' }).recommendation.brand).toBe('Comfort Colors');
  });
  it('picks a budget body for a budget tier', () => {
    expect(recommendGarment({ budget_tier: 'budget' }).recommendation.brand).toBe('Gildan');
  });
});

describe('faceLayoutFor (print area != visible face — the WC26 sock/drawstring lesson)', () => {
  it('rotates sock leg FRONT strips (file renders toe-up) but not the BACKS (file renders cuff-up)', () => {
    for (const p of ['leg_front_right', 'leg_front_left']) {
      const l = faceLayoutFor('Cushioned Crew Socks', p, 632, 2620);
      expect(l?.faces[0]?.rotate180).toBe(true);
      expect(l?.faces[0]?.w).toBeLessThan(0.7); // only the central band stays frontal
    }
    for (const p of ['leg_back_right', 'leg_back_left']) {
      const l = faceLayoutFor('Cushioned Crew Socks', p, 632, 2620);
      expect(l?.faces[0]?.rotate180).toBeUndefined();
      expect(l?.faces[0]?.w).toBeLessThan(0.7);
    }
  });

  it('confines drawstring-bag wrap areas to the visible front (top half above the fold)', () => {
    const l = faceLayoutFor('Drawstring Bag', 'front', 4950, 11100);
    expect(l?.faces).toHaveLength(1);
    expect(l?.faces[0]?.rotate180).toBeUndefined();
    const f = l!.faces[0]!;
    expect(f.y + f.h).toBeLessThan(0.5); // art never reaches the bottom fold
  });

  it('composes wallet wraps onto BOTH faces (front upright, back rotated) — no blank face', () => {
    const l = faceLayoutFor('Zipper Wallet', 'front', 2482, 2756);
    expect(l?.faces).toHaveLength(2);
    expect(l?.faces[0]?.rotate180).toBeUndefined(); // front face upright
    expect(l?.faces[1]?.rotate180).toBe(true); // back face renders inverted past the fold
    expect((l!.faces[0]!.y + l!.faces[0]!.h)).toBeLessThanOrEqual(l!.faces[1]!.y); // front above back
  });

  it('insets headphone ear-cup art so both oval cups print clean', () => {
    const l = faceLayoutFor('AirPods Max Shell Case', 'Left', 1234, 1644);
    expect(l?.faces).toHaveLength(1);
    expect(l?.faces[0]?.w).toBeLessThan(0.8); // inset within the oval
  });

  it('confines duffle display faces to the central frontal window', () => {
    const l = faceLayoutFor('All-Over Print Duffle Bag', 'front', 3000, 1998);
    expect(l?.faces[0]?.w).toBeLessThan(0.85);
    expect(faceLayoutFor('All-Over Print Duffle Bag', 'pocket', 2060, 1269)).toBeUndefined();
  });

  it('leaves normal faces alone (backpack front, canvas, tees)', () => {
    expect(faceLayoutFor('All-Over Print Backpack', 'front', 1747, 2468)).toBeUndefined();
    expect(faceLayoutFor('Stretched Canvas', 'front', 2400, 3000)).toBeUndefined();
    expect(faceLayoutFor('Unisex Staple Tee', 'front', 1800, 2400)).toBeUndefined();
  });

  it('does not treat a normal-aspect drawstring front as a wrap', () => {
    expect(faceLayoutFor('Drawstring Bag', 'front', 1800, 2400)).toBeUndefined();
  });
});

describe('extremeAspectWarning', () => {
  it('flags unknown extreme-aspect fill areas as suspect wraps', () => {
    expect(extremeAspectWarning('Mystery Tote', 'front', 4000, 12000)).toContain('extreme aspect');
    expect(extremeAspectWarning('Mystery Runner', 'front', 12000, 4000)).toContain('extreme aspect');
  });
  it('stays quiet for normal faces', () => {
    expect(extremeAspectWarning('Canvas', 'front', 2400, 3000)).toBeUndefined();
    expect(extremeAspectWarning('Tee', 'front', 1800, 2400)).toBeUndefined();
  });
});

describe('placedStyleFor (collar padding is an APPAREL concept)', () => {
  it('keeps collar breathing room on apparel', () => {
    expect(placedStyleFor('Unisex Staple Tee')).toBe('chest_fill');
    expect(placedStyleFor('Closed-Back Trucker Cap')).toBe('chest_fill');
    expect(placedStyleFor('Fleece Pullover Hoodie')).toBe('chest_fill');
  });
  it('centers on non-apparel placed goods (the MOROCCO clear-case incident)', () => {
    expect(placedStyleFor('Clear Case for iPhone®')).toBe('back_center');
    expect(placedStyleFor('White Glossy Mug')).toBe('back_center');
    expect(placedStyleFor(undefined)).toBe('chest_fill');
  });
});

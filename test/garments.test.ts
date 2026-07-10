import { describe, it, expect } from 'vitest';
import {
  extremeAspectWarning,
  faceLayoutFor,
  isInteriorPlacement,
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

  it('leaves genuinely flat faces alone (canvas, tees)', () => {
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

describe('faceLayoutFor — cylindrical drinkware (the MOROCCO water-bottle star-clip)', () => {
  it('insets art on bottles / tumblers / glasses so nothing clips at the shoulder/base/sides', () => {
    for (const name of ['Slim Water Bottle', 'Stainless Tumbler', 'Rocks Glass', 'Aluminum Can Cooler']) {
      const l = faceLayoutFor(name, 'front', 2502, 2303);
      expect(l?.faces).toHaveLength(1);
      expect(l?.faces[0]?.w).toBeLessThan(0.8); // inset from the wrapping sides
      expect(l?.faces[0]?.y).toBeGreaterThan(0.05); // clear of the shoulder/neck
      expect(l!.faces[0]!.y + l!.faces[0]!.h).toBeLessThan(0.9); // clear of the base
    }
  });
  it('gives mugs/steins a TIGHTER front-arc inset than a bottle (the wide Black Glossy Mug 300)', () => {
    // horizontal-stripe-probe calibrated: the mug front-facing arc is only area x 0.25-0.75.
    const bottle = faceLayoutFor('Slim Water Bottle', 'default', 2502, 2303)!;
    for (const name of ['Black Glossy Mug', 'White Glossy Mug', 'Beer Stein']) {
      const l = faceLayoutFor(name, 'default', 720, 296)!;
      expect(l.faces).toHaveLength(1);
      // strictly narrower than the general cylinder inset so it stays on the front arc
      expect(l.faces[0]!.w).toBeLessThan(bottle.faces[0]!.w);
      expect(l.faces[0]!.w).toBeCloseTo(0.44, 2);
      // horizontally centered on the front (x=0.5)
      expect(l.faces[0]!.x + l.faces[0]!.w / 2).toBeCloseTo(0.5, 2);
    }
  });
  it('does not treat apparel/flat goods as cylinders', () => {
    expect(faceLayoutFor('Unisex Staple Tee', 'front', 1800, 2400)).toBeUndefined();
    expect(faceLayoutFor('Stretched Canvas', 'front', 2400, 3000)).toBeUndefined();
  });
});

describe('faceLayoutFor — the 4 pilot quirks (Merch QC discovery sweep, 2026-07-10)', () => {
  it('tote 274: top-favors the visible front, clear of the front+back fold', () => {
    const l = faceLayoutFor('All-Over Print Large Tote Bag w/ Pocket', 'default', 1701, 3000)!;
    expect(l.faces).toHaveLength(1);
    // the whole design sits in the top ~45% (the fold is ~y 0.42)
    expect(l.faces[0]!.y + l.faces[0]!.h).toBeLessThan(0.42);
    // the pocket sibling has no layout -> gets the solid background
    expect(faceLayoutFor('All-Over Print Large Tote Bag w/ Pocket', 'pocket', 1200, 1200)).toBeUndefined();
    // a square (non-wrap) tote is NOT top-favored
    expect(faceLayoutFor('Cotton Tote Bag', 'front', 2000, 2000)).toBeUndefined();
  });
  it('notebook 1013: composes onto the FRONT cover (right half), clear of the spine at x=0.5', () => {
    const l = faceLayoutFor('Softcover Journal with Inside Prints', 'outside_cover', 2968, 1978)!;
    expect(l.faces).toHaveLength(1);
    expect(l.faces[0]!.x).toBeGreaterThan(0.5); // starts to the RIGHT of the spine
    // only the outside cover gets a layout; inside/page placements are excluded upstream
    expect(faceLayoutFor('Softcover Journal with Inside Prints', 'inside_cover', 2968, 1978)).toBeUndefined();
    expect(faceLayoutFor('Softcover Journal with Inside Prints', 'page1_front', 2968, 1978)).toBeUndefined();
  });
  it('bucket hat 654: confines art to the small flat front-crown band', () => {
    const l = faceLayoutFor('All-Over Print Reversible Bucket Hat', 'outside_front', 2571, 3000)!;
    expect(l.faces).toHaveLength(1);
    expect(l.faces[0]!.h).toBeLessThan(0.25); // small flat band, does not wrap the crown/brim
    expect(l.faces[0]!.x + l.faces[0]!.w / 2).toBeCloseTo(0.5, 1); // centered on the front
    // the back crown gets no layout (solid); inside/labels are excluded upstream
    expect(faceLayoutFor('All-Over Print Reversible Bucket Hat', 'outside_back', 2571, 3000)).toBeUndefined();
  });
});

describe('isInteriorPlacement (interior/label surfaces print blank, not solid)', () => {
  it('excludes inside surfaces, pages, and labels', () => {
    for (const p of ['inside_cover', 'inside_front', 'inside_back', 'page1_front', 'page3_back', 'label_outside', 'label_inside'])
      expect(isInteriorPlacement(p)).toBe(true);
  });
  it('keeps exterior display placements (outside_* never matches "inside")', () => {
    for (const p of ['front', 'back', 'default', 'pocket', 'top', 'bottom', 'outside_cover', 'outside_front', 'outside_back', 'leg_front_left'])
      expect(isInteriorPlacement(p)).toBe(false);
  });
});

describe('faceLayoutFor — backpack front (the SPAIN backpack pocket-seam split)', () => {
  it('keeps the design in the upper-body window above the pocket seam', () => {
    const l = faceLayoutFor('All-Over Print Backpack', 'front', 1747, 2468);
    expect(l?.faces).toHaveLength(1);
    // the design stays in the TOP portion — its bottom edge clears the pocket seam (~lower 40%)
    expect(l!.faces[0]!.y + l!.faces[0]!.h).toBeLessThan(0.6);
  });
  it('does not apply the top window to the pocket/side panels (they stay solid)', () => {
    expect(faceLayoutFor('All-Over Print Backpack', 'pocket', 2060, 1269)).toBeUndefined();
    expect(faceLayoutFor('All-Over Print Backpack', 'top', 3000, 857)).toBeUndefined();
  });
  it('does not treat a drawstring/duffle bag as a pocket-seam backpack', () => {
    expect(faceLayoutFor('Drawstring Bag', 'front', 1800, 2400)).toBeUndefined();
  });
});

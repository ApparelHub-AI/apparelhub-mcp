import { describe, it, expect } from 'vitest';
import { pricingFloor, qualityTier, recommendGarment } from '../src/knowledge/garments.js';

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

import { describe, it, expect } from 'vitest';
import { resolveVariants, type MatrixVariant } from '../src/knowledge/variants.js';

const matrix: MatrixVariant[] = [
  { provider_variant_id: 4016, color: 'Black', size: 'S' },
  { provider_variant_id: 4017, color: 'Black', size: 'M' },
  { provider_variant_id: 8495, color: 'Heather Midnight Navy', size: 'S' },
  { provider_variant_id: 4021, color: 'Aqua', size: 'S' },
];

describe('resolveVariants', () => {
  it('resolves by color + size', () => {
    const r = resolveVariants(matrix, [{ color: 'Black', sizes: ['S', 'M'] }], '71', 27.99);
    expect(r.resolved.map((v) => v.provider_variant_id)).toEqual([4016, 4017]);
    expect(r.resolved[0]?.price).toBe(27.99);
    expect(r.warnings).toHaveLength(0);
  });

  it('records unresolved color/size pairs', () => {
    const r = resolveVariants(matrix, [{ color: 'Black', sizes: ['XXL'] }], '71');
    expect(r.resolved).toHaveLength(0);
    expect(r.unresolved).toEqual([{ color: 'Black', size: 'XXL' }]);
  });

  it('warns on the BC 3001 AQUA-vs-Navy trap for explicit ids', () => {
    const r = resolveVariants(
      matrix,
      [{ color: 'Navy', sizes: ['S'], provider_variant_ids: [4021] }],
      '71',
    );
    expect(r.resolved[0]?.provider_variant_id).toBe(4021);
    expect(r.warnings[0]).toContain('AQUA');
  });

  it('does not warn about AQUA on other products', () => {
    const r = resolveVariants(
      matrix,
      [{ color: 'Navy', sizes: ['S'], provider_variant_ids: [4021] }],
      '999',
    );
    expect(r.warnings).toHaveLength(0);
  });
});

describe('resolveVariants: single-dimension garments (the MOROCCO phone-case incident)', () => {
  it('matches by size only when the catalog has no color dimension (clear phone case)', () => {
    const caseMatrix = [
      { provider_variant_id: 601, size: 'iPhone 15' },
      { provider_variant_id: 602, size: 'iPhone 16' },
    ];
    const r = resolveVariants(caseMatrix, [{ color: 'Clear', sizes: ['iPhone 15', 'iPhone 16'] }]);
    expect(r.resolved.map((v) => v.provider_variant_id)).toEqual([601, 602]);
    expect(r.resolved[0]?.color).toBe('Clear'); // requested color kept as the label
    expect(r.warnings.some((w) => w.includes('no color dimension'))).toBe(true);
  });

  it('matches by color only when the catalog has no size dimension', () => {
    const posterMatrix = [
      { provider_variant_id: 701, color: 'White' },
      { provider_variant_id: 702, color: 'Black' },
    ];
    const r = resolveVariants(posterMatrix, [{ color: 'Black', sizes: ['One size'] }]);
    expect(r.resolved.map((v) => v.provider_variant_id)).toEqual([702]);
    expect(r.warnings.some((w) => w.includes('no size dimension'))).toBe(true);
  });

  it('still records unresolved sizes on a colorless catalog (no false binding)', () => {
    const caseMatrix = [{ provider_variant_id: 601, size: 'iPhone 15' }];
    const r = resolveVariants(caseMatrix, [{ color: 'Clear', sizes: ['iPhone 99'] }]);
    expect(r.resolved).toHaveLength(0);
    expect(r.unresolved).toEqual([{ color: 'Clear', size: 'iPhone 99' }]);
  });

  it('keeps strict two-dimension matching when the catalog has both dimensions', () => {
    const r = resolveVariants(matrix, [{ color: 'Purple', sizes: ['S'] }], '71');
    expect(r.resolved).toHaveLength(0); // color exists in catalog terms, so no relaxation
    expect(r.unresolved).toEqual([{ color: 'Purple', size: 'S' }]);
  });
});

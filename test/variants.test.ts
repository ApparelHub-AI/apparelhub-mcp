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

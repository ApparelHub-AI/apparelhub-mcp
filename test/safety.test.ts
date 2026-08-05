import { describe, it, expect } from 'vitest';
import {
  scoreQuality,
  verifyDesignQuality,
  checkDesignCompliance,
  scoreMockup,
  verifyMockupQuality,
  safetyTools,
  MOCKUP_VISUAL_CHECKLIST,
} from '../src/tools/safety.js';
import type { MockupStats } from '../src/image/imaging.js';
import type { Imaging, ImageStats } from '../src/image/imaging.js';
import { fakeContext } from './helpers/ctx.js';

const cleanStats: ImageStats = {
  width: 1024,
  height: 1024,
  mode: 'RGBA',
  has_alpha: true,
  transparent_ratio: 0.4,
  corner_alpha: [0, 0, 0, 0],
  premultiplied_white: true,
};

function fakeImaging(over: Partial<Imaging> = {}): Imaging {
  return {
    downloadToTemp: async () => '/tmp/fake.png',
    makeTransparent: async () => ({ outputPath: '/tmp/o.png', cornersClean: true }),
    readBytes: async () => new Uint8Array([1]),
    imageSize: async () => ({ width: 1024, height: 1024 }),
    imageStats: async () => cleanStats,
    ocr: async () => ({ available: false, text: '' , confidence: null }),
    cleanup: async () => {},
    ...over,
  };
}

describe('scoreQuality', () => {
  it('scores a clean transparent design 100', () => {
    const r = scoreQuality(cleanStats);
    expect(r.quality_score).toBe(100);
    expect(r.issues).toHaveLength(0);
  });

  it('blocks a design with no alpha channel', () => {
    const r = scoreQuality({ ...cleanStats, has_alpha: false });
    expect(r.issues.some((i) => i.category === 'transparency' && i.severity === 'block')).toBe(true);
    expect(r.quality_score).toBeLessThan(100);
  });

  it('WARNS (never blocks) on a very low-resolution design — the pipeline auto-upscales it', () => {
    // The build pipeline upscales low-res designs to the print area, so a low-res design must not
    // make an unattended run SKIP the item (the NORWAY passport-wallet 847x596 QC-skip). It stays
    // a warn so the score is only lightly penalized and the item still builds.
    const r = scoreQuality({ ...cleanStats, width: 500, height: 500 });
    const res = r.issues.find((i) => i.category === 'resolution');
    expect(res?.severity).toBe('warn');
    expect(r.issues.some((i) => i.severity === 'block')).toBe(false);
    expect(r.quality_score).toBeGreaterThanOrEqual(70); // still passes the task's score gate
  });

  it('does not flag resolution at 1024x1024', () => {
    const r = scoreQuality({ ...cleanStats, width: 1024, height: 1024 });
    expect(r.issues.some((i) => i.category === 'resolution')).toBe(false);
  });
});

describe('verify_design_quality', () => {
  it('returns a score + transparency summary', async () => {
    const res = (await verifyDesignQuality.handler(
      { design_uuid: 'd1', image_url: 'https://cdn.example/x.png' },
      fakeContext(undefined, fakeImaging()),
    )) as any;
    expect(res.quality_score).toBe(100);
    expect(res.transparency.has_alpha).toBe(true);
  });

  it('degrades when Pillow is unavailable', async () => {
    await expect(
      verifyDesignQuality.handler(
        { design_uuid: 'd1', image_url: 'https://cdn.example/x.png' },
        fakeContext(undefined, fakeImaging({ imageStats: async () => undefined })),
      ),
    ).rejects.toMatchObject({ code: 'local_tool_unavailable' });
  });
});

describe('check_design_compliance', () => {
  it('flags a trademark in the prompt as advisory (approved, review_required)', async () => {
    const res = (await checkDesignCompliance.handler(
      { prompt: 'a nike logo tee', target_channels: ['Etsy'] },
      fakeContext(undefined, fakeImaging()),
    )) as any;
    expect(res.approved).toBe(true);
    expect(res.recommendation).toBe('review_required');
    expect(res.flags.some((f: any) => f.category === 'trademark')).toBe(true);
    expect(res.disclaimer).toContain('not legal advice');
  });
});

// ---------------------------------------------------------------------------
// verify_mockup_quality (epic phase 5)
// ---------------------------------------------------------------------------

function mockup(over: Partial<MockupStats> = {}): MockupStats {
  return {
    width: 1000, height: 1000, min_dimension: 1000,
    garment_ratio: 0.45, design_coverage: 0.4, largest_flat_run: 0.3,
    chroma_green_ratio: 0, dominant_share: 0.6, distinct_colors: 40,
    empty: false, ...over,
  };
}

describe('scoreMockup', () => {
  it('passes a clean render with no hard defect', () => {
    const { quality_score, issues } = scoreMockup(mockup());
    expect(quality_score).toBe(100);
    expect(issues).toHaveLength(0);
  });

  it('blocks an un-keyed chroma-green background', () => {
    // Measured 0.19 on a real green-screen leak vs 0.00 on a normal print.
    const { issues, quality_score } = scoreMockup(mockup({ chroma_green_ratio: 0.19 }));
    const i = issues.find((x) => x.category === 'background');
    expect(i?.severity).toBe('block');
    expect(quality_score).toBeLessThan(50);
  });

  it('does not flag an ordinary print as chroma green', () => {
    expect(scoreMockup(mockup({ chroma_green_ratio: 0 })).issues).toHaveLength(0);
  });

  it('blocks an empty render and short-circuits', () => {
    const { quality_score, issues } = scoreMockup(mockup({ empty: true, garment_ratio: 0 }));
    expect(quality_score).toBe(0);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.category).toBe('render');
  });

  it('warns on a render too small to judge', () => {
    const { issues } = scoreMockup(mockup({ width: 200, height: 200, min_dimension: 200 }));
    expect(issues.find((x) => x.category === 'resolution')?.severity).toBe('warn');
  });

  it('does NOT grade design coverage', () => {
    // Deliberate. Validation: the all-over-print tee that shipped with bare
    // sleeves scored 0.55, a CORRECT chest print scored 0.62. The metric does
    // not separate them, so it must never become a verdict. If someone adds a
    // coverage threshold later, this fails and explains why.
    const brokenAop = scoreMockup(mockup({ design_coverage: 0.55 }));
    const correctPrint = scoreMockup(mockup({ design_coverage: 0.62 }));
    expect(brokenAop.issues).toHaveLength(0);
    expect(correctPrint.issues).toHaveLength(0);
    expect(brokenAop.quality_score).toBe(correctPrint.quality_score);
  });
});

describe('verify_mockup_quality tool', () => {
  it('returns the fixed visual checklist and names the sleeves-and-hem case', () => {
    expect(MOCKUP_VISUAL_CHECKLIST.length).toBeGreaterThanOrEqual(5);
    const joined = MOCKUP_VISUAL_CHECKLIST.join(' ').toLowerCase();
    expect(joined).toContain('sleeves');
    expect(joined).toContain('hem');
    expect(joined).toContain('upright');
  });

  it('is exported as a read-only tool', () => {
    expect(verifyMockupQuality.annotations?.readOnlyHint).toBe(true);
    expect(safetyTools.map((t) => t.name)).toContain('verify_mockup_quality');
  });
});

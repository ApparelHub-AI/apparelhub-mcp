import { describe, it, expect } from 'vitest';
import { scoreQuality, verifyDesignQuality, checkDesignCompliance } from '../src/tools/safety.js';
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
    ocr: async () => ({ available: false, text: '' }),
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

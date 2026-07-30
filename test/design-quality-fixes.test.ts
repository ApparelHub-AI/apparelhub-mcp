/**
 * apparelhub-mcp #763, #764, #765, #766.
 *
 * One theme: each tool answered CONFIDENTLY and WRONGLY, which is worse than not
 * answering. A 100/100 on a defective design, a "no text" on a design covered in
 * text, and a green-bordered image from the one flag that exists to prevent it are
 * all acted on by an agent precisely because they look like answers.
 */
import { describe, it, expect } from 'vitest';

import { scoreQuality, verifyDesignQuality } from '../src/tools/safety.js';
import {
  augmentPromptForTransparency,
  isFallbackableError,
  isPromptTooLongError,
} from '../src/knowledge/sources.js';
import { AhError } from '../src/errors.js';
import { designApparel, verifyDesignText } from '../src/tools/design.js';
import type { Imaging, ImageStats } from '../src/image/imaging.js';
import { fakeContext } from './helpers/ctx.js';
import { jsonResponse, queueFetch, noSleep } from './helpers/fakeFetch.js';
import { ApiClient } from '../src/http/client.js';

const cleanStats: ImageStats = {
  width: 1024,
  height: 1024,
  mode: 'RGBA',
  has_alpha: true,
  transparent_ratio: 0.4,
  corner_alpha: [0, 0, 0, 0],
  premultiplied_white: true,
  chroma_halo_ratio: 0,
  black_box_ratio: 0,
};

function fakeImaging(over: Partial<Imaging> = {}): Imaging {
  return {
    downloadToTemp: async () => '/tmp/fake.png',
    makeTransparent: async () => ({ outputPath: '/tmp/o.png', cornersClean: true }),
    readBytes: async () => new Uint8Array([1]),
    imageSize: async () => ({ width: 1024, height: 1024 }),
    imageStats: async () => cleanStats,
    mockupStats: async () => undefined,
    ocr: async () => ({ available: false, text: '' }),
    threadColors: async () => [],
    ensureResolution: async () => ({ outputPath: '/tmp/o.png', upscaled: false }),
    cleanup: async () => {},
    ...over,
  } as Imaging;
}

// --------------------------------------------------------------------------
// #763 — 100/100 on visibly defective designs
// --------------------------------------------------------------------------

describe('#763 scoreQuality sees visible defects', () => {
  it('still scores a genuinely clean design 100', () => {
    const r = scoreQuality(cleanStats);
    expect(r.quality_score).toBe(100);
    expect(r.issues).toHaveLength(0);
  });

  it('blocks on a green chroma halo', () => {
    // The reported defect: keying left a green fringe that prints as an outline.
    const r = scoreQuality({ ...cleanStats, chroma_halo_ratio: 0.086 });
    expect(r.quality_score).toBeLessThan(100);
    const issue = r.issues.find((i) => i.finding.includes('Chroma-key green'));
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('block');
  });

  it('blocks on a solid black box artifact', () => {
    const r = scoreQuality({ ...cleanStats, black_box_ratio: 0.46 });
    expect(r.quality_score).toBeLessThan(100);
    const issue = r.issues.find((i) => i.finding.includes('solid black rectangle'));
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('block');
  });

  it('reports both when both are present', () => {
    const r = scoreQuality({ ...cleanStats, chroma_halo_ratio: 0.09, black_box_ratio: 0.4 });
    expect(r.issues.filter((i) => i.severity === 'block')).toHaveLength(2);
    expect(r.quality_score).toBeLessThanOrEqual(30);
  });

  it('does not trip on a trace of green', () => {
    // Anti-aliasing against green artwork leaves a handful of pixels; that is not
    // a halo, and flagging it would make the check noise the agent learns to skip.
    const r = scoreQuality({ ...cleanStats, chroma_halo_ratio: 0.001 });
    expect(r.quality_score).toBe(100);
  });

  it('does not trip on a small dark element', () => {
    const r = scoreQuality({ ...cleanStats, black_box_ratio: 0.02 });
    expect(r.quality_score).toBe(100);
  });

  it('degrades to the old behaviour when the fields are absent', () => {
    // An older python/image_stats.py omits them: "not measured", not "clean".
    const { chroma_halo_ratio, black_box_ratio, ...older } = cleanStats;
    void chroma_halo_ratio;
    void black_box_ratio;
    const r = scoreQuality(older as ImageStats);
    expect(r.quality_score).toBe(100);
  });

  it('surfaces the defect through the tool, not just the scorer', async () => {
    const res = (await verifyDesignQuality.handler(
      { design_uuid: 'd1', image_url: 'https://cdn.example/x.png' },
      fakeContext(
        undefined,
        fakeImaging({ imageStats: async () => ({ ...cleanStats, black_box_ratio: 0.5 }) }),
      ),
    )) as { quality_score: number; issues: { severity: string }[] };
    expect(res.quality_score).toBeLessThan(100);
    expect(res.issues.some((i) => i.severity === 'block')).toBe(true);
  });
});

// --------------------------------------------------------------------------
// #764 — has_text was false when OCR simply could not look
// --------------------------------------------------------------------------

describe('#764 has_text distinguishes "no text" from "unknown"', () => {
  it('returns null, not false, when OCR is unavailable', async () => {
    const res = (await verifyDesignText.handler(
      { image_uuid: 'i1', image_url: 'https://cdn.example/x.png' },
      fakeContext(undefined, fakeImaging({ ocr: async () => ({ available: false, text: '' }) })),
    )) as { has_text: boolean | null; note?: string };

    // false would assert "this design contains no text" after never looking —
    // and an agent skips the spell-check on the strength of it.
    expect(res.has_text).toBeNull();
    expect(res.has_text).not.toBe(false);
    expect(res.note ?? '').toMatch(/unknown/i);
  });

  it('returns false when OCR ran and genuinely found nothing', async () => {
    const res = (await verifyDesignText.handler(
      { image_uuid: 'i1', image_url: 'https://cdn.example/x.png' },
      fakeContext(undefined, fakeImaging({ ocr: async () => ({ available: true, text: '' }) })),
    )) as { has_text: boolean | null };
    expect(res.has_text).toBe(false);
  });

  it('returns true and the text when OCR found some', async () => {
    const res = (await verifyDesignText.handler(
      { image_uuid: 'i1', image_url: 'https://cdn.example/x.png' },
      fakeContext(
        undefined,
        fakeImaging({ ocr: async () => ({ available: true, text: 'STAY WILD' }) }),
      ),
    )) as { has_text: boolean | null; detected_text: string };
    expect(res.has_text).toBe(true);
    expect(res.detected_text).toBe('STAY WILD');
  });

  it('does not report phantom detected_text when OCR is unavailable', async () => {
    const res = (await verifyDesignText.handler(
      { image_uuid: 'i1', image_url: 'https://cdn.example/x.png' },
      fakeContext(undefined, fakeImaging({ ocr: async () => ({ available: false, text: 'noise' }) })),
    )) as { detected_text: string };
    expect(res.detected_text).toBe('');
  });
});

// --------------------------------------------------------------------------
// #765 — the green fragment was appended even when nothing would key it
// --------------------------------------------------------------------------

describe('#765 design_apparel only asks for green when it will key it', () => {
  /** Drive design_apparel and return the prompt that reached POST images/generate. */
  async function promptSentFor(input: Record<string, unknown>): Promise<string> {
    const { fetchImpl, calls } = queueFetch([
      jsonResponse(200, { image_uuid: 'g1', url: 'https://cdn.example/x.png' }), // generate
      jsonResponse(200, { image_uuid: 't1', url: 'https://cdn.example/t.png' }), // transform
    ]);
    const api = new ApiClient({
      apiKey: 'k',
      baseUrl: 'https://api.example.test/agents/v1',
      userAgent: 't',
      fetchImpl,
      sleepImpl: noSleep,
    });
    await designApparel.handler(
      { verify_text: false, ...input } as never,
      fakeContext(api, fakeImaging()),
    );
    const generate = calls.find((c) => c.url.includes('images/generate'));
    return String(JSON.parse(String(generate?.init?.body ?? '{}')).prompt ?? '');
  }

  it('appends the green hint when the design will be keyed', async () => {
    const prompt = await promptSentFor({ prompt: 'a saguaro cactus', needs_transparency: true });
    expect(prompt).toMatch(/00FF00/i);
  });

  it('does NOT append it for an all-over print', async () => {
    // The exact case the tool description tells you to use. It produced a
    // green-framed image that nothing then keyed out.
    const prompt = await promptSentFor({ prompt: 'a saguaro cactus', needs_transparency: false });
    expect(prompt).not.toMatch(/00FF00/i);
    expect(prompt).not.toMatch(/chroma/i);
    expect(prompt).toBe('a saguaro cactus');
  });

  it('defaults to appending it (transparency is the default)', async () => {
    const prompt = await promptSentFor({ prompt: 'a saguaro cactus' });
    expect(prompt).toMatch(/00FF00/i);
  });
});

// --------------------------------------------------------------------------
// #766 — Nano Banana rejected ~440-char prompts five other models accepted
// --------------------------------------------------------------------------

describe('#766 prompt length', () => {
  it('keeps our boilerplate small enough to leave room for the design', () => {
    // The old hint was 331 chars, so OUR text was the majority of a typical
    // prompt and pushed it past Nano Banana's limit.
    const overhead = augmentPromptForTransparency('x').length - 1;
    expect(overhead).toBeLessThan(200);
  });

  it('still specifies everything keying depends on', () => {
    // Shortening must not cost the instruction its force: a sage-green or
    // gradient background does not key cleanly.
    const p = augmentPromptForTransparency('a cactus');
    expect(p).toMatch(/#00FF00/i);
    expect(p).toMatch(/flat|uniform/i);
    expect(p).toMatch(/edge to edge/i);
    expect(p).toMatch(/not transparent|no checkerboard/i);
  });

  it('a realistic design prompt stays under the shortest model limit', () => {
    const userPrompt =
      'a detailed vintage-style desert scene with a saguaro cactus, layered sunset ' +
      'gradient, and fine linework, suitable for a screen-printed tee';
    expect(augmentPromptForTransparency(userPrompt).length).toBeLessThan(400);
  });

  it('is still idempotent', () => {
    const once = augmentPromptForTransparency('a cactus');
    expect(augmentPromptForTransparency(once)).toBe(once);
  });

  it('recognises a prompt-length rejection', () => {
    for (const message of [
      'http_error: Request Too Long',
      'Prompt is too long for this model',
      'too many tokens in request',
      'maximum context length exceeded',
    ]) {
      expect(isPromptTooLongError(new AhError({ code: 'generation_failed', message }))).toBe(true);
    }
  });

  it('does not mistake other failures for a length problem', () => {
    for (const message of ['rate limited', 'invalid api key', 'internal server error']) {
      expect(isPromptTooLongError(new AhError({ code: 'generation_failed', message }))).toBe(false);
    }
  });

  it('falls back to another model on a length rejection', () => {
    // Model-SPECIFIC: the identical prompt succeeds on a model with a longer
    // limit, which is exactly what the ladder is for. Previously the whole
    // generation died on the first rung.
    const err = new AhError({ code: 'generation_failed', message: 'http_error: Request Too Long' });
    expect(isFallbackableError(err)).toBe(true);
  });

  it('does not make every generation_failed fallbackable', () => {
    const err = new AhError({ code: 'generation_failed', message: 'content policy violation' });
    expect(isFallbackableError(err)).toBe(false);
  });
});

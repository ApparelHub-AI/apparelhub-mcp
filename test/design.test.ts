import { describe, it, expect } from 'vitest';
import {
  generateImage,
  processTransparency,
  verifyDesignText,
  designApparel,
  iterateDesign,
} from '../src/tools/design.js';
import { runGeneration } from '../src/image/generate.js';
import { ApiClient } from '../src/http/client.js';
import { AhError } from '../src/errors.js';
import type { Imaging } from '../src/image/imaging.js';
import { fakeContext } from './helpers/ctx.js';
import { queueFetch, jsonResponse, noSleep } from './helpers/fakeFetch.js';

function apiFrom(bodies: Response[]) {
  const { fetchImpl, calls } = queueFetch(bodies);
  const api = new ApiClient({
    apiKey: 'k',
    baseUrl: 'https://api.example.test/agents/v1',
    userAgent: 't',
    fetchImpl,
    sleepImpl: noSleep,
  });
  return { api, calls };
}

function fakeImaging(over: Partial<Imaging> = {}): Imaging {
  return {
    downloadToTemp: async () => '/tmp/fake-in.png',
    makeTransparent: async () => ({
      outputPath: '/tmp/fake-out.png',
      cornersClean: true,
      width: 900,
      height: 700,
    }),
    readBytes: async () => new Uint8Array([1, 2, 3]),
    imageSize: async () => ({ width: 900, height: 700 }),
    imageStats: async () => ({
      width: 900,
      height: 700,
      mode: 'RGBA',
      has_alpha: true,
      transparent_ratio: 0.4,
      corner_alpha: [0, 0, 0, 0],
      premultiplied_white: true,
    }),
    ocr: async () => ({ available: true, text: 'STAY WILD' }),
    recomposeFill: async () => {
      throw new Error('not expected in this test');
    },
    solidFill: async () => {
      throw new Error('not expected in this test');
    },
    ensureResolution: async () => ({ outputPath: '/tmp/fake-out.png', upscaled: false }),
    cleanup: async () => {},
    ...over,
  };
}

describe('runGeneration', () => {
  it('polls an async generation to completion', async () => {
    const { api } = apiFrom([
      jsonResponse(202, { image_uuid: 'g2', processing_status: 'pending' }),
      jsonResponse(200, { processing_status: 'completed', url: 'https://cdn.example/done.png' }),
    ]);
    const g = await runGeneration(api, { prompt: 'x', source: 'Nano Banana' }, { sleep: noSleep, intervalMs: 0 });
    expect(g).toMatchObject({ image_uuid: 'g2', image_url: 'https://cdn.example/done.png' });
  });

  it('throws generation_failed on a failed status', async () => {
    const { api } = apiFrom([
      jsonResponse(202, { image_uuid: 'g3', processing_status: 'pending' }),
      jsonResponse(200, { processing_status: 'failed', error: 'blocked' }),
    ]);
    await expect(
      runGeneration(api, { prompt: 'x', source: 'Nano Banana' }, { sleep: noSleep }),
    ).rejects.toMatchObject({ code: 'generation_failed' });
  });

  it('parses the structured async model_rate_limited failure into source + retry_after', async () => {
    // The exact platform contract string (async path) reported via the poll status endpoint.
    const { api } = apiFrom([
      jsonResponse(202, { image_uuid: 'g4', processing_status: 'pending' }),
      jsonResponse(200, {
        processing_status: 'failed',
        error: 'model_rate_limited: Nano Banana throttled by provider (retry_after=25s)',
      }),
    ]);
    let caught: unknown;
    try {
      await runGeneration(api, { prompt: 'x', source: 'Nano Banana' }, { sleep: noSleep });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AhError);
    expect(caught).toMatchObject({
      code: 'model_rate_limited',
      source: 'Nano Banana',
      retryAfter: 25,
    });
    expect((caught as AhError).message).toContain('Nano Banana');
  });

  it('a model_rate_limited-prefixed failure that does not fully parse still gets the precise code', async () => {
    const { api } = apiFrom([
      jsonResponse(202, { image_uuid: 'g5', processing_status: 'pending' }),
      jsonResponse(200, {
        processing_status: 'failed',
        error: 'model_rate_limited: provider says slow down',
      }),
    ]);
    let caught: unknown;
    try {
      await runGeneration(api, { prompt: 'x', source: 'Nano Banana' }, { sleep: noSleep });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: 'model_rate_limited' });
    expect((caught as AhError).source).toBeUndefined();
  });

  it('parses a SYNCHRONOUS 200 where the image is nested under generated_image (#70)', async () => {
    // Real platform sync-path shape (OpenAI / Grok Imagine, or a slow model that slipped to sync):
    // a 200 with the image under generated_image, NOT top-level. Before #70 this threw generation_failed
    // even though the image was created + saved.
    const { api } = apiFrom([
      jsonResponse(200, {
        generated_image: { uuid: 'sync-1', url: 'https://cdn.example/sync.png', title: 't' },
        context: { uuid: 'ctx-1' },
      }),
    ]);
    const g = await runGeneration(api, { prompt: 'x', source: 'OpenAI' }, { sleep: noSleep });
    expect(g).toMatchObject({
      image_uuid: 'sync-1',
      image_url: 'https://cdn.example/sync.png',
      source_used: 'OpenAI',
    });
  });
});

describe('generate_image', () => {
  it('returns an inline (fast-model) image and augments the prompt for transparency', async () => {
    const { api, calls } = apiFrom([jsonResponse(200, { image_uuid: 'g1', url: 'https://cdn.example/x.png' })]);
    const res = (await generateImage.handler(
      { prompt: 'a cactus', source: 'OpenAI' },
      fakeContext(api),
    )) as any;
    expect(res).toMatchObject({ image_uuid: 'g1', image_url: 'https://cdn.example/x.png', source_used: 'OpenAI' });
    const body = JSON.parse(calls[0]?.init?.body as string);
    expect(body.prompt).toContain('#00FF00');
  });

  it('rejects an unknown source with bad_request and does not call the API (#70)', async () => {
    const { api, calls } = apiFrom([]); // nothing queued: the API must NOT be hit
    await expect(
      generateImage.handler({ prompt: 'x', source: 'Flux 1.1' }, fakeContext(api)),
    ).rejects.toMatchObject({ code: 'bad_request' });
    expect(calls.length).toBe(0);
  });

  it('normalizes a case-variant source to canonical before calling the API (#70)', async () => {
    const { api, calls } = apiFrom([
      jsonResponse(202, { image_uuid: 'g6', processing_status: 'pending' }),
      jsonResponse(200, { processing_status: 'completed', url: 'https://cdn.example/ok.png' }),
    ]);
    const res = (await generateImage.handler(
      { prompt: 'x', source: 'SeeDream 4.5' }, // near-miss casing
      fakeContext(api),
    )) as any;
    expect(res.source_used).toBe('Seedream 4.5'); // canonical
    const body = JSON.parse(calls[0]?.init?.body as string);
    expect(body.source).toBe('Seedream 4.5'); // forwarded the canonical name, not the variant
  });
});

describe('process_transparency', () => {
  it('keys the background server-side and uploads a new image', async () => {
    const { api } = apiFrom([jsonResponse(200, { image_uuid: 't1', url: 'https://cdn.example/t.png' })]);
    const res = (await processTransparency.handler(
      { image_uuid: 'g1', image_url: 'https://cdn.example/x.png' },
      fakeContext(api, fakeImaging()),
    )) as any;
    expect(res).toMatchObject({
      image_uuid: 't1',
      image_url: 'https://cdn.example/t.png',
      has_true_alpha: true,
      corners_clean: true,
      keying_mode: 'box',
    });
    expect(res.note).toBeUndefined();
  });

  it('auto-recovers in dominance mode when the AI produced a tinted green background', async () => {
    const { api } = apiFrom([jsonResponse(200, { image_uuid: 't2', url: 'https://cdn.example/t2.png' })]);
    const calls: Array<string | undefined> = [];
    // box mode -> chroma_background (tinted green); dominance mode -> succeeds.
    const imaging = fakeImaging({
      makeTransparent: async (_in: string, opts?: { mode?: 'box' | 'dominance' }) => {
        calls.push(opts?.mode);
        if (opts?.mode !== 'dominance') {
          throw new AhError({ code: 'chroma_background', message: 'tinted green', suggestion: 'retry dominance' });
        }
        return { outputPath: '/tmp/dom.png', cornersClean: true, width: 800, height: 600 };
      },
    });
    const res = (await processTransparency.handler(
      { image_uuid: 'g1', image_url: 'https://cdn.example/x.png' },
      fakeContext(api, imaging),
    )) as any;
    expect(calls).toEqual(['box', 'dominance']); // tried box (default), then fell back
    expect(res).toMatchObject({ image_uuid: 't2', keying_mode: 'dominance' });
    expect(res.note).toContain('dominance');
  });

  it('does NOT auto-fall-back when a mode is pinned explicitly (surfaces the error)', async () => {
    const { api } = apiFrom([]); // no upload expected
    const imaging = fakeImaging({
      makeTransparent: async () => {
        throw new AhError({ code: 'chroma_background', message: 'tinted green' });
      },
    });
    await expect(
      processTransparency.handler(
        { image_uuid: 'g1', image_url: 'https://cdn.example/x.png', background_mode: 'box' },
        fakeContext(api, imaging),
      ),
    ).rejects.toMatchObject({ code: 'chroma_background' });
  });
});

describe('verify_design_text', () => {
  it('reports a spelling match when OCR is available', async () => {
    const ctx = fakeContext(undefined, fakeImaging({ ocr: async () => ({ available: true, text: 'STAY WILD' }) }));
    const res = (await verifyDesignText.handler(
      { image_uuid: 'g1', image_url: 'https://cdn.example/x.png', expected_text: 'stay wild' },
      ctx,
    )) as any;
    expect(res).toMatchObject({ has_text: true, spelled_correctly: true });
  });

  it('degrades with a note when OCR is unavailable', async () => {
    const ctx = fakeContext(undefined, fakeImaging({ ocr: async () => ({ available: false, text: '' }) }));
    const res = (await verifyDesignText.handler(
      { image_uuid: 'g1', image_url: 'https://cdn.example/x.png' },
      ctx,
    )) as any;
    expect(res.spelled_correctly).toBeNull();
    expect(res.note).toContain('tesseract');
  });
});

describe('design_apparel', () => {
  it('generates, keys transparency, and checks text end-to-end', async () => {
    const { api } = apiFrom([
      jsonResponse(200, { image_uuid: 'g1', url: 'https://cdn.example/x.png' }), // generate
      jsonResponse(200, { image_uuid: 't1', url: 'https://cdn.example/t.png' }), // transform
    ]);
    const res = (await designApparel.handler(
      { prompt: 'stay wild cactus', source: 'OpenAI' },
      fakeContext(api, fakeImaging()),
    )) as any;
    expect(res.designs).toHaveLength(1);
    expect(res.designs[0]).toMatchObject({
      design_uuid: 't1',
      design_url: 'https://cdn.example/t.png',
      transparency_clean: true,
    });
    expect(res.designs[0].text_verified.has_text).toBe(true);
  });

  it('degrades gracefully when the local image toolchain is missing', async () => {
    const { api } = apiFrom([jsonResponse(200, { image_uuid: 'g1', url: 'https://cdn.example/x.png' })]);
    const imaging = fakeImaging({
      makeTransparent: async () => {
        throw new AhError({
          code: 'local_tool_unavailable',
          message: 'needs Pillow',
          suggestion: 'pip3 install Pillow',
        });
      },
    });
    const res = (await designApparel.handler(
      { prompt: 'x', source: 'OpenAI', verify_text: false },
      fakeContext(api, imaging),
    )) as any;
    expect(res.designs[0]).toMatchObject({ design_uuid: 'g1', transparency_clean: false });
    expect(res.designs[0].warning).toContain('Pillow');
  });

  it('keeps the design (does not abort the run) when keying hard-fails', async () => {
    const { api } = apiFrom([jsonResponse(200, { image_uuid: 'g1', url: 'https://cdn.example/x.png' })]);
    const imaging = fakeImaging({
      makeTransparent: async () => {
        throw new AhError({ code: 'transparency_failed', message: 'keyer exit 2' });
      },
    });
    const res = (await designApparel.handler(
      { prompt: 'x', source: 'OpenAI', verify_text: false },
      fakeContext(api, imaging),
    )) as any;
    expect(res.designs[0]).toMatchObject({ design_uuid: 'g1', transparency_clean: false });
    expect(res.designs[0].warning).toContain('transparency_failed');
  });

  it('surfaces a transient error (does NOT silently ship an unkeyed design)', async () => {
    const { api } = apiFrom([jsonResponse(200, { image_uuid: 'g1', url: 'https://cdn.example/x.png' })]);
    const imaging = fakeImaging({
      makeTransparent: async () => {
        throw new AhError({ code: 'upstream_unavailable', message: 'platform 503' });
      },
    });
    await expect(
      designApparel.handler({ prompt: 'x', source: 'OpenAI', verify_text: false }, fakeContext(api, imaging)),
    ).rejects.toMatchObject({ code: 'upstream_unavailable' });
  });
});

describe('iterate_design', () => {
  it('rejects a source that cannot edit', async () => {
    await expect(
      iterateDesign.handler(
        { source_design_uuid: 'g1', change_description: 'blue', source: 'Seedream 4.0' },
        fakeContext(),
      ),
    ).rejects.toMatchObject({ code: 'unprocessable' });
  });

  it('edits via an inline edit-capable source', async () => {
    const { api, calls } = apiFrom([jsonResponse(200, { image_uuid: 'g9', url: 'https://cdn.example/v.png' })]);
    const res = (await iterateDesign.handler(
      { source_design_uuid: 'g1', change_description: 'make it blue', source: 'OpenAI' },
      fakeContext(api),
    )) as any;
    expect(res).toMatchObject({ design_uuid: 'g9', design_url: 'https://cdn.example/v.png' });
    const body = JSON.parse(calls[0]?.init?.body as string);
    expect(body.source_image_uuid).toBe('g1');
  });
});

describe('process_transparency: resolution floor (NORWAY passport-wallet QC-skip)', () => {
  it('upscales a low-res keyed design to the floor so verify_design_quality does not block', async () => {
    // A 1024x1024 design keyed + tight-cropped to its artwork can come out 847x596 (min side
    // 596 < 600 = the QC gate's hard block). process_transparency now upscales the keyed result
    // and uploads THAT, so the design that reaches verify_design_quality is print-ready.
    const { api } = apiFrom([jsonResponse(200, { image_uuid: 'hi', url: 'https://cdn.example/hi.png' })]);
    let ensuredFloor = 0;
    const readPaths: string[] = [];
    const imaging = fakeImaging({
      makeTransparent: async () => ({ outputPath: '/tmp/keyed-847x596.png', cornersClean: true, width: 847, height: 596 }),
      ensureResolution: async (p: string, min: number) => {
        ensuredFloor = min;
        return { outputPath: '/tmp/keyed-upscaled.png', upscaled: true, width: 2843, height: 2000 };
      },
      readBytes: async (p: string) => {
        readPaths.push(p);
        return new Uint8Array([1, 2, 3]);
      },
    });
    const res = (await processTransparency.handler(
      { image_uuid: 'g1', image_url: 'https://cdn.example/x.png' },
      fakeContext(api, imaging),
    )) as any;

    expect(ensuredFloor).toBe(2000); // upscaled to the resolution floor
    expect(readPaths).toContain('/tmp/keyed-upscaled.png'); // the UPSCALED file is what gets uploaded
    expect(res.image_uuid).toBe('hi');
  });

  it('does not re-upload when the keyed design is already large enough', async () => {
    const { api } = apiFrom([jsonResponse(200, { image_uuid: 't1', url: 'https://cdn.example/t.png' })]);
    const readPaths: string[] = [];
    const imaging = fakeImaging({
      makeTransparent: async () => ({ outputPath: '/tmp/keyed-big.png', cornersClean: true, width: 2400, height: 2000 }),
      ensureResolution: async () => ({ outputPath: '/tmp/unused.png', upscaled: false }),
      readBytes: async (p: string) => {
        readPaths.push(p);
        return new Uint8Array([1, 2, 3]);
      },
    });
    await processTransparency.handler(
      { image_uuid: 'g1', image_url: 'https://cdn.example/x.png' },
      fakeContext(api, imaging),
    );
    // upscaled:false -> the ORIGINAL keyed file is uploaded, not a new one.
    expect(readPaths).toEqual(['/tmp/keyed-big.png']);
  });
});

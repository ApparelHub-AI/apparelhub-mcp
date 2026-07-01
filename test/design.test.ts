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
    ocr: async () => ({ available: true, text: 'STAY WILD' }),
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
});

describe('process_transparency', () => {
  it('keys the background locally and uploads a new image', async () => {
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
    });
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

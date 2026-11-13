// The platform decides a design's background from the prompt, and reports what it decided
// (design_intent), what it did (print_ready) and whether it generated from its own rewrite
// (prompt_improvement.applied). These cover the three ways this server could get that wrong:
// dropping the report, keying a design the platform already prepared, and letting an all-over
// design be keyed.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateImage, designApparel, processTransparency } from '../src/tools/design.js';
import { runGeneration } from '../src/image/generate.js';
import { ApiClient } from '../src/http/client.js';
import type { Imaging, ImageStats, MakeTransparentOptions } from '../src/image/imaging.js';
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

const OPAQUE: ImageStats = {
  width: 1024,
  height: 1024,
  mode: 'RGB',
  has_alpha: false,
  transparent_ratio: 0,
  corner_alpha: [255, 255, 255, 255],
  premultiplied_white: false,
};
const TRANSPARENT: ImageStats = {
  width: 900,
  height: 700,
  mode: 'RGBA',
  has_alpha: true,
  transparent_ratio: 0.4,
  corner_alpha: [0, 0, 0, 0],
  premultiplied_white: true,
};

/** `input` is what the downloaded design measures as; the keyer's output is always transparent. */
function imagingWith(input: ImageStats, keyCalls: MakeTransparentOptions[] = []): Imaging {
  return {
    downloadToTemp: async () => '/tmp/in.png',
    makeTransparent: async (_p: string, opts: MakeTransparentOptions = {}) => {
      keyCalls.push(opts);
      return { outputPath: '/tmp/out.png', cornersClean: true, width: 900, height: 700 };
    },
    readBytes: async () => new Uint8Array([1, 2, 3]),
    imageSize: async () => ({ width: 900, height: 700 }),
    imageStats: async (p: string) => (p === '/tmp/in.png' ? input : TRANSPARENT),
    ocr: async () => ({ available: false, text: '', confidence: null }),
    ensureResolution: async () => ({ outputPath: '/tmp/out.png', upscaled: false }),
    cleanup: async () => {},
  } as unknown as Imaging;
}

const INTENT = {
  background: 'isolated',
  key_color: '#FF00FF',
  garment: { category: 'hoodie', descriptor: '' },
  source: 'llm_rewrite',
};

describe('runGeneration: the platform report', () => {
  it('returns the OUTCOME from the status poll, not the 202 statement of intent', async () => {
    const { api } = apiFrom([
      jsonResponse(202, {
        image_uuid: 'g1',
        processing_status: 'pending',
        print_ready: { pending: true, reason: null, key_color: '#FF00FF' },
        design_intent: INTENT,
      }),
      jsonResponse(200, {
        processing_status: 'completed',
        url: 'https://cdn.example/done.png',
        background_state: 'transparent',
        print_ready: { applied: true, reason: null },
        design_intent: INTENT,
      }),
    ]);
    const g = await runGeneration(api, { prompt: 'x', source: 'Nano Banana' }, { sleep: noSleep, intervalMs: 0 });
    expect(g.print_ready).toEqual({ applied: true, reason: null });
    expect(g.design_intent).toEqual(INTENT);
    expect(g.background_state).toBe('transparent');
  });

  it('reads the report off a synchronous 200 as well', async () => {
    const { api } = apiFrom([
      jsonResponse(200, {
        generated_image: { uuid: 's1', url: 'https://cdn.example/s.png' },
        print_ready: { applied: false, reason: 'full_scene_intent' },
        design_intent: { ...INTENT, background: 'full_scene', key_color: null, source: 'llm' },
      }),
    ]);
    const g = await runGeneration(api, { prompt: 'x', source: 'Grok Imagine' }, { sleep: noSleep });
    expect(g.print_ready).toMatchObject({ reason: 'full_scene_intent' });
    expect(g.design_intent).toMatchObject({ background: 'full_scene' });
  });

  it('sends the opt-outs only when the caller chose them', async () => {
    const plain = apiFrom([jsonResponse(200, { image_uuid: 'a', url: 'https://cdn.example/a.png' })]);
    await runGeneration(plain.api, { prompt: 'x', source: 'OpenAI' }, { sleep: noSleep });
    expect(JSON.parse(plain.calls[0]?.init?.body as string)).toEqual({
      source: 'OpenAI',
      size: '1024x1024',
      prompt: 'x',
    });

    const chosen = apiFrom([jsonResponse(200, { image_uuid: 'b', url: 'https://cdn.example/b.png' })]);
    await runGeneration(
      chosen.api,
      { prompt: 'x', source: 'OpenAI', intent: 'all_over', autoKey: false, promptImprovement: 'skip' },
      { sleep: noSleep },
    );
    expect(JSON.parse(chosen.calls[0]?.init?.body as string)).toMatchObject({
      intent: 'all_over',
      auto_key: false,
      prompt_improvement: 'skip',
    });
  });
});

describe('generate_image: passes the platform report through', () => {
  it('returns design_intent, print_ready and background_state, and says when the prompt was rewritten', async () => {
    const { api } = apiFrom([
      jsonResponse(200, {
        generated_image: { uuid: 'g1', url: 'https://cdn.example/g.png' },
        prompt_improvement: { applied: true, improved_prompt: 'a howling wolf, flat vector', issues: ['names_product'] },
        print_ready: { applied: true, reason: null },
        design_intent: INTENT,
      }),
    ]);
    const res = (await generateImage.handler(
      { prompt: 'hoodie with a howling wolf', source: 'Grok Imagine' },
      fakeContext(api),
    )) as Record<string, unknown>;
    expect(res.design_intent).toEqual(INTENT);
    expect(res.print_ready).toEqual({ applied: true, reason: null });
    expect(String(res.prompt_rewritten)).toContain('improved_prompt');
  });

  it('does not claim a rewrite when the suggestion was only advice', async () => {
    const { api } = apiFrom([
      jsonResponse(200, {
        generated_image: { uuid: 'g1', url: 'https://cdn.example/g.png' },
        prompt_improvement: { applied: false, improved_prompt: 'x' },
      }),
    ]);
    const res = (await generateImage.handler(
      { prompt: 'a howling wolf', source: 'Grok Imagine' },
      fakeContext(api),
    )) as Record<string, unknown>;
    expect(res.prompt_rewritten).toBeUndefined();
  });
});

describe('design_apparel: acts on the platform report', () => {
  it('tells the platform an all-over design is all-over, so it is not keyed', async () => {
    const { api, calls } = apiFrom([jsonResponse(200, { image_uuid: 'g1', url: 'https://cdn.example/x.png' })]);
    await designApparel.handler(
      { prompt: 'sleeping cat illustration', source: 'OpenAI', needs_transparency: false, verify_text: false },
      fakeContext(api, imagingWith(OPAQUE)),
    );
    const body = JSON.parse(calls[0]?.init?.body as string);
    expect(body.intent).toBe('all_over');
    expect(body.prompt).toBe('sleeping cat illustration');
  });

  it('does not send an intent for a placed design', async () => {
    const { api, calls } = apiFrom([
      jsonResponse(200, { image_uuid: 'g1', url: 'https://cdn.example/x.png' }),
      jsonResponse(200, { image_uuid: 't1', url: 'https://cdn.example/t.png' }),
    ]);
    await designApparel.handler(
      { prompt: 'a howling wolf', source: 'OpenAI', verify_text: false },
      fakeContext(api, imagingWith(OPAQUE)),
    );
    expect(JSON.parse(calls[0]?.init?.body as string).intent).toBeUndefined();
  });

  it.each(['scene_on_key_cropped', 'fake_transparency_checkerboard'])(
    'does not run the keyer on a design the platform reported as %s',
    async (reason) => {
      const { api, calls } = apiFrom([
        jsonResponse(200, {
          generated_image: { uuid: 'g1', url: 'https://cdn.example/x.png' },
          print_ready: { applied: reason === 'scene_on_key_cropped', reason, message: 'Shown to the user.' },
        }),
      ]);
      const keyCalls: MakeTransparentOptions[] = [];
      const res = (await designApparel.handler(
        { prompt: 'a forest clearing at dawn', source: 'Grok Imagine', verify_text: false },
        fakeContext(api, imagingWith(OPAQUE, keyCalls)),
      )) as { designs: Array<Record<string, unknown>> };
      expect(keyCalls).toHaveLength(0);
      expect(calls).toHaveLength(1); // nothing was uploaded
      const d = res.designs[0]!;
      expect(d.design_uuid).toBe('g1');
      expect(d.transparency_clean).toBe(false);
      expect(String(d.warning)).toContain(reason);
      expect(d.print_ready).toMatchObject({ reason });
    },
  );

  it('carries the report and the rewrite notice on each design', async () => {
    const { api } = apiFrom([
      jsonResponse(200, {
        generated_image: { uuid: 'g1', url: 'https://cdn.example/x.png' },
        prompt_improvement: { applied: true, improved_prompt: 'a green dragon, flat vector' },
        print_ready: { applied: true, reason: null },
        design_intent: INTENT,
        background_state: 'transparent',
      }),
      jsonResponse(200, { image_uuid: 't1', url: 'https://cdn.example/t.png' }),
    ]);
    const res = (await designApparel.handler(
      { prompt: 'hoodie with a green dragon', source: 'Grok Imagine', verify_text: false },
      fakeContext(api, imagingWith(TRANSPARENT)),
    )) as { designs: Array<Record<string, unknown>> };
    const d = res.designs[0]!;
    expect(d.design_intent).toEqual(INTENT);
    expect(d.prompt_improvement).toMatchObject({ applied: true });
    expect(String(d.prompt_rewritten)).toContain('improved_prompt');
  });
});

describe('process_transparency: a design the platform already keyed', () => {
  it('crops it and keys nothing, so artwork sharing the old key colour survives', async () => {
    // The platform keyed a magenta screen from behind a green dragon. Before this, the
    // transparent corners failed the green sanity check and the dominance fallback swept the
    // dragon away, reporting a "safe re-key".
    const { api } = apiFrom([jsonResponse(200, { image_uuid: 't1', url: 'https://cdn.example/t.png' })]);
    const keyCalls: MakeTransparentOptions[] = [];
    const res = (await processTransparency.handler(
      { image_uuid: 'g1', image_url: 'https://cdn.example/x.png' },
      fakeContext(api, imagingWith(TRANSPARENT, keyCalls)),
    )) as Record<string, unknown>;
    expect(keyCalls).toEqual([{ cropOnly: true }]);
    expect(res.keying_mode).toBe('none');
    expect(res.transparency_clean).toBe(true);
    expect(String(res.note)).toContain('nothing was keyed');
  });

  it('still keys an opaque design', async () => {
    const { api } = apiFrom([jsonResponse(200, { image_uuid: 't1', url: 'https://cdn.example/t.png' })]);
    const keyCalls: MakeTransparentOptions[] = [];
    const res = (await processTransparency.handler(
      { image_uuid: 'g1', image_url: 'https://cdn.example/x.png' },
      fakeContext(api, imagingWith(OPAQUE, keyCalls)),
    )) as Record<string, unknown>;
    expect(keyCalls).toEqual([{ mode: 'box', force: undefined }]);
    expect(res.keying_mode).toBe('box');
  });

  it('respects an explicitly pinned mode even on a transparent input', async () => {
    const { api } = apiFrom([jsonResponse(200, { image_uuid: 't1', url: 'https://cdn.example/t.png' })]);
    const keyCalls: MakeTransparentOptions[] = [];
    await processTransparency.handler(
      { image_uuid: 'g1', image_url: 'https://cdn.example/x.png', background_mode: 'dominance' },
      fakeContext(api, imagingWith(TRANSPARENT, keyCalls)),
    );
    expect(keyCalls[0]).toMatchObject({ mode: 'dominance' });
    expect(keyCalls[0]?.cropOnly).toBeUndefined();
  });
});

// The script itself, on real pixels: the property the TypeScript above relies on.
const SCRIPT = fileURLToPath(new URL('../python/make_transparent.py', import.meta.url));
const hasPillow = spawnSync('python3', ['-c', 'import PIL']).status === 0;

describe.skipIf(!hasPillow)('make_transparent.py --crop-only', () => {
  const dir = tmpdir();
  const make = (name: string) => {
    // 200x200, fully transparent, with an opaque pure-green 80x80 square in the middle: a
    // green subject whose (non-green) screen was already removed.
    const p = join(dir, `${name}-${Math.random().toString(36).slice(2)}.png`);
    const r = spawnSync('python3', [
      '-c',
      'import sys\nfrom PIL import Image\n' +
        'im = Image.new("RGBA", (200, 200), (255, 255, 255, 0))\n' +
        'im.paste((0, 255, 0, 255), (60, 60, 140, 140))\nim.save(sys.argv[1])',
      p,
    ]);
    expect(r.status).toBe(0);
    return p;
  };
  const opaquePixels = (p: string) =>
    Number(
      spawnSync(
        'python3',
        ['-c', 'import sys\nfrom PIL import Image\nprint(sum(1 for a in Image.open(sys.argv[1]).convert("RGBA").getdata(3) if a))', p],
        { encoding: 'utf8' },
      ).stdout.trim(),
    );

  it('keeps green artwork that dominance keying would clear', () => {
    const input = make('crop-only');
    const out = join(dir, `crop-only-out-${Math.random().toString(36).slice(2)}.png`);
    const r = spawnSync('python3', [SCRIPT, input, out, '--crop-only'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(opaquePixels(out)).toBe(80 * 80);

    // The control: the same image through the path it used to take.
    const swept = join(dir, `dominance-out-${Math.random().toString(36).slice(2)}.png`);
    spawnSync('python3', [SCRIPT, input, swept, '--dominance'], { encoding: 'utf8' });
    expect(opaquePixels(swept)).toBe(0);
    for (const f of [input, out, swept]) rmSync(f, { force: true });
  });
});

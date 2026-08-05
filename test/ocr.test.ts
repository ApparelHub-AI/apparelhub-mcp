import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { LocalImaging, parseTesseractTsv, type Imaging } from '../src/image/imaging.js';
import { verifyDesignText } from '../src/tools/design.js';
import { fakeContext } from './helpers/ctx.js';

const SAMPLE = fileURLToPath(new URL('./fixtures/ocr-sample.png', import.meta.url));

function fakeImaging(over: Partial<Imaging> = {}): Imaging {
  return {
    downloadToTemp: async () => '/tmp/fake.png',
    makeTransparent: async () => ({ outputPath: '/tmp/o.png', cornersClean: true }),
    readBytes: async () => new Uint8Array([1]),
    imageSize: async () => ({ width: 1024, height: 1024 }),
    imageStats: async () => undefined,
    mockupStats: async () => undefined,
    ocr: async () => ({ available: false, text: '', confidence: null }),
    threadColors: async () => [],
    ensureResolution: async () => ({ outputPath: '/tmp/o.png', upscaled: false }),
    cleanup: async () => {},
    ...over,
  } as Imaging;
}

// tesseract TSV: level, page, block, par, line, word, left, top, width, height, conf, text.
// Word rows are level 5; the container rows above them carry conf -1.
const tsvRow = (
  level: string,
  block: string,
  par: string,
  line: string,
  conf: string,
  text: string,
) => [level, '1', block, par, line, '1', '0', '0', '10', '10', conf, text].join('\t');

const TSV_HEADER =
  'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';

describe('parseTesseractTsv', () => {
  it('reconstructs words into lines', () => {
    const tsv = [
      TSV_HEADER,
      tsvRow('5', '1', '1', '1', '96', 'STAY'),
      tsvRow('5', '1', '1', '1', '95', 'WILD'),
      tsvRow('5', '1', '1', '2', '94', 'MOON'),
    ].join('\n');
    expect(parseTesseractTsv(tsv).text).toBe('STAY WILD\nMOON');
  });

  it('averages per-word confidence', () => {
    const tsv = [TSV_HEADER, tsvRow('5', '1', '1', '1', '90', 'A'), tsvRow('5', '1', '1', '1', '70', 'B')].join('\n');
    expect(parseTesseractTsv(tsv).confidence).toBe(80);
  });

  it('ignores the -1 confidence of non-word container rows', () => {
    // Averaging -1 in would drag the score toward a failure that did not happen.
    const tsv = [
      TSV_HEADER,
      tsvRow('1', '0', '0', '0', '-1', ''),
      tsvRow('2', '1', '0', '0', '-1', ''),
      tsvRow('5', '1', '1', '1', '90', 'A'),
    ].join('\n');
    const out = parseTesseractTsv(tsv);
    expect(out.confidence).toBe(90);
    expect(out.text).toBe('A');
  });

  it('reports no confidence rather than zero when nothing was read', () => {
    // null = "no measurement". Zero would read as "measured, and terrible".
    const out = parseTesseractTsv(TSV_HEADER);
    expect(out.text).toBe('');
    expect(out.confidence).toBeNull();
  });

  it('skips blank word cells', () => {
    const tsv = [TSV_HEADER, tsvRow('5', '1', '1', '1', '95', 'A'), tsvRow('5', '1', '1', '1', '0', '   ')].join('\n');
    expect(parseTesseractTsv(tsv).text).toBe('A');
    expect(parseTesseractTsv(tsv).confidence).toBe(95);
  });
});

describe('LocalImaging.ocr (end to end)', () => {
  // Exercises whichever engine is present. In CI there is no native tesseract,
  // so this is the proof that the bundled WASM engine plus the bundled language
  // data actually work offline — the wiring most likely to break silently and
  // regress the hosted server back to "OCR unavailable".
  it('reads text from a real image and reports a confidence', async () => {
    const out = await new LocalImaging().ocr(SAMPLE);
    expect(out.available).toBe(true);
    expect(out.text.replace(/\s+/g, ' ').trim()).toBe('STAY WILD');
    expect(out.confidence).not.toBeNull();
    expect(out.confidence!).toBeGreaterThan(70);
    expect(out.engine).toMatch(/native|wasm/);
  }, 60_000);
});

describe('verify_design_text confidence handling', () => {
  const run = (ocr: { available: boolean; text: string; confidence: number | null }) =>
    verifyDesignText.handler(
      { image_uuid: 'i1', image_url: 'https://cdn.example.test/d.png', expected_text: 'STAY WILD' },
      fakeContext(undefined, fakeImaging({ ocr: async () => ocr })),
    ) as Promise<any>;

  it('gives a verdict when the read is confident', async () => {
    const res = await run({ available: true, text: 'STAY WILD', confidence: 96 });
    expect(res.has_text).toBe(true);
    expect(res.spelled_correctly).toBe(true);
  });

  it('still reports a mismatch when the read is confident', async () => {
    // Note the verdict is a substring match, so 'STAY WILDE' would PASS —
    // deliberate leniency toward OCR noise at the edges. A transposition is a
    // real miss.
    const res = await run({ available: true, text: 'STAY WLID', confidence: 96 });
    expect(res.spelled_correctly).toBe(false);
  });

  it('refuses a spelling verdict when the read is low confidence', async () => {
    // The regression this guards: tesseract returns fluent-looking gibberish on
    // stylized display faces (measured: 24% on a distorted design, against 96%
    // for a clean read). Scoring that as a misspelling would condemn a design
    // that is perfectly fine — the same confident-wrong failure the "OCR
    // unavailable" branch exists to prevent, only inverted.
    const res = await run({ available: true, text: '— OND C8 OULU lll alee', confidence: 24 });
    expect(res.has_text).toBe(true);
    expect(res.spelled_correctly).toBeNull();
    expect(res.note).toMatch(/confidence/i);
    expect(res.note).toMatch(/read the design image yourself/i);
  });

  it('keeps has_text null when OCR could not run at all', async () => {
    const res = await run({ available: false, text: '', confidence: null });
    expect(res.has_text).toBeNull();
    expect(res.spelled_correctly).toBeNull();
  });

  it('does not degrade when the engine reported no confidence', async () => {
    // A missing measurement is not evidence of a bad read.
    const res = await run({ available: true, text: 'STAY WILD', confidence: null });
    expect(res.spelled_correctly).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The hosted image assembles OCR from three pieces that live in three different
 * files, none of which import each other:
 *
 *   - package.json     declares the tesseract.js version (as a devDependency)
 *   - Dockerfile       installs the runtime copy into the image
 *   - build.sh         keeps it out of the esbuild bundle
 *   - tessdata/        supplies the language data the engine loads offline
 *
 * Break any one and OCR silently reverts to "unavailable" on the hosted server
 * — the exact state this was built to fix, and one that no unit test touching
 * only src/ would notice. These assertions are cheap; a bad hosted deploy is not.
 */

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

const pkg = JSON.parse(read('../package.json')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const dockerfile = read('../deploy/hosted/Dockerfile');
const buildScript = read('../deploy/hosted/build.sh');

describe('hosted image OCR wiring', () => {
  it('pins tesseract.js to the same version the image installs', () => {
    const declared = pkg.devDependencies?.['tesseract.js'];
    expect(declared, 'tesseract.js must stay a devDependency').toBeTruthy();

    const installed = /tesseract\.js@(\S+)/.exec(dockerfile)?.[1];
    expect(installed, 'Dockerfile must install tesseract.js').toBeTruthy();
    expect(installed).toBe(declared);
  });

  it('keeps tesseract.js out of the published package dependencies', () => {
    // It carries tens of megabytes of WASM. npx users can install the native
    // binary instead, so every npm consumer paying that cost is a bad trade.
    expect(pkg.dependencies?.['tesseract.js']).toBeUndefined();
  });

  it('marks tesseract.js external to the bundle', () => {
    // Inlining it into the single .mjs breaks it: it loads worker and WASM
    // files from disk at run time.
    expect(buildScript).toContain('--external:tesseract.js');
  });

  it('copies the language data into the image', () => {
    // Without this the engine fetches the model from a CDN on a cold start,
    // which can simply fail inside Lambda.
    expect(dockerfile).toMatch(/COPY\s+tessdata\/\s+\$\{LAMBDA_TASK_ROOT\}\/tessdata\//);
  });

  it('ships the language data the loader actually looks for', () => {
    // imaging.ts resolves ../../tessdata and passes gzip:false, so the plain
    // .traineddata must exist under that name — not the gzipped CDN form.
    expect(() => read('../tessdata/eng.traineddata')).not.toThrow();
  });

  it('lets every path the Dockerfile copies through .dockerignore', () => {
    // .dockerignore is an allowlist (`*` then `!path`). A COPY of something not
    // un-ignored fails the build with "file not found in build context", which
    // reads like a missing file and sends you looking in the wrong place. This
    // is derived from the Dockerfile rather than hardcoded, so a future COPY is
    // covered without anyone remembering to update this test.
    const ignore = read('../.dockerignore')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('!'))
      .map((l) => l.slice(1).replace(/\/$/, ''));

    const copied = [...dockerfile.matchAll(/^COPY\s+(\S+)/gm)]
      .map((m) => m[1]!.replace(/\/$/, ''))
      .filter((src) => !src.startsWith('--')); // skip COPY --from= style flags

    for (const src of copied) {
      const allowed = ignore.some((entry) => src === entry || src.startsWith(`${entry}/`));
      expect(allowed, `Dockerfile copies "${src}" but .dockerignore never un-ignores it`).toBe(true);
    }
  });
});

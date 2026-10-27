import { describe, expect, it, vi } from 'vitest';
import { uploadDesign, __test } from '../src/tools/upload.js';
import { AhError } from '../src/errors.js';
import { fakeContext } from './helpers/ctx.js';
import { apiSequence, jsonResponse, noSleep } from './helpers/fakeFetch.js';
import type { ToolContext } from '../src/tools/context.js';
import { ApiClient } from '../src/http/client.js';

// Bring-your-own artwork (#129). The gap these cover: an agent handed a client's
// own logo had no way to put it on a product, so it either stopped or was tempted
// to regenerate a mark it had been told not to touch.

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const WEBP = Buffer.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', 'utf-8');

const INITIATE = {
  upload_url: 'https://storage.example.test/uploads/temp/abc.upload?sig=x',
  image_uuid: 'design-1',
  s3_key: 'uploads/temp/abc.upload',
  expires_in: 900,
};

function ctxWith(
  api: ApiClient,
  fetchImpl?: typeof fetch,
  now?: () => number,
): ToolContext {
  return { ...fakeContext(api), fetchImpl, sleepImpl: noSleep, nowImpl: now ?? (() => 0) };
}

/** A stub for the raw (non-ApparelHub) fetch: the presigned PUT and source_url. */
function rawFetch(responses: Response[]): { impl: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const next = responses.shift();
    if (!next) throw new Error('rawFetch: no more responses queued');
    return next;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

// --- format sniffing ---------------------------------------------------------

describe('format sniffing', () => {
  it('identifies the three supported formats from magic bytes', () => {
    expect(__test.sniffContentType(new Uint8Array(PNG))).toBe('image/png');
    expect(__test.sniffContentType(new Uint8Array(JPEG))).toBe('image/jpeg');
    expect(__test.sniffContentType(new Uint8Array(WEBP))).toBe('image/webp');
  });

  it('does not guess at an unknown payload', () => {
    expect(__test.sniffContentType(new Uint8Array(Buffer.from('not an image')))).toBeUndefined();
  });

  it('recognises SVG, which has no magic bytes to sniff', () => {
    expect(__test.looksLikeSvg(new Uint8Array(SVG))).toBe(true);
    expect(__test.looksLikeSvg(new Uint8Array(Buffer.from('<?xml version="1.0"?>\n' + SVG.toString())))).toBe(true);
    expect(__test.looksLikeSvg(new Uint8Array(PNG))).toBe(false);
    expect(__test.looksLikeSvg(new Uint8Array(Buffer.from('<html><body>nope</body></html>')))).toBe(false);
  });
});

// --- SSRF guard --------------------------------------------------------------

describe('address guard', () => {
  it('blocks the address ranges a fetch must never reach', () => {
    for (const ip of [
      '127.0.0.1',        // loopback
      '169.254.169.254',  // cloud instance metadata
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.1',
      '100.64.0.1',       // carrier-grade NAT
      '0.0.0.0',
      '224.0.0.1',        // multicast
      '::1',
      'fd00::1',          // unique-local
      'fe80::1',          // link-local
      '::ffff:127.0.0.1', // IPv4-mapped loopback
    ]) {
      expect(isBlocked(ip), ip).toBe(true);
    }
  });

  it('allows ordinary public addresses', () => {
    for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:2800:220:1::1']) {
      expect(isBlocked(ip), ip).toBe(false);
    }
  });

  const isBlocked = (ip: string): boolean => __test.isBlockedAddress(ip);
});

// --- transports --------------------------------------------------------------

describe('upload_design', () => {
  it('takes inline bytes all the way to a usable design_uuid', async () => {
    const { api, calls: apiCalls } = apiSequence([
      INITIATE,
      { message: 'Processing started', image_uuid: 'design-1', processing_status: 'processing' },
      { image_uuid: 'design-1', processing_status: 'completed', url: 'https://cdn.example.test/design-1.png', title: 'client-logo' },
    ]);
    const put = rawFetch([jsonResponse(200)]);

    const res = (await uploadDesign.handler(
      { image_base64: PNG.toString('base64'), filename: 'client-logo.png' },
      ctxWith(api, put.impl),
    )) as Record<string, unknown>;

    expect(res.status).toBe('completed');
    expect(res.design_uuid).toBe('design-1');
    expect(res.url).toBe('https://cdn.example.test/design-1.png');
    expect(res.transport).toBe('base64');

    // The declared size lets the storage quota refuse an over-limit upload before
    // the presigned URL is minted, so it must actually be sent.
    const initiateBody = JSON.parse(String(apiCalls[0].init?.body));
    expect(initiateBody).toMatchObject({ filename: 'client-logo.png', content_type: 'image/png', file_size: PNG.byteLength });

    // The PUT goes to storage, with the signed content type and WITHOUT our API key.
    expect(put.calls).toHaveLength(1);
    expect(put.calls[0].url).toBe(INITIATE.upload_url);
    expect(put.calls[0].init?.method).toBe('PUT');
    const headers = put.calls[0].init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('image/png');
    expect(JSON.stringify(headers).toLowerCase()).not.toContain('x-api-key');
  });

  it('hands back a presigned URL when given no bytes, and uploads nothing itself', async () => {
    const { api } = apiSequence([INITIATE]);
    const put = rawFetch([]); // any raw call at all would throw

    const res = (await uploadDesign.handler(
      { filename: 'seal.png', content_type: 'image/png' },
      ctxWith(api, put.impl),
    )) as Record<string, unknown>;

    expect(res.mode).toBe('presigned');
    expect(res.upload_url).toBe(INITIATE.upload_url);
    expect(res.image_uuid).toBe('design-1');
    expect(String(res.next_step)).toContain('image_uuid="design-1"');
    expect(put.calls).toHaveLength(0);
  });

  it('finishes a presigned upload when called back with the image_uuid', async () => {
    const { api, calls } = apiSequence([
      { message: 'Processing started' },
      { image_uuid: 'design-1', processing_status: 'completed', url: 'https://cdn.example.test/design-1.png' },
    ]);

    const res = (await uploadDesign.handler({ image_uuid: 'design-1' }, ctxWith(api))) as Record<string, unknown>;

    expect(res.status).toBe('completed');
    expect(res.design_uuid).toBe('design-1');
    expect(res.transport).toBe('presigned');
    expect(calls[0].url).toContain('/images/upload/design-1/complete');
    expect(calls[1].url).toContain('/images/upload/design-1/status');
  });

  it('resumes polling when complete has already been called', async () => {
    // The platform only accepts complete once, so a re-entry to resume polling
    // gets a 404 there. That is the normal resume path, not a failure.
    const api = apiWithStatuses([
      [404, { message: 'Upload not found or already processing' }],
      [200, { image_uuid: 'design-1', processing_status: 'completed', url: 'https://cdn.example.test/d.png' }],
    ]);

    const res = (await uploadDesign.handler({ image_uuid: 'design-1' }, ctxWith(api))) as Record<
      string,
      unknown
    >;
    expect(res.status).toBe('completed');
    expect(res.design_uuid).toBe('design-1');
  });

  it('reports a storage rejection as an upload failure, not a success', async () => {
    const { api } = apiSequence([INITIATE]);
    const put = rawFetch([jsonResponse(403, { message: 'expired' })]);

    await expect(
      uploadDesign.handler({ image_base64: PNG.toString('base64') }, ctxWith(api, put.impl)),
    ).rejects.toMatchObject({ code: 'upload_failed' });
  });

  it('hands the poll back instead of hanging when processing runs long', async () => {
    let t = 0;
    const { api } = apiSequence([
      INITIATE,
      { message: 'Processing started' },
      { image_uuid: 'design-1', processing_status: 'processing' },
      { image_uuid: 'design-1', processing_status: 'processing' },
    ]);
    const put = rawFetch([jsonResponse(200)]);
    const res = (await uploadDesign.handler(
      { image_base64: PNG.toString('base64') },
      ctxWith(api, put.impl, () => (t += 60_000)), // blows the budget on the second poll
    )) as Record<string, unknown>;

    expect(res.status).toBe('processing');
    expect(String(res.next_step)).toContain('upload_design again');
  });

  it('surfaces a failed processing run as an error', async () => {
    const { api } = apiSequence([
      INITIATE,
      { message: 'Processing started' },
      { image_uuid: 'design-1', processing_status: 'failed', error: 'Unsupported image format.' },
    ]);
    const put = rawFetch([jsonResponse(200)]);

    await expect(
      uploadDesign.handler({ image_base64: PNG.toString('base64') }, ctxWith(api, put.impl)),
    ).rejects.toMatchObject({ code: 'upload_processing_failed' });
  });
});

// --- guardrails --------------------------------------------------------------

describe('upload_design guardrails', () => {
  it('uploads an SVG as vector rather than refusing it', async () => {
    // SVG has no magic bytes, so it is sniffed from the document head; the
    // platform renders it at print resolution.
    const { api, calls } = apiSequence([
      INITIATE,
      { message: 'ok' },
      {
        image_uuid: 'design-1',
        processing_status: 'completed',
        url: 'https://cdn.example.test/d.png',
        rasterized_from_svg: { width: 4096, height: 2048, source_bytes: 812 },
      },
    ]);
    const put = rawFetch([jsonResponse(200)]);
    const res = (await uploadDesign.handler(
      { image_base64: SVG.toString('base64'), filename: 'mark.svg' },
      ctxWith(api, put.impl),
    )) as Record<string, unknown>;

    expect(res.status).toBe('completed');
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ content_type: 'image/svg+xml' });
    expect((put.calls[0].init?.headers as Record<string, string>)['Content-Type']).toBe('image/svg+xml');
    expect((res.warnings as string[]).join(' ')).toContain('4096x2048');
  });

  it('names the export step for a format that must be converted first', async () => {
    const { api } = apiSequence([]);
    const pdf = Buffer.from('%PDF-1.7\n%âãÏÓ\n', 'latin1');
    await uploadDesign.handler({ image_base64: pdf.toString('base64') }, ctxWith(api)).catch((err: AhError) => {
      expect(err.code).toBe('unsupported_format');
      expect(err.message).toContain('PDF');
      // Never suggest recreating the mark.
      expect(err.suggestion?.toLowerCase()).toContain('do not redraw');
    });

    const junk = Buffer.from('this is not an image at all');
    await uploadDesign.handler({ image_base64: junk.toString('base64') }, ctxWith(api)).catch((err: AhError) => {
      expect(err.code).toBe('unsupported_format');
      expect(err.suggestion).toContain('SVG');
      expect(err.suggestion?.toLowerCase()).toContain('do not redraw');
    });
    expect.assertions(6);
  });

  it('caps inline base64 and points at the cheaper transports', async () => {
    const { api } = apiSequence([]);
    const huge = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]).toString('base64');
    await uploadDesign.handler({ image_base64: huge }, ctxWith(api)).catch((err: AhError) => {
      expect(err.code).toBe('file_too_large');
      expect(err.suggestion).toContain('source_url');
      expect(err.suggestion).toContain('presigned');
    });
    expect.assertions(3);
  });

  it('refuses a non-https source_url', async () => {
    const { api } = apiSequence([]);
    await expect(
      uploadDesign.handler({ source_url: 'http://example.com/logo.png' }, ctxWith(api)),
    ).rejects.toMatchObject({ code: 'invalid_source_url' });
  });

  it('refuses a source_url that resolves to a non-public address', async () => {
    const { api } = apiSequence([]);
    const put = rawFetch([]); // must never be reached
    await expect(
      uploadDesign.handler({ source_url: 'https://localhost/logo.png' }, ctxWith(api, put.impl)),
    ).rejects.toMatchObject({ code: 'invalid_source_url' });
    expect(put.calls).toHaveLength(0);
  });

  it('refuses both transports at once rather than silently picking one', async () => {
    const { api } = apiSequence([]);
    await expect(
      uploadDesign.handler(
        { source_url: 'https://example.com/a.png', image_base64: PNG.toString('base64') },
        ctxWith(api),
      ),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });
});

// --- warnings ----------------------------------------------------------------

describe('upload_design warnings', () => {
  async function uploadWithStatus(status: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { api } = apiSequence([INITIATE, { message: 'ok' }, status]);
    const put = rawFetch([jsonResponse(200)]);
    return (await uploadDesign.handler(
      { image_base64: PNG.toString('base64') },
      ctxWith(api, put.impl),
    )) as Record<string, unknown>;
  }

  it('says the mark was kept crisp when it was enlarged with nearest-neighbour', async () => {
    const res = await uploadWithStatus({
      image_uuid: 'design-1',
      processing_status: 'completed',
      url: 'https://cdn.example.test/d.png',
      low_res_upscaled: { original_width: 11, original_height: 11, filter: 'nearest' },
    });
    const warnings = res.warnings as string[];
    expect(warnings.join(' ')).toContain('11x11');
    expect(warnings.join(' ')).toContain('crisp');
  });

  it('offers the pixel-art escape hatch when a small file was smoothed', async () => {
    const res = await uploadWithStatus({
      image_uuid: 'design-1',
      processing_status: 'completed',
      url: 'https://cdn.example.test/d.png',
      low_res_upscaled: { original_width: 300, original_height: 200, filter: 'lanczos' },
    });
    expect((res.warnings as string[]).join(' ')).toContain('upscale="pixel"');
  });

  it('flags a content type that disagrees with the actual bytes', async () => {
    const { api } = apiSequence([
      INITIATE,
      { message: 'ok' },
      { image_uuid: 'design-1', processing_status: 'completed', url: 'https://cdn.example.test/d.png' },
    ]);
    const put = rawFetch([jsonResponse(200)]);
    const res = (await uploadDesign.handler(
      { image_base64: JPEG.toString('base64'), content_type: 'image/png' },
      ctxWith(api, put.impl),
    )) as Record<string, unknown>;
    expect((res.warnings as string[]).join(' ')).toContain('image/jpeg');
  });
});

// --- naming ------------------------------------------------------------------

describe('filename inference', () => {
  it('takes the filename from a source URL when one is there', () => {
    expect(__test.guessFilename('https://cdn.example.test/assets/iron-paw-logo.png', 'image/png')).toBe(
      'iron-paw-logo.png',
    );
  });

  it('falls back to an extension that matches the real format', () => {
    expect(__test.guessFilename('https://cdn.example.test/download?id=9', 'image/webp')).toBe('upload.webp');
  });
});

// --- local helper ------------------------------------------------------------

/** An ApiClient that replays a sequence of (status, body) pairs — the shared helper
 *  only does 200s, and the resume path needs a 404. */
function apiWithStatuses(pairs: Array<[number, unknown]>): ApiClient {
  const queue = pairs.map(([status, body]) => jsonResponse(status, body));
  const fetchImpl = vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error('apiWithStatuses: no more responses queued');
    return next;
  }) as unknown as typeof fetch;
  return new ApiClient({
    apiKey: 'k',
    baseUrl: 'https://api.example.test/agents/v1',
    userAgent: 't',
    fetchImpl,
    sleepImpl: noSleep,
  });
}

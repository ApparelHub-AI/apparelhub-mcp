import { z } from 'zod';
import { lookup } from 'node:dns/promises';
import { defineTool, type ToolDef } from './registry.js';
import { AhError } from '../errors.js';
import { isRecord, str } from '../util/shape.js';
import type { ToolContext } from './context.js';

// -----------------------------------------------------------------------------
// Bring-your-own artwork (epic #129).
//
// Everything else in this server assumes a design was generated here. Merchants
// who already own their artwork — a logo, a brand mark, a cleared cover, anything
// a client forbids redrawing — had no way in at all: create_product and
// ship_product both need a design uuid, and nothing produced one from a file.
//
// The platform side has always supported it through a three-step presigned
// handshake. This tool is the missing front door, and it covers both kinds of
// caller: one that can make an HTTP PUT itself (cheapest, full resolution), and
// one that cannot (no shell, so the bytes have to travel through the tool call).
// -----------------------------------------------------------------------------

/** Platform ceiling for a single upload. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Ceiling for the inline-base64 transport. Far below MAX_UPLOAD_BYTES on purpose:
 * base64 arguments are expensive in the CALLER's context (~1.37x the bytes, and
 * roughly 350k tokens per megabyte), and the request also has to fit inside the
 * server's own invocation payload limit. Anything real should use source_url or
 * the presigned mode.
 */
const MAX_BASE64_BYTES = 4 * 1024 * 1024;

/** Redirect hops allowed when fetching source_url. Each hop is re-validated. */
const MAX_REDIRECTS = 3;

/** How long to wait for server-side processing before handing the poll back. */
const PROCESS_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 2_000;

type ContentType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml';

const EXT_FOR: Record<ContentType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

// --- format sniffing ---------------------------------------------------------

/**
 * Content type from magic bytes, or undefined.
 *
 * The bytes are authoritative — a declared content type (or a URL's extension,
 * or a server's Content-Type header) is a claim, and the presigned PUT is signed
 * against whatever we declare at initiate. Getting that wrong fails the PUT with
 * an opaque S3 signature error, so sniff rather than trust.
 */
export function sniffContentType(bytes: Uint8Array): ContentType | undefined {
  if (bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp';
  }
  return undefined;
}

/**
 * True when the payload is an SVG document.
 *
 * SVG has no magic-byte signature — it is XML — so it is sniffed from the head of
 * the document instead, tolerating a BOM, an XML declaration and a DOCTYPE.
 */
export function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, 2048))
    .replace(/^\uFEFF/, '')
    .trimStart()
    .toLowerCase();
  if (!head.startsWith('<')) return false;
  return /<\s*(?:\w+:)?svg[\s/>]/.test(head);
}

function rejectUnsupportedFormat(bytes: Uint8Array): never {
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 256)).trimStart();
  if (/^%PDF-/.test(head)) {
    throw new AhError({
      code: 'unsupported_format',
      message: 'That file is a PDF, not an image.',
      suggestion:
        'Export the artwork as SVG (best — it is rendered at print resolution) or PNG, then upload that. Do NOT redraw or approximate the mark.',
    });
  }
  throw new AhError({
    code: 'unsupported_format',
    message:
      'Unsupported image format. The file is not PNG, JPEG, WEBP or SVG.',
    suggestion:
      'Adobe Illustrator (.ai) and EPS files need exporting first: save as SVG to keep it vector (rendered at print resolution, best quality), or export a PNG at the size you intend to print. Do NOT redraw or approximate the mark.',
  });
}

// --- SSRF guard --------------------------------------------------------------

function ipv4IsPrivate(ip: string): boolean {
  const p = ip.split('.').map((n) => Number.parseInt(n, 10));
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true; // unparseable = refuse
  const [a, b] = p as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;                  // this-host, private, loopback
  if (a === 169 && b === 254) return true;                            // link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true;                   // private
  if (a === 192 && b === 168) return true;                            // private
  if (a === 100 && b >= 64 && b <= 127) return true;                  // carrier-grade NAT
  if (a === 192 && b === 0) return true;                              // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true;               // benchmarking
  if (a >= 224) return true;                                          // multicast + reserved
  return false;
}

/** Refuse anything that is not a routable public address. */
export function isBlockedAddress(ip: string): boolean {
  const addr = ip.toLowerCase();
  if (addr.includes('.') && !addr.startsWith('::ffff:')) return ipv4IsPrivate(addr);
  if (addr.startsWith('::ffff:')) return ipv4IsPrivate(addr.slice('::ffff:'.length));
  if (addr === '::' || addr === '::1') return true;                   // unspecified, loopback
  const head = Number.parseInt(addr.split(':')[0] || '0', 16);
  if ((head & 0xfe00) === 0xfc00) return true;                        // fc00::/7 unique-local
  if ((head & 0xffc0) === 0xfe80) return true;                        // fe80::/10 link-local
  if ((head & 0xff00) === 0xff00) return true;                        // ff00::/8 multicast
  return false;
}

async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AhError({ code: 'invalid_source_url', message: `source_url is not a valid URL: ${raw}` });
  }
  if (url.protocol !== 'https:') {
    throw new AhError({
      code: 'invalid_source_url',
      message: 'source_url must be https.',
      suggestion: 'Host the file over https, or use the presigned mode and upload the bytes directly.',
    });
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(url.hostname, { all: true });
  } catch {
    throw new AhError({
      code: 'invalid_source_url',
      message: `Could not resolve the host in source_url: ${url.hostname}`,
    });
  }
  if (addresses.length === 0 || addresses.some((a) => isBlockedAddress(a.address))) {
    throw new AhError({
      code: 'invalid_source_url',
      message: `source_url resolves to a non-public address (${url.hostname}). Refusing to fetch it.`,
      suggestion: 'Use a publicly reachable https URL, or the presigned mode.',
    });
  }
  return url;
}

// --- transports --------------------------------------------------------------

type FetchLike = typeof fetch;

function fetchOf(ctx: ToolContext): FetchLike {
  return ctx.fetchImpl ?? fetch;
}

async function fetchSourceBytes(ctx: ToolContext, sourceUrl: string): Promise<Uint8Array> {
  const doFetch = fetchOf(ctx);
  let current = sourceUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const url = await assertPublicUrl(current); // re-validated every hop
    const res = await doFetch(url.toString(), {
      method: 'GET',
      redirect: 'manual',
      signal: ctx.signal,
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) {
        throw new AhError({ code: 'source_fetch_failed', message: `source_url returned ${res.status} with no redirect target.` });
      }
      current = new URL(location, url).toString();
      continue;
    }
    if (!res.ok) {
      throw new AhError({
        code: 'source_fetch_failed',
        message: `Could not fetch source_url (HTTP ${res.status}).`,
        suggestion: 'Check the link is publicly readable — a share link that requires sign-in will not work.',
      });
    }

    const declared = Number.parseInt(res.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
      throw new AhError({
        code: 'file_too_large',
        message: `That file is ${(declared / 1024 / 1024).toFixed(1)}MB; the limit is 50MB.`,
      });
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      throw new AhError({
        code: 'file_too_large',
        message: `That file is ${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB; the limit is 50MB.`,
      });
    }
    if (bytes.byteLength === 0) {
      throw new AhError({ code: 'source_fetch_failed', message: 'source_url returned an empty body.' });
    }
    return bytes;
  }

  throw new AhError({
    code: 'source_fetch_failed',
    message: `source_url redirected more than ${MAX_REDIRECTS} times.`,
  });
}

function decodeBase64(raw: string): Uint8Array {
  // Tolerate a data: URI wrapper — agents paste them constantly.
  const payload = raw.startsWith('data:') ? (raw.split(',', 2)[1] ?? '') : raw;
  let buf: Buffer;
  try {
    buf = Buffer.from(payload.replace(/\s+/g, ''), 'base64');
  } catch {
    throw new AhError({ code: 'invalid_base64', message: 'image_base64 is not valid base64.' });
  }
  if (buf.byteLength === 0) {
    throw new AhError({ code: 'invalid_base64', message: 'image_base64 decoded to zero bytes.' });
  }
  if (buf.byteLength > MAX_BASE64_BYTES) {
    throw new AhError({
      code: 'file_too_large',
      message: `Inline base64 is capped at ${MAX_BASE64_BYTES / 1024 / 1024}MB decoded (this was ${(buf.byteLength / 1024 / 1024).toFixed(1)}MB).`,
      suggestion:
        'Use source_url if the file is reachable over https, or call upload_design with no source to get a presigned URL and PUT the bytes yourself. Both avoid spending context on the file.',
    });
  }
  return new Uint8Array(buf);
}

async function putToPresigned(
  ctx: ToolContext,
  uploadUrl: string,
  bytes: Uint8Array,
  contentType: ContentType,
): Promise<void> {
  const doFetch = fetchOf(ctx);
  // Deliberately a bare fetch: this is S3, not the ApparelHub API. Sending our
  // API key here would leak it to a third party, and S3 rejects unexpected
  // headers that were not part of the signature.
  const res = await doFetch(uploadUrl, {
    method: 'PUT',
    // Uint8Array.from gives an ArrayBuffer-backed view, which is a valid body
    // under TS 6's narrowed BodyInit (same shape design.ts uses for Blob parts).
    body: Uint8Array.from(bytes),
    headers: { 'Content-Type': contentType },
    signal: ctx.signal,
  });
  if (!res.ok) {
    throw new AhError({
      code: 'upload_failed',
      message: `Storage rejected the file upload (HTTP ${res.status}).`,
      suggestion:
        res.status === 403
          ? 'The presigned URL expires 15 minutes after it is issued, and the Content-Type on the PUT must match the one declared at initiate. Start again with a fresh upload_design call.'
          : 'Retry the upload; if it keeps failing, start again with a fresh upload_design call.',
    });
  }
}

// --- status polling ----------------------------------------------------------

interface UploadOutcome {
  design_uuid: string;
  processing_status: string;
  url?: string;
  title?: string;
  low_res_upscaled?: Record<string, unknown>;
  rasterized_from_svg?: Record<string, unknown>;
}

function readStatus(raw: unknown, uuid: string): UploadOutcome {
  const status = str(raw, 'processing_status', 'status') ?? 'unknown';
  const out: UploadOutcome = { design_uuid: uuid, processing_status: status };
  const url = str(raw, 'url', 'image_url');
  if (url) out.url = url;
  const title = str(raw, 'title');
  if (title) out.title = title;
  const lru = isRecord(raw) ? raw.low_res_upscaled : undefined;
  if (isRecord(lru)) out.low_res_upscaled = lru;
  const svg = isRecord(raw) ? raw.rasterized_from_svg : undefined;
  if (isRecord(svg)) out.rasterized_from_svg = svg;
  return out;
}

async function completeAndPoll(
  ctx: ToolContext,
  imageUuid: string,
  workspace: string | undefined,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
): Promise<UploadOutcome> {
  const path = `images/upload/${encodeURIComponent(imageUuid)}`;
  try {
    await ctx.api.post(`${path}/complete`, { workspace, signal: ctx.signal });
  } catch (err) {
    // 404 here means "already processing" (the platform only accepts complete
    // once). That is the normal case when re-entering to resume a poll, so it is
    // not an error — anything else is.
    if (!(err instanceof AhError) || (err.code !== 'not_found' && err.code !== 'conflict')) throw err;
  }

  const deadline = now() + PROCESS_TIMEOUT_MS;
  for (;;) {
    const raw = await ctx.api.get(`${path}/status`, { workspace, signal: ctx.signal });
    const last = readStatus(raw, imageUuid);
    if (last.processing_status === 'completed') return last;
    if (last.processing_status === 'failed') {
      throw new AhError({
        code: 'upload_processing_failed',
        message: str(raw, 'error') ?? 'The platform could not process that image.',
        suggestion: 'Check the file opens as a valid PNG/JPEG/WEBP, then upload it again.',
      });
    }
    if (now() >= deadline) return last; // hand the poll back rather than hanging
    await sleep(POLL_INTERVAL_MS);
  }
}

// --- the tool ----------------------------------------------------------------

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const uploadDesign = defineTool({
  name: 'upload_design',
  description:
    "Upload artwork the merchant ALREADY OWNS and turn it into a design_uuid usable by " +
    'create_product / ship_product. This is the way to build products from a client\'s own ' +
    'files — a logo, a brand mark, a cleared cover, a photograph — instead of generating ' +
    'something new. If a client says their mark must not be redrawn, use this; never ' +
    'regenerate or approximate a mark to work around a missing file.\n\n' +
    'Three ways to supply the file, pick the cheapest one available:\n' +
    '1. `source_url` — an https URL the server can fetch. One call, no context cost. Best ' +
    'when the asset is already hosted or reachable by link (the link must not require sign-in).\n' +
    '2. no source at all — returns a presigned `upload_url` you PUT the bytes to yourself, then ' +
    'call this tool again with the returned `image_uuid` to finish. No context cost, full ' +
    'resolution, and the right choice whenever you can make an HTTP request (curl, fetch, ' +
    'requests).\n' +
    '3. `image_base64` — inline bytes. Works anywhere, but costs roughly 350k tokens per ' +
    'megabyte of file, so reserve it for small files when neither of the above is possible.\n\n' +
    'Accepts PNG, JPEG, WEBP and SVG. SVG is the BEST input for a logo or mark: it is ' +
    'rendered server-side at print resolution, so it stays crisp at any size. Two things ' +
    'must be true of the SVG first — text converted to outlines, and any linked image ' +
    'embedded — otherwise the upload is refused with instructions rather than silently ' +
    'losing that part of the artwork. For pixel art, or any hard-edge raster mark that must ' +
    'stay crisp, pass upscale="pixel" so a small file is enlarged without being smoothed.',
  inputSchema: z.object({
    source_url: z
      .string()
      .url()
      .optional()
      .describe('Public https URL of the artwork. The server fetches it. Must not require sign-in.'),
    image_base64: z
      .string()
      .optional()
      .describe(
        'Base64-encoded file bytes (a data: URI is accepted). Expensive in context — prefer source_url or the presigned mode. Capped at 4MB decoded.',
      ),
    image_uuid: z
      .string()
      .optional()
      .describe(
        'Finish a presigned upload: pass the image_uuid from a previous upload_design call after you have PUT the bytes. Also use this to resume polling if processing was still running.',
      ),
    filename: z.string().optional().describe('Original filename. Used for the default title.'),
    title: z.string().optional().describe('Display title for the design. Defaults to the filename stem.'),
    content_type: z
      .enum(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'])
      .optional()
      .describe(
        'Declared MIME type. Detected from the file when the bytes are supplied, so it is only needed for the presigned mode (defaults to image/png). Use image/svg+xml to upload vector.',
      ),
    upscale: z
      .enum(['auto', 'pixel', 'smooth'])
      .optional()
      .describe(
        'How to resample if the file is below the 512px print minimum. "pixel" = nearest-neighbour, keeps pixel art and hard-edge marks crisp. "smooth" = for photographic art. "auto" (default) detects. Pass "pixel" for a client mark that must not be approximated.',
      ),
    workspace: z.string().optional().describe('Workspace uuid (agency accounts).'),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    const ws = input.workspace;
    const sleep = ctx.sleepImpl ?? defaultSleep;
    const now = ctx.nowImpl ?? (() => Date.now());
    const warnings: string[] = [];

    // --- resume / finalize a presigned upload --------------------------------
    if (input.image_uuid && !input.source_url && !input.image_base64) {
      await ctx.progress.report(50, 'Finishing upload...');
      const outcome = await completeAndPoll(ctx, input.image_uuid, ws, sleep, now);
      return finish(outcome, warnings, 'presigned');
    }

    if (input.source_url && input.image_base64) {
      throw new AhError({
        code: 'bad_request',
        message: 'Pass source_url or image_base64, not both.',
      });
    }

    // --- no bytes: hand back a presigned URL ---------------------------------
    if (!input.source_url && !input.image_base64) {
      const contentType = (input.content_type ?? 'image/png') as ContentType;
      const filename = input.filename ?? `upload.${EXT_FOR[contentType]}`;
      const init = await ctx.api.post('images/upload/initiate', {
        body: {
          filename,
          content_type: contentType,
          ...(input.title ? { title: input.title } : {}),
          ...(input.upscale ? { upscale: input.upscale } : {}),
        },
        workspace: ws,
        signal: ctx.signal,
      });
      const uploadUrl = str(init, 'upload_url');
      const imageUuid = str(init, 'image_uuid', 'uuid');
      if (!uploadUrl || !imageUuid) {
        throw new AhError({ code: 'upstream_unexpected', message: 'The platform did not return an upload URL.' });
      }
      return {
        mode: 'presigned',
        upload_url: uploadUrl,
        image_uuid: imageUuid,
        expires_in: isRecord(init) && typeof init.expires_in === 'number' ? init.expires_in : 900,
        content_type: contentType,
        next_step:
          `PUT the file bytes to upload_url with header "Content-Type: ${contentType}" (for example: ` +
          `curl -X PUT -H "Content-Type: ${contentType}" --upload-file <path> "<upload_url>"), then call ` +
          `upload_design again with image_uuid="${imageUuid}" to finish and get the design_uuid.`,
      };
    }

    // --- bytes supplied: fetch or decode, then run the whole handshake -------
    await ctx.progress.report(10, input.source_url ? 'Fetching artwork...' : 'Decoding artwork...');
    const bytes = input.source_url
      ? await fetchSourceBytes(ctx, input.source_url)
      : decodeBase64(input.image_base64 as string);

    const detected: ContentType | undefined = sniffContentType(bytes) ?? (looksLikeSvg(bytes) ? 'image/svg+xml' : undefined);
    if (!detected) rejectUnsupportedFormat(bytes);
    if (input.content_type && input.content_type !== detected) {
      warnings.push(
        `The file is actually ${detected}, not the declared ${input.content_type}. Uploaded as ${detected}.`,
      );
    }

    const filename =
      input.filename ??
      (input.source_url ? guessFilename(input.source_url, detected) : `upload.${EXT_FOR[detected]}`);

    await ctx.progress.report(35, 'Reserving storage...');
    const init = await ctx.api.post('images/upload/initiate', {
      body: {
        filename,
        content_type: detected,
        file_size: bytes.byteLength,
        ...(input.title ? { title: input.title } : {}),
        ...(input.upscale ? { upscale: input.upscale } : {}),
      },
      workspace: ws,
      signal: ctx.signal,
    });
    const uploadUrl = str(init, 'upload_url');
    const imageUuid = str(init, 'image_uuid', 'uuid');
    if (!uploadUrl || !imageUuid) {
      throw new AhError({ code: 'upstream_unexpected', message: 'The platform did not return an upload URL.' });
    }

    await ctx.progress.report(60, 'Uploading artwork...');
    await putToPresigned(ctx, uploadUrl, bytes, detected);

    await ctx.progress.report(80, 'Processing...');
    const outcome = await completeAndPoll(ctx, imageUuid, ws, sleep, now);
    await ctx.progress.report(100, 'Upload complete.');
    return finish(outcome, warnings, input.source_url ? 'source_url' : 'base64', bytes.byteLength);
  },
});

function guessFilename(sourceUrl: string, contentType: ContentType): string {
  try {
    const base = new URL(sourceUrl).pathname.split('/').filter(Boolean).pop();
    if (base && /\.[a-z0-9]{2,5}$/i.test(base)) return decodeURIComponent(base);
  } catch {
    /* fall through to the default */
  }
  return `upload.${EXT_FOR[contentType]}`;
}

function finish(
  outcome: UploadOutcome,
  warnings: string[],
  transport: string,
  bytes?: number,
): Record<string, unknown> {
  const svg = outcome.rasterized_from_svg;
  if (svg) {
    warnings.push(
      `The SVG was rendered to a ${svg.width}x${svg.height} raster at print resolution. The design is now a raster — re-upload the SVG if you need it at a different size.`,
    );
  }
  const lru = outcome.low_res_upscaled;
  if (lru) {
    const filter = typeof lru.filter === 'string' ? lru.filter : undefined;
    const from = `${lru.original_width}x${lru.original_height}`;
    if (filter === 'nearest') {
      warnings.push(
        `The artwork was ${from}, below the print minimum, so it was enlarged with nearest-neighbour — pixel edges were kept crisp rather than smoothed.`,
      );
    } else {
      warnings.push(
        `The artwork was ${from}, below the print minimum, so it was enlarged (smoothed). Enlarging cannot add detail. If this is pixel art or a hard-edge mark, re-upload with upscale="pixel"; otherwise supply a higher-resolution original.`,
      );
    }
  }

  if (outcome.processing_status !== 'completed') {
    return {
      status: 'processing',
      design_uuid: outcome.design_uuid,
      transport,
      warnings,
      next_step: `Still processing. Call upload_design again with image_uuid="${outcome.design_uuid}" to resume polling.`,
    };
  }

  return {
    status: 'completed',
    design_uuid: outcome.design_uuid,
    url: outcome.url,
    title: outcome.title,
    transport,
    ...(bytes !== undefined ? { bytes } : {}),
    warnings,
    next_step:
      'Pass design_uuid to ship_product (or create_product) exactly as you would a generated design.',
  };
}

export const uploadTools: ToolDef[] = [uploadDesign];

// Exposed for unit tests.
export const __test = { sniffContentType, looksLikeSvg, isBlockedAddress, guessFilename };

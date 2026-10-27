import { describe, it, expect } from 'vitest';
import { setProductImages, productTools } from '../src/tools/product.js';
import { ApiClient } from '../src/http/client.js';
import { fakeContext } from './helpers/ctx.js';
import { queueFetch, jsonResponse, noSleep, type RecordedCall } from './helpers/fakeFetch.js';

// Generic placeholders only (public repo): short ids, "Acme Co", example.test hosts.

/** An ApiClient over a queued sequence of Responses, recording each call. */
function apiWith(responses: Response[]): { api: ApiClient; calls: RecordedCall[] } {
  const { fetchImpl, calls } = queueFetch(responses);
  const api = new ApiClient({
    apiKey: 'k',
    baseUrl: 'https://api.example.test/agents/v1',
    userAgent: 't',
    fetchImpl,
    sleepImpl: noSleep,
  });
  return { api, calls };
}

/** The JSON body a recorded call actually sent. */
function sentBody(call: RecordedCall): Record<string, unknown> {
  return JSON.parse(String(call.init?.body ?? '{}')) as Record<string, unknown>;
}

const MOCKUP = 'https://cdn.example.test/mockup-front.png';
const PHOTO = 'https://cdn.example.test/lifestyle.png';

/** A product read, shaped like the platform's GET /product/{uuid}. */
function productRead(
  images: unknown[],
  version: number,
  cover = MOCKUP,
): Record<string, unknown> {
  return {
    uuid: 'p-1',
    name: 'Acme Co Tee',
    images,
    images_version: version,
    display_image: cover,
    // The deprecated flat mirror the platform still serves for back-compat.
    gallery_images: images.map((i) =>
      typeof i === 'string' ? i : (i as Record<string, unknown>).url,
    ),
  };
}

const MOCKUP_ENTRY = {
  url: MOCKUP,
  source: 'mockup',
  ai_generated: false,
  thumbnail_url: 'https://cdn.example.test/mockup-front-thumb.png',
  added_at: '2020-01-01T00:00:00Z',
};

describe('set_product_images', () => {
  it('is registered on the product tool set', () => {
    expect(productTools.map((t) => t.name)).toContain('set_product_images');
  });

  it('is not marked read-only', () => {
    expect(setProductImages.annotations?.readOnlyHint).not.toBe(true);
    expect(setProductImages.annotations?.openWorldHint).toBe(true);
  });

  it('documents that the list replaces rather than merges', () => {
    expect(setProductImages.description).toMatch(/REPLACES, IT DOES NOT MERGE/);
  });

  it('documents every channel image cap, since order decides what ships', () => {
    const d = setProductImages.description;
    expect(d).toMatch(/ORDER IS FUNCTIONAL/);
    expect(d).toMatch(/TikTok Shop takes 9/);
    expect(d).toMatch(/Wix 15/);
    expect(d).toMatch(/Shopify and WooCommerce are unlimited/);
    expect(d).toMatch(/TRUNCATE IN GALLERY ORDER/);
  });

  it('documents that ai_generated is independent of source and must not be guessed', () => {
    expect(setProductImages.description).toMatch(/Do not guess it from `source`/);
  });

  it('reads the product, then writes the gallery in the order given', async () => {
    const { api, calls } = apiWith([
      jsonResponse(200, productRead([MOCKUP_ENTRY], 3)),
      jsonResponse(200, {}),
      jsonResponse(
        200,
        productRead(
          [MOCKUP_ENTRY, { url: PHOTO, source: 'upload', ai_generated: true }],
          4,
        ),
      ),
    ]);

    const out = (await setProductImages.handler(
      {
        product_uuid: 'p-1',
        images: [
          { url: MOCKUP, source: 'mockup', ai_generated: false },
          { url: PHOTO, source: 'upload', ai_generated: true },
        ],
      },
      fakeContext(api),
    )) as Record<string, unknown>;

    // Read, write, re-read.
    expect(calls).toHaveLength(3);
    expect(calls[0].init?.method).toBe('GET');
    expect(calls[1].init?.method).toBe('PATCH');
    expect(calls[2].init?.method).toBe('GET');

    const body = sentBody(calls[1]);
    expect(body.gallery_images).toEqual([
      { url: MOCKUP, source: 'mockup', ai_generated: false },
      { url: PHOTO, source: 'upload', ai_generated: true },
    ]);

    expect(out.applied).toBe(true);
    expect(out.conflict).toBe(false);
    expect(out.image_count).toBe(2);
    expect(out.images_version).toBe(4);
    expect(out.product_url).toContain('p-1');
  });

  it('passes the version it just read as expected_images_version', async () => {
    const { api, calls } = apiWith([
      jsonResponse(200, productRead([MOCKUP_ENTRY], 7)),
      jsonResponse(200, {}),
      jsonResponse(200, productRead([MOCKUP_ENTRY], 8)),
    ]);

    await setProductImages.handler(
      { product_uuid: 'p-1', images: [{ url: MOCKUP, source: 'mockup' }] },
      fakeContext(api),
    );

    expect(sentBody(calls[1]).expected_images_version).toBe(7);
  });

  it('omits expected_images_version when the platform did not report one', async () => {
    // An older platform build that does not serve the token yet. Fabricating a
    // version would disable the very guard it exists to provide.
    const { api, calls } = apiWith([
      jsonResponse(200, { uuid: 'p-1', images: [MOCKUP_ENTRY] }),
      jsonResponse(200, {}),
      jsonResponse(200, { uuid: 'p-1', images: [MOCKUP_ENTRY] }),
    ]);

    await setProductImages.handler(
      { product_uuid: 'p-1', images: [{ url: MOCKUP, source: 'mockup' }] },
      fakeContext(api),
    );

    expect(sentBody(calls[1])).not.toHaveProperty('expected_images_version');
  });

  it('defaults source to unknown and ai_generated to null rather than guessing', async () => {
    const { api, calls } = apiWith([
      jsonResponse(200, productRead([], 1)),
      jsonResponse(200, {}),
      jsonResponse(200, productRead([{ url: PHOTO, source: 'unknown' }], 2)),
    ]);

    await setProductImages.handler(
      { product_uuid: 'p-1', images: [{ url: PHOTO }] },
      fakeContext(api),
    );

    expect(sentBody(calls[1]).gallery_images).toEqual([
      { url: PHOTO, source: 'unknown', ai_generated: null },
    ]);
  });

  it('sends ai_generated: false as false, not as null', async () => {
    // false ("stated: not AI") and null ("nobody said") are different claims.
    const { api, calls } = apiWith([
      jsonResponse(200, productRead([], 1)),
      jsonResponse(200, {}),
      jsonResponse(200, productRead([{ url: PHOTO, source: 'upload' }], 2)),
    ]);

    await setProductImages.handler(
      { product_uuid: 'p-1', images: [{ url: PHOTO, source: 'upload', ai_generated: false }] },
      fakeContext(api),
    );

    const sent = (sentBody(calls[1]).gallery_images as Record<string, unknown>[])[0];
    expect(sent.ai_generated).toBe(false);
  });

  it('sends gallery_images: null to reset to the provider mockups', async () => {
    const { api, calls } = apiWith([
      jsonResponse(200, productRead([{ url: PHOTO, source: 'upload' }], 5)),
      jsonResponse(200, {}),
      jsonResponse(200, productRead([MOCKUP_ENTRY], 6)),
    ]);

    await setProductImages.handler(
      { product_uuid: 'p-1', images: null },
      fakeContext(api),
    );

    expect(sentBody(calls[1]).gallery_images).toBeNull();
  });

  it('sets the cover alone without touching the gallery', async () => {
    const { api, calls } = apiWith([
      jsonResponse(200, productRead([MOCKUP_ENTRY], 2)),
      jsonResponse(200, {}),
      jsonResponse(200, productRead([MOCKUP_ENTRY], 3, PHOTO)),
    ]);

    const out = (await setProductImages.handler(
      { product_uuid: 'p-1', cover: PHOTO },
      fakeContext(api),
    )) as Record<string, unknown>;

    const body = sentBody(calls[1]);
    expect(body.display_image).toBe(PHOTO);
    expect(body).not.toHaveProperty('gallery_images');
    expect(out.cover).toBe(PHOTO);
  });

  it('reports the cover the platform actually stored, not the one requested', async () => {
    // The platform moves the cover to the new first image when the gallery is
    // replaced without naming one. Echoing the request would misreport that.
    const { api } = apiWith([
      jsonResponse(200, productRead([MOCKUP_ENTRY], 1, MOCKUP)),
      jsonResponse(200, {}),
      jsonResponse(200, productRead([{ url: PHOTO, source: 'upload' }], 2, PHOTO)),
    ]);

    const out = (await setProductImages.handler(
      { product_uuid: 'p-1', images: [{ url: PHOTO, source: 'upload' }] },
      fakeContext(api),
    )) as Record<string, unknown>;

    expect(out.cover).toBe(PHOTO);
  });

  it('normalizes the deprecated flat URL list into entries with unknown provenance', async () => {
    const { api } = apiWith([
      jsonResponse(200, { uuid: 'p-1', gallery_images: [MOCKUP], images_version: 1 }),
      jsonResponse(200, {}),
      jsonResponse(200, { uuid: 'p-1', gallery_images: [MOCKUP, PHOTO], images_version: 2 }),
    ]);

    const out = (await setProductImages.handler(
      { product_uuid: 'p-1', images: [{ url: MOCKUP }, { url: PHOTO }] },
      fakeContext(api),
    )) as Record<string, unknown>;

    expect(out.images).toEqual([
      { url: MOCKUP, source: 'unknown', ai_generated: null },
      { url: PHOTO, source: 'unknown', ai_generated: null },
    ]);
  });

  it('reports a missing ai_generated as null rather than false when reading back', async () => {
    const { api } = apiWith([
      jsonResponse(200, productRead([], 1)),
      jsonResponse(200, {}),
      jsonResponse(200, productRead([{ url: PHOTO, source: 'upload' }], 2)),
    ]);

    const out = (await setProductImages.handler(
      { product_uuid: 'p-1', images: [{ url: PHOTO, source: 'upload' }] },
      fakeContext(api),
    )) as Record<string, unknown>;

    const first = (out.images as Record<string, unknown>[])[0];
    expect(first.ai_generated).toBeNull();
  });

  describe('version conflict', () => {
    it('re-reads and reports the current state instead of retrying', async () => {
      const { api, calls } = apiWith([
        jsonResponse(200, productRead([MOCKUP_ENTRY], 3)),
        jsonResponse(409, {
          error_code: 'images_version_conflict',
          message: 'images_version_conflict',
          current_version: 9,
          expected_version: 3,
        }),
        // The re-read: somebody else's gallery.
        jsonResponse(200, productRead([{ url: PHOTO, source: 'upload', ai_generated: true }], 9, PHOTO)),
      ]);

      const out = (await setProductImages.handler(
        { product_uuid: 'p-1', images: [{ url: MOCKUP, source: 'mockup' }] },
        fakeContext(api),
      )) as Record<string, unknown>;

      expect(out.conflict).toBe(true);
      expect(out.applied).toBe(false);
      expect(out.expected_images_version).toBe(3);
      expect(out.current_images_version).toBe(9);
      expect(out.current_cover).toBe(PHOTO);
      expect(out.current_images).toEqual([
        expect.objectContaining({ url: PHOTO, source: 'upload', ai_generated: true }),
      ]);

      // read, failed write, re-read — and crucially NO second PATCH.
      expect(calls).toHaveLength(3);
      expect(calls.filter((c) => c.init?.method === 'PATCH')).toHaveLength(1);
    });

    it('does not silently clobber: the conflict result is a refusal, not a success', async () => {
      const { api } = apiWith([
        jsonResponse(200, productRead([MOCKUP_ENTRY], 1)),
        jsonResponse(409, { error_code: 'images_version_conflict', message: 'stale version' }),
        jsonResponse(200, productRead([{ url: PHOTO, source: 'upload' }], 2, PHOTO)),
      ]);

      const out = (await setProductImages.handler(
        { product_uuid: 'p-1', images: [{ url: MOCKUP, source: 'mockup' }] },
        fakeContext(api),
      )) as Record<string, unknown>;

      expect(out.applied).toBe(false);
      expect(String(out.message)).toMatch(/nothing was written/i);
      expect(String(out.suggestion)).toMatch(/current_images/);
    });

    it('detects the conflict when the code arrives under `error` rather than `error_code`', async () => {
      // The repo's HTTP mapper reads `error`; this contract documents `error_code`.
      // Either spelling has to be recognised or the guard silently stops working.
      const { api } = apiWith([
        jsonResponse(200, productRead([MOCKUP_ENTRY], 1)),
        jsonResponse(409, { error: 'images_version_conflict', message: 'stale' }),
        jsonResponse(200, productRead([MOCKUP_ENTRY], 2)),
      ]);

      const out = (await setProductImages.handler(
        { product_uuid: 'p-1', images: [{ url: MOCKUP, source: 'mockup' }] },
        fakeContext(api),
      )) as Record<string, unknown>;

      expect(out.conflict).toBe(true);
    });

    it('rethrows an unrelated 409 rather than swallowing it as a version conflict', async () => {
      const { api } = apiWith([
        jsonResponse(200, productRead([MOCKUP_ENTRY], 1)),
        jsonResponse(409, { error: 'product_locked', message: 'This product is locked.' }),
      ]);

      await expect(
        setProductImages.handler(
          { product_uuid: 'p-1', images: [{ url: MOCKUP, source: 'mockup' }] },
          fakeContext(api),
        ),
      ).rejects.toThrow(/locked/i);
    });
  });

  describe('input validation', () => {
    it('refuses a call that changes nothing', async () => {
      const { api } = apiWith([]);
      await expect(
        setProductImages.handler({ product_uuid: 'p-1' }, fakeContext(api)),
      ).rejects.toThrow(/Nothing to change/i);
    });

    it('refuses a duplicated image URL, naming it, without calling the API', async () => {
      const { api, calls } = apiWith([]);
      await expect(
        setProductImages.handler(
          {
            product_uuid: 'p-1',
            images: [
              { url: PHOTO, source: 'upload' },
              { url: PHOTO, source: 'mockup' },
            ],
          },
          fakeContext(api),
        ),
      ).rejects.toThrow(new RegExp(PHOTO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      expect(calls).toHaveLength(0);
    });

    it('rejects more than 20 images at the schema boundary', () => {
      const images = Array.from({ length: 21 }, (_, i) => ({
        url: `https://cdn.example.test/i${i}.png`,
      }));
      const parsed = setProductImages.inputSchema.safeParse({ product_uuid: 'p-1', images });
      expect(parsed.success).toBe(false);
    });

    it('accepts exactly 20 images', () => {
      const images = Array.from({ length: 20 }, (_, i) => ({
        url: `https://cdn.example.test/i${i}.png`,
      }));
      expect(
        setProductImages.inputSchema.safeParse({ product_uuid: 'p-1', images }).success,
      ).toBe(true);
    });

    it('rejects a URL longer than 512 characters', () => {
      const url = `https://cdn.example.test/${'a'.repeat(520)}.png`;
      expect(
        setProductImages.inputSchema.safeParse({ product_uuid: 'p-1', images: [{ url }] }).success,
      ).toBe(false);
    });

    it('rejects a source outside the platform enum', () => {
      const parsed = setProductImages.inputSchema.safeParse({
        product_uuid: 'p-1',
        images: [{ url: PHOTO, source: 'lifestyle' }],
      });
      expect(parsed.success).toBe(false);
    });

    it('accepts every source the platform defines', () => {
      for (const source of ['mockup', 'upload', 'ai_mockup', 'print_file', 'unknown']) {
        expect(
          setProductImages.inputSchema.safeParse({
            product_uuid: 'p-1',
            images: [{ url: PHOTO, source }],
          }).success,
        ).toBe(true);
      }
    });

    it('accepts ai_generated as true, false, or null', () => {
      for (const ai of [true, false, null]) {
        expect(
          setProductImages.inputSchema.safeParse({
            product_uuid: 'p-1',
            images: [{ url: PHOTO, ai_generated: ai }],
          }).success,
        ).toBe(true);
      }
    });
  });
});

import { describe, it, expect } from 'vitest';
import { generateListingImage, productTools } from '../src/tools/product.js';
import { ApiClient } from '../src/http/client.js';
import { fakeContext } from './helpers/ctx.js';
import { queueFetch, jsonResponse, noSleep, type RecordedCall } from './helpers/fakeFetch.js';

// Generic placeholders only (public repo): short ids, "Acme Co", example.test hosts.

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

function sentBody(call: RecordedCall): Record<string, unknown> {
  return JSON.parse(String(call.init?.body ?? '{}')) as Record<string, unknown>;
}

const PHOTO = 'https://cdn.example.test/on-model.png';

/** A synchronous generation success (image inline, no polling). */
function generated(url = PHOTO): Response {
  return jsonResponse(200, {
    generated_image: { uuid: 'img-1', url, processing_status: 'completed' },
  });
}

describe('generate_listing_image', () => {
  it('is registered on the product tool surface', () => {
    expect(productTools.map((t) => t.name)).toContain('generate_listing_image');
  });

  it('sends the product and style, and NO prompt when no guidance is given', async () => {
    // The preset supplies the prompt. Filler would be folded into the merchant's real prompt as
    // extra guidance rather than ignored, so the field must be absent, not empty.
    const { api, calls } = apiWith([generated()]);
    await generateListingImage.handler(
      { product_uuid: 'p-1', style: 'on_model' },
      fakeContext(api),
    );

    const body = sentBody(calls[0]!);
    expect(body.source_product_uuid).toBe('p-1');
    expect(body.style).toBe('on_model');
    expect('prompt' in body).toBe(false);
  });

  it('passes guidance through as the prompt when supplied', async () => {
    const { api, calls } = apiWith([generated()]);
    await generateListingImage.handler(
      { product_uuid: 'p-1', style: 'lifestyle', guidance: 'outdoors at golden hour' },
      fakeContext(api),
    );

    expect(sentBody(calls[0]!).prompt).toBe('outdoors at golden hour');
  });

  it('only ever picks an edit-capable model', async () => {
    // This is an edit of the product's mockup. A text-to-image-only model can never satisfy it,
    // so it must not appear as the primary or as a fallback rung.
    const { api, calls } = apiWith([generated()]);
    await generateListingImage.handler(
      { product_uuid: 'p-1', style: 'detail' },
      fakeContext(api),
    );

    expect(sentBody(calls[0]!).source).not.toBe('Google Imagen 4');
    expect(sentBody(calls[0]!).source).not.toBe('Flux 1.1 Pro');
  });

  it('does NOT attach by default, and says what to do next', async () => {
    const { api, calls } = apiWith([generated()]);
    const out = (await generateListingImage.handler(
      { product_uuid: 'p-1', style: 'on_model' },
      fakeContext(api),
    )) as Record<string, unknown>;

    expect(out.attached).toBe(false);
    expect(out.image_url).toBe(PHOTO);
    expect(String(out.next_step)).toMatch(/attach/i);
    // Exactly one call: generation. Nothing reached the storefront.
    expect(calls).toHaveLength(1);
  });

  it('appends when asked, declaring ai_generated truthfully', async () => {
    const { api, calls } = apiWith([
      generated(),
      jsonResponse(200, {
        message: 'Image added to the product listing.',
        images: [{ url: PHOTO, source: 'ai_mockup', ai_generated: true }],
        images_version: 4,
        display_image: PHOTO,
      }),
    ]);
    const out = (await generateListingImage.handler(
      { product_uuid: 'p-1', style: 'on_model', attach: true, set_as_cover: true },
      fakeContext(api),
    )) as Record<string, unknown>;

    const attach = calls[1]!;
    expect(String(attach.url)).toContain('/product/p-1/listing-images');
    const body = sentBody(attach);
    expect(body.url).toBe(PHOTO);
    expect(body.source).toBe('ai_mockup');
    // The one path where the client actually knows: it just generated this image.
    expect(body.ai_generated).toBe(true);
    expect(body.image_uuid).toBe('img-1');
    expect(body.set_as_cover).toBe(true);
    expect(out.attached).toBe(true);
    expect(out.images_version).toBe(4);
  });

  it('uses the APPEND endpoint, never the replace-the-gallery one', async () => {
    // set_product_images replaces the whole gallery; routing an append through it would delete
    // every other listing image.
    const { api, calls } = apiWith([
      generated(),
      jsonResponse(200, { images: [], images_version: 2, display_image: PHOTO }),
    ]);
    await generateListingImage.handler(
      { product_uuid: 'p-1', style: 'flat_lay', attach: true },
      fakeContext(api),
    );

    expect(String(calls[1]!.url)).toContain('/listing-images');
    expect(String(calls[1]!.init?.method ?? 'GET')).toBe('POST');
  });

  it('turns the no-mockup refusal into an actionable error', async () => {
    // The likeliest refusal. A generic validation failure would leave an agent with no next move.
    const { api } = apiWith([
      jsonResponse(400, {
        message:
          'This product has no mockup to generate listing imagery from. Generate a mockup '
          + 'preview first.',
      }),
    ]);

    await expect(
      generateListingImage.handler(
        { product_uuid: 'p-1', style: 'on_model' },
        fakeContext(api),
      ),
    ).rejects.toMatchObject({
      code: 'product_has_no_mockup',
      suggestion: expect.stringMatching(/mockup preview/i),
    });
  });

  it('passes source_image_url through only when given', async () => {
    const { api, calls } = apiWith([generated()]);
    await generateListingImage.handler(
      { product_uuid: 'p-1', style: 'detail' },
      fakeContext(api),
    );
    expect('source_image_url' in sentBody(calls[0]!)).toBe(false);

    const two = apiWith([generated()]);
    await generateListingImage.handler(
      { product_uuid: 'p-1', style: 'detail', source_image_url: 'https://cdn.example.test/m.png' },
      fakeContext(two.api),
    );
    expect(sentBody(two.calls[0]!).source_image_url).toBe('https://cdn.example.test/m.png');
  });

  it('reports that it spent a generation', async () => {
    // Four styles across thirty products is 120 generations; an agent needs this to reason about
    // a bulk loop before starting one.
    const { api } = apiWith([generated()]);
    const out = (await generateListingImage.handler(
      { product_uuid: 'p-1', style: 'on_model' },
      fakeContext(api),
    )) as Record<string, unknown>;
    expect(out.metered).toBe('image_generation');
  });
});

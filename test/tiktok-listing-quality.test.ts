import { describe, it, expect } from 'vitest';
import { diagnoseTiktokListings, updateProduct } from '../src/tools/product.js';
import { fakeContext } from './helpers/ctx.js';
import { apiRecording } from './helpers/fakeFetch.js';

// The TikTok listing-quality loop (apparelhub-ai#950). Two properties matter
// most here and both are about blast radius:
//   - a bare call is a READ, never a write;
//   - applying TikTok's copy recommendations goes through a TikTok-only
//     override, so it cannot rewrite the shared product record (which would
//     change the Shopify/WooCommerce/Wix listings too).

const diagnosis = {
  integration_uuid: 'int-1',
  products: [
    {
      product_uuid: 'prod-1',
      product_name: 'Cool Tee',
      external_id: '123456',
      diagnosable: true,
      tier: 'POOR',
      remaining_recommendations: 3,
      issues: [
        {
          field: 'TITLE',
          code: 'TITLE_LESS_THAN_40_CHARACTERS',
          how_to_solve: 'Names must be at least 40 characters long.',
          reaches_tier: 'GOOD',
        },
      ],
      recommended: {
        search_terms: ['graphic tee', 'cotton tee'],
        titles: ['A much better, longer, more descriptive title'],
        descriptions: [],
        image: null,
      },
    },
  ],
  unavailable: {},
};

describe('diagnose_tiktok_listings', () => {
  it('is a read when no apply is given', async () => {
    const { api, calls } = apiRecording(diagnosis);
    const out = (await diagnoseTiktokListings.handler(
      { store_uuid: 'store-1' },
      fakeContext(api),
    )) as Record<string, unknown>;

    expect(calls[0].init?.method ?? 'GET').toBe('GET');
    expect(calls[0].url).toContain('store/store-1/tiktok/listing-quality');
    expect((out.products as unknown[]).length).toBe(1);
  });

  it('filters server-side so TikTok is only asked about the listings requested', async () => {
    const { api, calls } = apiRecording(diagnosis);
    await diagnoseTiktokListings.handler(
      { store_uuid: 'store-1', product_uuids: ['prod-1', 'prod-2'] },
      fakeContext(api),
    );
    // Not a client-side filter: diagnosing a whole catalog to then discard most
    // of it would burn the channel's rate limit for nothing.
    expect(decodeURIComponent(calls[0].url)).toContain('product_uuids=prod-1,prod-2');
  });

  it('surfaces the tier, the machine-readable issues and the recommended values', async () => {
    const { api } = apiRecording(diagnosis);
    const out = (await diagnoseTiktokListings.handler(
      { store_uuid: 'store-1' },
      fakeContext(api),
    )) as { products: Record<string, unknown>[] };

    const p = out.products[0] as Record<string, any>;
    expect(p.tier).toBe('POOR');
    expect(p.issues[0].code).toBe('TITLE_LESS_THAN_40_CHARACTERS');
    // reaches_tier is what THIS fix unlocks, not the current grade.
    expect(p.issues[0].reaches_tier).toBe('GOOD');
    expect(p.recommended.search_terms).toEqual(['graphic tee', 'cotton tee']);
  });

  it('posts to the optimize route only when apply is given', async () => {
    const { api, calls } = apiRecording({ applied_count: 1, results: [] });
    await diagnoseTiktokListings.handler(
      { store_uuid: 'store-1', apply: ['search_terms'] },
      fakeContext(api),
    );
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].url).toContain('/tiktok/listing-quality/optimize');
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      fields: ['search_terms'],
      dry_run: false,
    });
  });

  it('passes dry_run through so a caller can preview the changes', async () => {
    const { api, calls } = apiRecording({ applied_count: 0, results: [] });
    await diagnoseTiktokListings.handler(
      { store_uuid: 'store-1', apply: ['title'], dry_run: true },
      fakeContext(api),
    );
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      fields: ['title'],
      dry_run: true,
    });
  });

  it('rejects a field it cannot apply rather than sending it on', () => {
    const parsed = diagnoseTiktokListings.inputSchema.safeParse({
      store_uuid: 's',
      apply: ['price'],
    });
    expect(parsed.success).toBe(false);
  });
});

describe('update_product tiktok_listing overrides', () => {
  it('sends title/description as TikTok-only overrides, not as product fields', async () => {
    const { api, calls } = apiRecording({ uuid: 'prod-1' });
    await updateProduct.handler(
      {
        product_uuid: 'prod-1',
        changes: {
          tiktok_listing: {
            title: 'A much better, longer, more descriptive title',
            search_terms: ['graphic tee'],
          },
        },
      },
      fakeContext(api),
    );

    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.tiktok_listing.title).toBe('A much better, longer, more descriptive title');
    // The shared product name must NOT be touched — that is what keeps a
    // TikTok-optimized title off the merchant's other sales channels.
    expect(body.name).toBeUndefined();
    expect(body.description).toBeUndefined();
  });
});

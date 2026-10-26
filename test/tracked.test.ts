import { describe, it, expect } from 'vitest';
import {
  importChannelCatalog,
  getCatalogImportRun,
  listTrackedListings,
  bindTrackedListing,
  unbindTrackedListing,
  trackedListingTools,
} from '../src/tools/tracked.js';
import { allTools } from '../src/tools/index.js';
import { ApiClient } from '../src/http/client.js';
import { AhError } from '../src/errors.js';
import { fakeContext } from './helpers/ctx.js';
import { jsonResponse, queueFetch, noSleep } from './helpers/fakeFetch.js';

// Generic placeholders only (public repo): short ids, "Acme Apparel".

function client(responses: Response[]) {
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

const RUN = {
  uuid: 'run-1',
  integration_uuid: 'int-1',
  status: 'queued',
  pages: 0,
  seen: 0,
  created: 0,
  updated: 0,
  ours: 0,
  removed: 0,
  images_fetched: 0,
  error: null,
  started_at: '2026-10-22T12:00:00',
  finished_at: null,
};

describe('import_channel_catalog', () => {
  it('POSTs to the integration import route and returns the run to poll', async () => {
    const { api, calls } = client([
      jsonResponse(202, { run: RUN, message: 'Catalog import started.' }),
    ]);
    const res = (await importChannelCatalog.handler(
      { store_uuid: 's-1', integration_uuid: 'int-1' },
      fakeContext(api),
    )) as Record<string, any>;
    expect(calls[0].url).toBe(
      'https://api.example.test/agents/v1/store/s-1/ecommerce/integration/int-1/catalog/import',
    );
    expect(calls[0].init?.method).toBe('POST');
    expect(res.already_running).toBe(false);
    expect(res.run.run_uuid).toBe('run-1');
    expect(res.run.status).toBe('queued');
    expect(res.next_step).toContain('get_catalog_import_run');
    expect(res.note).toMatch(/Nothing is written to the merchant's store/);
  });

  it('returns the RUNNING run on 409 import_in_progress instead of erroring', async () => {
    const running = { ...RUN, uuid: 'run-0', status: 'running', pages: 3, seen: 150 };
    const { api, calls } = client([
      jsonResponse(409, {
        error: 'import_in_progress',
        message: 'An import for this channel is already running.',
        run: running,
      }),
      jsonResponse(200, {
        listings: [],
        total: 0,
        limit: 1,
        offset: 0,
        channels: [
          { integration_uuid: 'int-2', channel: 'WooCommerce', catalog_read: true, last_run: null },
          {
            integration_uuid: 'int-1',
            channel: 'TikTok Shop',
            catalog_read: true,
            last_run: running,
          },
        ],
      }),
    ]);
    const res = (await importChannelCatalog.handler(
      { store_uuid: 's-1', integration_uuid: 'int-1' },
      fakeContext(api),
    )) as Record<string, any>;
    expect(res.already_running).toBe(true);
    expect(res.run.run_uuid).toBe('run-0');
    expect(res.run.seen).toBe(150);
    expect(res.next_step).toContain('Poll get_catalog_import_run');
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain('/store/s-1/catalog?');
    expect(calls[1].url).toContain('integration=int-1');
  });

  it('turns catalog_read_unsupported into a specific, non-retry error', async () => {
    const { api } = client([
      jsonResponse(409, {
        error: 'catalog_read_unsupported',
        message: 'Shopify catalog import is not available yet.',
      }),
    ]);
    const err = await importChannelCatalog
      .handler({ store_uuid: 's-1', integration_uuid: 'int-3' }, fakeContext(api))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AhError);
    expect((err as AhError).code).toBe('catalog_read_unsupported');
    expect((err as AhError).suggestion).toMatch(/Do not retry/);
  });

  it('turns integration_inactive into a reconnect instruction', async () => {
    const { api } = client([
      jsonResponse(409, {
        error: 'integration_inactive',
        message: 'Reconnect this sales channel before importing its catalog.',
      }),
    ]);
    const err = (await importChannelCatalog
      .handler({ store_uuid: 's-1', integration_uuid: 'int-1' }, fakeContext(api))
      .catch((e: unknown) => e)) as AhError;
    expect(err.code).toBe('integration_inactive');
    expect(err.suggestion).toMatch(/reconnect/i);
  });

  it('turns wrong_workspace into a retry-with-workspace instruction, keeping the uuid', async () => {
    const { api } = client([
      jsonResponse(409, {
        error: 'wrong_workspace',
        message: "This store is in the 'Acme Co' workspace. Retry the same call with workspace=w2.",
        retry_with: { workspace: 'w2' },
      }),
    ]);
    const err = (await importChannelCatalog
      .handler({ store_uuid: 's-1', integration_uuid: 'int-1' }, fakeContext(api))
      .catch((e: unknown) => e)) as AhError;
    expect(err.code).toBe('wrong_workspace');
    expect(err.message).toContain('workspace=w2');
    expect(err.suggestion).toMatch(/workspace/);
  });

  it('leaves a 404 as not_found', async () => {
    const { api } = client([
      jsonResponse(404, { error: 'integration_not_found', message: 'Not connected.' }),
    ]);
    const err = (await importChannelCatalog
      .handler({ store_uuid: 's-1', integration_uuid: 'nope' }, fakeContext(api))
      .catch((e: unknown) => e)) as AhError;
    expect(err.code).toBe('not_found');
  });
});

describe('get_catalog_import_run', () => {
  it('reads the run and states a failure', async () => {
    const { api, calls } = client([
      jsonResponse(200, {
        run: { ...RUN, status: 'failed', pages: 2, seen: 80, error: 'Channel rejected the token.' },
      }),
    ]);
    const res = (await getCatalogImportRun.handler(
      { store_uuid: 's-1', run_uuid: 'run-1' },
      fakeContext(api),
    )) as Record<string, any>;
    expect(calls[0].url).toBe('https://api.example.test/agents/v1/store/s-1/catalog/runs/run-1');
    expect(res.run.status).toBe('failed');
    expect(res.run.error).toBe('Channel rejected the token.');
    expect(res.next_step).toMatch(/nothing was marked removed/);
  });
});

describe('list_tracked_listings', () => {
  it('passes filters through and maps listings + channels', async () => {
    const { api, calls } = client([
      jsonResponse(200, {
        listings: [
          {
            uuid: 'l-1',
            integration_uuid: 'int-1',
            channel: 'WooCommerce',
            external_id: 1234567,
            title: 'Acme Apparel Logo Tee',
            description: 'Soft tee.',
            image_url: 'https://shop.example.com/tee.jpg',
            price: 24.99,
            currency: 'USD',
            channel_status: 'live',
            product_sku: 'ACME-TEE',
            variants: [{ external_variant_id: '9', sku: 'ACME-TEE-M', title: 'M', price: 24.99 }],
            made_in_apparelhub: false,
            product_uuid: null,
            first_seen_at: '2026-10-22T12:00:00',
            last_seen_at: '2026-10-22T12:00:00',
            removed_at: null,
          },
        ],
        total: 1,
        limit: 50,
        offset: 0,
        channels: [
          { integration_uuid: 'int-1', channel: 'WooCommerce', catalog_read: true, last_run: RUN },
        ],
      }),
    ]);
    const res = (await listTrackedListings.handler(
      {
        store_uuid: 's-1',
        integration: 'int-1',
        scope: 'external',
        include_removed: true,
        limit: 50,
      },
      fakeContext(api),
    )) as Record<string, any>;
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/agents/v1/store/s-1/catalog');
    expect(url.searchParams.get('scope')).toBe('external');
    expect(url.searchParams.get('integration')).toBe('int-1');
    expect(url.searchParams.get('include_removed')).toBe('true');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(res.total).toBe(1);
    expect(res.listings[0].listing_uuid).toBe('l-1');
    expect(res.listings[0].made_in_apparelhub).toBe(false);
    expect(res.listings[0].variants[0].sku).toBe('ACME-TEE-M');
    expect(res.listings[0].external_id).toBe('1234567');
    expect(res.channels[0].catalog_read).toBe(true);
    expect(res.channels[0].last_run.run_uuid).toBe('run-1');
    expect(res.note).toMatch(/not ApparelHub products/);
  });

  it('does not send include_removed when false', async () => {
    const { api, calls } = client([jsonResponse(200, { listings: [], total: 0, channels: [] })]);
    await listTrackedListings.handler(
      { store_uuid: 's-1', include_removed: false },
      fakeContext(api),
    );
    expect(new URL(calls[0].url).searchParams.has('include_removed')).toBe(false);
  });

  it('rejects an out-of-range limit at the schema', () => {
    expect(listTrackedListings.inputSchema.safeParse({ store_uuid: 's', limit: 501 }).success).toBe(
      false,
    );
  });
});

describe('tool surface', () => {
  it('registers all three, read tools read-only and the import not destructive', () => {
    const names = new Set(allTools().map((t) => t.name));
    for (const t of trackedListingTools) expect(names.has(t.name)).toBe(true);
    expect(getCatalogImportRun.annotations?.readOnlyHint).toBe(true);
    expect(listTrackedListings.annotations?.readOnlyHint).toBe(true);
    expect(importChannelCatalog.annotations?.readOnlyHint).toBe(false);
    expect(importChannelCatalog.annotations?.destructiveHint).toBe(false);
    expect(importChannelCatalog.annotations?.openWorldHint).toBe(true);
  });

  it('every description tells the agent nothing is written to the store or fulfilled', () => {
    expect(importChannelCatalog.description).toMatch(/nothing is written to the merchant's store/i);
    expect(importChannelCatalog.description).toMatch(/fulfilled exactly as they are today/);
    expect(listTrackedListings.description).toMatch(/NOT APPARELHUB PRODUCTS/);
  });
});

describe('bind_tracked_listing / unbind_tracked_listing (#1332)', () => {
  const input = { store_uuid: 's1', listing_uuid: 'l1', product_uuid: 'p1' };

  it('previews first and stops with what is still unmapped', async () => {
    const { api, calls } = client([
      jsonResponse(200, {
        dry_run: true, ready: false,
        mapped: [{ external_variant_id: '901', variant_uuid: 'v1' }],
        unmapped: [{ external_variant_id: 'pink', title: 'Pink / XS' }],
        product_variants: [{ uuid: 'v1', color: 'Black', size: 'M' }],
      }),
    ]);
    const res = (await bindTrackedListing.handler(input, fakeContext(api))) as any;
    expect(res.bound).toBe(false);
    expect(res.unmapped).toEqual([{ external_variant_id: 'pink', title: 'Pink / XS' }]);
    expect(res.next_step).toMatch(/variant_map/);
    expect(calls).toHaveLength(1);                                  // never bound for real
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ product_uuid: 'p1', dry_run: true });
  });

  it('binds for real once the preview is ready, with the same map', async () => {
    const { api, calls } = client([
      jsonResponse(200, { dry_run: true, ready: true, mapped: [], unmapped: [], product_variants: [] }),
      jsonResponse(200, {
        binding: { product_uuid: 'p1', variants: [] },
        listing: { uuid: 'l1', bound: true, made_in_apparelhub: false, product_uuid: 'p1' },
      }),
    ]);
    const res = (await bindTrackedListing.handler({ ...input, variant_map: { pink: 'v1' } }, fakeContext(api))) as any;
    expect(res.bound).toBe(true);
    expect(res.listing.bound).toBe(true);
    expect(res.listing.made_in_apparelhub).toBe(false);
    const real = JSON.parse(String(calls[1].init?.body));
    expect(real).toEqual({ product_uuid: 'p1', variant_map: { pink: 'v1' } });  // no dry_run
    expect(calls[1].url).toMatch(/\/store\/s1\/catalog\/l1\/bind$/);
  });

  it('a blocked preview says how to fix it and does not bind', async () => {
    const { api, calls } = client([
      jsonResponse(200, { dry_run: true, ready: false, mapped: [], unmapped: [], product_variants: [],
        blocked: { error: 'product_not_synced_to_provider', message: 'Sync first.' } }),
    ]);
    const res = (await bindTrackedListing.handler(input, fakeContext(api))) as any;
    expect(res.bound).toBe(false);
    expect(res.next_step).toMatch(/sync_to_fulfillment/);
    expect(calls).toHaveLength(1);
  });

  it('turns a refusal into its next step', async () => {
    const { api } = client([
      jsonResponse(409, { error: 'listing_already_bound', message: 'That listing is already bound.' }),
    ]);
    await expect(bindTrackedListing.handler(input, fakeContext(api))).rejects.toMatchObject({
      code: 'listing_already_bound',
      suggestion: expect.stringMatching(/unbind_tracked_listing/),
    });
  });

  it('unbinds with DELETE', async () => {
    const { api, calls } = client([jsonResponse(200, { message: 'Unbound.' })]);
    const res = (await unbindTrackedListing.handler({ store_uuid: 's1', listing_uuid: 'l1' }, fakeContext(api))) as any;
    expect(res.unbound).toBe(true);
    expect(calls[0].init?.method).toBe('DELETE');
  });

  it('list_tracked_listings carries bound and binding', async () => {
    const { api } = client([jsonResponse(200, {
      listings: [{ uuid: 'l1', bound: true, made_in_apparelhub: false, product_uuid: 'p1',
        binding: { product_uuid: 'p1', product_name: 'Moonlit Tee', variants: [] } }],
      channels: [],
    })]);
    const res = (await listTrackedListings.handler({ store_uuid: 's1' }, fakeContext(api))) as any;
    expect(res.listings[0].bound).toBe(true);
    expect(res.listings[0].binding.product_name).toBe('Moonlit Tee');
  });
});

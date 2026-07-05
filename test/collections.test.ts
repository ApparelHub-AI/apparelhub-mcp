import { describe, it, expect } from 'vitest';
import {
  listCollections,
  getCollection,
  createCollection,
  updateCollection,
  deleteCollection,
  addProductsToCollection,
  removeProductFromCollection,
  syncCollection,
} from '../src/tools/collections.js';
import { ApiClient } from '../src/http/client.js';
import { fakeContext } from './helpers/ctx.js';
import { jsonResponse, queueFetch, noSleep } from './helpers/fakeFetch.js';

// Generic placeholders only (public repo — Rule 13): short ids + "Acme Co", never real data.

function apiReturning(raw: unknown): ApiClient {
  const { fetchImpl } = queueFetch([jsonResponse(200, raw)]);
  return new ApiClient({
    apiKey: 'k',
    baseUrl: 'https://api.example.test/agents/v1',
    userAgent: 't',
    fetchImpl,
    sleepImpl: noSleep,
  });
}

/** ApiClient that returns `raw` and records the calls (for method/path/body asserts). */
function apiRecording(raw: unknown) {
  const { fetchImpl, calls } = queueFetch([jsonResponse(200, raw)]);
  const api = new ApiClient({
    apiKey: 'k',
    baseUrl: 'https://api.example.test/agents/v1',
    userAgent: 't',
    fetchImpl,
    sleepImpl: noSleep,
  });
  return { api, calls };
}

describe('list_collections', () => {
  it('maps the backend `title` field to `name` and surfaces product_count + sync status', async () => {
    const raw = [
      {
        uuid: 'c1',
        title: 'Acme Co Summer',
        description: 'Warm-weather picks',
        product_count: 3,
        collection_type: 'custom',
        sort_order: 0,
        published: true,
        ecommerce_statuses: [
          {
            integration_uuid: 'i1',
            provider_name: 'Shopify',
            sync_status: 'Synced',
            external_id: 'gid://shopify/Collection/1',
          },
        ],
      },
    ];
    const res = (await listCollections.handler(
      { store_uuid: 's1' },
      fakeContext(apiReturning(raw)),
    )) as any;
    expect(res.total).toBe(1);
    expect(res.collections[0]).toMatchObject({
      collection_uuid: 'c1',
      name: 'Acme Co Summer',
      product_count: 3,
      published: true,
    });
    expect(res.collections[0].ecommerce_statuses[0]).toEqual({
      integration_uuid: 'i1',
      channel: 'Shopify',
      sync_status: 'Synced',
      external_id: 'gid://shopify/Collection/1',
    });
  });

  it('handles a {collections:[...]} envelope and passes workspace= through', async () => {
    const { api, calls } = apiRecording({ collections: [{ uuid: 'c2', title: 'Acme Co Kids' }] });
    const res = (await listCollections.handler(
      { store_uuid: 's1', workspace: 'w1' },
      fakeContext(api),
    )) as any;
    expect(res.total).toBe(1);
    expect(res.collections[0]).toMatchObject({ collection_uuid: 'c2', name: 'Acme Co Kids' });
    expect(calls[0]?.url).toContain('/store/s1/collections');
    expect(calls[0]?.url).toContain('workspace=w1');
    expect(calls[0]?.init?.method).toBe('GET');
  });
});

describe('get_collection', () => {
  it('returns the collection plus a light projection of its member products', async () => {
    const raw = {
      uuid: 'c1',
      title: 'Acme Co Summer',
      product_count: 1,
      products: [{ uuid: 'p1', name: 'Tank', display_image: 'https://cdn.example/p1.png', position: 1 }],
    };
    const { api, calls } = apiRecording(raw);
    const res = (await getCollection.handler(
      { store_uuid: 's1', collection_uuid: 'c1' },
      fakeContext(api),
    )) as any;
    expect(res.collection).toMatchObject({ collection_uuid: 'c1', name: 'Acme Co Summer' });
    expect(res.products[0]).toEqual({
      product_uuid: 'p1',
      name: 'Tank',
      display_image: 'https://cdn.example/p1.png',
      position: 1,
    });
    expect(calls[0]?.url).toContain('/store/s1/collections/c1');
    expect(calls[0]?.init?.method).toBe('GET');
  });
});

describe('create_collection', () => {
  it('POSTs to the collections path and sends the name as `title` (+ description)', async () => {
    const { api, calls } = apiRecording({ uuid: 'c9', title: 'Acme Co Winter' });
    const res = (await createCollection.handler(
      { store_uuid: 's1', name: 'Acme Co Winter', description: 'Cozy stuff' },
      fakeContext(api),
    )) as any;
    expect(res.collection).toMatchObject({ collection_uuid: 'c9', name: 'Acme Co Winter' });
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.url).toMatch(/\/store\/s1\/collections$/);
    const body = JSON.parse(calls[0]?.init?.body as string);
    expect(body.title).toBe('Acme Co Winter'); // backend field is `title`, not `name`
    expect(body.description).toBe('Cozy stuff');
    expect(body).not.toHaveProperty('name');
  });
});

describe('update_collection', () => {
  it('PATCHes and maps a name change to the `title` body field', async () => {
    const { api, calls } = apiRecording({ uuid: 'c1', title: 'Renamed' });
    const res = (await updateCollection.handler(
      { store_uuid: 's1', collection_uuid: 'c1', name: 'Renamed' },
      fakeContext(api),
    )) as any;
    expect(res.changes_applied).toEqual(['title']);
    expect(calls[0]?.init?.method).toBe('PATCH');
    expect(calls[0]?.url).toContain('/store/s1/collections/c1');
    const body = JSON.parse(calls[0]?.init?.body as string);
    expect(body.title).toBe('Renamed');
  });

  it('throws bad_request when no changes are provided', async () => {
    await expect(
      updateCollection.handler({ store_uuid: 's1', collection_uuid: 'c1' }, fakeContext(apiReturning({}))),
    ).rejects.toThrow(/No changes/i);
  });
});

describe('delete_collection', () => {
  it('sends a DELETE to the collection path', async () => {
    const { api, calls } = apiRecording({ message: 'Collection deleted successfully' });
    const res = (await deleteCollection.handler(
      { store_uuid: 's1', collection_uuid: 'c1' },
      fakeContext(api),
    )) as any;
    expect(res).toEqual({ collection_uuid: 'c1', deleted: true });
    expect(calls[0]?.init?.method).toBe('DELETE');
    expect(calls[0]?.url).toContain('/store/s1/collections/c1');
  });
});

describe('add_products_to_collection', () => {
  it('POSTs the product_uuids array to the .../products path', async () => {
    const { api, calls } = apiRecording({ message: '2 products added to collection' });
    const res = (await addProductsToCollection.handler(
      { store_uuid: 's1', collection_uuid: 'c1', product_uuids: ['p1', 'p2'] },
      fakeContext(api),
    )) as any;
    expect(res).toMatchObject({ collection_uuid: 'c1', message: '2 products added to collection' });
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.url).toContain('/store/s1/collections/c1/products');
    const body = JSON.parse(calls[0]?.init?.body as string);
    expect(body.product_uuids).toEqual(['p1', 'p2']); // confirmed body field name
  });
});

describe('remove_product_from_collection', () => {
  it('DELETEs the product-scoped path (no body)', async () => {
    const { api, calls } = apiRecording({ message: 'Product removed from collection' });
    const res = (await removeProductFromCollection.handler(
      { store_uuid: 's1', collection_uuid: 'c1', product_uuid: 'p1' },
      fakeContext(api),
    )) as any;
    expect(res).toMatchObject({ collection_uuid: 'c1', product_uuid: 'p1', removed: true });
    expect(calls[0]?.init?.method).toBe('DELETE');
    expect(calls[0]?.url).toContain('/store/s1/collections/c1/products/p1');
    expect(calls[0]?.init?.body).toBeUndefined();
  });
});

describe('sync_collection', () => {
  it('POSTs to .../sync with integration_uuid as a QUERY param and reports the result', async () => {
    const { api, calls } = apiRecording({
      message: 'Collection synced successfully',
      external_id: 'gid://shopify/Collection/1',
      products_added: 2,
      products_skipped: 1,
    });
    const res = (await syncCollection.handler(
      { store_uuid: 's1', collection_uuid: 'c1', integration_uuid: 'i1' },
      fakeContext(api),
    )) as any;
    expect(res).toMatchObject({
      collection_uuid: 'c1',
      integration_uuid: 'i1',
      external_id: 'gid://shopify/Collection/1',
      products_added: 2,
      products_skipped: 1,
    });
    expect(res.view_url).toBe('https://apparelhub.ai/stores/s1');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.url).toContain('/store/s1/collections/c1/sync');
    expect(calls[0]?.url).toContain('integration_uuid=i1'); // query param, not body
  });
});

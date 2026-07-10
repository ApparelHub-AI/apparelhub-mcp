import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveGarmentLayout,
  bundledLayoutResolver,
  _clearIntelligenceCacheForTests,
  type GeometryPlacement,
} from '../src/knowledge/intelligence.js';
import { queueFetch, jsonResponse } from './helpers/fakeFetch.js';

const PLACEMENTS: GeometryPlacement[] = [
  { provider_ref_id: 'front', area_width: 1747, area_height: 2468 },
];

const BASE = 'https://api.example.test/agents/v1';

beforeEach(() => {
  _clearIntelligenceCacheForTests();
});

describe('bundledLayoutResolver', () => {
  it('mirrors the bundled garments.ts tables', () => {
    const r = bundledLayoutResolver('Ceramic Mug 11oz');
    expect(r.source).toBe('bundled');
    // Mug family rule: central-band inset.
    const face = r.faceLayout('default', 2000, 900);
    expect(face?.faces[0].x).toBe(0.28);
    expect(face?.faces[0].w).toBe(0.44);
    expect(r.printStyle()).toBe('placed');
    // Non-apparel placed good centers on the face.
    expect(r.placedStyle()).toBe('back_center');
    expect(r.isInterior('inside_pages')).toBe(true);
    expect(r.isInterior('front')).toBe(false);
  });

  it('apparel resolves to chest_fill + placed with no face', () => {
    const r = bundledLayoutResolver('Unisex Staple T-Shirt');
    expect(r.printStyle()).toBe('placed');
    expect(r.placedStyle()).toBe('chest_fill');
    expect(r.faceLayout('front', 1000, 1200)).toBeUndefined();
  });
});

describe('resolveGarmentLayout — no service key (local npx)', () => {
  it('returns the bundled resolver and never calls the platform', async () => {
    const { fetchImpl, calls } = queueFetch([]);
    const r = await resolveGarmentLayout(
      'prov-uuid', '300', 'Ceramic Mug', PLACEMENTS,
      { baseUrl: BASE, fetchImpl },
    );
    expect(r.source).toBe('bundled');
    expect(calls.length).toBe(0);
  });
});

describe('resolveGarmentLayout — hosted (service key set)', () => {
  it('resolves face layouts, style, and interior from the platform response', async () => {
    const platformBody = {
      source: 'db',
      print_style: 'fill',
      placed_style: 'back_center',
      placements: {
        front: { faces: [{ x: 0.1, y: 0.05, w: 0.8, h: 0.46 }], note: 'backpack top-favor' },
      },
      interior_placements: ['inside_liner'],
      warnings: [],
    };
    const { fetchImpl, calls } = queueFetch([jsonResponse(200, platformBody)]);
    const r = await resolveGarmentLayout(
      'prov-uuid', '279', 'All-Over Print Backpack', PLACEMENTS,
      { serviceKey: 'svc-key', baseUrl: BASE, fetchImpl },
    );
    expect(r.source).toBe('platform');
    // Sent to the right endpoint with the service key header.
    expect(calls[0].url).toBe(`${BASE}/service/garment-intelligence/resolve`);
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('svc-key');
    // Face + style come from the platform, not the bundled tables.
    expect(r.faceLayout('front', 1747, 2468)?.faces[0]).toEqual({ x: 0.1, y: 0.05, w: 0.8, h: 0.46 });
    expect(r.printStyle()).toBe('fill');
    expect(r.placedStyle()).toBe('back_center');
    // Platform exclude_placements flow through interior_placements...
    expect(r.isInterior('inside_liner')).toBe(true);
    // ...and the generic regex still backstops placements the response omits.
    expect(r.isInterior('page3')).toBe(true);
    expect(r.isInterior('front')).toBe(false);
  });

  it('a null placement entry resolves to no face (falls back to bundled compose)', async () => {
    const body = {
      source: 'none', print_style: 'placed', placed_style: 'chest_fill',
      placements: { front: null }, interior_placements: [], warnings: [],
    };
    const { fetchImpl } = queueFetch([jsonResponse(200, body)]);
    const r = await resolveGarmentLayout(
      'prov-uuid', '71', 'Unisex Staple T-Shirt', PLACEMENTS,
      { serviceKey: 'svc-key', baseUrl: BASE, fetchImpl },
    );
    expect(r.source).toBe('platform');
    expect(r.faceLayout('front', 1747, 2468)).toBeUndefined();
  });

  it('caches per (provider, product_ref) for the process lifetime', async () => {
    const body = {
      source: 'db', print_style: 'fill', placed_style: 'back_center',
      placements: { front: { faces: [{ x: 0.1, y: 0.05, w: 0.8, h: 0.46 }] } },
      interior_placements: [], warnings: [],
    };
    // Only ONE response queued — a second fetch would throw.
    const { fetchImpl, calls } = queueFetch([jsonResponse(200, body)]);
    const opts = { serviceKey: 'svc-key', baseUrl: BASE, fetchImpl };
    const r1 = await resolveGarmentLayout('prov', '279', 'Backpack', PLACEMENTS, opts);
    const r2 = await resolveGarmentLayout('prov', '279', 'Backpack', PLACEMENTS, opts);
    expect(r1.source).toBe('platform');
    expect(r2.source).toBe('platform');
    expect(calls.length).toBe(1); // second call served from cache
  });
});

describe('resolveGarmentLayout — graceful degradation', () => {
  it('non-200 falls back to bundled and is NOT cached (retries next call)', async () => {
    const { fetchImpl, calls } = queueFetch([
      jsonResponse(503, { error: 'unavailable' }),
      jsonResponse(200, {
        source: 'db', print_style: 'fill', placed_style: 'back_center',
        placements: { front: { faces: [{ x: 0.16, y: 0.13, w: 0.68, h: 0.72 }] } },
        interior_placements: [], warnings: [],
      }),
    ]);
    const opts = { serviceKey: 'svc-key', baseUrl: BASE, fetchImpl };
    const first = await resolveGarmentLayout('prov', '646', 'Water Bottle', PLACEMENTS, opts);
    expect(first.source).toBe('bundled'); // degraded

    const second = await resolveGarmentLayout('prov', '646', 'Water Bottle', PLACEMENTS, opts);
    expect(second.source).toBe('platform'); // retried, not pinned to the fallback
    expect(calls.length).toBe(2);
  });

  it('a network throw falls back to bundled', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const r = await resolveGarmentLayout(
      'prov', '279', 'All-Over Print Backpack', PLACEMENTS,
      { serviceKey: 'svc-key', baseUrl: BASE, fetchImpl },
    );
    expect(r.source).toBe('bundled');
    // Bundled backpack rule still applies for the front placement.
    expect(r.faceLayout('front', 1747, 2468)?.faces[0].y).toBe(0.05);
  });

  it('a malformed (non-object) body falls back to bundled', async () => {
    const { fetchImpl } = queueFetch([jsonResponse(200, 'not-an-object')]);
    const r = await resolveGarmentLayout(
      'prov', '279', 'All-Over Print Backpack', PLACEMENTS,
      { serviceKey: 'svc-key', baseUrl: BASE, fetchImpl },
    );
    expect(r.source).toBe('bundled');
  });
});

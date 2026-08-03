import { describe, it, expect } from 'vitest';
import { browseCatalog, findGarments, getGarmentDetails } from '../src/tools/catalog.js';
import { fakeContext } from './helpers/ctx.js';
import { apiSequence } from './helpers/fakeFetch.js';

// Platform epic #757: an agent found one provider's headwear was embroidery-only
// and reported "no hat is possible" as settled fact, while the same account
// carried DTF-printed caps on another provider. These tests pin the parts of the
// tool surface that make repeating that mistake harder.

describe('find_garments', () => {
  it('searches every provider by default and does not require naming one', async () => {
    const { api, calls } = apiSequence([
      {
        results: [
          {
            provider: 'Printify',
            product_ref_id: '10194',
            name: 'Printed Trucker Cap',
            decoration_method: ['dtf'],
            decoration_confidence: 'high',
            accepts_photoreal: true,
          },
        ],
        total_matched: 1,
        providers_searched: ['Printful', 'Printify', 'Gelato'],
      },
    ]);

    const res = (await findGarments.handler(
      { category: 'hat', accepts_photoreal: true },
      fakeContext(api),
    )) as any;

    // One call. No provider-resolution round-trip, because not naming a provider
    // is the whole point.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/merchandise/find-garments');
    expect(calls[0]?.url).toContain('category=hat');
    expect(calls[0]?.url).toContain('accepts_photoreal=true');
    expect(calls[0]?.url).not.toContain('providers=');

    expect(res.results[0]).toMatchObject({
      provider: 'Printify',
      product_ref_id: '10194',
      decoration_method: ['dtf'],
      accepts_photoreal: true,
    });
  });

  it('echoes coverage back so the agent can state it honestly', async () => {
    // An agent that says "no printable hat exists" after searching two of three
    // providers is repeating the original mistake with better data.
    const { api } = apiSequence([
      {
        results: [],
        total_matched: 0,
        providers_searched: ['Printful', 'Printify'],
        providers_unavailable: [{ provider: 'Gelato', reason: 'timeout' }],
        warnings: ['No garments matched ... That is not proof the item is impossible.'],
      },
    ]);
    const res = (await findGarments.handler({ category: 'hat' }, fakeContext(api))) as any;
    expect(res.providers_searched).toEqual(['Printful', 'Printify']);
    expect(res.providers_unavailable).toEqual([{ provider: 'Gelato', reason: 'timeout' }]);
    expect(res.warnings[0]).toContain('not proof');
  });

  it('sends array filters as csv, which is what the platform parses', async () => {
    const { api, calls } = apiSequence([{ results: [], total_matched: 0 }]);
    await findGarments.handler(
      { decoration_method: ['dtf', 'dtg'], providers: ['Printify', 'Gelato'] },
      fakeContext(api),
    );
    const url = calls[0]?.url ?? '';
    expect(decodeURIComponent(url)).toContain('decoration_method=dtf,dtg');
    expect(decodeURIComponent(url)).toContain('providers=Printify,Gelato');
  });

  it('falls back to the row count when the platform omits total_matched', async () => {
    const { api } = apiSequence([{ results: [{ provider: 'Printify', name: 'Cap' }] }]);
    const res = (await findGarments.handler({}, fakeContext(api))) as any;
    expect(res.total_matched).toBe(1);
  });

  it('is advertised as read-only so it is cheap to reach for', async () => {
    expect(findGarments.annotations?.readOnlyHint).toBe(true);
  });

  it('tells the agent to use it BEFORE declaring something impossible', async () => {
    // The description is the only thing that reaches an agent deciding whether
    // to drop an item, so the instruction has to be in it.
    const d = findGarments.description.toLowerCase();
    expect(d).toContain('before telling a user an item cannot be built');
    expect(d).toContain('every fulfillment provider');
  });
});

describe('decoration capability survives the catalog projections', () => {
  it('browse_catalog carries decoration fields through mapGarment', async () => {
    const { api } = apiSequence([
      { providers: [{ uuid: 'py-uuid', name: 'Printify' }] },
      {
        products: [
          {
            provider_ref_id: '10194',
            name: 'Printed Trucker Cap',
            decoration_method: ['dtf'],
            decoration_confidence: 'high',
            accepts_photoreal: true,
          },
        ],
      },
    ]);
    const res = (await browseCatalog.handler({ provider: 'Printify' }, fakeContext(api))) as any;
    expect(res.garments[0]).toMatchObject({
      decoration_method: ['dtf'],
      decoration_confidence: 'high',
      accepts_photoreal: true,
    });
  });

  it('omits accepts_photoreal when the platform could not tell, rather than saying false', async () => {
    // null means "nobody checked", NOT "cannot". Coercing it to false here would
    // recreate the exact bug at the client layer: an agent reading false drops
    // the garment.
    const { api } = apiSequence([
      { providers: [{ uuid: 'pf-uuid', name: 'Printful' }] },
      {
        products: [
          {
            provider_ref_id: '850',
            name: 'Knitted Beanie',
            decoration_method: [],
            decoration_confidence: 'unknown',
            accepts_photoreal: null,
          },
        ],
      },
    ]);
    const res = (await browseCatalog.handler({ provider: 'Printful' }, fakeContext(api))) as any;
    expect(res.garments[0]).not.toHaveProperty('accepts_photoreal');
    expect(res.garments[0]).not.toHaveProperty('decoration_method');
    expect(res.garments[0].decoration_confidence).toBe('unknown');
  });

  it('get_garment_details carries them on the garment too', async () => {
    const { api } = apiSequence([
      { providers: [{ uuid: 'pf-uuid', name: 'Printful' }] },
      {
        name: 'Dad Hat',
        decoration_method: ['embroidery'],
        decoration_confidence: 'high',
        accepts_photoreal: false,
        variants: [{ id: 1, color: 'Black', size: 'One size', price: 12 }],
      },
    ]);
    const res = (await getGarmentDetails.handler(
      { provider: 'Printful', product_ref_id: '206' },
      fakeContext(api),
    )) as any;
    expect(res.garment).toMatchObject({
      decoration_method: ['embroidery'],
      accepts_photoreal: false,
    });
  });
});

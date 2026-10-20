import { describe, it, expect } from 'vitest';
import { getDesignCollection, readTools } from '../src/tools/read.js';
import { generateImage } from '../src/tools/design.js';
import { ApiClient } from '../src/http/client.js';
import { fakeContext } from './helpers/ctx.js';
import { jsonResponse, queueFetch, noSleep } from './helpers/fakeFetch.js';

// Brand briefs and collections (apparelhub-ai#1174 / #1175). Generic placeholders only: this is a
// public repo, so no real account data or uuids.

function apiFrom(bodies: Response[]) {
  const { fetchImpl, calls } = queueFetch(bodies);
  const api = new ApiClient({
    apiKey: 'k',
    baseUrl: 'https://api.example.test/agents/v1',
    userAgent: 't',
    fetchImpl,
    sleepImpl: noSleep,
  });
  return { api, calls };
}

const pending = (uuid: string, extra: Record<string, unknown> = {}) =>
  jsonResponse(202, { image_uuid: uuid, processing_status: 'pending', ...extra });
const done = (url: string) => jsonResponse(200, { processing_status: 'completed', url });

describe('generate_image concepts', () => {
  it('omits concepts entirely on an ordinary generation', async () => {
    const { api, calls } = apiFrom([pending('g1'), done('https://cdn.example/1.png')]);
    const res = (await generateImage.handler({ prompt: 'a fox' }, fakeContext(api))) as any;
    const body = JSON.parse(calls[0]?.init?.body as string);
    expect(body).not.toHaveProperty('concepts');
    expect(res).not.toHaveProperty('concepts_requested');
    expect(res).not.toHaveProperty('warning');
  });

  it('treats concepts: 1 as ordinary and does not send it', async () => {
    const { api, calls } = apiFrom([pending('g1'), done('https://cdn.example/1.png')]);
    await generateImage.handler({ prompt: 'a fox', concepts: 1 }, fakeContext(api));
    expect(JSON.parse(calls[0]?.init?.body as string)).not.toHaveProperty('concepts');
  });

  it('sends concepts and points the caller at get_design_collection', async () => {
    const { api, calls } = apiFrom([pending('g2'), done('https://cdn.example/2.png')]);
    const res = (await generateImage.handler(
      { prompt: 'a whole outdoor brand', source: 'Nano Banana', concepts: 4 },
      fakeContext(api),
    )) as any;
    expect(JSON.parse(calls[0]?.init?.body as string).concepts).toBe(4);
    expect(res.concepts_requested).toBe(4);
    expect(res.collection_note).toContain('get_design_collection');
    expect(res).not.toHaveProperty('warning');
  });

  it('clamps to the platform cap rather than refusing', async () => {
    const { api, calls } = apiFrom([pending('g3'), done('https://cdn.example/3.png')]);
    const res = (await generateImage.handler(
      { prompt: 'x', source: 'Nano Banana', concepts: 50 },
      fakeContext(api),
    )) as any;
    expect(JSON.parse(calls[0]?.init?.body as string).concepts).toBe(7);
    expect(res.concepts_requested).toBe(7);
  });

  it('warns when the source cannot answer with a collection, instead of implying a set', async () => {
    const { api } = apiFrom([pending('g4'), done('https://cdn.example/4.png')]);
    const res = (await generateImage.handler(
      { prompt: 'x', source: 'Seedream 4.5', concepts: 4, no_fallback: true },
      fakeContext(api),
    )) as any;
    expect(res.warning).toMatch(/reduced to 1/);
    expect(res).not.toHaveProperty('collection_note');
  });

  it('passes the prompt_improvement block through, brand_brief included', async () => {
    const pi = {
      needs_improvement: true,
      improved_prompt: 'a stylised compass rose, flat 2D graphic',
      issues: ['brand_brief'],
      suggestion_id: 's1',
    };
    const { api } = apiFrom([pending('g5', { prompt_improvement: pi }), done('https://cdn.example/5.png')]);
    const res = (await generateImage.handler({ prompt: 'a brand brief' }, fakeContext(api))) as any;
    expect(res.prompt_improvement).toEqual(pi);
  });
});

describe('get_design_collection', () => {
  it('maps siblings, keeps model copy as-is, and warns about designs that print with their background', async () => {
    const { api, calls } = apiFrom([
      jsonResponse(200, {
        collection: [
          {
            uuid: 'd2',
            url: 'https://cdn.example/d2.png',
            thumbnail_url: 'https://cdn.example/d2_thumb.png',
            title: 'Trail Tee',
            concept_description: 'A compass rose over a ridge line.',
            background_state: 'transparent',
          },
          {
            uuid: 'd3',
            url: 'https://cdn.example/d3.png',
            thumbnail_url: null,
            title: null,
            concept_description: null,
            background_state: 'opaque_varied',
          },
        ],
      }),
    ]);
    const res = (await getDesignCollection.handler({ design_uuid: 'd1' }, fakeContext(api))) as any;
    expect(calls[0]?.url).toContain('images/generated/d1/collection');
    expect(res.total).toBe(2);
    expect(res.collection[0]).toMatchObject({
      design_uuid: 'd2',
      title: 'Trail Tee',
      concept_description: 'A compass rose over a ridge line.',
      full_url: 'https://cdn.example/d2.png',
      background_state: 'transparent',
    });
    // Null stays null: the tool never invents a title or a description.
    expect(res.collection[1].title).toBeNull();
    expect(res.collection[1].concept_description).toBeNull();
    expect(res.warning).toMatch(/1 of 2 will print with their background/);
  });

  it('returns an empty list for an ordinary design, with no warning', async () => {
    const { api } = apiFrom([jsonResponse(200, { collection: [] })]);
    const res = (await getDesignCollection.handler({ design_uuid: 'd9' }, fakeContext(api))) as any;
    expect(res).toEqual({ design_uuid: 'd9', collection: [], total: 0 });
  });

  it('is read-only and registered with the read tools', () => {
    expect(getDesignCollection.annotations?.readOnlyHint).toBe(true);
    expect(readTools.map((t) => t.name)).toContain('get_design_collection');
  });
});

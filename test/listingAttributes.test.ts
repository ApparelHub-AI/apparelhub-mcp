import { describe, it, expect } from 'vitest';
import {
  describeListingAttributes,
  setListingAttributes,
  setChannelSettings,
  channelTools,
} from '../src/tools/channel.js';
import { fakeContext } from './helpers/ctx.js';
import { apiRecording } from './helpers/fakeFetch.js';

// Generic placeholders only (public repo): short ids, "Acme Co".

const recording = apiRecording;

/** The JSON body the tool actually sent. */
function sentBody(call: { init?: { body?: unknown } }): Record<string, unknown> {
  return JSON.parse(String(call.init?.body ?? '{}')) as Record<string, unknown>;
}

// Shaped like the real API response. The three orthogonal type properties matter:
// a single data_type enum could not express a field that is enumerated AND
// free-text-able, which most real fields are.
const SCHEMA_PAYLOAD = {
  integration_uuid: 'i-1',
  provider: 'Acme Channel',
  supported: true,
  allows_custom_fields: false,
  resolved_for: { category_id: 'c-1', resolution: 'keyword_match' },
  fields: [
    {
      key: 'material',
      label: 'Material',
      scope: 'product',
      value_type: 'string',
      cardinality: 'multi',
      free_text: true,
      requirement: 'optional',
      allowed_values: [{ value: 'Cotton', label: 'Cotton' }],
      allowed_values_count: 1,
    },
    {
      key: 'hazard question',
      label: 'Hazard Question',
      scope: 'integration',
      value_type: 'string',
      cardinality: 'single',
      free_text: false,
      requirement: 'optional',
      allowed_values: [
        { value: 'Yes', label: 'Yes' },
        { value: 'No', label: 'No' },
      ],
      allowed_values_count: 2,
    },
    {
      key: 'named substances',
      label: 'Named Substances',
      scope: 'integration',
      value_type: 'string',
      cardinality: 'multi',
      free_text: false,
      requirement: 'conditional',
      required_when: [{ field_key: 'hazard question', equals_value: 'Yes' }],
      allowed_values_count: 647,
    },
  ],
  values: { material: 'Cotton' },
  unset_required: [],
  rejected: [],
};

describe('describe_listing_attributes', () => {
  it('is registered on the channel tool set', () => {
    const names = channelTools.map((t) => t.name);
    expect(names).toContain('describe_listing_attributes');
    expect(names).toContain('set_listing_attributes');
    expect(names).toContain('set_channel_settings');
  });

  it('is marked read-only', () => {
    expect(describeListingAttributes.annotations?.readOnlyHint).toBe(true);
    // The writes must NOT be, or a client may auto-approve a legal attestation.
    expect(setListingAttributes.annotations?.readOnlyHint).toBeUndefined();
    expect(setChannelSettings.annotations?.readOnlyHint).toBeUndefined();
  });

  it('hits the product route when a product is given', async () => {
    const { api, calls } = recording(SCHEMA_PAYLOAD);
    await describeListingAttributes.handler(
      { store_uuid: 's-1', product_uuid: 'p-1' },
      fakeContext(api),
    );
    expect(calls[0].url).toContain('/store/s-1/products/p-1/listing-attributes');
  });

  it('hits the integration route when no product is given', async () => {
    const { api, calls } = recording(SCHEMA_PAYLOAD);
    await describeListingAttributes.handler(
      { store_uuid: 's-1', integration_uuid: 'i-1' },
      fakeContext(api),
    );
    expect(calls[0].url).toContain('/store/s-1/integration/i-1/listing-attributes');
  });

  it('refuses clearly when neither a product nor an integration is given', async () => {
    // The shop-wide route addresses the integration directly, so there is nothing
    // to resolve it from. Naming the missing argument beats a malformed URL.
    const { api } = recording(SCHEMA_PAYLOAD);
    await expect(
      describeListingAttributes.handler({ store_uuid: 's-1' }, fakeContext(api)),
    ).rejects.toThrow(/integration_uuid/);
  });

  it('surfaces the three orthogonal type properties', async () => {
    const { api } = recording(SCHEMA_PAYLOAD);
    const r = (await describeListingAttributes.handler(
      { store_uuid: 's-1', product_uuid: 'p-1' },
      fakeContext(api),
    )) as { fields: Record<string, unknown>[] };
    const material = r.fields.find((f) => f.key === 'material')!;
    expect(material.cardinality).toBe('multi');
    expect(material.free_text).toBe(true);
    expect(material.allowed_values).toBeTruthy();
  });

  it('surfaces the conditional requirement and its trigger', async () => {
    const { api } = recording(SCHEMA_PAYLOAD);
    const r = (await describeListingAttributes.handler(
      { store_uuid: 's-1', product_uuid: 'p-1' },
      fakeContext(api),
    )) as { fields: Record<string, unknown>[] };
    const conditional = r.fields.find((f) => f.key === 'named substances')!;
    expect(conditional.requirement).toBe('conditional');
    expect(conditional.required_when).toEqual([
      { field_key: 'hazard question', equals_value: 'Yes' },
    ]);
  });

  it('surfaces how the taxonomy node was resolved', async () => {
    // A guessed category means the fields belong to a different kind of product,
    // and setting attributes against it is worse than setting none.
    const { api } = recording(SCHEMA_PAYLOAD);
    const r = (await describeListingAttributes.handler(
      { store_uuid: 's-1', product_uuid: 'p-1' },
      fakeContext(api),
    )) as { resolved_for: { resolution: string } };
    expect(r.resolved_for.resolution).toBe('keyword_match');
  });

  it('passes include_values through', async () => {
    const { api, calls } = recording(SCHEMA_PAYLOAD);
    await describeListingAttributes.handler(
      { store_uuid: 's-1', product_uuid: 'p-1', include_values: 'all' },
      fakeContext(api),
    );
    expect(calls[0].url).toContain('include_values=all');
  });

  it('reports an unsupported channel as a fact rather than failing', async () => {
    const { api } = recording({
      integration_uuid: 'i-9',
      provider: 'Acme Co',
      supported: false,
      fields: [],
      values: {},
    });
    const r = (await describeListingAttributes.handler(
      { store_uuid: 's-1', integration_uuid: 'i-9' },
      fakeContext(api),
    )) as { supported: boolean; fields: unknown[] };
    expect(r.supported).toBe(false);
    expect(r.fields).toEqual([]);
  });
});

describe('set_listing_attributes', () => {
  it('sends the values to the product route', async () => {
    const { api, calls } = recording({ accepted: { material: 'Cotton' }, rejected: [] });
    await setListingAttributes.handler(
      { store_uuid: 's-1', product_uuid: 'p-1', values: { material: 'Cotton' } },
      fakeContext(api),
    );
    expect(calls[0].url).toContain('/store/s-1/products/p-1/listing-attributes');
  });

  it('keeps the rejection reasons and allowed values in the tool result', async () => {
    // The whole point: a rejected value must reach the model with enough detail to
    // correct itself, rather than vanishing.
    const { api } = recording({
      accepted: { material: 'Cotton' },
      rejected: [
        {
          key: 'named substances',
          reason: 'value_not_allowed',
          message: '"Nope" is not an allowed value for "Named Substances".',
          allowed_values: [{ value: 'Substance A', label: 'Substance A' }],
          allowed_values_count: 647,
        },
      ],
      unset_required: [],
      values: { material: 'Cotton' },
    });
    const r = (await setListingAttributes.handler(
      {
        store_uuid: 's-1',
        product_uuid: 'p-1',
        values: { material: 'Cotton', 'named substances': 'Nope' },
      },
      fakeContext(api),
    )) as { accepted: Record<string, unknown>; rejected: Record<string, unknown>[] };

    expect(r.accepted).toEqual({ material: 'Cotton' });
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0].reason).toBe('value_not_allowed');
    expect(r.rejected[0].message).toBeTruthy();
    expect(r.rejected[0].allowed_values).toBeTruthy();
  });

  it('reports a partial write as a success with both halves', async () => {
    const { api } = recording({
      accepted: { a: '1', b: '2', c: '3' },
      rejected: [{ key: 'd', reason: 'value_not_allowed', message: 'no' }],
    });
    const r = (await setListingAttributes.handler(
      { store_uuid: 's-1', product_uuid: 'p-1', values: { a: '1', b: '2', c: '3', d: '4' } },
      fakeContext(api),
    )) as { accepted: Record<string, unknown>; rejected: unknown[] };
    expect(Object.keys(r.accepted)).toHaveLength(3);
    expect(r.rejected).toHaveLength(1);
  });

  it('defaults sync to false so a set does not silently publish', async () => {
    const { api, calls } = recording({ accepted: {}, rejected: [] });
    await setListingAttributes.handler(
      { store_uuid: 's-1', product_uuid: 'p-1', values: { material: 'Cotton' } },
      fakeContext(api),
    );
    expect(sentBody(calls[0]).sync).toBe(false);
  });

  it('passes sync through when asked', async () => {
    const { api, calls } = recording({ accepted: {}, rejected: [], synced: { ok: true } });
    await setListingAttributes.handler(
      { store_uuid: 's-1', product_uuid: 'p-1', values: { material: 'Cotton' }, sync: true },
      fakeContext(api),
    );
    expect(sentBody(calls[0]).sync).toBe(true);
  });

  it('supports a multi-valued field', async () => {
    const { api, calls } = recording({ accepted: {}, rejected: [] });
    await setListingAttributes.handler(
      { store_uuid: 's-1', product_uuid: 'p-1', values: { material: ['Cotton', 'Linen'] } },
      fakeContext(api),
    );
    expect((sentBody(calls[0]).values as Record<string, unknown>).material).toEqual([
      'Cotton',
      'Linen',
    ]);
  });
});

describe('set_channel_settings', () => {
  it('sends the values to the integration route', async () => {
    const { api, calls } = recording({ accepted: {}, rejected: [] });
    await setChannelSettings.handler(
      { store_uuid: 's-1', integration_uuid: 'i-1', values: { 'hazard question': 'No' } },
      fakeContext(api),
    );
    expect(calls[0].url).toContain('/store/s-1/integration/i-1/listing-attributes');
  });

  it('reports a conditionally-required follow-up as unset rather than filling it', async () => {
    // Answering one question can make another required — naming specific
    // substances from a list of hundreds. It must surface, never be chosen.
    const { api } = recording({
      accepted: { 'hazard question': 'Yes' },
      rejected: [],
      unset_required: ['named substances'],
      values: { 'hazard question': 'Yes' },
    });
    const r = (await setChannelSettings.handler(
      { store_uuid: 's-1', integration_uuid: 'i-1', values: { 'hazard question': 'Yes' } },
      fakeContext(api),
    )) as { accepted: Record<string, unknown>; unset_required: string[] };
    expect(r.unset_required).toContain('named substances');
    expect(r.accepted['named substances']).toBeUndefined();
  });

  it('relays the value verbatim rather than normalising it', async () => {
    const { api, calls } = recording({ accepted: {}, rejected: [] });
    await setChannelSettings.handler(
      { store_uuid: 's-1', integration_uuid: 'i-1', values: { 'hazard question': 'Not Sure' } },
      fakeContext(api),
    );
    expect(sentBody(calls[0]).values).toEqual({ 'hazard question': 'Not Sure' });
  });
});

describe('tool descriptions carry the safety rules', () => {
  // The model reads these and acts on them, so they are a safety surface in their
  // own right — not documentation. Asserted so a future edit cannot quietly
  // remove the instruction that stops an agent inventing a legal attestation.
  it('the shop-wide write tells the agent never to invent a value', () => {
    const d = setChannelSettings.description;
    expect(d).toMatch(/NEVER INVENT A VALUE/);
    expect(d).toMatch(/leave it UNSET/i);
    expect(d).toMatch(/legal/i);
  });

  it('the shop-wide write warns against reasoning from the product type', () => {
    // The specific wrong move: assuming printed apparel is automatically exempt.
    expect(setChannelSettings.description).toMatch(/do not reason from|printed apparel/i);
  });

  it('the product write repeats the never-invent rule', () => {
    expect(setListingAttributes.description).toMatch(/NEVER INVENT A VALUE/);
  });

  it('the product write says a set does not reach the channel without a sync', () => {
    expect(setListingAttributes.description).toMatch(/does NOT change the live listing/i);
  });

  it('describe explains that a guessed category is unverified', () => {
    expect(describeListingAttributes.description).toMatch(/keyword_match/);
    expect(describeListingAttributes.description).toMatch(/unverified/i);
  });

  it('describe explains that values are what is live on the channel', () => {
    expect(describeListingAttributes.description).toMatch(/LIVE ON THE CHANNEL/);
  });
});

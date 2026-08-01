import { describe, it, expect } from 'vitest';
import {
  checkSetupReadiness,
  listConnectableProviders,
  connectFulfillmentProvider,
  connectSalesChannel,
  startChannelConnect,
  checkConnectionStatus,
  setupTools,
} from '../src/tools/setup.js';
import { fakeContext } from './helpers/ctx.js';
import { apiRecording, apiSequence } from './helpers/fakeFetch.js';

// Generic placeholders only (public repo): s1 = store uuid, p1 = provider uuid,
// "Acme Apparel" store name, example.com hosts.

const READY_EMPTY = {
  ready_to_design: true,
  ready_to_fulfill: false,
  ready_to_sell: false,
  stores: [],
  next_steps: [
    { step: 'create_store', reason: 'You do not have a store yet.', blocked: false },
  ],
  options: {
    fulfillment: [
      { uuid: 'p1', name: 'Printify', family: 'fulfillment', connect_mode: 'in_chat', agent_completable: true },
      { uuid: 'p2', name: 'Printful', family: 'fulfillment', connect_mode: 'browser', agent_completable: false },
    ],
    sales_channels: [
      { uuid: 'c1', name: 'WooCommerce', family: 'sales_channel', connect_mode: 'in_chat', agent_completable: true },
    ],
  },
  limits: { store: { allowed: true } },
};

describe('check_setup_readiness', () => {
  it('passes the platform payload through and adds an actionable next move', async () => {
    const { api, calls } = apiRecording(READY_EMPTY);
    const res = (await checkSetupReadiness.handler({}, fakeContext(api))) as any;
    expect(calls[0]!.url).toContain('/onboarding/readiness');
    expect(res.ready_to_fulfill).toBe(false);
    expect(res.guidance).toContain('create_store');
  });

  it('says so plainly when nothing is missing', async () => {
    const { api } = apiRecording({ ...READY_EMPTY, next_steps: [] });
    const res = (await checkSetupReadiness.handler({}, fakeContext(api))) as any;
    expect(res.guidance).toContain('Nothing is missing');
  });

  it('marks a plan-limit block as blocked rather than something to retry', async () => {
    const { api } = apiRecording({
      ...READY_EMPTY,
      next_steps: [{ step: 'create_store', reason: 'Store limit reached.', blocked: true }],
    });
    const res = (await checkSetupReadiness.handler({}, fakeContext(api))) as any;
    expect(res.guidance).toContain('BLOCKED');
    expect(res.guidance).toContain('upgrade');
  });
});

describe('list_connectable_providers', () => {
  it('splits the families and counts what can be done without a browser', async () => {
    const { api } = apiRecording(READY_EMPTY);
    const res = (await listConnectableProviders.handler({}, fakeContext(api))) as any;
    expect(res.fulfillment_providers).toHaveLength(2);
    expect(res.sales_channels).toHaveLength(1);
    // 2 of 3 are in_chat.
    expect(res.guidance).toContain('2 of 3');
  });
});

describe('connect_fulfillment_provider', () => {
  it('validates before connecting, so a bad token stores nothing', async () => {
    const { api, calls } = apiSequence([
      { valid: true, shops: [{ id: 'shop1' }] },
      { message: 'Connected', provider_name: 'Printify' },
    ]);
    await connectFulfillmentProvider.handler(
      { store_uuid: 's1', provider_uuid: 'p1', api_token: 'secret-token' },
      fakeContext(api),
    );
    expect(calls[0]!.url).toContain('/validate-pat');
    expect(calls[1]!.url).toContain('/connect-pat');
  });

  it('asks which shop when a token maps to several, without connecting', async () => {
    const { api, calls } = apiRecording({
      valid: true,
      shops: [{ id: 'shop1', title: 'One' }, { id: 'shop2', title: 'Two' }],
    });
    const res = (await connectFulfillmentProvider.handler(
      { store_uuid: 's1', provider_uuid: 'p1', api_token: 'secret-token' },
      fakeContext(api),
    )) as any;
    expect(res.connected).toBe(false);
    expect(res.needs_shop_selection).toBe(true);
    expect(res.shops).toHaveLength(2);
    // Must NOT have attempted the connect.
    expect(calls).toHaveLength(1);
  });

  it('passes the chosen shop through on the second call', async () => {
    const { api, calls } = apiSequence([
      { valid: true, shops: [{ id: 'shop1' }, { id: 'shop2' }] },
      { message: 'Connected' },
    ]);
    await connectFulfillmentProvider.handler(
      { store_uuid: 's1', provider_uuid: 'p1', api_token: 'secret-token', shop_id: 'shop2' },
      fakeContext(api),
    );
    expect(JSON.parse(calls[1]!.init?.body as string)).toMatchObject({ shop_id: 'shop2' });
  });

  it('never returns the submitted token, on any path', async () => {
    const { api } = apiSequence([
      { valid: true, shops: [{ id: 'shop1' }] },
      { message: 'Connected', provider_name: 'Printify' },
    ]);
    const res = await connectFulfillmentProvider.handler(
      { store_uuid: 's1', provider_uuid: 'p1', api_token: 'super-secret-token' },
      fakeContext(api),
    );
    // A credential pasted into a chat is already in a transcript; it must not
    // also come back in a tool result.
    expect(JSON.stringify(res)).not.toContain('super-secret-token');
  });

  it('does not leak the token when the shop picker is returned either', async () => {
    const { api } = apiRecording({ valid: true, shops: [{ id: 'a' }, { id: 'b' }] });
    const res = await connectFulfillmentProvider.handler(
      { store_uuid: 's1', provider_uuid: 'p1', api_token: 'super-secret-token' },
      fakeContext(api),
    );
    expect(JSON.stringify(res)).not.toContain('super-secret-token');
  });
});

describe('connect_sales_channel', () => {
  it('posts the credentials to the api-key connect route', async () => {
    const { api, calls } = apiRecording({ message: 'Connected' });
    await connectSalesChannel.handler(
      {
        store_uuid: 's1',
        provider_uuid: 'c1',
        credentials: { store_url: 'https://shop.example.com', consumer_key: 'ck', consumer_secret: 'cs' },
      },
      fakeContext(api),
    );
    expect(calls[0]!.url).toContain('/ecommerce/c1/connect-api-key');
    expect(JSON.parse(calls[0]!.init?.body as string)).toMatchObject({ consumer_key: 'ck' });
  });

  it('never returns the submitted credentials', async () => {
    const { api } = apiRecording({ message: 'Connected' });
    const res = await connectSalesChannel.handler(
      { store_uuid: 's1', provider_uuid: 'c1', credentials: { consumer_secret: 'super-secret-cs' } },
      fakeContext(api),
    );
    expect(JSON.stringify(res)).not.toContain('super-secret-cs');
  });
});

describe('start_channel_connect', () => {
  it('dispatches a sales-channel authorize URL', async () => {
    const { api, calls } = apiRecording({ auth_url: 'https://provider.example.com/authorize?x=1' });
    const res = (await startChannelConnect.handler(
      { provider_uuid: 'c2', kind: 'sales_channel', store_uuid: 's1' },
      fakeContext(api),
    )) as any;
    expect(calls[0]!.url).toContain('/store/s1/ecommerce/c2/initiate');
    expect(res.authorization_url).toContain('authorize');
    expect(res.guidance).toContain('poll');
  });

  it('refuses a sales-channel connect with no store, instead of guessing one', async () => {
    const { api, calls } = apiRecording({});
    const res = (await startChannelConnect.handler(
      { provider_uuid: 'c2', kind: 'sales_channel' },
      fakeContext(api),
    )) as any;
    expect(res.started).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('can create a store while dispatching fulfillment OAuth', async () => {
    const { api, calls } = apiRecording({ uuid: 's9', redirect_url: 'https://provider.example.com/oauth' });
    const res = (await startChannelConnect.handler(
      { provider_uuid: 'p2', kind: 'fulfillment', store_name: 'Acme Apparel' },
      fakeContext(api),
    )) as any;
    expect(calls[0]!.url).toContain('/store/create/merchandise_provider/p2');
    expect(JSON.parse(calls[0]!.init?.body as string)).toMatchObject({ name: 'Acme Apparel' });
    expect(res.authorization_url).toContain('oauth');
    expect(res.store_uuid).toBe('s9');
  });

  it('says what to do when the provider returns no URL, rather than claiming success', async () => {
    const { api } = apiRecording({ message: 'nothing useful' });
    const res = (await startChannelConnect.handler(
      { provider_uuid: 'p2', kind: 'fulfillment', store_uuid: 's1' },
      fakeContext(api),
    )) as any;
    expect(res.authorization_url).toBeUndefined();
    expect(res.guidance).toContain('did not return an authorization URL');
  });
});

describe('check_connection_status', () => {
  it('reports not-connected while the user is still authorizing', async () => {
    const { api, calls } = apiRecording({
      stores: [{ uuid: 's1', fulfillment: { connected: false, connection_state: 'unknown' } }],
    });
    const res = (await checkConnectionStatus.handler({ store_uuid: 's1' }, fakeContext(api))) as any;
    // Polls readiness, which makes no provider call -- so eager polling cannot
    // burn someone else's rate limit.
    expect(calls[0]!.url).toContain('/onboarding/readiness');
    expect(res.connected).toBe(false);
    expect(res.guidance).toContain('poll again');
  });

  it('reports connected once the connection lands', async () => {
    const { api } = apiRecording({
      stores: [{ uuid: 's1', fulfillment: { connected: true, connection_state: 'connected' } }],
    });
    const res = (await checkConnectionStatus.handler({ store_uuid: 's1' }, fakeContext(api))) as any;
    expect(res.connected).toBe(true);
  });

  it('tells the agent to re-authorize rather than retry a dead connection', async () => {
    const { api } = apiRecording({
      stores: [{ uuid: 's1', fulfillment: { connected: false, connection_state: 'reconnect_required' } }],
    });
    const res = (await checkConnectionStatus.handler({ store_uuid: 's1' }, fakeContext(api))) as any;
    expect(res.needs_reconnect).toBe(true);
    expect(res.guidance).toContain('Retrying will not fix it');
  });

  it('scopes to one store when asked', async () => {
    const { api } = apiRecording({
      stores: [
        { uuid: 's1', fulfillment: { connected: true } },
        { uuid: 's2', fulfillment: { connected: false } },
      ],
    });
    const res = (await checkConnectionStatus.handler({ store_uuid: 's2' }, fakeContext(api))) as any;
    expect(res.stores).toHaveLength(1);
    expect(res.connected).toBe(false);
  });
});

describe('setup tool surface', () => {
  it('exports all six tools with sane annotations', () => {
    expect(setupTools).toHaveLength(6);
    const readOnly = setupTools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name);
    expect(readOnly.sort()).toEqual(
      ['check_connection_status', 'check_setup_readiness', 'list_connectable_providers'].sort(),
    );
    // Every tool talks to the platform.
    expect(setupTools.every((t) => t.annotations?.openWorldHint)).toBe(true);
  });
});

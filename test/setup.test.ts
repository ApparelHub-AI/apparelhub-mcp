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
    expect(JSON.parse(calls[1]!.init?.body as string)).toMatchObject({
      external_store_id: 'shop2',
    });
  });

  // The outage this suite missed: the assertions above check WHICH endpoint was
  // called, not WHAT was sent. The client posted the credential as `api_token`
  // while the platform reads `pat`, so the token arrived as nothing, the
  // provider was called with no credential at all, and its 401 reached the agent
  // as "Invalid token" -- three freshly minted tokens burned chasing a phantom.
  // A URL assertion cannot see that. These are body assertions.

  it('sends the credential under the field name the platform actually reads', async () => {
    const { api, calls } = apiSequence([
      { valid: true, shops: [{ id: 'shop1' }] },
      { message: 'Connected' },
    ]);
    await connectFulfillmentProvider.handler(
      { store_uuid: 's1', provider_uuid: 'p1', api_token: 'secret-token' },
      fakeContext(api),
    );
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const body = JSON.parse(call.init?.body as string);
      expect(body).toMatchObject({ pat: 'secret-token' });
      // Not merely redundant: a lingering alias means whichever name the
      // platform stops honouring first turns this back into a credential-less
      // call that reports itself as the merchant's bad token.
      expect(body).not.toHaveProperty('api_token');
    }
  });

  it('sends the chosen shop under the field name the platform actually reads', async () => {
    const { api, calls } = apiSequence([
      { valid: true, shops: [{ id: 'shop1' }, { id: 'shop2' }] },
      { message: 'Connected' },
    ]);
    await connectFulfillmentProvider.handler(
      { store_uuid: 's1', provider_uuid: 'p1', api_token: 'secret-token', shop_id: 'shop2' },
      fakeContext(api),
    );
    expect(JSON.parse(calls[1]!.init?.body as string)).not.toHaveProperty('shop_id');
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
    // The dispatch must tell the model to KEEP polling. Without this the model
    // hands over a link and stops, and since the tab where the user authorizes
    // cannot report back to the conversation, a successful connect reaches
    // nobody -- which is exactly what happened to a real operator (#136).
    expect(res.next_action).toBe('poll_check_connection_status');
    expect(res.guidance).toContain('KEEP POLLING');
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

  // Shopify's consent screen lives on the merchant's OWN domain, so unlike
  // every other provider it cannot build an authorize URL from the provider
  // row alone. The tool named Shopify in its description while having no way
  // to pass a shop, so the very first call failed -- before the user ever saw
  // a link. Nothing caught it because nothing asserted the tool could supply
  // what the backend required (#867).
  it('passes the merchant shop domain through for Shopify', async () => {
    const { api, calls } = apiRecording({ auth_url: 'https://your-store.myshopify.com/admin/oauth/authorize' });
    await startChannelConnect.handler(
      {
        provider_uuid: 'c3',
        kind: 'sales_channel',
        store_uuid: 's1',
        shop_url: 'your-store.myshopify.com',
      },
      fakeContext(api),
    );
    expect(JSON.parse(calls[0]!.init?.body as string)).toMatchObject({
      shop_url: 'your-store.myshopify.com',
    });
  });

  it('tells the agent Shopify needs a shop domain before it calls', () => {
    // The description is the only place a model learns this, and it learns it
    // BEFORE the first call. A backend error message arrives too late to stop
    // the user watching a failure.
    expect(startChannelConnect.description).toContain('shop_url');
    expect(startChannelConnect.inputSchema.shape.shop_url.description).toContain('myshopify');
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

  // The bug this file previously could not see: a sales channel could connect
  // and this reported false forever, because it only ever inspected
  // `fulfillment.connected`. The agent would poll out its whole budget and
  // then ask the user whether they had really authorized -- while the channel
  // sat connected in readiness the entire time (#867).
  it('sees a connected sales channel, not just fulfillment', async () => {
    const { api } = apiRecording({
      stores: [
        {
          uuid: 's1',
          fulfillment: { connected: false, connection_state: 'unknown' },
          sales_channels: [
            { integration_uuid: 'i1', provider: { uuid: 'c3', name: 'Shopify' }, connected: true },
          ],
        },
      ],
    });
    const res = (await checkConnectionStatus.handler(
      { store_uuid: 's1', provider_uuid: 'c3' },
      fakeContext(api),
    )) as any;
    expect(res.connected).toBe(true);
  });

  it('does not call a different provider connected', async () => {
    // A poll that answers "is anything connected" says true the moment any
    // earlier connection exists. The agent would then announce success for a
    // connection that never happened -- worse than reporting false, because
    // the user stops looking.
    const { api } = apiRecording({
      stores: [
        {
          uuid: 's1',
          fulfillment: { connected: true, connection_state: 'connected', provider: { uuid: 'p2', name: 'Printful' } },
          sales_channels: [
            { integration_uuid: 'i1', provider: { uuid: 'c1', name: 'WooCommerce' }, connected: true },
          ],
        },
      ],
    });
    const res = (await checkConnectionStatus.handler(
      { store_uuid: 's1', provider_uuid: 'c3' },
      fakeContext(api),
    )) as any;
    expect(res.connected).toBe(false);
  });

  it('still answers about fulfillment when no provider is named', async () => {
    // Back-compat: the fulfillment flow verified working in production must
    // not change behaviour just because channels became visible.
    const { api } = apiRecording({
      stores: [
        {
          uuid: 's1',
          fulfillment: { connected: true, connection_state: 'connected', provider: { uuid: 'p2' } },
          sales_channels: [],
        },
      ],
    });
    const res = (await checkConnectionStatus.handler({ store_uuid: 's1' }, fakeContext(api))) as any;
    expect(res.connected).toBe(true);
  });

  it('surfaces connected channels even when polled without a provider', async () => {
    const { api } = apiRecording({
      stores: [
        {
          uuid: 's1',
          fulfillment: { connected: false },
          sales_channels: [
            { integration_uuid: 'i1', provider: { uuid: 'c3', name: 'Shopify' }, connected: true },
          ],
        },
      ],
    });
    const res = (await checkConnectionStatus.handler({ store_uuid: 's1' }, fakeContext(api))) as any;
    // Unscoped `connected` stays fulfillment-only by design, but the agent must
    // not be left with a bare false and no way to tell what happened.
    expect(res.connected_sales_channels).toHaveLength(1);
    expect(res.guidance).toContain('provider_uuid');
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

// Every call in setup.ts is workspace-scoped server-side, and omitting the
// workspace scopes to the account's DEFAULT one. Until these tools accepted a
// workspace there was no way to reach a store that lived anywhere else, so an
// agency account got two different silent failures: the connect calls refused
// a store that list_my_stores had just returned ("Store not found or access
// denied", raised before the credential was ever read), and the readiness
// polls answered about the wrong workspace and reported false forever.
describe('workspace scoping', () => {
  it('threads the workspace onto the sales-channel connect', async () => {
    const { api, calls } = apiRecording({ message: 'Connected' });
    await connectSalesChannel.handler(
      {
        store_uuid: 's1',
        provider_uuid: 'c1',
        credentials: { store_url: 'https://shop.example.com', consumer_key: 'ck', consumer_secret: 'cs' },
        workspace: 'w-agency',
      },
      fakeContext(api),
    );
    expect(calls[0]!.url).toContain('workspace=w-agency');
  });

  it('sends no workspace when none was given, so single-workspace accounts are unchanged', async () => {
    const { api, calls } = apiRecording({ message: 'Connected' });
    await connectSalesChannel.handler(
      { store_uuid: 's1', provider_uuid: 'c1', credentials: { consumer_key: 'ck' } },
      fakeContext(api),
    );
    expect(calls[0]!.url).not.toContain('workspace=');
  });

  // Both legs, not just the last one: validate-pat resolves the same store, so
  // a workspace-less validate fails before connect-pat is ever reached.
  it('threads the workspace onto both legs of the fulfillment connect', async () => {
    const { api, calls } = apiSequence([{ shops: [{ id: 'shop1' }] }, { message: 'Connected' }]);
    await connectFulfillmentProvider.handler(
      { store_uuid: 's1', provider_uuid: 'p1', api_token: 'tok', workspace: 'w-agency' },
      fakeContext(api),
    );
    expect(calls[0]!.url).toContain('workspace=w-agency');
    expect(calls[1]!.url).toContain('workspace=w-agency');
  });

  it('threads the workspace onto a browser-based channel dispatch', async () => {
    const { api, calls } = apiRecording({ auth_url: 'https://provider.example.com/authorize' });
    await startChannelConnect.handler(
      { provider_uuid: 'c2', kind: 'sales_channel', store_uuid: 's1', workspace: 'w-agency' },
      fakeContext(api),
    );
    expect(calls[0]!.url).toContain('workspace=w-agency');
  });

  it('threads the workspace onto the readiness poll', async () => {
    const { api, calls } = apiRecording({ stores: [] });
    await checkConnectionStatus.handler(
      { store_uuid: 's1', workspace: 'w-agency' },
      fakeContext(api),
    );
    expect(calls[0]!.url).toContain('workspace=w-agency');
  });

  // The poll-forever case made explicit. A named store that readiness does not
  // report at all cannot become connected by waiting, so this must not read as
  // "not yet" -- that is what burned the whole poll budget and ended in asking
  // the user whether they had really authorized.
  it('calls out a wrong-workspace poll instead of reporting a bare not-yet', async () => {
    const { api } = apiRecording({
      stores: [{ uuid: 'other', fulfillment: { connected: true } }],
    });
    const res = (await checkConnectionStatus.handler({ store_uuid: 's1' }, fakeContext(api))) as any;
    expect(res.connected).toBe(false);
    expect(res.wrong_workspace).toBe(true);
    expect(res.guidance).toContain('workspace');
    expect(res.guidance).not.toContain('poll again');
  });

  it('does not cry wrong-workspace when the store is present but still pending', async () => {
    const { api } = apiRecording({
      stores: [{ uuid: 's1', fulfillment: { connected: false, connection_state: 'unknown' } }],
    });
    const res = (await checkConnectionStatus.handler({ store_uuid: 's1' }, fakeContext(api))) as any;
    expect(res.wrong_workspace).toBeUndefined();
    expect(res.guidance).toContain('poll again');
  });
});

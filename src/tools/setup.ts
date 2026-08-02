import { z } from 'zod';
import { defineTool } from './registry.js';
import { isRecord, str } from '../util/shape.js';

// First-time account setup (platform epic: agent-guided setup).
//
// Until these existed the server exposed ~97 tools and not one of them
// CONNECTED anything. `create_store` and `activate_store` were both present,
// but `activate_store` requires a fulfillment connection that no tool could
// create — so an agent driving a brand-new user hit a wall immediately and had
// to send them to the web dashboard. Setup was the only stage of the pipeline
// an agent could not drive.
//
// The shape of the problem, which these tools are built around:
//
//   Four of the eight connectable providers need NO browser. Printify and
//   Gelato take an API token, WooCommerce and Wix take API keys, and all four
//   can be completed entirely in the conversation.
//
//   The other four (Printful, Shopify, TikTok Shop, Fourthwall) need a consent
//   screen. For those the agent's job is not to complete the connection but to
//   BRACKET it: dispatch a link, then poll until the connection appears. That
//   is what makes a chat session better than the web wizard — the web OAuth
//   round trip is a fragile one-shot, so a user who bounces off to go create a
//   Printful account loses the flow. In chat they just say "ok, made it" and
//   the agent hands over a fresh link.
//
// These are deliberately THIN. Which providers exist, which connect in chat,
// what is still missing and what to do next are all decided by the platform's
// readiness endpoint, so the rules can be corrected server-side without an npm
// release and every surface (these tools, the web consent page) reads the same
// answer. Do not reimplement that logic here.
//
// One hard rule throughout: never echo a submitted credential back, including
// in error paths. A token pasted into a chat is already in a transcript; it
// must not also come back in a tool result.

const enc = encodeURIComponent;

const STORE_UUID = z
  .string()
  .min(1)
  .describe('Store uuid (from list_my_stores or create_store).');

const PROVIDER_UUID = z
  .string()
  .min(1)
  .describe('Provider uuid (from list_connectable_providers).');

function rec(raw: unknown): Record<string, unknown> {
  return isRecord(raw) ? raw : { result: raw };
}

/**
 * Turn readiness into a single sentence the model can act on.
 *
 * The payload already carries ordered next_steps; this just surfaces the head
 * of that list so the model never has to infer priority from an array.
 */
function guidanceFor(readiness: Record<string, unknown>): string {
  const steps = Array.isArray(readiness.next_steps) ? readiness.next_steps : [];
  if (steps.length === 0) {
    return 'Nothing is missing. This account can design, fulfill and sell.';
  }
  const head = isRecord(steps[0]) ? steps[0] : {};
  const reason = typeof head.reason === 'string' ? head.reason : '';
  const step = typeof head.step === 'string' ? head.step : 'continue setup';
  const blocked = head.blocked === true;
  if (blocked) {
    return `Next: ${step}. ${reason} This is BLOCKED by a plan limit — surface the upgrade path rather than retrying.`;
  }
  return `Next: ${step}. ${reason}`;
}

export const checkSetupReadiness = defineTool({
  name: 'check_setup_readiness',
  description:
    'What this account already has, what it still needs, and the single next action to take. Returns ready_to_design / ready_to_fulfill / ready_to_sell, a per-store breakdown, and an ordered next_steps list. Start here for any first-time setup, and call it again after each connection to confirm the state actually changed. Read-only, makes no provider calls, and is safe to poll.',
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (_input, ctx) => {
    const raw = rec(await ctx.api.get('onboarding/readiness', { signal: ctx.signal }));
    return { ...raw, guidance: guidanceFor(raw) };
  },
});

export const listConnectableProviders = defineTool({
  name: 'list_connectable_providers',
  description:
    'Fulfillment providers and sales channels this account may connect, each marked with how it connects: connect_mode "in_chat" means you can complete it here by asking for a credential, "browser" means you must dispatch an authorization link with start_channel_connect and poll. Also returns where the merchant generates the credential, when there is one. Use this before asking a user for anything, so you ask for the right thing.',
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (_input, ctx) => {
    // Readiness already computes both lists, gated to what this caller may
    // actually connect. Reusing it keeps one source of truth and avoids
    // offering a provider the user would then be refused.
    const raw = rec(await ctx.api.get('onboarding/readiness', { signal: ctx.signal }));
    const options = isRecord(raw.options) ? raw.options : {};
    const fulfillment = Array.isArray(options.fulfillment) ? options.fulfillment : [];
    const channels = Array.isArray(options.sales_channels) ? options.sales_channels : [];
    const inChat = [...fulfillment, ...channels].filter(
      (p) => isRecord(p) && p.connect_mode === 'in_chat',
    ).length;
    return {
      fulfillment_providers: fulfillment,
      sales_channels: channels,
      guidance:
        `${inChat} of ${fulfillment.length + channels.length} can be connected without leaving this conversation. ` +
        'For connect_mode "browser", use start_channel_connect and then poll check_connection_status.',
    };
  },
});

export const connectFulfillmentProvider = defineTool({
  name: 'connect_fulfillment_provider',
  description:
    'Connect an API-token fulfillment provider (Printify, Gelato) to a store, entirely in chat. Validates the token first, so a bad token fails before anything is stored. If the token maps to more than one shop the result asks you to pick one and lists them — call again with shop_id set. For Printful use start_channel_connect instead: it needs a browser. Never repeat the token back to the user.',
  inputSchema: z.object({
    store_uuid: STORE_UUID,
    provider_uuid: PROVIDER_UUID,
    api_token: z
      .string()
      .min(1)
      .describe(
        "The merchant's provider API token. Get the generation URL from list_connectable_providers (credential_url). Treat as a secret: do not echo it.",
      ),
    shop_id: z
      .string()
      .optional()
      .describe('Which shop to connect, when the token maps to several. Omit on the first call.'),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    const base = `store/${enc(input.store_uuid)}/merchandise_provider/${enc(input.provider_uuid)}`;

    // Validate before connecting: a bad token should fail without persisting
    // anything, and the same call is what surfaces a multi-shop token.
    const validated = rec(
      await ctx.api.post(`${base}/validate-pat`, {
        body: { api_token: input.api_token },
        signal: ctx.signal,
      }),
    );

    const shops = Array.isArray(validated.shops) ? validated.shops : [];
    if (!input.shop_id && shops.length > 1) {
      return {
        connected: false,
        needs_shop_selection: true,
        shops,
        guidance:
          'This token has access to more than one shop. Ask the user which one, then call again with shop_id.',
      };
    }

    const body: Record<string, unknown> = { api_token: input.api_token };
    if (input.shop_id) body.shop_id = input.shop_id;

    const connected = rec(await ctx.api.post(`${base}/connect-pat`, { body, signal: ctx.signal }));

    return {
      connected: true,
      // Deliberately does NOT include the token, on any path.
      provider: str(connected, 'provider_name', 'provider') ?? undefined,
      result: connected,
      guidance:
        'Fulfillment is connected. Activate the store with activate_store if it is not already active, then check_setup_readiness to confirm.',
    };
  },
});

export const connectSalesChannel = defineTool({
  name: 'connect_sales_channel',
  description:
    'Connect an API-key sales channel (WooCommerce, Wix) to a store, entirely in chat. For Shopify and TikTok Shop use start_channel_connect instead: they need a browser. Credentials are write-only and are never returned.',
  inputSchema: z.object({
    store_uuid: STORE_UUID,
    provider_uuid: PROVIDER_UUID,
    credentials: z
      .record(z.string(), z.unknown())
      .describe(
        'Channel credentials, e.g. WooCommerce { store_url, consumer_key, consumer_secret }; Wix { api_key, site_id }. Treat as secrets: do not echo them.',
      ),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    const raw = rec(
      await ctx.api.post(
        `store/${enc(input.store_uuid)}/ecommerce/${enc(input.provider_uuid)}/connect-api-key`,
        { body: input.credentials, signal: ctx.signal },
      ),
    );
    return {
      connected: true,
      result: raw,
      guidance:
        'Sales channel connected. Use check_setup_readiness to confirm, then sync_to_channel to list products on it.',
    };
  },
});

export const startChannelConnect = defineTool({
  name: 'start_channel_connect',
  description:
    'Begin a browser-based connection (Printful, Shopify, TikTok Shop, Fourthwall). Returns an authorization URL to give the user. THE CONNECTION IS NOT FINISHED WHEN THIS RETURNS. You must keep polling check_connection_status until it reports connected, then tell the user. The browser tab where they authorize is NOT this conversation and cannot report back to you, so polling is the only way you or they will learn it worked. Poll every few seconds, up to about two minutes, and if it has not landed by then ask whether they finished authorizing rather than giving up silently. If they need to create an upstream account first, let them, then call this again for a fresh link.',
  inputSchema: z.object({
    provider_uuid: PROVIDER_UUID,
    kind: z
      .enum(['fulfillment', 'sales_channel'])
      .describe('Which family this provider belongs to (from list_connectable_providers.family).'),
    store_uuid: z
      .string()
      .optional()
      .describe(
        'Store to attach to. Required for sales_channel. For fulfillment, omit it together with store_name to create a new store.',
      ),
    store_name: z
      .string()
      .optional()
      .describe('Name for a NEW store, when connecting fulfillment without an existing store_uuid.'),
    callback_url: z
      .string()
      .optional()
      .describe(
        'Where the browser lands after authorizing. Must be an ApparelHub app URL; anything else is rejected. Defaults to the platform callback, which is usually what you want.',
      ),
  }),
  annotations: { openWorldHint: true },
  handler: async (input, ctx) => {
    let raw: Record<string, unknown>;

    if (input.kind === 'sales_channel') {
      if (!input.store_uuid) {
        return {
          started: false,
          error: 'store_uuid is required to connect a sales channel.',
          guidance: 'Create or pick a store first, then call again with store_uuid.',
        };
      }
      const body: Record<string, unknown> = {};
      if (input.callback_url) body.callback_url = input.callback_url;
      raw = rec(
        await ctx.api.post(
          `store/${enc(input.store_uuid)}/ecommerce/${enc(input.provider_uuid)}/initiate`,
          { body, signal: ctx.signal },
        ),
      );
    } else {
      const body: Record<string, unknown> = {};
      if (input.store_uuid) body.store_uuid = input.store_uuid;
      else if (input.store_name) body.name = input.store_name;
      if (input.callback_url) body.callback_url = input.callback_url;
      raw = rec(
        await ctx.api.post(`store/create/merchandise_provider/${enc(input.provider_uuid)}`, {
          body,
          signal: ctx.signal,
        }),
      );
    }

    const authUrl =
      str(raw, 'auth_url', 'redirect_url', 'authorization_url', 'oauth_url') ?? undefined;

    return {
      started: true,
      authorization_url: authUrl,
      store_uuid: str(raw, 'uuid', 'store_uuid') ?? input.store_uuid,
      result: raw,
      // Structured, because a sentence is easy for a model to skip and this
      // step is the one that decides whether the user ever learns the outcome.
      next_action: authUrl ? 'poll_check_connection_status' : 'retry_start_channel_connect',
      guidance: authUrl
        ? 'Give the user this link and ask them to authorize in a browser. Then KEEP POLLING check_connection_status until connected is true, and tell them when it lands. Do not stop after handing over the link: the tab where they authorize cannot report back to this conversation, so your poll is the only way the result reaches them. Poll every few seconds for about two minutes; if it has not landed, ask whether they finished authorizing.'
        : 'The provider did not return an authorization URL. Re-check the provider and store, then try again.',
    };
  },
});

export const checkConnectionStatus = defineTool({
  name: 'check_connection_status',
  description:
    'Poll whether a dispatched connection has completed. Call this repeatedly after start_channel_connect while the user authorizes in their browser, and announce the result when it lands: they cannot see this conversation from the tab they authorized in, so if you do not tell them, nobody does. Read-only, makes no provider call, and is safe to poll every few seconds. connected true means say so and continue setup. connected false means keep waiting. needs_reconnect means retrying will never work and you must dispatch a fresh link with start_channel_connect.',
  inputSchema: z.object({
    store_uuid: z
      .string()
      .optional()
      .describe('Narrow the answer to one store. Omit to get the whole account.'),
  }),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (input, ctx) => {
    // Readiness is the poll target on purpose: it reads persisted connection
    // state and makes NO provider call, so polling it cannot burn a provider
    // rate limit no matter how eager the model is.
    const raw = rec(await ctx.api.get('onboarding/readiness', { signal: ctx.signal }));
    const stores = Array.isArray(raw.stores) ? raw.stores : [];
    const scoped = input.store_uuid
      ? stores.filter((s) => isRecord(s) && s.uuid === input.store_uuid)
      : stores;

    const connected = scoped.some(
      (s) => isRecord(s) && isRecord(s.fulfillment) && s.fulfillment.connected === true,
    );
    const needsReconnect = scoped.filter(
      (s) =>
        isRecord(s) &&
        isRecord(s.fulfillment) &&
        s.fulfillment.connection_state === 'reconnect_required',
    );

    return {
      connected,
      stores: scoped,
      needs_reconnect: needsReconnect.length > 0,
      guidance: needsReconnect.length
        ? 'A fulfillment connection has stopped working. Retrying will not fix it — dispatch start_channel_connect again so the user can re-authorize.'
        : connected
          ? 'Connected. Continue with check_setup_readiness for the next step.'
          : 'Not connected yet. If the user has authorized in their browser, wait a few seconds and poll again.',
    };
  },
});

export const setupTools = [
  checkSetupReadiness,
  listConnectableProviders,
  connectFulfillmentProvider,
  connectSalesChannel,
  startChannelConnect,
  checkConnectionStatus,
];

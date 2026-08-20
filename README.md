# @apparelhub/mcp-server

Workflow-level [MCP](https://modelcontextprotocol.io/) tools that let an AI agent run an
ApparelHub store end to end: set it up, design apparel, build products, list them across sales
channels, and work the orders and listings that come back. Each tool wraps the
[ApparelHub Agent API](https://apparelhub.ai/agents) and bakes in the platform's hard-won
production lessons, so the agent gets correct behavior for free instead of learning the gotchas
itself.

There are two ways to run it: a **hosted connector you authorize with OAuth** (recommended, no API
key to handle) and this **npm package you run yourself** with a key. Both serve the identical tool
surface.

> **Status: early access.** The npm package is pre-1.0 while the surface stabilizes. The
> agent-facing **tool surface is v1** and is the contract we keep stable (see
> [`CHANGELOG.md`](./CHANGELOG.md) and [Versioning](#versioning--stability)).

## What makes this different

A thin wrapper around a REST API just renames HTTP calls. These tools are at the **workflow
level**: one `ship_product` call resolves variants, generates and waits for a mockup (through the
two-phase completion gate), creates the product with the right field names, adds every variant,
associates it with a store, and syncs to fulfillment and channels in the correct order, refusing a
negative-margin price and warning on known variant traps along the way. The scar tissue lives in
the code, not in your agent's context.

## Connect

**Prefer the hosted connector.** Authorizing it provisions the API key for you, so there is no
credential to create, paste, rotate, or leak into a config file. Reach for the self-run package
only when your client cannot speak remote MCP or OAuth, or when you specifically want the server
running on your own machine.

| | Hosted connector (OAuth) | Self-run package (API key) |
|---|---|---|
| Credential | Provisioned for you on approval | You create and paste an API key |
| Local prerequisites | None | Node.js 20+, Python 3 + Pillow, optionally tesseract |
| Transport | Remote MCP over HTTP | stdio |
| Best for | Any client that supports remote MCP | Clients without remote/OAuth support, local control, development |

### Recommended: the hosted connector

```
https://mcp.apparelhub.ai/mcp
```

Add that URL to any MCP client that supports remote servers, sign in to ApparelHub, and approve.
**You never handle an API key.** Approving the grant provisions a connector key on your account
(or reuses the one you already have), and the hosted server resolves your session to it on every
call. Nothing to paste, nothing to rotate by hand, nothing sitting in a dotfile.

The hosted server also carries the imaging toolchain the design and quality tools need, so
transparency keying, image statistics, and OCR all work with **no local dependencies at all**: no
Node, no Python, no Pillow, no tesseract.

**Claude Code**

```bash
claude mcp add --transport http apparelhub https://mcp.apparelhub.ai/mcp
```

Then run `/mcp` and choose **Authenticate**.

**Any client that reads an MCP config file**

```jsonc
{
  "mcpServers": {
    "apparelhub": {
      "type": "http",
      "url": "https://mcp.apparelhub.ai/mcp"
    }
  }
}
```

**claude.ai** — add it as a custom connector under Settings → Connectors, paste the same URL, then
authorize when prompted.

#### What the handshake actually does

Standard OAuth 2.1, nothing custom for you to configure. Your client discovers the authorization
server from `/.well-known/oauth-protected-resource` (RFC 9728), registers itself dynamically, and
runs an authorization-code flow with PKCE (`S256`) for the `mcp` scope against
`https://api.apparelhub.ai`. Refresh tokens and revocation are supported. Access tokens are opaque:
the hosted server exchanges yours for your connector key server-side, so the key is never in your
client, your config, or your chat history.

#### Key slots and revoking

One connector key is minted per account and shared across every chat surface you grant, and it
counts against your plan's API key allowance. The Free plan includes API access with one slot, so
if that slot is already taken by a self-service key the consent screen says so and offers to free
it or upgrade. To revoke, disconnect from the client that holds the grant, or delete the connector
key at <https://apparelhub.ai/developer/api-keys>.

### Alternative: run the package yourself

Requirements:

- **Node.js 20+**.
- An **ApparelHub account and API key** — generate one at
  <https://apparelhub.ai/developer/api-keys>.
- For the design + quality tools only: **Python 3 with Pillow** (transparency keying, image QC)
  and optionally **tesseract** (OCR text detection). These run locally; if they're missing, those
  tools return a clear notice telling you exactly what to install, and never crash.

The server reads your key from the `APPARELHUB_API_KEY` environment variable at startup and speaks
MCP over stdio. It never accepts the key as a tool argument, and the API host is pinned (no
override).

#### Claude Code

```jsonc
// ~/.claude/mcp.json (or a project .mcp.json)
{
  "mcpServers": {
    "apparelhub": {
      "command": "npx",
      "args": ["-y", "@apparelhub/mcp-server"],
      "env": { "APPARELHUB_API_KEY": "your-key-here" }
    }
  }
}
```

#### Cursor

```jsonc
// .cursor/mcp.json
{
  "mcpServers": {
    "apparelhub": {
      "command": "npx",
      "args": ["-y", "@apparelhub/mcp-server"],
      "env": { "APPARELHUB_API_KEY": "your-key-here" }
    }
  }
}
```

#### Aider

```yaml
# .aider.conf.yml
mcp-servers:
  apparelhub:
    command: npx
    args: ["-y", "@apparelhub/mcp-server"]
    env:
      APPARELHUB_API_KEY: your-key-here
```

#### Any other MCP client

Same shape everywhere: run `npx -y @apparelhub/mcp-server` with `APPARELHUB_API_KEY` in its
environment.

#### Environment variables

| Variable | Purpose |
|---|---|
| `APPARELHUB_API_KEY` | **Required.** Your ApparelHub API key. Not needed on the hosted connector. |
| `APPARELHUB_MCP_TELEMETRY` | Set to `off` to disable the coarse usage signal (see [Privacy](#privacy)). |
| `APPARELHUB_MCP_PYTHON` | Path to the Python 3 interpreter for the local image tools (default `python3`). |

## Tools

121 tools. [`docs/TOOLS.md`](./docs/TOOLS.md) walks through the core groups; call `tools/list` from
your agent for the authoritative live schemas.

- **Setup & connect** — `check_setup_readiness` (what the account has, what it needs, the single
  next action), `list_connectable_providers`, `connect_fulfillment_provider` and
  `connect_sales_channel` (API-token providers connected entirely in chat), plus
  `start_channel_connect` / `check_connection_status` for the browser-based ones (Printful,
  Shopify, TikTok Shop, Fourthwall).
- **Read** — `list_my_workspaces`, `list_my_stores`, `list_my_designs`, `list_my_products`,
  `list_my_orders`, `get_order_details`.
- **Catalog** — `browse_catalog`, `get_garment_details`, `find_garments` (search every connected
  provider at once for a capability), `recommend_garment`, `list_catalog_providers`.
- **Design** — `design_apparel`, `iterate_design`, `upload_design` (bring artwork the merchant
  already owns), `fit_aspect` (quota-free reshape), design lifecycle (`archive_design`,
  `restore_design`, `delete_design`), and split primitives `generate_image`,
  `process_transparency`, `verify_design_text`.
- **Product** — `ship_product`, `update_product`, `delete_product`, `unsync_from_channel`,
  `diagnose_tiktok_listings`, and split primitives `create_product`, `add_variants`,
  `sync_to_fulfillment`, `sync_to_channel`.
- **Orders** — lifecycle (`approve_order`, `unapprove_order`, `hold_order`, `cancel_order`,
  `confirm_order`, `submit_order_to_fulfillment`, `check_order_status`, `reconcile_order`),
  draft edits (`add_order_item`, `remove_order_item`), and design-approval holds
  (`list_order_holds`, `approve_order_hold`, `request_hold_changes`).
- **Fulfillment issues** — `report_fulfillment_issue` (report a defect on an order),
  `list_fulfillment_issues` (per-order or workspace-wide inbox), `check_fulfillment_issue` (full
  issue plus the provider-ready problem report), `resolve_fulfillment_issue` (record the provider
  filing, close with a resolution, or create a replacement order).
- **Channel intelligence** — what the sales channel itself reports and what you can set on it:
  `channel_performance`, `channel_opportunities`, `channel_coverage`, `listing_changes` (did the
  last edit actually work), `describe_listing_attributes`, `set_listing_attributes`,
  `set_channel_settings`, `import_size_measurements`.
- **Analytics** — `analytics_summary`, `analytics_timeseries`, `analytics_breakdown`,
  `analytics_ops`, `analytics_portfolio`.
- **Collections** — `list_collections`, `get_collection`, `create_collection`, `update_collection`,
  `delete_collection`, `add_products_to_collection`, `remove_product_from_collection`,
  `sync_collection`.
- **Cross-workspace transfer** — `copy_product_to_workspace`, `move_product_to_workspace`,
  `check_product_move`, and the design equivalents.
- **Workspace & team management** (agency / Enterprise, account-wide key) — workspaces
  (`create_workspace`, `update_workspace`, `delete_workspace`, `check_workspace_deletion`,
  `assign_workspace_member`, `unassign_workspace_member`, `move_store_to_workspace`,
  `get_role_matrix`) and team (`get_account_overview`, `list_account_members`, `remove_member`,
  `invite_member`, `list_invites`, `revoke_invite`, `resend_invite`, `accept_invite`).
- **Store & order management** — store settings/lifecycle (`get_store_settings`,
  `update_store_settings`, `create_store`, `archive_store`, `unarchive_store`, `activate_store`),
  order payment/ops (`record_order_payment`, `mark_order_no_payment`, `set_order_payment_method`,
  `sync_orders`, `estimate_order_costs`, `get_orders_summary`, `list_pending_fulfillments`), and
  `archive_product` / `restore_product`.
- **Systems of action** — `analyze_what_works`, `auto_optimize_listings`, `cascade_price_change`,
  `set_prices_by_margin`, `recover_from_outage`.
- **Safety** — `verify_design_quality`, `verify_mockup_quality`, `check_design_compliance`.
- **API escape hatch** — `get_api_reference` (discover the full agent API from the live OpenAPI
  spec) and `api_request` (call any `/agents/v1` endpoint when no dedicated tool fits).

Read tools are read-only. Product and design tools default to **draft, never live**, enforce
pricing floors, and guard known variant traps. Systems-of-action mutations default to a **dry run**
and only take safe actions (archive, never delete) when applied. Every product/order/store result
carries a `view_url` back into apparelhub.ai. Errors come back in a consistent shape
(`{error: {code, message, retry_after?, suggestion?}}`) — tools never throw across the MCP boundary.

`get_api_reference` also reports what the server you are actually talking to serves — its version,
tool count, and every tool name — so an agent can tell "that tool does not exist" apart from "my
cached tool list is stale" instead of guessing.

## Privacy

An optional, coarse usage signal helps improve the tools. It sends **only** non-identifying
features — the tool name, outcome, latency, error code, and a strict allowlist of coarse fields
(e.g. AI source name, garment category). It **never** sends prompts, images, ids, URLs, or customer
data. It's buffered and fire-and-forget (it can never affect a tool call). Turn it off entirely
with `APPARELHUB_MCP_TELEMETRY=off`.

The hosted connector additionally records one operational metric per request (outcome, latency, and
for a tool call the tool name). It carries no per-identity dimension and no user data.

## Skill vs. MCP

ApparelHub ships the same knowledge in two forms:

- The **[markdown skill](https://github.com/ApparelHub-AI/apparelhub-skills)** is the
  lowest-friction way to use ApparelHub from Claude Code — it teaches the agent the REST API and
  the design rules directly.
- This **MCP server** turns that knowledge into a typed, callable tool surface (with the
  systems-of-action tools) that works across any MCP-capable agent, and, through the hosted
  connector, in chat surfaces that cannot run a skill or a local process at all.

Use the skill for a quick start in Claude Code; use the MCP server when you want typed tools, the
higher-order workflows, or a client other than Claude Code.

## Development

```bash
npm ci
npm run build      # tsc -> dist/
npm run typecheck
npm run lint
npm test           # vitest
```

The image tools shell out to bundled Python scripts in [`python/`](./python); the imaging layer is
injectable, so the tool orchestration is unit-tested with a fake and the scripts are smoke-tested
directly.

## Versioning & stability

The **tool surface** is versioned separately from the package (this is v1). When the underlying
REST API evolves, the server adapts internally — the agent-facing tool names + shapes stay stable.
That's the contract that lets you install once and keep working. Package releases follow
[Semantic Versioning](https://semver.org/); see [`docs/RELEASING.md`](./docs/RELEASING.md).

On the hosted connector you are always on the current version, which is another reason to prefer
it: new tools appear without you upgrading anything. Clients cache the tool list, so ask
`get_api_reference` if you suspect yours has fallen behind.

## License

MIT © ApparelHub. See [`LICENSE`](./LICENSE).

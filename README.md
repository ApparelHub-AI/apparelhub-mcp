# @apparelhub/mcp-server

Workflow-level [MCP](https://modelcontextprotocol.io/) tools that let an AI agent run an
ApparelHub store end to end: design apparel, build products, sync them to sales channels, and
manage orders. Each tool wraps the [ApparelHub Agent API](https://apparelhub.ai/agents) and bakes
in the platform's hard-won production lessons, so the agent gets correct behavior for free instead
of learning the gotchas itself.

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

## Requirements

- **Node.js 20+**.
- An **ApparelHub account and API key** — generate one at
  <https://apparelhub.ai/developer/api-keys>.
- For the design + quality tools only: **Python 3 with Pillow** (transparency keying, image QC)
  and optionally **tesseract** (OCR text detection). These run locally; if they're missing, those
  tools return a clear notice telling you exactly what to install, and never crash.

## Install & configure

The server reads your key from the `APPARELHUB_API_KEY` environment variable at startup and speaks
MCP over stdio. It never accepts the key as a tool argument, and the API host is pinned (no
override).

### Claude Code

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

### Cursor

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

### Aider

```yaml
# .aider.conf.yml
mcp-servers:
  apparelhub:
    command: npx
    args: ["-y", "@apparelhub/mcp-server"]
    env:
      APPARELHUB_API_KEY: your-key-here
```

### claude.ai / any MCP client

Any MCP-capable client uses the same shape: run `npx -y @apparelhub/mcp-server` with
`APPARELHUB_API_KEY` in its environment.

### Environment variables

| Variable | Purpose |
|---|---|
| `APPARELHUB_API_KEY` | **Required.** Your ApparelHub API key. |
| `APPARELHUB_MCP_TELEMETRY` | Set to `off` to disable the coarse usage signal (see [Privacy](#privacy)). |
| `APPARELHUB_MCP_PYTHON` | Path to the Python 3 interpreter for the local image tools (default `python3`). |

## Tools

74 tools. See [`docs/TOOLS.md`](./docs/TOOLS.md) for the full reference; call `tools/list` from
your agent for the live schemas.

- **Read** — `list_my_workspaces`, `list_my_stores`, `list_my_designs`, `list_my_products`,
  `list_my_orders`, `get_order_details`.
- **Catalog** — `browse_catalog`, `get_garment_details`, `recommend_garment`.
- **Design** — `design_apparel`, `iterate_design`, and split primitives `generate_image`,
  `process_transparency`, `verify_design_text`.
- **Product** — `ship_product`, `update_product`, `delete_product`, and split primitives
  `create_product`, `add_variants`, `sync_to_fulfillment`, `sync_to_channel`.
- **Orders** — lifecycle (`approve_order`, `unapprove_order`, `hold_order`, `cancel_order`,
  `confirm_order`, `submit_order_to_fulfillment`, `check_order_status`, `reconcile_order`) and
  design-approval holds (`list_order_holds`, `approve_order_hold`, `request_hold_changes`).
- **Analytics** — `analytics_summary`, `analytics_timeseries`, `analytics_breakdown`,
  `analytics_ops`, `analytics_portfolio`.
- **Collections** — `list_collections`, `get_collection`, `create_collection`, `update_collection`,
  `delete_collection`, `add_products_to_collection`, `remove_product_from_collection`,
  `sync_collection`.
- **Cross-workspace transfer** — `copy_product_to_workspace`, `move_product_to_workspace`,
  `check_product_move`, and the design equivalents.
- **Store & order management** — store settings/lifecycle (`get_store_settings`,
  `update_store_settings`, `create_store`, `archive_store`, `unarchive_store`, `activate_store`),
  order payment/ops (`record_order_payment`, `mark_order_no_payment`, `set_order_payment_method`,
  `sync_orders`, `estimate_order_costs`, `get_orders_summary`, `list_pending_fulfillments`), and
  `archive_product` / `restore_product`.
- **Systems of action** — `analyze_what_works`, `auto_optimize_listings`, `cascade_price_change`,
  `recover_from_outage`.
- **Safety** — `verify_design_quality`, `check_design_compliance`.
- **API escape hatch** — `get_api_reference` (discover the full agent API from the live OpenAPI
  spec) and `api_request` (call any `/agents/v1` endpoint when no dedicated tool fits).

Read tools are read-only. Product and design tools default to **draft, never live**, enforce
pricing floors, and guard known variant traps. Systems-of-action mutations default to a **dry run**
and only take safe actions (archive, never delete) when applied. Every product/order/store result
carries a `view_url` back into apparelhub.ai. Errors come back in a consistent shape
(`{error: {code, message, retry_after?, suggestion?}}`) — tools never throw across the MCP boundary.

## Privacy

An optional, coarse usage signal helps improve the tools. It sends **only** non-identifying
features — the tool name, outcome, latency, error code, and a strict allowlist of coarse fields
(e.g. AI source name, garment category). It **never** sends prompts, images, ids, URLs, or customer
data. It's buffered and fire-and-forget (it can never affect a tool call). Turn it off entirely
with `APPARELHUB_MCP_TELEMETRY=off`.

## Skill vs. MCP

ApparelHub ships the same knowledge in two forms:

- The **[markdown skill](https://github.com/ApparelHub-AI/apparelhub-skills)** is the
  lowest-friction way to use ApparelHub from Claude Code — it teaches the agent the REST API and
  the design rules directly.
- This **MCP server** turns that knowledge into a typed, callable tool surface (with the
  systems-of-action tools) that works across any MCP-capable agent, not just Claude Code.

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

## License

MIT © ApparelHub. See [`LICENSE`](./LICENSE).

# @apparelhub/mcp-server

Workflow-level [MCP](https://modelcontextprotocol.io/) tools that let an AI agent run an
ApparelHub store: design apparel, build products, sync them to sales channels, and manage
orders. The tools wrap the [ApparelHub Agent API](https://apparelhub.ai/agents) and bake in
the platform's hard-won production lessons, so an agent gets correct behavior without having
to learn the gotchas itself.

> **Status:** early access. The package version is pre-1.0 while the surface stabilizes; the
> agent-facing **tool surface is v1** and is the contract we keep stable (see
> [`CHANGELOG.md`](./CHANGELOG.md)).

## Requirements

- Node.js 20 or newer.
- An ApparelHub account and an API key. Generate one at
  <https://apparelhub.ai/developer/api-keys>.

## Quick start

The server reads your key from the `APPARELHUB_API_KEY` environment variable at startup and
speaks MCP over stdio. It never takes the key as a tool argument.

### Claude Code

```jsonc
// ~/.claude/mcp.json (or your project's .mcp.json)
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

The same `command` / `args` / `env` shape works for any MCP-capable client (Cursor, Aider,
and others). Full config snippets live in the docs.

## Tools

The surface is workflow-level, not a thin REST wrapper. It ships in groups (design, product,
catalog, read, systems-of-action, safety). Call `tools/list` from your agent for the current
set and each tool's schema. Read tools are read-only; product and design tools default to
**draft, never live**, and enforce ApparelHub's pricing floors and quality gates.

## Privacy

An optional, coarse, per-tool-call telemetry signal helps improve the tools. It never sends
prompts, images, or customer data — only non-identifying features (e.g. tool name, outcome,
garment type). Turn it off with `APPARELHUB_MCP_TELEMETRY=off`.

## Development

```bash
npm ci
npm run build      # tsc -> dist/
npm run typecheck
npm run lint
npm test           # vitest
```

## License

MIT © ApparelHub. See [`LICENSE`](./LICENSE).

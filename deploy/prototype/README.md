# Phase 0.5 prototype — remote MCP on a Lambda Function URL

Throwaway deployment for [epic #31](https://github.com/ApparelHub-AI/apparelhub-mcp/issues/31) /
[ticket #38](https://github.com/ApparelHub-AI/apparelhub-mcp/issues/38): prove the existing tool
surface works over MCP **streamable HTTP** from a real hosted chat surface (Claude.ai custom
connector) before any authorization-server work.

What it is:

- The full existing tool surface (`src/server.ts`), served **stateless** — a fresh server +
  transport per request, `enableJsonResponse` so every POST returns a plain JSON body.
- **Static bearer auth**, prototype-only: `Authorization: Bearer <secret>` or a `/<secret>/mcp`
  path prefix (for connector UIs that only accept a URL). The real OAuth flow is Phase 2.
- One test account: the deploy parameters carry a single platform API key. Do not point this at
  anything you would not burn quota on.
- Local image tooling (transparency, OCR) degrades with a structured notice on this runtime —
  by design. Those tools go container-packaged in Phase 1.

## Deploy

Prerequisites: AWS SAM CLI, credentials for the target account, Node 20+.

```bash
# 1. Build the bundle
deploy/prototype/build.sh

# 2. Deploy (secrets come from your shell, never from a committed file)
export APPARELHUB_API_KEY=...           # test-account Agent API key
export MCP_BEARER="$(openssl rand -hex 32)"

sam deploy \
  --template-file deploy/prototype/template.yaml \
  --stack-name apparelhub-mcp-prototype \
  --resolve-s3 \
  --capabilities CAPABILITY_IAM \
  --tags Managed-by=SAM Project=apparelhub-mcp Lifecycle=prototype \
  --parameter-overrides "ApparelhubApiKey=$APPARELHUB_API_KEY McpBearer=$MCP_BEARER"
```

The stack output `FunctionUrl` is the base URL. The connector endpoint is:

```
<FunctionUrl><MCP_BEARER>/mcp
```

## Smoke test

```bash
BASE=<FunctionUrl>   # ends with /

curl -s "${BASE}healthz"   # -> {"ok":true}

# initialize (note: Accept must offer both content types per the MCP spec)
curl -s -X POST "${BASE}${MCP_BEARER}/mcp" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

# tools/list
curl -s -X POST "${BASE}${MCP_BEARER}/mcp" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

## Connect from Claude.ai

Settings → Connectors → Add custom connector → paste `<FunctionUrl><MCP_BEARER>/mcp`.
No OAuth prompt should appear (the URL embeds the prototype secret).

While testing, record for the ticket: observed tool-call timeout behavior, how long-running
tools degrade, and anything surprising in how the surface renders tool results.

## Teardown

```bash
sam delete --stack-name apparelhub-mcp-prototype
```

Rotate (delete) the test API key afterwards if it was minted for this prototype.

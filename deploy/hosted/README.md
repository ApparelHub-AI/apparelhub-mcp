# Hosted remote MCP server (Phase 1)

The non-throwaway sibling of `deploy/prototype/`: same stateless streamable-HTTP handler
(`src/http/lambda.ts`), packaged as a **container image** so the python + Pillow imaging
toolchain works hosted (transparency keying, quality stats). Static bearer auth remains the
Phase 1 interim; the OAuth authorization server is Phase 2 (#34).

Deploys run from CI: **Actions → "Deploy hosted MCP server"** → pick the environment. The
workflow builds the esbuild bundle, docker-builds via `sam build`, and deploys with secrets
from the GitHub environment (`APPARELHUB_AGENT_API_KEY`, `MCP_BEARER`). There is no local
deploy path by design — image builds need docker, and CI owns the credentials.

Smoke and connector instructions are identical to `deploy/prototype/README.md` (the endpoint
shape is the same: `<FunctionUrl><MCP_BEARER>/mcp`).

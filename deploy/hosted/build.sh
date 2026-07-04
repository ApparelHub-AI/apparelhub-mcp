#!/usr/bin/env bash
# Build the hosted Lambda bundle (Phase 1, ticket #33).
# Output: deploy/hosted/build/handler.mjs — consumed by deploy/hosted/Dockerfile.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="$REPO_ROOT/deploy/hosted/build"

cd "$REPO_ROOT"
npm run build

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

npx --yes esbuild dist/http/lambda.js \
  --bundle \
  --platform=node \
  --format=esm \
  --target=node22 \
  --outfile="$OUT_DIR/handler.mjs" \
  --banner:js='import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'

# Smoke the bundle: the unauthenticated liveness probe must answer.
node --input-type=module -e "
import { handler } from '$OUT_DIR/handler.mjs';
const res = await handler({ rawPath: '/healthz', requestContext: { http: { method: 'GET' } } });
if (res.statusCode !== 200 || JSON.parse(res.body).ok !== true) {
  console.error('bundle smoke FAILED:', res);
  process.exit(1);
}
console.log('bundle smoke: healthz ok');
"

echo "Built $OUT_DIR/handler.mjs ($(du -h "$OUT_DIR/handler.mjs" | cut -f1))"

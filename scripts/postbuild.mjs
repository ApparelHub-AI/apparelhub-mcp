// Ensure the compiled CLI entrypoint is executable and carries a node shebang,
// so `npx @apparelhub/mcp-server` works. tsc does not reliably preserve shebangs.
import { readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';

const entry = 'dist/index.js';
if (!existsSync(entry)) {
  console.error(`postbuild: ${entry} not found (did the build run?)`);
  process.exit(1);
}
const shebang = '#!/usr/bin/env node\n';
let src = readFileSync(entry, 'utf8');
if (!src.startsWith('#!')) {
  writeFileSync(entry, shebang + src);
}
chmodSync(entry, 0o755);
console.log(`postbuild: ensured shebang + exec bit on ${entry}`);

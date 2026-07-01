# Releasing

`@apparelhub/mcp-server` follows [Semantic Versioning](https://semver.org/). The **tool surface**
is versioned separately (see `src/version.ts` `TOOL_SURFACE_VERSION`): adding a tool or an
optional field is a minor package bump; a breaking change to an existing tool's name/shape is a
major bump and should be rare — the whole point of the surface is that agents install once and keep
working as the REST API evolves underneath.

## Cutting a release

1. Land all changes on `main` via PR (CI green on Node 20 + 22).
2. Bump `version` in `package.json` **and** `SERVER_VERSION` in `src/version.ts` (a unit test
   asserts they match, so they can't drift).
3. Move the `CHANGELOG.md` `[Unreleased]` items under the new version heading with a date.
4. Merge, then create a **GitHub Release** for the tag `vX.Y.Z`. That triggers
   `.github/workflows/publish.yml`.

## Publishing (npm)

`publish.yml` runs on a published Release (or manual dispatch). It builds, tests, and then:

- **If the `NPM_TOKEN` repo secret is set** → `npm publish --provenance --access public`.
- **If not** → `npm publish --dry-run` only, and logs a warning. This is the current state: the
  pipeline is wired but stubbed until credentials are added.

### Enabling real publishing (later)

1. Create an npm **automation** access token for an account that can publish to the `@apparelhub`
   scope.
2. Add it as the `NPM_TOKEN` repository secret (Settings → Secrets and variables → Actions).
3. The next published Release will publish for real — no workflow change needed. Provenance uses
   the workflow's OIDC `id-token: write` permission (already granted).

## Post-public checklist

The repo is private during early access. When it's made public:

- Flip the npm publish on (add `NPM_TOKEN` as above).
- List the server in the MCP registry / directory for discoverability.
- Add the MCP install path to the apparelhub.ai `/agents` funnel (and/or a `/mcp` page) alongside
  the skill (an `apparelhub-ui` change).
- Run the public-content scan before the first public tag (no real account data anywhere — names,
  uuids, store URLs; use generic placeholders like `your-store`, `Acme`, `<uuid>`).

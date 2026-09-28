# Contributing to Omnium

Omnium is a local marketplace of zero-dependency, no-build Claude Code
plugins under `plugins/<name>/` — that folder is byte-for-byte what installs.
Two files are the binding sources of truth and this guide does **not** duplicate
them: [`DESIGN.md`](DESIGN.md) (decisions + backward-compatibility contract) and
[`docs/development.md`](docs/development.md) (workflow + the 15-rule style
charter). Read both before a non-trivial change.

## Setup

```
npm install
git config core.hooksPath scripts/git-hooks
```

The pre-commit hook auto-stamps plugin versions; without it `npm run check`
still catches drift, so skipping it only defers the failure.

## Dev loop

- **Iterate:** `claude --plugin-dir <checkout>/plugins/<name>` — no cache, live tree.
- **Release:** commit (hook bumps) → `/plugin marketplace update omnium` → `/reload-plugins`.

See [`docs/development.md`](docs/development.md) for the why (the stale-cache footgun).

## The three hard rules

A reviewer will bounce a PR for any of these; the detail lives in `DESIGN.md`.

- **Zero runtime deps is a defect, not a preference.** An import under
  `plugins/**` that is not `node:*` or relative fails
  `tests/omnium/zero-dep.test.mjs`. No
  `package.json`/`node_modules` under `plugins/`. (DESIGN.md directive 2)
- **No build; ported behavior is frozen.** Shipped bytes are a frozen surface;
  ported quirks are kept and documented, never "fixed". (directive 1, charter rule 14)
- **Cross-platform or rejected.** No POSIX-only assumptions — Windows, macOS and
  Linux must all work. (directive 4)

Everything else — headers, JSDoc, naming, fail-open posture — is the 15-rule
charter in [`docs/development.md`](docs/development.md).

## Editing shared code

Canonical shared modules live in `shared/*.mjs` (mcp-core, mcp-schema, project,
atomic-write, lock-core, path-key). Consumers (`expertum`, `graphyne`,
`memosyne`) carry **byte-identical** copies in `common/`; the plugins with no
MCP server (`cautium`, `contextum`, `distillum`, `sessio`, `statusline`) have none — never
give them one.

Edit only under `shared/`, then `npm run sync:shared`. Editing a `common/` copy
in place is caught by `tests/omnium/vendoring.test.mjs`. See DESIGN.md **D13**
for the
factory-shim vs copy-as-module distinction.

## Versioning

Semver lives in `plugins/<name>/.claude-plugin/plugin.json` **only** — never in
marketplace entries. The pre-commit hook auto-bumps PATCH from a content hash;
you hand-bump MINOR for a deliberate feature; MAJOR is banned (no breaking
changes). Commit a plugin's changes wholly — the guard hashes the working tree.

## Before you open a PR

- `npm run check` is green (oxlint + version-guard + `node --test` + `tsc --noEmit`), no
  skipped or todo tests. GitHub Actions re-runs that exact script on Linux for
  every push and PR (`.github/workflows/ci.yml`) — a red cross there is the same
  gate failing, not a separate one.
- Behavioral/ported change: the plugin's own suite + parity fixtures + repo
  guards green, plus one `--plugin-dir` smoke session. (DESIGN.md **D10**)
- Update `CHANGELOG.md` only for a user-visible change or a MINOR — automatic
  PATCH bumps are not logged.
- Comments and commit messages in English; no emojis; no `TODO`/`FIXME` shipped.

**Do not:** add a runtime dep or build step; edit `common/` copies directly;
put a `version` in marketplace entries; hand-edit `.plugin-versions.json`; use
SHA versioning; or break any frozen surface (tool names, schemas, error text,
hook events, store formats, env vars).

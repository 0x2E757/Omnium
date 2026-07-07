# Omnium design — versioning discipline (Q6) and test strategy / DoD (Q8)

## Decisions

1. **Initial versions (minor bump, not patch continuation):** autonomity `0.2.0`, expertum `0.4.0`, graphyne `0.2.0`, memosyne `0.2.0`. Explicit semver stays in `plugin.json` forever; `marketplace.json` entries carry **no** `version` field.
2. **Bump discipline:** patch auto-bumped by a committed **pre-commit hook** (`scripts/git-hooks/pre-commit` → `node scripts/version-guard.mjs --fix`) driven by per-plugin content hashes in a committed `.plugin-versions.json`; MINOR stays hand-managed; MAJOR is effectively banned (no-breaking-changes rule).
3. **Stale-cache footgun neutralized structurally:** dev iteration uses `claude --plugin-dir` (bypasses the cache entirely); promotion to the daily driver is `git commit` (hook bumps automatically) → `/plugin marketplace update omnium` → `/reload-plugins`. A `version-guard` check in the test gate catches missed bumps even if the hook is not installed.
4. **GitHub-forward choice:** keep explicit semver, never switch to SHA versioning. `plugin.json` `version` wins at every level of Claude Code's resolution order, so behavior is identical for a local path marketplace today and `0x2E757/Omnium` later; nothing changes at migration except the footgun disappearing (installs read the committed tree).
5. **Tests live at repo root** (`tests/<plugin>/` + `tests/omnium/` + `tests/parity/`), never inside `plugins/<name>/` — the plugin folder is the shipped artifact and stays byte-identical to the install cache. (Layout proposal; architect-reviewer owns the final call.)
6. **Ported suites keep their assertions** — ported with import-path rewrites only; the frozen assertions pin the shipped behavior. Graphyne/Memosyne `tests/web/*` do not port (web UI is out of Omnium scope).
7. **Parity harness:** differential fixtures under `tests/parity/fixtures/` capture the real `yaml`/`picomatch`/`diff` outputs, which the vendored zero-dep ports must reproduce exactly; each server's stdio e2e test pins the wire contract (tool set, schemas, `tools/call` responses, store-tree bytes).
8. **Drift + invariant guards:** byte-compare test for the vendored shared core; a zero-dep guard test (only `node:` and relative imports under `plugins/`, no `package.json`/`node_modules` inside any plugin folder).
9. **DoD gate per port task:** `npm run check` = `version-guard` (stamps fresh) + `node --test` (ported prior + parity + guards) + `tsc --noEmit`, all green — plus one manual `--plugin-dir` smoke session per plugin before it replaces the installed original.
10. **Toolchain: plain npm** (no pnpm, no workspaces). Root `package.json` with exactly two devDependencies (`typescript`, `@types/node`), `engines: ">=24"`, committed `package-lock.json`. Runtime stays zero-dep.
11. **Repo hygiene:** `.gitignore` = `node_modules/`, `.expertum/`, `*.log` (no `dist/` — nothing is built); commit `.graphyne/`/`.memosyne/` stores; root `CHANGELOG.md` with per-plugin sections; `LICENSE` before GitHub.

---

## Summary

Both questions reduce to the same principle: the upstream plugins already solved these problems once (commit-count stamping, root-level zero-dep test harnesses in Autonomity/Expertum), and Omnium should keep the *shape* of those solutions while removing the parts that only made sense for four separate repos. Versioning becomes explicit semver with an automated per-plugin bump tied to commits; testing becomes "the old suites are the spec" plus a parity harness that replays the exact shipping artifacts frozen from the install cache.

## Scope / What was analyzed

- `the upstream Graphyne source ({package.json,PLUGIN.md,scripts/build-plugin.mjs,tests/**})` and the Memosyne equivalents
- `the upstream Autonomity source ({package.json,scripts/stamp-version.mjs,plugins/autonomity/.claude-plugin/plugin.json,test/})` and `the upstream Expertum source ({package.json,plugins/expertum/PLUGIN.md,.claude-plugin/marketplace.json,.gitignore})`
- Installed artifacts: `~/.claude/plugins/cache/{autonomity/autonomity/0.1.5, expertum/expertum/0.3.5, graphyne/graphyne/0.1.28, memosyne/memosyne/0.1.64}/` (verified present)
- Official plugin reference (version resolution, cache keying): https://code.claude.com/docs/en/plugins-reference

---

## Q6 — Versioning

### 6.1 Version numbers: bump MINOR once, then hand back to automation

The old patch numbers are **commit counts**, not release counters — `scripts/build-plugin.mjs` stamps `MAJOR.MINOR.<git rev-list --count HEAD>` (`the upstream Graphyne source (scripts/build-plugin.mjs:57-72)`; same pattern in `the upstream Autonomity source (scripts/stamp-version.mjs:19-31)`). Continuing the line as `0.1.29`/`0.1.65`/`0.1.6`/`0.3.6` would therefore:

- falsely imply the old counter continues, and
- **collide** if any old repo ever receives one more commit and gets stamped (old-marketplace `graphyne 0.1.29` vs Omnium `graphyne 0.1.29` would be two different artifacts with the same version — poison during the migration window when both marketplaces may coexist on the machine).

A minor bump (`0.1.28 → 0.2.0`, `0.1.64 → 0.2.0`, `0.1.5 → 0.2.0`, `0.3.5 → 0.4.0`) sorts strictly after every floor under semver, is collision-proof against the frozen old lines, and honestly signals "new distribution home, internals rewritten, behavior identical". Note for Expertum specifically: `server.js` reads `plugin.json`'s version into `serverInfo.version` at startup (`the upstream Expertum source (plugins/expertum/PLUGIN.md:54-55)`), so the version string is user-visible on the MCP wire — a clean `0.4.0` reads better there than `0.3.6`.

**Ongoing discipline:** PATCH is machine-bumped (below) whenever a plugin's shipped bytes change; MINOR is hand-bumped only for deliberate feature additions; MAJOR never (breaking changes are forbidden by mandate).

### 6.2 What replaces commit-count stamping: content-hash-driven auto-bump at commit time

Commit-count stamping existed to make "version changes ⇔ bytes changed" hold automatically, because the cache is version-keyed and a forgotten bump once shipped a stale grant-unaware hook (`the upstream Graphyne source (scripts/build-plugin.mjs:60-62)`). In one repo with four plugins, commit count is the wrong signal: it advances all four in lockstep and restarts near zero. But **manual bumping reinstates the exact forgetting failure mode that caused the original bug** — so the replacement must stay automatic, just per-plugin.

Decision: `scripts/version-guard.mjs` (zero-dep, ~80 lines) plus a committed hook directory.

- The script hashes each `plugins/<name>/` tree (sorted relative paths + file bytes → sha256) and compares against a committed stamp file `.plugin-versions.json` (`{ "<name>": { "version": "0.2.0", "hash": "…" } }`).
- `--fix`: for each plugin whose hash changed and whose `plugin.json` version was not already hand-bumped, bump PATCH in `plugins/<name>/.claude-plugin/plugin.json` and rewrite the stamp. Idempotent; also exposed as `npm run stamp`.
- Default (check) mode: exit non-zero listing any plugin whose tree no longer matches its stamp — this is the CI/DoD-gate form.
- `scripts/git-hooks/pre-commit` (committed) runs `--fix` and re-stages `plugin.json` + `.plugin-versions.json`. One-time setup after clone: `git config core.hooksPath scripts/git-hooks` — documented as step 0 in the README. Because the check mode also runs inside the test gate, a machine without the hook installed still cannot pass DoD with a stale version.

This keeps the invariant the old stamping bought (every content change advances the version) while scoping bumps to the plugin that actually changed, and it needs no git history math — so it behaves identically in a fresh shallow clone or a future GitHub CI job.

### 6.3 Neutralizing the stale-cache footgun in daily use

The footgun (documented in `the upstream Graphyne source (PLUGIN.md:68-72)` and `the upstream Memosyne source (PLUGIN.md:58-63)`): the local marketplace serves the working tree, but the install cache keys on the version string, so edits without a bump silently keep serving the cached copy. Two-lane workflow, both lanes safe by construction:

- **Iteration lane:** `claude --plugin-dir /path/to/Omnium/plugins/<name>` — loads the tree in place, no cache involved at all (the mechanism the upstream plugins already document, `the upstream Expertum source (plugins/expertum/PLUGIN.md:68-73)`). This is the only lane where uncommitted edits are exercised, and it cannot go stale.
- **Adoption lane:** `git commit` (pre-commit hook bumps any touched plugin) → `/plugin marketplace update omnium` → `/reload-plugins`. Since version provably changed whenever bytes changed, the update always re-copies. One `marketplace update` command now covers all four plugins instead of four separate ones — a concrete daily-use win of the mono-marketplace.

The residual gap — running `marketplace update` with *uncommitted* plugin edits — is closed by habit ordering (update right after commit) and by `npm run stamp` being safe to run at any moment; document the one rule "commit (or stamp) before update" in Omnium's PLUGIN docs, replacing the two repos' longer footgun warnings.

### 6.4 GitHub later: keep explicit semver; do not switch to SHA versioning

Official resolution order (Claude Code plugins reference, "Version management"): (1) `plugin.json` `version`, (2) marketplace-entry `version`, (3) git commit SHA for git-hosted sources, (4) `unknown`. Two consequences drive the decision:

- **Explicit `plugin.json` versions behave identically before and after the GitHub move** — they win at level 1 in both worlds. Migration changes nothing in versioning; it only *removes* the footgun, because a GitHub marketplace serves committed trees, and the auto-bump guarantees every commit that touches a plugin carries a version change (so the well-known "pushed commits but same version = no update" trap can never occur).
- **SHA versioning is the wrong fit here even though the docs recommend it for fast iteration:** SHAs do not sort (violating the user mandate that new versions sort after `0.1.5`/`0.3.5`/`0.1.28`/`0.1.64`), they version all four plugins in lockstep again (any commit anywhere re-copies everything), and they would surface as the visible version string in the `/plugin` UI and in Expertum's `serverInfo.version` — a regression in continuity and readability.

Corollary: `marketplace.json` plugin entries must **not** carry a `version` field — it is redundant (level 2 loses to level 1), creates a second place to forget, and a stale marketplace-entry version is a known update-blocking foot-gun in the wild ([everything-claude-code #36](https://github.com/affaan-m/everything-claude-code/issues/36)).

**Assumptions delegated to ai-engineer for verification** (stated so conflicts surface):
- A1: `/plugin marketplace update` / update flows are **equality-keyed** on the version string (docs: "skips the update if it matches"), not order-keyed; cache layout is `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` (observed on this machine for all four plugins).
- A2: a local path marketplace serves the working tree at add/update time (as both PLUGIN.md files state).
- A3: `uninstall <p>@<p>` + `install <p>@omnium` is a fresh install with no cross-marketplace version comparison; sort-after matters for human continuity and any future ordering logic, not for the migration itself.
- A4: one `/plugin marketplace update omnium` refreshes all four entries, re-copying only those whose version changed.
- A5: `${CLAUDE_PLUGIN_DATA}` resolves per plugin id (`<plugin>-<marketplace>`), so the marketplace rename changes the data dir (`autonomity-autonomity` → `autonomity-omnium`) — the nudge-state migration/acceptance is ai-engineer's mechanics territory, but versioning imposes no additional constraint on it.

---

## Q8 — Test strategy and definition of done

### 8.1 Where tests live and how the old suites port

**Location (proposal to architect-reviewer):** root-level `tests/<plugin>/` mirroring each upstream suite's internal structure, plus `tests/omnium/` for repo-level invariants and `tests/parity/` for the harness. Rationale: a plugin install copies the entire `plugins/<name>/` folder into the cache, so anything inside it ships to every install; keeping `plugins/<name>/` test-free preserves "repo tree == installed tree" byte parity (excellent for debugging cache issues) and matches the Autonomity/Expertum precedent of a root dev harness explicitly labeled "Not shipped" (`the upstream Autonomity source (package.json:6)`, `the upstream Expertum source (package.json:5)`).

**Port mechanics — imports only, assertions frozen.** The old tests are the behavioral spec; rewriting them would invalidate the oracle. Verified port surface:

- Graphyne: `tests/common/` (13 files), `tests/mcp/mcp.test.mts`, `tests/hook/hook.test.mts`, `tests/helpers.mts` port; `tests/web/*` (api/server/static + 3 frontend files) do **not** — the web UI is out of Omnium scope (context §inventory), which is why the headline "229" will shrink; the port task must record the ported/excluded split explicitly.
- Memosyne: `tests/common/` (6 files), `tests/mcp/mcp-handlers.test.mts`, `tests/hook/claude.test.mts` port; `tests/web/*` excluded likewise.
- Expertum `test/` (5 files) and Autonomity `test/` (4 files) port verbatim — they are already zero-dep `node --test` suites.
- The changes are mechanical: `../../src/common/X.mts` → the new plugin-internal path (e.g. `the upstream Graphyne source (tests/common/graph.test.mts:13)`), and the hook e2e suites spawn the hook by a single path constant (`the upstream Graphyne source (tests/hook/hook.test.mts:23)`, `the upstream Memosyne source (tests/hook/claude.test.mts:19)`) — one-line changes. Extensions in imports follow the Q5 language decision; nothing else moves.
- Critically, the MCP tests import **handlers**, not the SDK server (`tests/mcp/mcp.test.mts` → `src/mcp/handlers.mts`), so the SDK removal does not disturb them. But any test asserting zod-shaped validation error text becomes the *specification for the mini-validator's messages* — the porting agent must treat such assertion strings as immutable (error messages are part of the compat contract, context §compat).

Test files keep their current extensions (`.mts` in Graphyne/Memosyne suites, `.mjs`/`.js` in Autonomity/Expertum) — `node --test` runs `.mts` natively on node ≥ 24, which is already the engines floor (`the upstream Graphyne source (package.json:7-9)`).

### 8.2 Parity harness (`tests/parity/`)

The zero-dep rewrites of three third-party libraries must reproduce the originals exactly, so `tests/parity/fixtures/` holds **differential (golden) fixtures** captured from the real libraries — `yaml@2.9.0`, `picomatch@4.0.4`, `diff@9.0.0`. Each fixture records the library's output over a broad input corpus (values, exact bytes, and thrown-error messages), and the vendored port (`plugins/graphyne/common/yaml-lite.mjs`, `globs.mjs`, `plugins/memosyne/common/unified-diff.mjs`) is asserted to match every recorded outcome. The `yaml-roundtrip-real.json` fixture additionally round-trips real `.graphyne/meta/**.yaml` samples (block style, flow-style `tags: [test]`, quoted scalars) to prove on-disk store parity. The fixtures are regenerated by the one-off scripts under `tests/parity/fixtures/generators/`, which must run from a checkout that carries the real library in its `node_modules`. _(Superseded in part by DESIGN.md D17, memosyne 0.4.0: the `diff@9.0.0` / `plugins/memosyne/common/unified-diff.mjs` parity harness was removed with `memosyne_patch_task`; only the `yaml` and `picomatch` ports remain — two libraries, not three.)_

The **wire surface** — tool list, schemas, `tools/call` responses and error strings, and resulting store-tree bytes — is pinned by each server's own end-to-end stdio test: `tests/graphyne/mcp/mcp.test.mts`, `tests/memosyne/mcp-handlers.test.mts`, and `tests/expertum/server-stdio.test.mjs`, which seed temp stores and drive scripted JSON-RPC sequences. The frozen-surface discipline (never edit a tool name, description, schema, message, or on-disk format) carries the rest.

### 8.3 Repo-invariant guards (`tests/omnium/`)

- **Vendored-core drift guard:** enumerate the configured vendored-copy paths (canonical location per the shared-core decision, Q2 — architect's call) and `readFileSync` byte-compare each against the canonical file; on mismatch report the first differing line plus both sha256s. Trivial, fast, and it is the entire enforcement mechanism for the vendoring strategy — it must exist before the second copy does.
- **Zero-dep guard:** scan `plugins/**/*.{mjs,mts,js}` and assert every import specifier is `node:*` or relative; assert no `package.json` and no `node_modules/` exists anywhere under `plugins/`. This turns the project's core invariant ("the plugin folders ARE the source of truth, zero-dep") from a convention into a failing test.
- **Version/manifest guard:** `version-guard.mjs` check mode wrapped in a test, plus assertions that each `plugin.json` version parses as `X.Y.Z` and sorts after its frozen floor (`0.1.5`/`0.3.5`/`0.1.28`/`0.1.64`), that `marketplace.json` entries carry no `version` field, and that every `plugins/*` dir has a marketplace entry and vice versa.

### 8.4 Definition of done — per port task and overall

Per plugin port task, done means all of:

1. That plugin's ported prior suite green (assertion count not reduced except the documented web exclusions).
2. That plugin's stdio e2e test green (tool list, schemas, `tools/call` responses, store-tree bytes) and — for the vendored libraries — the differential fixtures green.
3. Repo guards green (drift, zero-dep, version/manifest).
4. `tsc --noEmit` clean repo-wide.
5. One manual smoke session via `claude --plugin-dir /path/to/Omnium/plugins/<name>` exercising the plugin's happy path before it replaces the installed original.

Items 1–4 are one command: `npm run check` = `node scripts/version-guard.mjs && node --test && tsc --noEmit`. No task may close with skipped or `.todo`-marked tests. The overall project DoD adds: all four plugins installed as `<plugin>@omnium` on the author's machine with the old marketplaces removed, and one real adopted project verified per plugin (existing `.graphyne/`/`.memosyne/` store read AND written without diff noise).

### 8.5 Toolchain: plain npm, two devDependencies, no workspaces

- **npm, not pnpm.** pnpm's symlinked `node_modules` is literally why the upstream plugins needed a build step (`the upstream Graphyne source (PLUGIN.md:7-14)`); with zero runtime deps that motivation is gone, and root-level `node_modules` never enters `plugins/` anyway — but npm removes the last symlink-shaped risk and one tool from the clone-and-go path. No `pnpm-workspace.yaml`, no npm workspaces either: there are no packages to link (plugins are self-contained by design; the shared core is vendored by copy, not resolved by a package manager — that is the whole point of the drift guard).
- **Not "nothing":** add `typescript@5.x` + `@types/node@24.x` as the only devDependencies. Node's type stripping performs no checking, so without `tsc --noEmit` the port loses its second safety net over ~2,300 lines of typed common code; the upstream plugins already ran this exact check (`the upstream Graphyne source (package.json:14)`). Both deps never ship (install copies `plugins/<name>/` only, and the zero-dep guard enforces it). One root `tsconfig.json` (`module: nodenext`, `noEmit`, `allowImportingTsExtensions`; add `checkJs` if Q5 lands on `.mjs`+JSDoc).
- Root `package.json`: `"private": true`, `engines: { "node": ">=24.0.0" }`, scripts `test` / `typecheck` / `stamp` / `check`, description following the existing "Dev/test harness … Not shipped" convention (`the upstream Autonomity source (package.json:6)`). Commit `package-lock.json`. No `.npmrc` needed (the pnpm `minimumReleaseAge` setting has no npm equivalent worth carrying for two pinned devDeps).

### 8.6 .gitignore / repo hygiene

- `.gitignore`: `node_modules/`, `.expertum/`, `*.log` — following Expertum's own file (`the upstream Expertum source (.gitignore:1-6)`). Deliberately **no** `dist/` entry: nothing is ever built, and its absence is a statement; the zero-dep guard would catch a stray build product regardless.
- Commit `.graphyne/` and `.memosyne/` stores once Omnium adopts its own plugins (dogfooding, consistent with all four sibling repos).
- Commit `.plugin-versions.json`, `scripts/`, and `scripts/git-hooks/pre-commit`.
- Root `CHANGELOG.md` with a section per plugin, seeded with the `0.2.0`/`0.4.0` migration entries — the docs explicitly pair explicit-version plugins with a changelog, and it becomes the user-facing update trail on GitHub.
- Add `LICENSE` before the GitHub move (marketplace metadata has a `license` field per plugin; pick once, apply to all four).

## Risks

- **Pre-commit hook not installed on a fresh clone** → auto-bump silently absent. Mitigated by `version-guard` check mode inside `npm run check` (DoD/CI), so staleness cannot pass a gate even hook-less.
- **Web-test exclusion masking a shrink:** "229 → fewer" must be documented in the port task record, or a future audit will read it as lost coverage.

## Recommendations (prioritized)

1. Build `scripts/version-guard.mjs` + `scripts/git-hooks/pre-commit` + `.plugin-versions.json` **before** the first plugin port lands — the bump invariant must exist from commit one.
2. Capture the differential fixtures for `yaml`/`picomatch`/`diff` before vendoring each library, so every port has its oracle from the first commit.
3. Stand up `tests/omnium/` guards (drift, zero-dep, version/manifest) before vendoring the shared core a second time.
4. Port Expertum and Autonomity suites first (verbatim, lowest risk), then Memosyne, then Graphyne (YAML + glob strategies land behind the parity harness, not before it).
5. Write the Omnium PLUGIN.md update section as the two-lane workflow (§6.3), replacing both repos' footgun warnings with the one rule "commit (or stamp) before update".

## Open questions

- Whether Claude Code's update flow ever *orders* versions rather than comparing equality (affects nothing today; A1 for ai-engineer).
- Whether a local path marketplace inside a git repo would resolve to a commit SHA if `version` were omitted (docs resolution level 3 says "git-hosted marketplace"; moot under the explicit-version decision, but worth one experiment if ai-engineer wants a belt-and-braces fallback documented).
- Exact ported-test counts after web exclusion (determinable only at port time; the DoD record captures it).
- Final tests location is architect-reviewer's call; everything in §8.1 survives a move to per-plugin `tests/` except the "repo tree == installed tree" property, which I would flag as worth keeping.

## Sources

- [Claude Code plugins reference — Version management, plugin.json fields, cache behavior](https://code.claude.com/docs/en/plugins-reference)
- [everything-claude-code #36 — marketplace.json version field blocks auto-updates](https://github.com/affaan-m/everything-claude-code/issues/36)
- [claude-code #46081 — stale marketplace cache vs new commits](https://github.com/anthropics/claude-code/issues/46081)

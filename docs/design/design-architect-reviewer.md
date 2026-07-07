# Omnium design decisions — repo layout, shared MCP core, shipped language, code-style charter

**Decisions**

1. **Layout:** `plugins/<name>/` is byte-for-byte what installs (no tests/dev files inside); tests live at top-level `tests/<plugin>/`; canonical shared code in `shared/`; one `docs/development.md`; per-plugin `README.md` ships, per-plugin `PLUGIN.md` is retired in favor of the repo-level dev doc.
2. **Shared MCP core:** canonical `shared/mcp-core.mjs` + `shared/mcp-schema.mjs`, vendored (byte-identical copies) into each plugin's `common/`; drift guard = `tests/shared/vendoring.test.mjs` byte-compare + DO-NOT-EDIT header + `scripts/sync-shared.mjs`. **YES — retrofit expertum onto the shared core now** (the brief's premise "expertum has no server test suite" is FALSE: five test files exist, including an end-to-end stdio test that pins the wire contract).
5. **Shipped-runtime language:** `.mjs` + JSDoc types for ALL shipped runtime (servers, handlers, common modules, hooks) — no `.mts` ships. Ported Graphyne/Memosyne test suites stay `.mts`; Expertum's tests convert to ESM alongside its server; new non-graphyne/memosyne tests are `.mjs`.
7. **Code-style charter:** 15 rules codifying the fleet's existing narrative-header, shell/logic-split, boring-code voice (full text below).

## Summary

The four plugins already share a deliberate architecture — thin IO shells over pure, unit-tested logic, narrative file headers, frozen user-visible strings — and Omnium's design should be a codification of that voice, not an invention. The two structural decisions with teeth are (a) making `plugins/<name>/` exactly equal to the installed artifact (everything else lives outside it, which makes the compat surface visually obvious to a human browser) and (b) shipping only `.mjs`, because hooks and servers execute on whatever `node` is on the user's PATH, and `.mts` would silently raise the runtime floor to Node ≥ 23.6 — a hard behavioral break for Graphyne's fail-closed enforcement hooks that the no-breaking-changes rule forbids.

## Scope / What was analyzed

- `the upstream Expertum source`: `plugins/expertum/server.js` (153 lines, CJS), `server-lib.js` (240 lines), `.mcp.json`, `plugin.json`, `.claude-plugin/marketplace.json`, `.gitignore`, `package.json`, all five `test/*.test.js` files (esp. `server-stdio.test.js`).
- `the upstream Autonomity source`: `plugins/autonomity/**` (hooks, commands, plugin.json), `test/*.test.mjs`, root files.
- `the upstream Graphyne source`: `src/mcp/server.mts`, `src/common/{graph,globs}.mts`, `src/claude/hook.mts`, `src/claude/plugin/.claude-plugin/plugin.json`, `scripts/build-plugin.mjs`, `package.json`, `tests/` tree, `PLUGIN.md` (grep).
- `the upstream Memosyne source`: `src/mcp/server.mts`, `src/common/storage.mts`, `src/claude/hook.mjs`, `tests/` tree.
- Web: Node.js native TypeScript timeline (type stripping flagged in 22.6, default-on in 23.6 with experimental warning, stable only in 24.12/25.2) — https://nodejs.org/api/typescript.html, https://nodesource.com/blog/Node.js-Supports-TypeScript-Natively.

---

## Decision 1 — Repo layout

**The tree:**

```
Omnium/
├── .claude-plugin/
│   └── marketplace.json          # name "omnium"; 4 entries, source "./plugins/<name>"
├── README.md                     # what Omnium is, install cmds, table of the 4 plugins
├── package.json                  # dev harness only (see below)
├── tsconfig.json                 # allowJs + checkJs + noEmit: typechecks JSDoc .mjs and .mts tests
├── .gitignore                    # node_modules/, .expertum/, *.log  (mirrors Expertum/.gitignore)
├── docs/
│   └── development.md            # marketplace cache-refresh footgun, vendoring workflow,
│                                 # versioning/release policy (content owned by monorepo-architect)
├── shared/
│   ├── README.md                 # the vendoring contract, 10 lines
│   ├── mcp-core.mjs              # canonical stdio JSON-RPC core (see Decision 2)
│   └── mcp-schema.mjs            # canonical ~80-line input validator
├── scripts/
│   └── sync-shared.mjs           # copies shared/*.mjs into each consuming plugin's common/
├── plugins/
│   ├── autonomity/
│   │   ├── .claude-plugin/plugin.json
│   │   ├── README.md
│   │   ├── commands/{on,off,status}.md
│   │   └── hooks/{hooks.json, hook.mjs, hook-lib.mjs, state.mjs}
│   ├── expertum/
│   │   ├── .claude-plugin/plugin.json
│   │   ├── .mcp.json             # unchanged key "expertum"; args updated to server.mjs
│   │   ├── README.md
│   │   ├── server.mjs            # entry: boots the shared core with the one tool
│   │   ├── common/{mcp-core.mjs, mcp-schema.mjs, server-lib.mjs}
│   │   ├── agents/*.md           # 21 files, copied verbatim
│   │   └── commands/{review,research}.md
│   ├── graphyne/
│   │   ├── .claude-plugin/plugin.json    # keeps "mcpServers": "./mcp/servers.json"
│   │   ├── mcp/servers.json              # unchanged key "graphyne", env GRAPHYNE_PROJECT_DIR
│   │   ├── README.md
│   │   ├── server.mjs                    # entry at plugin root (matches today's dist/claude layout)
│   │   ├── handlers.mjs
│   │   ├── common/*.mjs                  # 13 domain modules + vendored mcp-core/mcp-schema
│   │   │                                 # (+ yaml/glob modules per code-reviewer's decision)
│   │   ├── hooks/{hooks.json, hook.mjs}  # hook logic may split into hook-lib.mjs (see charter R2)
│   │   └── commands/{setup,init}.md
│   └── memosyne/
│       ├── .claude-plugin/plugin.json
│       ├── mcp/servers.json              # unchanged key "memosyne", env MEMOSYNE_PROJECT_DIR
│       ├── README.md
│       ├── server.mjs
│       ├── handlers.mjs
│       ├── common/*.mjs                  # incl. search-worker.mjs — MUST stay in the same dir
│       │                                 # as search-runner.mjs (worker_threads same-dir constraint)
│       ├── hooks/{hooks.json, hook.mjs}
│       └── commands/setup.md
└── tests/
    ├── autonomity/*.test.mjs             # ported from the autonomity suite
    ├── expertum/*.test.mjs               # ported from the expertum suite, CJS→ESM with the server
    ├── graphyne/{common,mcp,hook}/*.test.mts   # ported; web/service suites dropped (out of scope)
    ├── memosyne/{common,mcp,hook}/*.test.mts
    └── shared/vendoring.test.mjs         # byte-compares every vendored copy against shared/
```

**Rationale, keyed to "design for a human browsing":**

- **`plugins/<name>/` ≡ the installed artifact.** All four upstream plugins already keep tests OUTSIDE the plugin dir (`the upstream Autonomity source (test/)`, `the upstream Expertum source (test/)`, `the upstream Graphyne source (tests/)`, `the upstream Memosyne source (tests/)`), and a marketplace install copies the plugin folder into the version-keyed cache. Keeping the plugin folder pure means a human can diff `plugins/graphyne/` against `~/.claude/plugins/cache/.../graphyne/<version>/` and expect zero delta — the single most useful property when debugging the stale-cache footgun documented in `the upstream Graphyne source (scripts/build-plugin.mjs:57-65)`. It also keeps the compat surface (everything inside `plugins/`) visually separated from the dev surface (everything outside).
- **Top-level `tests/<plugin>/` mirroring `plugins/`**, name pluralized `tests/` (Graphyne/Memosyne convention wins over Autonomity/Expertum's `test/` because those two suites are 90% of the volume, ~397 tests, and keep their internal `common/ mcp/ hook/` sub-structure so a ported test's path changes minimally).
- **Server entry at plugin root** (`server.mjs`, `handlers.mjs` beside it; domain modules under `common/`). This matches both shipped precedents: Expertum ships `plugins/expertum/server.js` at root (`the upstream Expertum source (plugins/expertum/.mcp.json:5)` → `${CLAUDE_PLUGIN_ROOT}/server.js`) and Graphyne's built plugin puts `server.mjs` at the plugin root with `hooks/hook.mjs` beside it (`the upstream Graphyne source (scripts/build-plugin.mjs:46-51)`). A human opening `plugins/graphyne/` sees the entry point first, then descends into `common/` — the same reading order as the current repos' `src/mcp/server.mts → handlers.mts → common/*`.
- **Docs:** one user-facing `README.md` per plugin (ships with the install; the upstream plugins' plugin folders already do this — `plugins/autonomity/README.md`). The per-plugin `PLUGIN.md` dev notes are retired: their content (cache-refresh footgun, wiring rules like "hooks.json auto-loads, do NOT also list it in plugin.json" — `the upstream Graphyne source (PLUGIN.md:94)`) is repo-level in Omnium and would otherwise be duplicated four times; it moves once into `docs/development.md`.
- **Root `package.json`** (dev harness only, modeled on `the upstream Expertum source (package.json)` which states the pattern explicitly):

```json
{
  "name": "omnium-dev",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "description": "Dev/test harness for the Omnium plugins (node:test + tsc typecheck). Not shipped — the installable plugins are plugins/*, which stay zero-dependency.",
  "engines": { "node": ">=24.0.0" },
  "scripts": {
    "test": "node --test \"tests/**/*.test.*\"",
    "typecheck": "tsc --noEmit",
    "sync:shared": "node scripts/sync-shared.mjs"
  },
  "devDependencies": { "@types/node": "24.x", "typescript": "5.x" }
}
```
  No `dependencies` key at all — its absence is the zero-dep statement. `engines >=24` is the DEV floor (needed for `.mts` tests); the shipped `.mjs` runtime deliberately requires less (see Decision 5). No esbuild, no build script — there is nothing to build.
- **`.gitignore`:** `node_modules/`, `.expertum/`, `*.log` — inherited from the standard `.gitignore`, which already articulates why (`.expertum/` reports are per-run output, never committed). The `.graphyne/` store is committed as intentional dogfood; `.memosyne/` is ignored (it holds per-run work notes, some describing not-yet-fixed issues, so it is kept out of the published tree).
- **`marketplace.json`:** marketplace `name: "omnium"` (this is what makes installs land as `<plugin>@omnium`, satisfying the mission's uninstall/reinstall flow), `owner: { "name": "Eric Kevrel" }`, four `plugins[]` entries with `source: "./plugins/<name>"` and each plugin's existing one-paragraph description carried over from its current `plugin.json`/`marketplace.json` (style precedent: `the upstream Expertum source (.claude-plugin/marketplace.json)`). Exact `version` values inside each `plugin.json` are the monorepo-architect's call (question 6); the layout only fixes where they live.

## Decision 2 — Shared MCP core: `shared/` canonical, vendored copies, and YES to retrofitting expertum now

**Canonical location:** `shared/mcp-core.mjs` (stdio readline loop, newline-delimited JSON-RPC 2.0 dispatch, `initialize`/`notifications/initialized`/`tools/list`/`tools/call`, error codes -32601/-32602/-32603, stderr-only logging, `readPluginVersion()` from the sibling `plugin.json`) plus `shared/mcp-schema.mjs` (the ~80-line validator replacing zod). The core is a parameterized generalization of Expertum's proven server: `the upstream Expertum source (plugins/expertum/server.js:69-109)` already contains the entire dispatch, and the shape it must grow to (a tools *map* instead of one tool, optional `instructions`, per-tool input validation) is exactly what Graphyne/Memosyne's SDK usage reduces to (`registerTool` + stdio + instructions, per the prior panel finding).

**Why a top-level `shared/`, not "canonical lives in one plugin":** a human must be able to answer "where do I edit this?" in one glance. A file that is canonical inside `plugins/expertum/` but vendored into two siblings inverts the mental model (the reference copy would live inside one consumer). `shared/` at the root, with its own README stating the contract, makes the direction of truth unambiguous.

**Vendoring mechanics (three interlocking guards):**
1. Every copy — including the canonical one — begins with the identical header: `// VENDORED SHARED MODULE — canonical copy: shared/mcp-core.mjs. Do not edit any plugins/*/common/ copy; edit shared/ and run: node scripts/sync-shared.mjs`. Identical text everywhere keeps the files byte-identical.
2. `scripts/sync-shared.mjs` copies `shared/*.mjs` into each registered consumer path (a small literal list in the script — three entries; no magic discovery).
3. `tests/shared/vendoring.test.mjs` reads `shared/*.mjs` and byte-compares (`Buffer.equals`) every consumer copy. A drifted copy is a test failure, so the normal `npm test` gate IS the drift guard — no CI needed, which respects the local-only constraint. (Whether this test is part of the definition-of-done gate is the monorepo-architect's call; the test itself is mine.)

**Scope discipline:** only `mcp-core.mjs` and `mcp-schema.mjs` are shared. Graphyne and Memosyne each have near-twin `lock/project/registry` modules (compare `the upstream Graphyne source (src/common/project.mts)` vs `the upstream Memosyne source (src/common/project.mts)` — same design, plugin-specific details), but they are domain code that may legitimately diverge; forcing them through the vendoring contract would turn every graphyne-only fix into a three-plugin sync. The mechanics above are open-ended: if the code-reviewer decides the YAML-subset or glob module should be shared too, it drops into `shared/` and inherits guards 1-3 unchanged — that placement decision is theirs.

**Retrofit expertum NOW: YES.** The brief asked me to verify the claim "expertum has no test suite for its server" — it is **false**. `the upstream Expertum source (test/)` contains five suites: `server-stdio.test.js` (a true end-to-end test that spawns the real server process, feeds it a malformed line plus five requests, and asserts the exact frames: `serverInfo.name === "expertum"`, tools/list content, the `Wrote report to` result text, `-32602` for an unknown tool, `-32601` for an unknown method — `the upstream Expertum source (test/server-stdio.test.js:39-74)`), plus `sanitize-filename`, `resolve-target-dir`, `write-report`, and `agent-parity` unit suites. That flips the risk calculus the question hinged on:

- **Parity risk is low and pinned.** Expertum exposes ONE tool with four enumerable rejection paths, and the e2e test pins the observable wire behavior. Port the suite (CJS→ESM is mechanical) and run it against the retrofitted server; any regression the compat contract cares about is exactly what that test asserts.
- **Consistency win is structural, not cosmetic.** The shared core must exist regardless — Graphyne (12 tools) and Memosyne (11 tools) are the hard ports. If expertum keeps its private CJS server, Omnium permanently ships two transport implementations of the same protocol, and every future protocol fix (e.g. a protocolVersion bump) must be made twice and can silently diverge. Worse, the divergent copy would be the very file the shared core was derived from.
- **What changes for expertum:** `server.js` (CJS) becomes `server.mjs` = ~30 lines of "import core, register `expertum_write_report`, start"; `server-lib.js` becomes `common/server-lib.mjs` with its logic byte-comparable (same messages, same sanitization); `.mcp.json` `args` path updates from `server.js` to `server.mjs` — an internal path, not part of the compat surface (the server KEY `expertum` and tool name are what agents see, and both are untouched).
- **Hard condition (interaction with ai-engineer's compat contract):** the core's `initialize` and `tools/list` responses must match what each plugin's clients see TODAY — for expertum that is the hand-rolled shape at `server.js:76-80` (`capabilities: { tools: {} }`, no `instructions`); for graphyne/memosyne it is whatever the SDK currently emits (including the `instructions` field and any `capabilities` sub-flags such as `listChanged`). The core therefore takes `instructions` as optional and emits it only when provided. The byte-level definition of "match" belongs to the ai-engineer; I flag it as the one place the retrofit could leak a visible delta.

## Decision 5 — Shipped runtime language: `.mjs` + JSDoc, everywhere

**Decision:** every shipped runtime file — MCP servers, handlers, all `common/` modules, all hooks — is plain ESM `.mjs` with JSDoc type annotations, typechecked in dev by `tsc --noEmit` with `allowJs`/`checkJs`. No `.mts` ships in any plugin folder.

**Rationale:**

1. **Compat is the trump card, and it points at `.mjs`.** Hooks and MCP servers execute via `node <file>` using whatever Node is on the user's PATH. Native `.mts` execution requires Node ≥ 22.6 behind a flag, ≥ 23.6 unflagged (with an experimental warning until it stabilized in 24.12) — see https://nodejs.org/api/typescript.html. Today's *installed* plugins ship plain `.mjs`: Autonomity's hooks are committed `.mjs` source, Memosyne's hook is verbatim-copied `.mjs` (`the upstream Memosyne source (src/claude/hook.mjs)`), and Graphyne's installed server/hook are esbuild-emitted `.mjs` bundles (`the upstream Graphyne source (scripts/build-plugin.mjs:46-51)`). Shipping `.mts` would therefore RAISE the effective runtime floor of already-installed behavior — and the failure mode is not graceful: on Node < 22.6 a `.mts` hook does not "fail open", it fails to *parse*, which for Graphyne means the TDD gate and the Stop hard-block silently vanish. Under "breaking changes are FORBIDDEN," that risk is disqualifying; `.mjs` preserves the status-quo floor exactly.
2. **Zero translation semantics.** The no-build mandate means the committed file is the executed file. `.mjs` is the only format where that statement carries no asterisk (no type-stripping edge cases like enum/namespace erasability, no experimental warnings polluting hook stderr, no "which Node version parses this" question for a human reading the repo).
3. **Readability precedent.** The fleet's most polished, most human-readable files are already plain JS with JSDoc: `hook-lib.mjs`'s `decidePreToolUse` (`the upstream Autonomity source (plugins/autonomity/hooks/hook-lib.mjs:56-76)`) and the whole of `server-lib.js` demonstrate that the house voice does not depend on TypeScript syntax. JSDoc keeps parameter/return types visible as documentation, and `checkJs` keeps them honest.
4. **Conversion cost is bounded and test-guarded.** The `.mts → .mjs` transformation is mechanical (annotations move into JSDoc; `type` exports become `@typedef`s; `import ... from "./x.mts"` becomes `"./x.mjs"`), and the ported Graphyne (229) and Memosyne (168) suites verify behavior after conversion. Memosyne's `search-worker` keeps working: `new URL("./search-worker.mjs", import.meta.url)` from `common/` satisfies the same-dir worker constraint.

**Tests language:** ported Graphyne/Memosyne suites STAY `.mts` — they are dev-only (dev floor is Node ≥ 24 where type stripping is stable), and keeping their language minimizes the diff against 397 proven tests; only import paths change (`../src/common/x.mts` → `../../plugins/graphyne/common/x.mjs` — `tsc` infers the JSDoc types across that boundary). Expertum's CJS `.js` tests convert to ESM `.mjs` together with the server retrofit (Decision 2) so `require`-vs-`import` doesn't fork the harness. New tests outside those two suites are `.mjs`. `node --test "tests/**/*.test.*"` runs the mix natively.

## Decision 7 — Code-style charter (binding for implementing subagents)

The four plugins share a deliberate voice; these 15 rules codify it. Reference exemplars: `the upstream Expertum source (plugins/expertum/server-lib.js)`, `the upstream Autonomity source (plugins/autonomity/hooks/hook-lib.mjs)`, `the upstream Memosyne source (src/common/storage.mts)`, `the upstream Graphyne source (src/common/graph.mts)`.

1. **Narrative file header.** Every runtime file opens with a comment block in full sentences: what the file is, why it exists in this shape, and the one non-obvious design decision (e.g. `graph.mts:1-13` shows the on-disk format inline; `hook.mjs:2-8` states the fail-open posture up front). Headers name their sibling files when the split matters.
2. **Shell/logic split.** IO shells (stdio loops, hook dispatchers) contain no policy; pure logic modules (`*-lib`, `handlers`, `common/*`) never touch `process`, stdio, or env. This is the fleet's testing strategy, not a preference (`server.js` header states it verbatim).
3. **Comments explain WHY, never narrate WHAT.** Any looks-wrong-but-deliberate line gets an inline rationale at the site — the canonical example is the `|| (not ??)` empty-env-var comment that appears, deliberately repeated, in all three servers (`server.js:27-31`, Graphyne `server.mts:23-25`, Memosyne `server.mts:35-37`).
4. **JSDoc on every export.** `/** ... */` on each exported symbol, 1-4 lines, sentence-style. In `.mjs`, JSDoc `@param`/`@returns`/`@typedef` types ARE the type system and must pass `tsc --noEmit` (`checkJs`).
5. **Naming.** kebab-case filenames; camelCase functions/variables; SCREAMING_SNAKE exported constants; names are real words (`resolveTargetDir`, `stopBlockers`), no non-universal abbreviations.
6. **Constants carry rationale.** Every tuning constant gets a one-line why (`MAX_CONTENT_BYTES`'s "far above any legitimate report yet bounds a runaway write" — `server-lib.js:27-30`; `MAX_TAGS_PER_EDGE` — `graph.mts:24-27`).
7. **Error messages are frozen or house-style.** Existing shipped messages (tool errors, deny reasons, hook nudges) are copied BYTE-FOR-BYTE — they are compat surface. New messages follow the style: complete sentences, quote the offending value, tell the caller what to do next (`"Edge to \"x\" would carry 6 tags (…); the maximum is 5 tags per edge."`).
8. **Failure posture is explicit per file.** Hooks fail OPEN (a bug must never brick a session — `Autonomity hook.mjs:5-8`); MCP tools return `toolError(...)` results and never throw across the transport; best-effort side writes (registry, version read) are try/caught with a comment. Every empty `catch` states why swallowing is safe (`/* nothing to clean */` — `Memosyne storage.mts:33-35`).
9. **Module size.** Target ≤ ~400 lines including headers (the fleet's range: common modules ~150-250, servers 380-480, hooks 350-513 — the big hooks are the known outliers, split them per rule 2 where it doesn't disturb compat). Split by responsibility, and never so finely that following one behavior needs more than ~3 files.
10. **Boring code wins.** No nested ternaries, no clever one-liners, no metaprogramming or dynamic property tricks; early returns over deep nesting; `Set`/`Map` over object-as-dict for lookups (the fleet's habit).
11. **Imports.** `node:` prefix on all builtins; shipped runtime is ESM `.mjs` only; zero runtime dependencies — an import that isn't `node:*` or a relative path is a defect.
12. **Vendored files are read-only in place.** They carry the exact DO-NOT-EDIT header, are edited only under `shared/`, and are re-synced via `scripts/sync-shared.mjs`; the byte-compare test is the law.
13. **Tests.** `node:test` + `node:assert/strict`; test names are behavior sentences ("end-to-end: initialize, tools/list, tools/call, and error codes"); at least one e2e test per server drives the real process over stdio like `server-stdio.test.js` does; a leading comment states what the suite pins and why.
14. **Ported code improves nothing observable.** Tool names, input schemas, JSON output shapes, on-disk formats, timeouts, and messages are transplanted, not "cleaned up." Polish goes into comments, structure, and naming of internals only. When a ported oddity looks like a bug, KEEP it and document it (agents and stores depend on today's behavior).
15. **Language hygiene.** English everywhere in code, comments, and messages; no emojis; no TODO/FIXME in shipped files — open items go to `docs/development.md`.

## Findings

- **[Info] The brief's premise "expertum has no server test suite" is incorrect** — `the upstream Expertum source (test/server-stdio.test.js:39)` (plus 4 more suites). This materially strengthens the case for the retrofit decision above.
- **[High] Shipping `.mts` would be a latent breaking change** — `the upstream Graphyne source (scripts/build-plugin.mjs:46-51)` proves today's installed runtime is `.mjs`; native `.mts` needs Node ≥ 23.6 unflagged (https://nodejs.org/api/typescript.html), and a non-parsing Graphyne hook silently disables enforcement rather than failing open. Decision 5 eliminates this.
- **[Medium] The stale-cache footgun requires the version story to be solved in-repo** — `the upstream Graphyne source (scripts/build-plugin.mjs:57-65)` documents that the marketplace cache is version-keyed; Omnium drops commit-count stamping (no build step), so the replacement discipline (question 6, monorepo-architect) must land in `docs/development.md` or every edit-without-bump silently serves stale plugins.
- **[Info] The three servers already converge on one transport contract** — `server.js:74-108` vs the SDK usage in Graphyne/Memosyne `server.mts:8-11` — confirming the shared core is an extraction, not new architecture.
- **[Info] Memosyne's worker constraint survives all decisions** — `search-worker` stays a sibling of `search-runner` inside `plugins/memosyne/common/` as `.mjs`.

## Risks

- If the vendoring byte-compare test is not wired into the routine test run (DoD gate — monorepo-architect), copies WILL drift; the mechanics above assume `npm test` is run before any version bump.
- The expertum retrofit's only real exposure is the `initialize`/`tools-list` response shape; if the ai-engineer's compat contract ends up demanding byte-equality with the SDK's output for graphyne/memosyne, the core may need shape shims per consumer — design the core so response assembly is one small function per method.
- Retiring per-plugin `PLUGIN.md` loses in-folder dev notes for someone reading a cached install; mitigated by each plugin `README.md` linking to the repo.

## Recommendations (prioritized)

1. Build `shared/mcp-core.mjs` first and port EXPERTUM onto it first — smallest tool surface, strongest e2e pin — then reuse the proven core for graphyne/memosyne.
2. Land `tests/shared/vendoring.test.mjs` in the same commit as the first vendored copy, so drift protection never lags.
3. Convert `.mts → .mjs` module-by-module with the corresponding ported test file in the same change (the suites are the parity instrument; never batch-convert ahead of tests).
4. Write `docs/development.md` early with the cache-footgun section carried over from `build-plugin.mjs:57-65` / `PLUGIN.md`, leaving a placeholder section for the versioning policy (monorepo-architect).
5. Put the 15-rule charter verbatim at the top of `docs/development.md` (or a `docs/style.md` it links) so implementing subagents can be pointed at one URL-stable location.

## Open questions

- Exact `initialize`/`tools/list` response byte-shape the SDK servers emit today (capabilities sub-flags, `instructions` placement) — owned by ai-engineer; my core design assumes per-consumer configurability suffices.
- Whether the YAML-subset and glob modules become `shared/` files or stay graphyne-local — owned by code-reviewer; the vendoring mechanics accommodate either.
- Version numbering scheme and whether `sync:shared` + `test` + `typecheck` form the pre-bump DoD gate — owned by monorepo-architect; layout reserves `docs/development.md` for it.

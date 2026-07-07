# Omnium — Backward-Compatibility Contract & Claude Code Mechanics

## Decisions

1. **Tool names are marketplace-independent — verified.** The MCP prefix is `mcp__plugin_<plugin-name>_<server-name>__<tool-name>`; the marketplace name never appears. Switching `memosyne@memosyne` → `memosyne@omnium` changes NO tool name, command name, or agent name.
2. **`${CLAUDE_PLUGIN_DATA}` WILL reset on the marketplace switch — verified and accepted as non-breaking.** The data dir is keyed by the full plugin id `<plugin>@<marketplace>` (sanitized): `~/.claude/plugins/data/memosyne-memosyne/` → `~/.claude/plugins/data/memosyne-omnium/`. The only tenant is memosyne's per-session nudge counters, which are dead weight across a restart anyway. No mitigation needed; no `--keep-data` in the runbook.
3. **Migration runbook (per machine): add omnium first, then per-plugin uninstall-old → install-new, then remove the four old marketplaces, then restart.** Full sequence with checks in section (b).
4. **Compat boundary for shipped runtime files: everything executed via bare `node` (hook entry points, MCP server entry points, worker files) must run flagless on Node ≥ 22.18.0 and on every later maintained line.** `.mjs` satisfies this trivially; `.mts` satisfies it *only* at ≥ 22.18 / ≥ 23.6 and fails with `ERR_UNKNOWN_FILE_EXTENSION` below that. I recommend `.mjs + JSDoc` for all shipped executables (hooks especially — they fail OPEN: a node that can't parse the file silently removes the autonomity Stop gate and the graphyne TDD gate). If the architect-reviewer picks `.mts`, he must accept the documented ≥ 22.18 floor **plus** a SessionStart self-probe that surfaces the failure instead of silently disabling gates. Test files: free choice (`.mts` fine — they never run on a consumer machine).
5. **Version continuity: keep explicit `plugin.json` versions and continue each line — 0.1.6 / 0.3.6 / 0.1.29 / 0.1.65 at first Omnium release.** Omitting `version` (git-SHA fallback) is rejected: it destroys the numeric line and shows SHAs in UI. Cache paths are keyed `cache/<marketplace>/<plugin>/<version>/`, so the omnium install can never collide with the old cache even with equal numbers — the bump is for provenance and monotonic ordering, not for collision avoidance.
6. **Stale-cache footgun (facts): with an explicit version, editing the Omnium working tree does NOTHING for installed copies until `plugin.json` version is bumped.** `/plugin update` and auto-update skip when the resolved version string is unchanged (doc-verified). Dev loop must use `claude --plugin-dir /path/to/Omnium/plugins/<name>` (loads the tree in place, no cache, identical `mcp__plugin_…` prefixes). Release loop: bump version → `claude plugin marketplace update omnium` → `claude plugin update <p>@omnium` → restart (or `/reload-plugins`).
7. **Hard constraint for the shared-core design (owned by monorepo-architect, stated here because it is verified cache mechanics): cross-plugin symlinks do NOT survive a local-path install.** For plugins installed from a local path, only symlinks resolving *inside the plugin's own directory* are preserved; all others are skipped. Sharing the MCP core must be done by vendored identical copies guarded by a byte-equality test, not symlinks.

---

## Scope / What was analyzed

- Live installed state on this machine: `~/.claude/plugins/installed_plugins.json`, `known_marketplaces.json`, and the four cached plugins under `~/.claude/plugins/cache/{autonomity,expertum,graphyne,memosyne}/`.
- Sources: `the four upstream plugins` marketplace manifests; `the upstream Memosyne source (PLUGIN.md)` and `scripts/build-plugin.mjs` (the stale-cache narrative).
- Official docs (fetched 2026-07-02): [plugins-reference](https://code.claude.com/docs/en/plugins-reference), [plugin-marketplaces](https://code.claude.com/docs/en/plugin-marketplaces), [hooks](https://code.claude.com/docs/en/hooks), Anthropic's plugin-dev skill [tool-usage.md](https://github.com/anthropics/claude-code/blob/main/plugins/plugin-dev/skills/mcp-integration/references/tool-usage.md), [issue #29360](https://github.com/anthropics/claude-code/issues/29360), [Node.js TypeScript docs](https://nodejs.org/docs/latest-v24.x/api/typescript.html).

## Verified mechanics (the facts everything below rests on)

| # | Fact | Source |
|---|------|--------|
| M1 | MCP tool prefix is `mcp__plugin_<plugin-name>_<server-name>__<tool-name>` — plugin name + server key only, no marketplace component. | plugin-dev tool-usage.md; confirmed by issue #29360 ("The plugin loader namespaces MCP tools as `mcp__plugin_<plugin-name>_<server-name>__<tool>`"); empirically this session's tool is `mcp__plugin_expertum_expertum__expertum_write_report` |
| M2 | `${CLAUDE_PLUGIN_DATA}` "resolves to `~/.claude/plugins/data/{id}/`, where `{id}` is the plugin identifier with characters outside a-z A-Z 0-9 _ - replaced by `-`. For a plugin installed as `formatter@my-marketplace`, the directory is `~/.claude/plugins/data/formatter-my-marketplace/`." Created automatically on first reference. | plugins-reference, "Persistent data directory" |
| M3 | "The data directory is deleted automatically when you uninstall the plugin from the last scope where it is installed. … The CLI deletes by default; pass `--keep-data` to preserve it." | plugins-reference, uninstall section |
| M4 | "Removing a marketplace from its last remaining scope also uninstalls any plugins you installed from it." | plugin-marketplaces, `marketplace remove` |
| M5 | Version resolution order: `plugin.json` `version` → marketplace-entry `version` → git commit SHA. "Plugin versions determine cache paths and update detection: if the resolved version matches what a user already has, `/plugin update` and auto-update skip the plugin." | plugin-marketplaces, "Version resolution and release channels" |
| M6 | Cache layout `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`; old version dirs orphaned and auto-removed after 7 days. | plugins-reference "Plugin caching"; observed: `cache/expertum/expertum/0.3.5/` |
| M7 | Directory marketplaces are registered in place — `installLocation` IS the source path (`known_marketplaces.json:15,23,31,39`), so the catalog is read from the live working tree; only *installed plugins* are copied to the cache. | observed + plugin-marketplaces |
| M8 | Mid-session pinning: "When a plugin updates mid-session, hook commands, monitors, MCP servers, and LSP servers keep using the previous version's path. Run `/reload-plugins` to switch." | plugins-reference, environment variables |
| M9 | Omnium's command hooks use **exec form** (`"command": "node"` + `args`) — Claude Code spawns the interpreter directly, no shell on any platform. (Shell-form commands would instead run via `sh -c` on macOS/Linux or Git Bash/PowerShell on Windows.) Either way NO runtime/interpreter version is enforced: the hook execs whatever `node` is on the consumer's PATH; `plugin.json` has no `engines` field and "Claude Code ignores top-level fields it does not recognize." | hooks doc + plugins-reference manifest schema; verified `plugins/*/hooks/hooks.json` |
| M10 | Node type stripping: introduced v22.6 (flagged), default-on v23.6, default-on backported to v22.18.0 LTS, stable v24.12. Node ≤ 22.17 cannot run `.mts` flagless; Node 20 (EOL 2026-04-30) not at all. | nodejs.org typescript docs; Node 22.18.0 release |
| M11 | Local-path installs: "only symlinks that resolve within the plugin's own directory are preserved. All others are skipped." (The dereference-within-marketplace behavior applies to git-hosted marketplaces only.) | plugins-reference, symlink rules |
| M12 | Commands/agents are namespaced by **plugin name** (`plugin-dev:agent-creator`), never by marketplace. | plugins-reference, `name` field |
| M13 | `--plugin-dir` applies the SAME `mcp__plugin_<plugin>_<server>__` prefix as a marketplace install. | issue #29360 |
| M14 | `claude plugin validate <marketplace-dir>` checks marketplace.json, per-entry plugin.json for local-path sources, and "warns when the entry's `version` doesn't match the one in `plugin.json`." | plugin-marketplaces, troubleshooting |

## (a) The FINAL backward-compatibility contract

Every surface below is FROZEN — Omnium must preserve it exactly, because agents have learned the tool names/schemas/messages and on-disk stores are shared with other checkouts. Each row states HOW that surface is held today. The enforcement instruments are each server's end-to-end stdio tests (`tests/graphyne/mcp/`, `tests/memosyne/`, `tests/expertum/`), the vendored-library differential fixtures (`tests/parity/fixtures/`), the repo guards (`tests/omnium/`), and the version guard — all part of `npm run check`.

### A. Identity & namespacing

| Surface | Required value | Verification |
|---|---|---|
| Plugin names | `autonomity`, `expertum`, `graphyne`, `memosyne` | Diff `plugin.json` `name` old vs new; `claude plugin validate /path/to/Omnium` passes (also catches marketplace-entry/plugin.json version mismatch, M14). |
| Marketplace name | `omnium` (new — deliberately NOT a compat surface; nothing user-visible keys on it except the install id and data dir, see D) | n/a |
| Command names | `/autonomity:on\|off\|status`, `/expertum:review\|research`, `/graphyne:setup\|init`, `/memosyne:setup` — derived from plugin name + `commands/<file>.md` (M12) | File-list diff of `commands/` dirs; md diff of each command body (frontmatter + prose) old-cache vs Omnium. |
| Agent names | expertum's 21 `agents/*.md` — namespaced `expertum:<file>` (M12) | File-list diff + per-file md diff. |
| MCP server keys | `graphyne`, `memosyne` (in `mcp/servers.json`), `expertum` (in `.mcp.json`) | JSON diff of the server-config objects (keys, `command`, `args`, `env`). The *location* of the config (`.mcp.json` vs `plugin.json.mcpServers`) is not a compat surface — both are documented — but keep each plugin's current arrangement to keep diffs trivial. |
| Full tool names | `mcp__plugin_graphyne_graphyne__graphyne_*` (12), `mcp__plugin_memosyne_memosyne__memosyne_*` (11), `mcp__plugin_expertum_expertum__expertum_write_report` (1) — depend only on plugin name + server key (M1), so they survive the marketplace switch untouched | Covered by the two rows above + B1 below. Expertum's agent frontmatter references the namespaced name (`server-lib.js:20-22`) — grep Omnium agent files for the exact string. |

### B. MCP protocol surface

| Surface | Verification |
|---|---|
| B1. `tools/list` parity (names, descriptions, inputSchema JSON, ordering) | Each server's stdio e2e test (`tests/graphyne/mcp/mcp.test.mts`, `tests/memosyne/mcp-handlers.test.mts`, `tests/expertum/server-stdio.test.mjs`) drives `initialize` → `tools/list` and asserts the advertised tool set plus the load-bearing schema fields (multi-tag descriptions, param presence, ordering). Beyond those assertions the surface is held frozen by discipline — tool names, descriptions, and inputSchema JSON are never edited. |
| B2. `initialize` response (protocolVersion `2024-11-05`, serverInfo, `instructions` text) | The same e2e tests assert the `initialize` response and the agent-visible `instructions` text; frozen by discipline. |
| B3. `tools/call` happy paths | The e2e tests seed temp stores and drive scripted `tools/call` sequences, asserting each JSON response and the resulting store tree byte-for-byte (this doubles as the C1/C2 write-compat proof). |
| B4. `tools/call` error semantics | The handler/e2e tests assert the error `content` strings: the vendored validator's rejection messages (`zod-validate.mjs`, mirroring the prior zod pipeline byte-for-byte), `memosyne_patch_task` strict `applyPatch` failures (fuzzFactor 0, failure-on-noop — `handlers.mjs` call site), and graphyne lock/registry errors. Agents have learned these strings; they are contract. _(SUPERSEDED by DESIGN.md D17, memosyne 0.4.0: `memosyne_patch_task` and its `applyPatch` failures are retired; `memosyne_edit_task` replaces it with green-field error text.)_ |

### C. On-disk stores (shared with OTHER checkouts possibly running old plugin versions — strictest surface)

| Surface | Verification |
|---|---|
| C1. `.graphyne/` YAML meta — must be READ and WRITTEN in the frozen format forever (a checkout on plugin 0.1.28 must keep round-tripping stores written by Omnium, and vice versa) | The e2e store-tree byte assertions after write operations; plus the `yaml-roundtrip-real.json` differential fixture — real `meta/**.yaml` samples (flow-style `tags: [test]`, quoted scalars) round-tripped through the vendored parser/serializer and byte-checked against `yaml@2`'s output. |
| C2. `.memosyne/` markdown tasks + `config.json` + guard files | Same store-tree byte-diff in B3. |
| C3. `.expertum/<timestamp>--<name>/` report folders (naming pattern, write semantics) | Fixture call to `expertum_write_report` old vs new; diff created paths + file bytes. |
| C4. `graphyne.json` project config, registry files | Included in fixture repos for B3. |

### D. `${CLAUDE_PLUGIN_DATA}` and state files

- **Verified keying (M2):** data dir = `~/.claude/plugins/data/<plugin>-<marketplace>/`. The marketplace switch therefore moves memosyne's dir from `data/memosyne-memosyne/` to `data/memosyne-omnium/` (fresh, auto-created on first reference).
- **Is that breaking? No.** Inventory of everything under CLAUDE_PLUGIN_DATA today (grep across all four cached plugins found exactly one consumer): memosyne's `nudge-state/nudge-<session>-<repoTag>.json`, keyed by session id + cwd hash (`cache/memosyne/memosyne/0.1.64/hooks/hook.mjs:188,206-211`). Session ids never survive a restart, and migration requires a restart — the old counters are unreachable dead files either way. Autonomity state lives in `os.tmpdir()/claude-autonomity/<session>.state` (`hooks/state.mjs:14,21-23`) — path independent of plugin identity, untouched. Graphyne per-session state lives in the project's `.graphyne/tasks/` (bundled `hook.mjs:9318-9393`) — project-local, untouched. Expertum has no state.
- **Mitigation:** none required. Do NOT try to copy `data/memosyne-memosyne/` across — it is garbage post-restart. Contract clause for the future: any NEW state added under CLAUDE_PLUGIN_DATA must remain disposable-by-design (safe to lose on marketplace moves and uninstalls), or it must move into the project store.
- **Uninstall deletion (M3/M4):** `plugin uninstall` from the last scope deletes the data dir by default (CLI; the `/plugin` UI prompts). `marketplace remove` uninstalls the marketplace's plugins first. Since the only data is disposable, the runbook deliberately lets it be deleted — no `--keep-data`.
- **State-file path checks:** autonomity — assert `stateFile()` output in a unit test (`tests/autonomity/state.test.mjs`); memosyne — assert `TEMP_DIR = argv[3] + "/nudge-state"` logic in the hook tests (same argv → same paths).

### E. Hooks

| Surface | Verification |
|---|---|
| Events/matchers/timeouts: autonomity `UserPromptSubmit`/`PreToolUse(*)`/`SessionStart`/`Stop` (no explicit timeouts — inherit defaults, M9); graphyne 6 events, timeouts 5/5/10/10/10/10; memosyne 6 events with `${CLAUDE_PLUGIN_DATA}` argv | Each plugin's hook-wiring test asserts the events/matchers are wired (e.g. autonomity's "the four handled events are wired"). `hooks/hooks.json` is otherwise frozen by discipline; command strings must keep the exact `node "${CLAUDE_PLUGIN_ROOT}/…"` shape and argv order. |
| Hook behavior (JSON outputs, exit codes, additionalContext strings, decision blocks) | **Fixture tests:** each plugin's hook suite (`tests/graphyne/hook/hook.test.mts`, `tests/autonomity/*.test.mjs`, `tests/memosyne/*.test.mts`) pipes recorded stdin event JSONs (per event × per state: adopted/unadopted repo, on/off state, dirty/clean git, gated/ungated file, compact source) into the hook and asserts stdout JSON, exit code, and decision blocks. Graphyne's Stop hard-block and TDD PreToolUse deny are the highest-stakes rows. The glob-engine decision (picomatch `dot:true` semantics) is validated HERE: the corpus includes dotfile/dot-segment paths so any `matchesGlob` delta fails. |
| Hook output size/timeout envelopes | No change permitted to output volume class (10k-char cap and UserPromptSubmit 30s default are platform facts to stay within — current hooks already do). |

### F. Versioning & update flows

- Resolved version comes from `plugin.json` (M5) — Omnium keeps explicit versions there and does NOT set `version` in marketplace entries (docs warn plugin.json silently wins; one source of truth only — M14's validator warns on mismatch).
- First Omnium release: `autonomity 0.1.6`, `expertum 0.3.6`, `graphyne 0.1.29`, `memosyne 0.1.65`. Rationale: cache-path collision is impossible anyway (M6 keys on marketplace), and update detection is string-change not semver ordering (M5) — but monotonic continuation keeps `claude plugin list`, installed_plugins.json history, and human reasoning coherent, and preserves the option of a future migration path where a checkout compares versions.
- Every subsequent user-visible change bumps the patch. There is no stamping build anymore (no build at all), so the bump is manual; guard it with a test (monorepo-architect's charter): fail if `git diff` since the last release tag touches `plugins/<p>/**` without touching that plugin's `plugin.json` version.

### G. Non-surfaces (explicitly out of contract, so nobody "fixes" them)

- Marketplace name/description, plugin descriptions, README/PLUGIN.md prose, `displayName` (no plugin declares one; the `/plugin` UI shows the lowercase `name`, matching Anthropic's first-party convention), file layout inside the plugin (e.g. `server.js` vs `server.mjs` filename **is** a surface only because servers.json/.mcp.json reference it — keep the referenced entry filenames identical or update both sides atomically; the *internal* module split is free).
- `gitCommitSha` in installed_plugins.json (informational; recorded if Omnium is a git repo, harmless either way — but make Omnium a git repo from day one).

## (b) Migration runbook (per machine)

Preconditions: Omnium passes the full parity gate (section a) on this machine; `claude plugin validate /path/to/Omnium` is clean; Node on the machine satisfies the runtime floor (see c). Run everything from the CLI, **not** inside a live session (mid-session pinning, M8, makes in-session migration confusing).

1. **Register the new catalog first** (safe: registering ≠ enabling; plugin *names* only collide at install time):
   `claude plugin marketplace add /path/to/Omnium`
2. **Per plugin, uninstall old then install new** — never let `<p>@<p>` and `<p>@omnium` be installed simultaneously (duplicate commands/hooks/servers):
   ```
   claude plugin uninstall autonomity@autonomity   && claude plugin install autonomity@omnium
   claude plugin uninstall expertum@expertum       && claude plugin install expertum@omnium
   claude plugin uninstall graphyne@graphyne       && claude plugin install graphyne@omnium
   claude plugin uninstall memosyne@memosyne       && claude plugin install memosyne@omnium
   ```
   No `--keep-data` anywhere: the only data dir (memosyne nudge-state) is disposable and would be dead under the new id regardless (section a-D). User scope (default) matches the current installs (`installed_plugins.json`: all `"scope": "user"`).
3. **Remove the four old marketplaces** (now install-free, so M4's cascade does nothing):
   `claude plugin marketplace remove autonomity expertum graphyne memosyne` (one per invocation).
4. **Restart Claude Code** (fresh session; do not rely on `/reload-plugins` across an uninstall/reinstall churn).
5. **Checks (5 minutes):**
   - `claude plugin list` → exactly four entries, all `@omnium`, expected versions.
   - `~/.claude/plugins/installed_plugins.json` → installPaths under `cache/omnium/<p>/<version>/`.
   - In a session in an adopted repo: `/mcp` shows `graphyne`, `memosyne`, `expertum` connected; `/autonomity:status` answers; graphyne SessionStart context appears; one memosyne tool call succeeds and reads the existing `.memosyne/` store; a graphyne `graphyne_status` reads the existing `.graphyne/` store; after any prompt, `~/.claude/plugins/data/memosyne-omnium/nudge-state/` exists.
   - Old dirs: `cache/{autonomity,expertum,graphyne,memosyne}/` orphaned (auto-purged in 7 days, M6); `data/memosyne-memosyne/` gone (deleted at uninstall).
6. **Rollback** (if anything fails): the four upstream plugins are untouched — `claude plugin marketplace add the matching upstream plugin` and reinstall `<p>@<p>` reverses everything. (Graphyne/Memosyne need `pnpm build:plugin` first only if `dist/` was cleaned.)

## (c) `.mts` in shipped hooks/servers — the compat boundary

Facts: Claude Code enforces NO runtime version — `plugin.json` has no `engines` field and unknown fields are ignored (M9); hooks (exec form) and servers.json just exec whatever `node` is on the consumer's PATH directly, no shell (M9). `.mts` needs Node ≥ 22.18.0 or ≥ 23.6.0 to run flagless; below that it throws `ERR_UNKNOWN_FILE_EXTENSION` (M10). And the failure mode is asymmetric: an MCP server that won't start is *visible* (`/mcp` shows it failed), but a hook subprocess that dies means the event silently proceeds — the autonomity Stop gate and the graphyne TDD deny **fail open**. Also relevant: type stripping is erasable-syntax-only (no enums/namespaces-with-values/parameter properties; `import type` discipline; mandatory `.mts` extensions in imports) — a real, testable subset if `.mts` is chosen.

**The boundary the architect-reviewer must respect (my decision):**

- Every file executed via bare `node` on a consumer machine (hook entry points + everything they import, MCP server entry points + imports, `search-worker`) must run **flagless on Node ≥ 22.18.0 and every maintained later line**, and any environment below the floor must **fail loudly, not silently** (for hooks: emit a `systemMessage`/stderr warning from a floor-probe rather than vanishing).
- Within that boundary the language is his call, but the trade-off is not symmetric: **`.mjs` (+ JSDoc types, `tsc --checkJs` in dev) makes the floor question disappear entirely** — it runs on anything remotely modern, needs no erasable-syntax discipline, and matches the two already-proven precedents (autonomity's and memosyne's hooks are `.mjs` today; expertum's server is plain `.js`). `.mts` buys nicer annotations at the cost of a real floor, a syntax-subset discipline, and a fail-open hazard that then must be patched with a SessionStart probe. My recommendation: **`.mjs` for all shipped executables; `.mts` allowed for tests only.** Given the user's machines run Node ≥ 24 today, `.mts` would *work* — the boundary exists for requirement 1 of the mission ("must not preclude later public `marketplace add`"), where consumer Node versions are not controlled.

## (d) Local (path-based) marketplace: what actually refreshes an installed plugin — verified

- A directory marketplace is registered **in place**: `known_marketplaces.json` records `installLocation` = the source path itself (observed, `known_marketplaces.json:10-41`). The *catalog* (marketplace.json) is therefore always the live working tree; `claude plugin marketplace update omnium` re-reads it.
- The *installed plugin* is a **copy** in `~/.claude/plugins/cache/omnium/<plugin>/<resolved-version>/` (M6). The copy is refreshed **only when the resolved version changes** (M5: "if the resolved version matches what a user already has, `/plugin update` and auto-update skip the plugin"). Editing the working tree does nothing to installed copies. This is the PLUGIN.md footgun, now confirmed from official docs rather than folklore — and it has nothing to do with committing per se: the old build stamped patch = commit count (`Memosyne/scripts/build-plugin.mjs:49-54`), which is why "commit before build" mattered there. In Omnium (no build, explicit versions) the trigger is purely **bumping `plugin.json` version**.
- Therefore the two loops are:
  - **Dev loop:** `claude --plugin-dir /path/to/Omnium/plugins/<name>` — loads the working tree directly, no cache, no version bump, session-scoped; tool prefixes identical to installed form (M13), so even permission rules/agent `tools:` lists behave the same.
  - **Release loop:** bump `plugin.json` version → `claude plugin marketplace update omnium` (refresh catalog) → `claude plugin update <p>@omnium` (or startup auto-update) → restart or `/reload-plugins` (mid-session processes stay pinned to the old version path until then, M8). Old version dirs linger 7 days as orphans (M6) — expected, not a bug.
  - The SHA-fallback alternative (omit `version`; every commit = new version, M5) is rejected for Omnium: it forfeits the 0.1.x continuity (contract F) and displays commit SHAs as versions.
- For the versioning decision (monorepo-architect): what replaces commit-count stamping is *discipline plus a guard test* (contract F), and the footgun documentation in Omnium's PLUGIN.md should say exactly: "installed copies update only on `plugin.json` version bump; use `--plugin-dir` while developing."
- Cache-relevant layout constraint (M11): local-path installs skip all symlinks that leave the plugin directory, so the shared MCP core must be physically vendored into each plugin folder; a byte-equality test across the vendored copies is the anti-drift guard.

## Risks

- **Fail-open hooks** are the one place where a mechanical mistake (wrong node floor, a crashing hook) removes safety behavior *silently*; the `.mjs` decision plus fixture replay (E) is the mitigation.
- **Not asserting the wire surface (B1/B4) in the e2e tests** and eyeballing schemas instead would let the zod→mini-validator rewrite drift error strings that agents have learned; the stdio e2e tests are cheap (the servers are stdio + newline-JSON) and are the trustworthy gate.
- **Forgetting the version-bump discipline** re-creates the stale-cache footgun with worse symptoms than before (no stamping safety net); the guard test in F is not optional.

## Recommendations (prioritized)

1. Pin the wire surface (B1-B4) in each server's stdio e2e test before touching the schema/validation code, so a drift in tool names, schemas, or error strings fails the suite.
2. Adopt the runbook in (b) verbatim on this machine as the pilot; only after 5-of-5 checks pass, repeat on other machines.
3. Ship all executables as `.mjs`; add the version-bump guard test; document the `--plugin-dir` dev loop in Omnium's PLUGIN.md with the doc-verified refresh semantics from (d).

## Open questions

- Whether the user's *other* machines run Node ≥ 22.18 (unverifiable from here; irrelevant if `.mjs` is adopted, load-bearing if `.mts` wins).
- Whether `claude plugin update` on a directory marketplace re-resolves the plugin source without a prior `marketplace update` (docs imply marketplace refresh is the catalog step; the runbook orders both, which is safe either way).
- Exact Claude Code version on each machine — the `renames` (2.1.193+) behavior assumes recent builds; nothing in the contract depends on it, but the runbook's `claude plugin` CLI verbs do assume a current CLI.

## Sources

- https://code.claude.com/docs/en/plugins-reference (persistent data directory, caching, symlinks, manifest schema, env vars)
- https://code.claude.com/docs/en/plugin-marketplaces (version resolution, marketplace remove/update CLI, local paths)
- https://code.claude.com/docs/en/hooks (execution model, timeouts, no runtime enforcement)
- https://github.com/anthropics/claude-code/blob/main/plugins/plugin-dev/skills/mcp-integration/references/tool-usage.md (tool prefix format)
- https://github.com/anthropics/claude-code/issues/29360 (prefix identical under --plugin-dir)
- https://nodejs.org/docs/latest-v24.x/api/typescript.html and Node 22.18.0 release notes (type-stripping floors)

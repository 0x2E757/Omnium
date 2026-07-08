# Omnium — design record

Omnium is the single local marketplace housing its plugins as committed,
zero-dependency, human-readable source. This file is the binding decision record; the full
expert reports it condenses live in `docs/design/`. The four migrated plugins
below carry a frozen-surface contract from their upstream releases; the
repo-native plugins (`cautium` D15, `sessio` D16, `statusline`) have no such
predecessor. The prime directives, in
priority order:

1. **No breaking changes.** Every user-visible surface of the currently
   installed plugins (autonomity 0.1.5, expertum 0.3.5, graphyne 0.1.28,
   memosyne 0.1.64) is frozen: tool names and input schemas, error-message
   text, hook events/outputs, command names, on-disk store formats, env vars.
   The exhaustive contract with per-surface verification is
   `docs/design/design-ai-engineer.md` §(a). One sanctioned exception (D17,
   this session): `memosyne_patch_task` — its name, input schema, and error
   text — is retired and replaced by `memosyne_edit_task`, a deliberate
   breaking bump to memosyne 0.4.0. It is the sole break of this freeze; every
   other frozen surface stands.
2. **Zero runtime dependencies, no build.** `plugins/<name>/` is byte-for-byte
   what installs; an import that is not `node:*` or relative is a defect
   (guarded by tests).
3. **Human-readable code.** The 15-rule style charter in
   `docs/development.md` is binding.
4. **Cross-platform.** Every plugin must work on Windows, macOS, and Linux.
   Shipped code must not rely on POSIX-only mechanisms (uid/gid checks, file
   permission bits as the sole protection, `/tmp`, POSIX signals, `sh`-specific
   shell syntax, case-sensitive path assumptions); use `node:path`/`node:os`
   abstractions and platform-neutral designs. A solution that is correct only
   on Linux is a rejected solution.

## Decisions (who decided → where the detail lives)

| # | Decision | Report |
|---|----------|--------|
| D1 | Layout: `plugins/<name>/` ≡ installed artifact; tests at root `tests/<plugin>/`; repo guards in `tests/omnium/`; parity harness in `tests/parity/`; canonical shared code in `shared/`; dev docs in `docs/development.md`; per-plugin `README.md` ships | architect-reviewer |
| D2 | Shared MCP core: `shared/mcp-core.mjs` + `shared/mcp-schema.mjs`, vendored as byte-identical copies into each consumer's `common/` (local installs skip out-of-tree symlinks — verified), synced by `scripts/sync-shared.mjs`, guarded by a byte-compare test. Expertum IS retrofitted onto the core (its 5-suite tests, incl. the stdio e2e, pin the wire contract) | architect-reviewer, ai-engineer M11 |
| D3 | Shipped runtime language: `.mjs` + JSDoc everywhere, typechecked via `tsc --checkJs`. `.mts` would raise the node floor (< 22.18 fails to parse → fail-open hooks silently lose the TDD/Stop gates) — disqualified. Ported Graphyne/Memosyne test suites stay `.mts` (dev-only, node ≥ 24) | architect-reviewer, ai-engineer §(c) |
| D4 | Graphyne YAML: `.yaml` stays THE store format forever. Vendored subset parser (`plugins/graphyne/common/yaml-lite.mjs`, grammar spec'd) + dedicated Meta emitter, byte-identical to `yaml@2` output for the plain-safe scalar domain (all real data), semantic parity beyond. No JSON migration, no dual format | code-reviewer Q3 |
| D5 | Globs: vendored minimal matcher (`**`, `*`, `?`, literals) with picomatch `{dot:true}` semantics per the normative 17-row table; `path.matchesGlob` rejected (no dot option, experimental). Public API of `globs` module unchanged | code-reviewer Q4 |
| D6 | **RETIRED by D17 (memosyne 0.4.0)** — `memosyne_patch_task`, its vendored fuzz-0 jsdiff@9.0.0 `applyPatch` port (`plugins/memosyne/common/unified-diff.mjs`) and the differential oracle are removed, replaced by `memosyne_edit_task`. Original decision (superseded): input schema frozen; exact jsdiff behaviors incl. offset search, `\ No newline`, CRLF auto-conversion, verbatim throw messages | code-reviewer Q5; retired by user directive (this session) |
| D7 | Versions: fresh minor per plugin — autonomity 0.2.0, expertum 0.4.0, graphyne 0.2.0, memosyne 0.2.0 (old patch numbers were commit counts; continuing them risks collisions during migration). Explicit semver in `plugin.json` only; NO `version` in marketplace entries; never SHA versioning | monorepo-architect Q6 (arbitrated over ai-engineer's continuation proposal — collision argument wins; sort-after requirement still holds) |
| D8 | Bump discipline: `scripts/version-guard.mjs` hashes each plugin tree against `.plugin-versions.json`; pre-commit hook auto-bumps PATCH; check mode is part of `npm run check`, so a stale version cannot pass the gate | monorepo-architect Q6 |
| D9 | Dev loop: `claude --plugin-dir` (no cache); release loop: commit (hook bumps) → `/plugin marketplace update omnium` → `/reload-plugins`. Installed copies refresh ONLY on version change (doc-verified) | ai-engineer §(d) |
| D10 | Tests: each plugin's ported suite is its behavioral spec — ported with import-path rewrites only, assertions frozen (web suites excluded, out of scope). Compatibility is held by those suites' end-to-end stdio coverage, the vendored-library differential fixtures under `tests/parity/fixtures/` (the `yaml`/`picomatch` ports byte-checked against the real libraries), the version guard, and the frozen-surface discipline. DoD per port = suite green + fixtures green + repo guards green + `tsc --noEmit` clean + one `--plugin-dir` smoke session | monorepo-architect Q8 |
| D11 | Toolchain: plain npm, devDependencies `typescript` + `@types/node` + `oxlint` (the last added by D14), committed lockfile, engines node ≥ 24 (dev only). No pnpm, no workspaces, no build scripts | monorepo-architect Q8.5, amended by D14 |
| D12 | Migration runbook (per machine): add omnium marketplace → per-plugin uninstall-old/install-new (never both installed) → remove old marketplaces → restart → 5-point check. No `--keep-data`: the only `${CLAUDE_PLUGIN_DATA}` tenant is memosyne's disposable per-session nudge counters (data dir is keyed `<plugin>-<marketplace>` — verified) | ai-engineer §(b) |
| D13 | The D2 vendoring discipline governs EVERY `shared/*.mjs` canonical, not just the MCP core — currently also `lock-core.mjs`, `project.mjs`, and `atomic-write.mjs`. Behavior that legitimately differs per plugin (env-knob prefix, product name in errors) is shared as a FACTORY canonical behind a per-plugin domain shim (`common/lock.mjs` = `createFileLock({ envPrefix, product })`); identical behavior (project resolution, atomic writes) is shared shim-free, copies-as-the-module. This is the sanctioned shape for future twin dedupes (registry) — never runtime plugin-name detection inside a canonical | code-reviewer + architect-reviewer, lock-dedupe review |
| D14 | Static-analysis gate: `oxlint` (dev-only, amends D11) runs first in `npm run check`. Scope = `correctness` category ONLY, plus cherry-picked `import/no-cycle` + `import/no-self-import` (guard the vendored `common/` DAG — a cycle among the 4× copies is invisible to `tsc`). Wholesale `suspicious`/`style`/`pedantic`/`perf`/`restriction`/`nursery` are REJECTED: on a frozen-bytes surface (D1, charter rule 14) their only remedy is the forbidden rewrite (a `suspicious` census returned 60 findings, 0 real bugs, 1 false positive). Style stays the human 15-rule charter, not a machine. Carve-outs: `unicorn/prefer-string-starts-ends-with` off; `no-control-regex` off for the ported YAML emitter `graph.mjs` | code-reviewer + architect-reviewer, oxlint rule-layering review |
| D15 | Fifth plugin `cautium`: an always-on, zero-config security-conscience injector — a single `SessionStart` hook emits a three-layer primer as `additionalContext`: (1) six universal security duties (secrets, injection-safe input, least-priv authN/Z, supply-chain, crypto/TLS, never-disable-a-control); (2) a universal 0-10 change-impact rubric (autonomous / confirm-per-step / explicit-approval tiers + PID-targeted process kills); (3) an **OS-dependent** risk mapping keyed on `process.platform` (Linux calls out `/etc`, systemd, firewall/exposure, `fstab`/GRUB, `rm -rf`, SSH severing, `pkill`/`killall`; Windows calls out the registry, `PATH`/environment, OS settings, scheduled tasks/services, elevation/UAC, `taskkill`; macOS calls out `launchd`/`launchctl`, SIP, Gatekeeper, Keychain, Homebrew, `sudo`, `killall`; generic OS-neutral fallback for the rest). No MCP server, no commands, no state, no other events; the dispatcher fails OPEN. Repo-native — no upstream predecessor, so D1's frozen-surface freeze does not cover it; born at 0.1.0. Mirrors the autonomity zero-dep split (IO shell `hook.mjs` over pure `hook-lib.mjs`); pure Node ⇒ cross-platform (directive 4). Host-specific policy still lives in the user's own `CLAUDE.md`; layer 3 only tailors the risk taxonomy to the platform | user directive (this session) |
| D16 | Sixth plugin `sessio`: an always-on, zero-config scratch-file router — a single `SessionStart` hook injects a primer that routes temporary/generated files into a per-task dated subdirectory (`<base>/YYYY-MM-DD--<desc>`) of a scratch root, with exceptions for explicit output paths and project files. The root is read from the **`CLAUDE_SESSIONS_DIR`** env var (a FROZEN surface per D1; user/OS-specific, never hardcoded); when unset the hook does NOT go quiet — it injects an ONBOARDING primer that has the agent ask the user for a base dir and persist the env (recommended: Claude Code settings `env` in `settings.json`, applied cross-platform to the session and its hooks). No MCP server, no commands, no state, no other events; dispatcher fails OPEN; no fs writes (the agent mkdirs on demand). Repo-native — outside D1's freeze except the new `CLAUDE_SESSIONS_DIR` knob; born at 0.1.0. Mirrors the cautium/autonomity zero-dep IO-shell/pure-lib split | user directive (this session) |
| D17 | Retire `memosyne_patch_task` + its vendored fuzz-0 jsdiff@9.0.0 `applyPatch` port (`plugins/memosyne/common/unified-diff.mjs`) and the differential oracle; replace with a single LLM-native `memosyne_edit_task` — an exact `old_text`/`new_text` targeted editor (Claude Code `Edit` model: read-first, literal byte-match, unique-or-fail unless `replace_all`, empty `new_text` deletes), reusing the retired handler's lock / stale-Done guard / per-section validation. The uniqueness gate makes silent mis-apply impossible — no line numbers, no fuzz, no offset search to land on a coincidental duplicate. `memosyne_update_task` stays the full-section replace; `memosyne_edit_task` is the ONLY targeted editor. First sanctioned break of the D1 freeze (tool name + input schema + error text); breaking bump to memosyne 0.4.0. Supersedes D6 | user directive (this session) |

## Verified mechanics the design rests on

- MCP tool prefix is `mcp__plugin_<plugin>_<server>__<tool>` — marketplace name
  never appears; the omnium switch changes no tool/command/agent name.
- Cache: `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`; directory
  marketplaces are registered in place (catalog reads the live tree; installed
  plugins are copies refreshed only on version change).
- Hooks use exec form (`"command": "node"` + `args`; doc-recommended for path
  placeholders) — spawned directly, no shell on any platform. Shell form would
  run via `sh -c` (macOS/Linux) or Git Bash/PowerShell (Windows). No
  runtime-version enforcement; hooks fail OPEN — hence the `.mjs` floor decision.

Full fact table with sources: `docs/design/design-ai-engineer.md` §Verified mechanics.

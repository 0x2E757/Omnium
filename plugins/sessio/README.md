# Sessio

A Claude Code plugin that keeps **temporary and generated files tidy**. A single
`SessionStart` hook injects a primer telling the agent to route throwaway files
(scripts, data dumps, intermediate outputs, logs) into a per-task dated
subdirectory of a **scratch root**, instead of scattering them across the
working directory, your home, the Desktop, or the system temp dir — without you
copying the same rule into every project's `CLAUDE.md`.

It is **zero-config in behavior** (no commands, no toggle, no state, no MCP
server) and pure Node built-ins, so it is **cross-platform** (Windows/macOS/
Linux). It never writes to disk itself — the agent creates the subdirectory on
demand.

## The scratch root — one setting

The scratch root is deliberately **not hardcoded**: every user and OS has a
different preferred location (`~/claude-sessions`, `C:\Work\Claude Sessions`, …).
Sessio reads it from the **`CLAUDE_SESSIONS_DIR`** environment variable.

- **Configured** (`CLAUDE_SESSIONS_DIR` set) — the primer routes files under it:
  a per-task subdirectory named `YYYY-MM-DD--<short-kebab-description>`
  (e.g. `<base>/2026-07-06--parse-csv-data`), one per run. Today's date is
  computed by the hook. Exceptions: (1) a task that specifies an output path wins;
  (2) files that belong to a project (source, configs, tests) go in the project
  tree, not the scratch root.
- **Unconfigured** (unset) — the plugin does **not** go quiet. The primer
  *onboards*: it has the agent ask you for a base directory and then persist it
  as `CLAUDE_SESSIONS_DIR` so future sessions are configured — the recommended
  place is Claude Code's settings `env` in `settings.json` (applied
  cross-platform to the session and its hooks; the `/update-config` skill can set
  it), though an OS/shell environment variable works too.

## How it works

One hook, wired in `hooks/hooks.json` and dispatched by `hooks/hook.mjs`:

| Event | Behavior |
|-------|----------|
| `SessionStart` | Emits the scratch-file routing primer (routing under `CLAUDE_SESSIONS_DIR` when set, onboarding when not) as `additionalContext`. |

Every other event is a silent no-op. The dispatcher **fails open**: any error
emits nothing, so a bug can never brick a session. The primer text and its
accessors live in `hooks/hook-lib.mjs`, kept separate from the IO shell so both
are unit-testable without spawning a process.

It is **pure hooks** — no MCP server, no build step, zero dependencies (Node
built-ins only).

## Install

Sessio ships as part of the **Omnium** plugin collection; see the Omnium
repository's `README.md` and `docs/development.md` for marketplace setup and
install instructions.

## Develop / test

From the Omnium repo root:

```sh
npm test           # run the unit + wiring tests (zero dependencies)
npm run stamp      # auto-bump PATCH when plugin bytes changed (content hash, scripts/version-guard.mjs)
```

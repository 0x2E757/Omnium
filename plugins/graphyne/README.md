# Graphyne

Enforces two disciplines per adopted project: a **TDD gate** (editing gated
source is denied until a covering test is failing) and a **related-files
graph** (every file can declare the files it is connected to; editing a file
flags its neighbors for review before the turn may end). MCP server (the
writer) + enforcement hooks, shipped as committed zero-dependency source.

## Opt-in per project

Graphyne is dormant until the project has a `.graphyne/` directory:

- `/graphyne:setup` — adopt the project (creates the store; the hook handles
  this command directly and erases the prompt).
- `/graphyne:init` — forced full pass to populate the graph for an existing
  codebase.

Until adoption the MCP server completes its handshake with no tools and the
hooks stay silent — Graphyne looks uninstalled.

## Store & config

- `.graphyne/meta/<path>.yaml` — one meta file per node, COMMITTED. Undirected
  edges with 1–5 one-word tags each; `graphyne_link` writes both sides.
- `.graphyne/tasks/<session-id>/` — session state (edited files, red/green,
  checklist, grants, stop-block chain markers, the `/graphyne:off` mute),
  gitignored.
- `graphyne.json` — project config: `source`/`exclude`/`tests`/`docs`/`specs`/
  `metaExclude`/`ignore` globs and the `test.file`/`test.all` commands
  (plus optional `test.timeoutMs` — per-run cap, default 10 minutes, so a
  hanging test command can't wedge the serial MCP queue).

The YAML store format and the glob dialect are frozen compat surfaces: the
vendored subset parser/emitter (`common/yaml-lite.mjs`, `common/graph.mjs`) is
byte-identical to the old `yaml@2` output for every real store, and the
vendored matcher (`common/globs.mjs`) reproduces picomatch `{dot:true}`
semantics — stores written here stay readable (and diff-clean) for checkouts
still running graphyne ≤ 0.1.28, and vice versa.

## Tools (12)

`graphyne_project`, `graphyne_neighbors`, `graphyne_link`, `graphyne_unlink`,
`graphyne_forget`, `graphyne_test`, `graphyne_refactor` (delete-only grant),
`graphyne_bypass` (self-attested grant, weakest), `graphyne_checklist`,
`graphyne_review`, `graphyne_meta_confirm`, `graphyne_status`.

## Hooks

`SessionStart` (onboarding + post-compaction reconcile), `UserPromptSubmit`
(session pointer + `/graphyne:setup` adoption + the `/graphyne:off|on|status`
mute toggles), `PreToolUse` (the TDD deny
gate, incl. pure-deletion detection for refactor grants), `PostToolUse`
(edit bookkeeping + nudges), `Stop`/`SubagentStop` (hard block while meta,
reviews, confirmations, red tests, or grant re-verifications are outstanding).
Subagent scoping: every edit is attributed to the agent that made it (the
payload's `agent_id`; the main loop is `"main"`), and `SubagentStop` gates a
subagent only on the obligations its OWN edits incurred — a read-only subagent
(e.g. an analyst with no edit tools) passes silently, while the session-wide
`Stop` gate remains the parent's backstop for anything a subagent leaves
behind. A `SubagentStop` payload without `agent_id` falls back to the full
session gate.
Loop protection: when the payload carries `stop_hook_active` (boolean `true`
or string `"true"` — the stop is already a continuation caused by a prior
stop-hook block), the gate itself already blocked in the current stop chain
(own per-event/agent record, cleared by the next user prompt), AND the
outstanding count is unchanged since that block (progress and new work both
re-block), the gate waives with a `systemMessage` warning instead of
re-blocking — so an uncleanable obligation cannot loop, another gate's block
(other plugins, or a subagent's SubagentStop) never disarms this one, and
multi-stop convergence keeps its pressure.
Hooks fail OPEN; the store is the durable truth.

## Recovery

Obligations are cleared through the Graphyne MCP tools, but the gates are
enforced by hooks — so a dead or unregistered MCP server would leave them
uncleanable. The escape hatches, in order:

- **`/graphyne:off`** — mute enforcement for the current session (hook-handled,
  works without the MCP server): the TDD gate stops denying, Stop/SubagentStop
  warn instead of blocking. Obligations keep being **recorded, not cleared** —
  `/graphyne:on` re-arms the gates with the full set, `/graphyne:status`
  reports the current state. Because only a real user prompt fires
  `UserPromptSubmit`, the model cannot invoke the toggles itself. A resumed
  session keeps its mute (SessionStart reminds about it); a new session starts
  unmuted.
- **Manual, when even the hook is broken** — delete the session's state
  directory `.graphyne/tasks/<session-id>/` (session id = content of
  `.graphyne/tasks/.current`), or all of `.graphyne/tasks/`. That is
  gitignored session state; the committed graph under `.graphyne/meta/` is
  untouched.
- **Nuclear** — remove/rename the `.graphyne/` directory itself: the opt-in
  gate makes the whole plugin dormant.

## Layout

- `server.mjs` — stdio MCP entry on the vendored core (`common/mcp-core.mjs`,
  wire dialect "sdk"), with the prior zod-era validation text reproduced
  byte-for-byte.
- `tools.mjs` — the FROZEN advertised surface (12 tool definitions), data not
  code; its `instructions` text is the one unfrozen part, re-cut to fit Claude
  Code's ~2KB per-server cap (budget pinned by
  `tests/graphyne/mcp/instructions.test.mts`).
- `handlers.mjs` — pure tool logic; `hooks/hook.mjs` — the event dispatcher.
- `common/` — the ported modules plus the vendored `yaml-lite.mjs`/`globs.mjs`
  and the shared MCP core copies (synced from `shared/`, do not edit here).

Dev/test harness lives in the Omnium repo root (`tests/graphyne/`,
`tests/parity/`) and never ships. See `docs/development.md` for the two-lane
workflow (`--plugin-dir` for iteration; commit → marketplace update to adopt).

# Memosyne

Session-independent task memory for git projects. The agent records each piece
of substantial work as a **task** — a small markdown file under the project's
own `.memosyne/` store — via an **MCP server**, so a future agent (a later
session, or a different agent entirely) can reconstruct what was done, why, and
how to continue, without access to the chat. Adoption **hooks** nudge the agent
to actually record and hand off work instead of letting it evaporate.

## Opt-in per project

Memosyne is installed at user scope but acts **only** where a project has been
adopted by creating a `.memosyne/` directory at its root. Until then:

- the MCP server connects **dormant** — no tools advertised, no instructions sent;
- the hooks emit nothing for any event.

To adopt a project, run **`/memosyne:setup`** in it: the `UserPromptSubmit` hook
creates and seeds the store (`config.json` + the `AGENTS.md`/`CLAUDE.md` guard
files) and erases the prompt, then asks you to restart the session — activation
is resolved once, at server startup. Creating the folder by hand (`mkdir
.memosyne`) is equivalent; `commands/setup.md` doubles as fallback instructions
if the hook does not fire. Commit `.memosyne/` to share the store with your team.

## Task model

A task is a flat file `YYYY-MM-DD--HH-MM--{name}.md` with five tagged sections —
`summary` (a stable one-line abstract), `status` (`Backlog`, `Active`,
`Blocked`, `Done`, `Cancelled`), `related` (stems of connected tasks; the
relation is undirected — link/unlink write both sides), `files` (repo-relative
paths tagged P0/P1 plus up to 5 tags), and `description` (free-form markdown).
The agent touches these files **only** through the MCP tools, which keeps the
schema consistent; writes are atomic and serialized by a per-task lock, and
completed (`Done`, >2h old) tasks are guarded against casual editing so a
closed hand-off record stays frozen.

## MCP server (`server.mjs`)

Zero-dependency Node stdio server (the vendored shared core in `common/`),
launched by `mcp/servers.json` with `MEMOSYNE_PROJECT_DIR` pointing at the
project root (the git top level is used, so one repo has a single store no
matter the subdirectory). On an adopted project it sends MCP `instructions` on
connect — a briefing on the hand-off purpose and the task model, budgeted to
Claude Code's ~2KB per-server cap (`instructions.mjs`, pinned by
`tests/memosyne/instructions.test.mts`; per-tool usage lives in the tool
descriptions, scheduling in the hooks) — and advertises 11 tools:

`memosyne_project`, `memosyne_create_task`, `memosyne_list_tasks`,
`memosyne_find_by_file`, `memosyne_search` (full-text regex over
summary + description, ReDoS-bounded in a worker), `memosyne_get_task`
(a `sections` subset), `memosyne_update_task`, `memosyne_edit_task`
(replace an exact snippet of one plain-text section), `memosyne_link` /
`memosyne_unlink`, `memosyne_delete_task`.

The server also records every adopted project it runs in to a small discovery
registry (`data/registry.json` under the install root) — a plain index of
project paths and cached git metadata that repopulates itself if lost.

## Hooks (`hooks/hook.mjs`)

One dispatcher script wired to six events in `hooks/hooks.json`, entirely
passive (`additionalContext` nudges; nothing is ever blocked except the
`/memosyne:setup` prompt erase):

| Event | Behavior |
|-------|----------|
| `SessionStart` | startup/clear: recover context — load the Memosyne tools and review recent tasks before the first turn. compact: data-driven reconcile nudge when untracked work predates the summary. |
| `PostToolUse` (`*`) | Counts untracked work on two tiers — file edits and read/research calls — since the last Memosyne WRITE, and nudges when a tier is crossed. Memosyne writes reset the counters; Memosyne reads are ignored (reading is not tracking). |
| `PreToolUse` (`TaskCreate\|TaskUpdate`) | Every 3rd harness-task call: remember to ALSO record the work in Memosyne. |
| `UserPromptSubmit` | `/memosyne:setup` bootstrap; otherwise a short reminder every 3rd prompt unless a Memosyne write is recent. |
| `Stop` / `SubagentStop` | Turn-boundary hand-off nudge once enough untracked edits or reads have piled up. Events fired inside a subagent (`agent_id`-tagged) are ignored: a subagent's tool calls never inflate the main session's counters and its `SubagentStop` owns no hand-off, so background subagents can't re-trip the nudge on the parent's turns. |

Per-session counters live under `${CLAUDE_PLUGIN_DATA}/nudge-state/` —
disposable by design (safe to lose on update, uninstall or marketplace moves).

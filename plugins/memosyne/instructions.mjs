// The LLM-facing `initialize` instructions, in an import-safe module so tests
// can measure them (server.mjs starts the server at import time and cannot be
// imported). Claude Code silently truncates each MCP server's instructions at
// ~2KB — the pre-Omnium ~9KB text lost its entire task model to the cut — so
// this text is budgeted (<= 1900 chars) and front-loaded; the budget and the
// first-500-chars contract are pinned by tests/memosyne/instructions.test.mts.
// Scheduling (checkpoint cadence, significance thresholds) deliberately lives
// in the hooks, which fire just-in-time with live counters — the instructions
// only defer to them. Tool-by-tool usage lives in each tool's description.

import { STATUSES, DEFAULT_STATUS, SUMMARY_SOFT_MAX, DESCRIPTION_SOFT_MAX, MAX_TAGS } from "./common/task.mjs";

export const MEMOSYNE_INSTRUCTIONS = `\
Memosyne — persistent, session-independent task memory for THIS git project. PRIMARY purpose: hand-off — write tasks so a future agent can reconstruct what was done, why, and how to continue without this chat; record intent and rationale, not just steps.

Never read or write files under .memosyne/ directly; work with tasks ONLY through the memosyne_* tools.

At session start, call memosyne_list_tasks (and memosyne_project) to recover context. TRACKING means WRITING: only memosyne_create_task / memosyne_update_task / memosyne_edit_task persist a hand-off — reads recover context but record nothing. Hook reminders fire at work checkpoints — when they do, write (backfill if needed). When in doubt, create: a needless task is cheap, a lost hand-off is not.

TASK MODEL — five sections:
- summary: a STABLE abstract of what the task is about and why (<=${SUMMARY_SOFT_MAX} chars, one line). NEVER progress/results — no "DONE", no step log; it reads the same for Backlog and Done.
- status: ${STATUSES.join(", ")} — states, not actions; default ${DEFAULT_STATUS}.
- related: undirected links to other task stems — memosyne_link/memosyne_unlink write both sides. Link liberally.
- files: repo-relative entry points for resuming, P0 (must read) / P1 (maybe useful), up to ${MAX_TAGS} tags.
- description: free-form markdown; angle-bracket placeholders like <id> render verbatim. Keep under ~${DESCRIPTION_SOFT_MAX} chars — past that, split into linked tasks.

COMPLETED WORK IS FROZEN: prefer a NEW task over editing one Done and >2h old (tools refuse outside the 3 most recent unless force: true).

All task content in English. Address a task by its stem (from create/list). Read selectively: memosyne_get_task (sections), memosyne_search (regex), memosyne_find_by_file (path); memosyne_delete_task removes a task and its links. Prefer memosyne_edit_task over full rewrites; reuse existing tasks — creation fails on a stem collision.`;

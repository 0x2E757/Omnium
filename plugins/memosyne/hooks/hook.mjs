// Memosyne adoption hooks — a single Claude Code hook script, dispatched by event.
//
// Why one file: every Memosyne hook shares the same goal (make the deferred Memosyne MCP
// actually get used) and the same plumbing (read the hook JSON on stdin, print
// {hookSpecificOutput:{hookEventName,additionalContext}} on stdout, exit 0).
// Keeping them together shares that plumbing and gives one canonical,
// absolute-path script — mirroring how .mcp.json points at the memosyne server. The
// hook EVENT is passed as argv[2] so hooks.json picks the branch.
//
// Install: shipped as part of the Omnium memosyne plugin — this file runs in
// place, no bundling step. The sibling hooks/hooks.json registers one
// hooks.<Event> entry per event whose command is
//   node "${CLAUDE_PLUGIN_ROOT}/hooks/hook.mjs" <Event> "${CLAUDE_PLUGIN_DATA}"
// Counter state lives under the persistent ${CLAUDE_PLUGIN_DATA} passed as
// argv[3] (see TEMP_DIR below), regardless of which project triggered the hook.
//
// Provenance: a verbatim transplant of the prior memosyne hook (executable
// lines untouched — only these comments describe the Omnium reality). Every
// emitted nudge string and counter behavior is a frozen surface, pinned by
// tests/memosyne/claude.test.mts.
//
// All these events deliver model-visible text via hookSpecificOutput.additionalContext
// (verified against the official hooks docs). SessionEnd is deliberately NOT
// wired up: it is cleanup-only and cannot inject anything the model sees. Stop is
// intentionally a passive additionalContext nudge (no decision:"block"), so it
// never forces the agent to keep going — the reminder simply surfaces next turn.
//
// TRACKING MODEL — the core invariant
//   ONLY a Memosyne WRITE counts as tracking. Creating/updating/editing a task (or
//   linking/unlinking/deleting one) records a hand-off and is the single signal that
//   "this work is now persisted". Memosyne READS (memosyne_list_tasks / memosyne_get_task /
//   memosyne_search / memosyne_find_by_file / memosyne_project) are NOT tracking — the
//   SessionStart recovery read must not make the hook believe work is recorded.
//   So reads are ignored entirely by the counters; only writes reset them.
//
//   Untracked work is measured on TWO independent counters, each counting tool
//   calls since the last Memosyne WRITE (not since any touch):
//     - sinceEdits — project mutations (Edit/Write/NotebookEdit/MultiEdit).
//     - sinceReads — every OTHER non-Memosyne tool call (Read/Grep/Glob/WebSearch/
//       WebFetch/Bash/Task subagents/…). This is the RESEARCH signal — the kind
//       of substantial work that produces no file edits yet is expensive to redo,
//       and which the old edit-only model never caught.
//   Each has its own soft/hard tier (below). An Memosyne write zeroes both (and the
//   Stop baselines), so drift restarts cleanly after each hand-off.
//
// Events handled:
//   PostToolUse  (matcher "*", i.e. every tool) — bump the right counter and nudge
//     when a tier is crossed. Wording is chosen by whether anything has been
//     RECORDED this session (memosyne.writes>0): "create a task" if not, "update / new
//     task" if so. Reads and edits each escalate on their own tier.
//   PreToolUse   (matcher TaskCreate|TaskUpdate) — when the agent reaches for the
//     harness Task tracker, remind it to ALSO record the work in Memosyne for hand-off
//     (in addition, not instead); throttled to every 3rd call.
//   UserPromptSubmit — short Memosyne reminder every 3rd prompt (suppressed only if Memosyne
//     was WRITTEN recently).
//   Stop / SubagentStop — at a turn boundary, if untracked work has accumulated
//     (edits >= STOP_EDITS OR reads >= STOP_READS since the last Stop baseline) and
//     Memosyne wasn't written recently, nudge for hand-off.
//   SessionStart (source startup|clear) — on a fresh context, load the deferred
//     Memosyne tools and review recent tasks before the first turn.
//   SessionStart (source compact) — the context was just summarized and detail may
//     be lost; nudge to reconcile the tracked tasks with what survived the summary.
//     Gated on the untracked-work counters (silent when nothing needs reconciling)
//     and yields to a newer user prompt (manual /compact). (PreCompact cannot do
//     this: Claude Code ignores additionalContext for it, and anything injected
//     before compaction would be summarized away anyway.)
//
// Counters: sinceEdits / sinceReads (untracked work since last Memosyne WRITE) drive
// the PostToolUse + Stop nudges. memosyne.writes records hand-offs this session (chooses
// create-vs-update wording and gates recency suppression). prompt/task keep a
// lifetime `total` + a `since` that resets on fire (cadence exactly every N).
// stopEditBase/stopReadBase mark the counters at the last Stop nudge so it doesn't
// repeat every turn.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

// Cadence for the prompt + task-mirror nudges: emit once every N such events.
const EVERY = { prompt: 3, task: 3 };

// --- Tiered untracked-work nudges --------------------------------------------
// Two counters, each measured in tool calls since the last Memosyne WRITE, with their
// own soft/hard thresholds. Edits are the stronger signal (a mutation is concrete
// work), so they trip sooner; reads need more volume before they clearly add up to
// substantial research. After the hard tier, re-fire every HARD_REPEAT calls.
const EDIT_SOFT_AT = 2;
const EDIT_HARD_AT = 5;
const READ_SOFT_AT = 5;
const READ_HARD_AT = 10;
const HARD_REPEAT = 5;

// Project-mutation tools — these feed the EDIT counter; everything else non-Memosyne
// feeds the READ counter.
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// Memosyne MCP tool names reach the hook namespaced by the harness, and the
// namespace depends on how the server is installed:
//   standalone:  mcp__memosyne__memosyne_<action>
//   as a plugin: mcp__plugin_memosyne_memosyne__memosyne_<action>
// Match on the BARE action name (the segment after the final "__"), which is
// "memosyne_<action>" in every layout — so a future namespace change can never
// again make the hook blind to Memosyne writes. (Matching the full prefixed name
// was the plugin-conversion regression: the hook stopped seeing any write, so
// counters never reset and the Stop nudge fired every turn.)
function bareToolName(tool) {
  const i = tool.lastIndexOf("__");
  return i === -1 ? tool : tool.slice(i + 2);
}

// Memosyne WRITE tools, by bare action name — calling one RECORDS a hand-off: it is
// the only thing that counts as tracking, resetting both work counters. Reads (any
// other memosyne_* tool) are deliberately NOT here and are ignored by the counters.
const MEMOSYNE_WRITE_TOOLS = new Set([
  "memosyne_create_task",
  "memosyne_update_task",
  "memosyne_edit_task",
  "memosyne_link",
  "memosyne_unlink",
  "memosyne_delete_task",
]);

// Any Memosyne MCP tool (read or write): an mcp__…__memosyne_* call, regardless of
// namespace. Used to IGNORE Memosyne reads (neither tracking nor work).
function isMemosyneTool(tool) {
  return tool.startsWith("mcp__") && bareToolName(tool).startsWith("memosyne_");
}

// The harness tags every hook payload fired INSIDE a subagent with agent_id
// (PostToolUse for its tool calls, SubagentStop when it ends); main-loop payloads
// carry none. Memosyne's counters model the MAIN conversation's hand-off obligation,
// and subagents here own no Memosyne write tools — so subagent activity must never
// touch the parent's counters and a subagent SubagentStop owns no hand-off to nudge
// (the whole session's Stop stays the backstop for whatever the parent actually leaves
// behind). Returns null when absent or blank, so a legacy harness that never sends
// agent_id keeps today's whole-session behavior.
//
// Only this HELPER is borrowed from graphyne/hooks/hook.mjs; the STRATEGY differs.
// Graphyne records per-agent work and scopes only its SubagentStop gate to that slice,
// because a graphyne subagent can incur AND clear its own obligations. A Memosyne
// subagent cannot (no write tool), so a per-agent counter would only ever raise a nudge
// it can never satisfy — hence Memosyne drops subagent events wholesale instead.
function agentIdOf(input) {
  const a = input.agent_id;
  return typeof a === "string" && a !== "" ? a : null;
}

// Below this many tool calls since the last Memosyne WRITE the work is presumed freshly
// tracked, so the prompt and Stop nudges are suppressed (redundant with the live
// hand-off). Reads never make work "recent" — only a write does.
const RECENT_WITHIN = 5;
// Stop/SubagentStop fire once this much untracked work has piled up since the last
// Stop nudge — edits OR reads, so a read-heavy (research) turn triggers it too.
const STOP_EDITS = 2;
const STOP_READS = 5;

// Reminder texts. The periodic nudge has create-vs-update wording (by whether
// anything was recorded this session) and soft-vs-hard tone (by tier). `kind` is
// "edit" or "read"; `n` is that counter's value, for concreteness.
const workPhrase = (kind, n) => (kind === "edit" ? `${n} file edit(s)` : `${n} read/research tool calls`);

const createNudge = (kind, n, hard) =>
  `Memosyne: ${workPhrase(kind, n)} this session and NOTHING recorded yet. ` +
  (hard
    ? `This is clearly substantial work a future agent must be able to resume (research counts, not just edits) — create a task NOW (memosyne_create_task). `
    : `If this is becoming real work, record it so a future agent can resume — create a task (memosyne_create_task). `) +
  `Memosyne tools are deferred: load via ToolSearch if needed.`;

const updateNudge = (kind, n, hard) =>
  `Memosyne checkpoint: ${workPhrase(kind, n)} since your last Memosyne write. ` +
  (hard
    ? `Update the task you're tracking (memosyne_update_task / memosyne_edit_task — status/description/files), or open a NEW task if this is different work.`
    : `If this is the same task, update it (memosyne_update_task / memosyne_edit_task) as you go; if it's new work, open a new task.`);

const PROMPT_NUDGE = `Reminder: track and hand off substantial work — including research/investigation, not just file edits — via the Memosyne MCP (its tools are deferred; load them with ToolSearch if needed).`;
const TASK_NUDGE =
  `You're using the harness Task tool. In ADDITION (not instead), make sure this work is recorded for hand-off in ` +
  `the Memosyne MCP — memosyne_create_task for new work, memosyne_update_task as it progresses. ` +
  `Load the deferred Memosyne tools with ToolSearch if needed.`;
const STOP_CREATE_NUDGE =
  `Turn ending with untracked work (file edits and/or research) and nothing recorded in Memosyne. By Memosyne's significance ` +
  `rule — research/investigation is hand-off-worthy too, not just file edits — a future agent will need this to ` +
  `resume. Create a task in the Memosyne MCP (memosyne_create_task; deferred — load via ToolSearch if needed).`;
const STOP_UPDATE_NUDGE =
  `Turn ending after more work since your last Memosyne write. Record it for hand-off: update the tracked task ` +
  `(memosyne_update_task / memosyne_edit_task) or open a new one (Memosyne tools are deferred — load via ToolSearch if needed).`;
// Data-driven (unlike its static siblings): reports the untracked-work counters that
// survived the summary on disk, and only fires when they show something to reconcile.
// The closing clause yields to a newer user prompt — SessionStart(compact) also fires
// on manual /compact, where "continue the interrupted work" would fight the fresh
// prompt sitting right next to it.
const postCompactNudge = (edits, reads) =>
  `Memosyne: the context was just compacted — ${edits} file edit(s) and ${reads} read/research tool call(s) ` +
  `since the last Memosyne write predate it, and their detail survives only as far as the summary kept it. ` +
  `Reconcile as a silent setup step: load the deferred Memosyne tools via ToolSearch, review the tracked ` +
  `tasks (memosyne_list_tasks), and record any in-progress work visible in the summary but not yet tracked ` +
  `(memosyne_update_task / memosyne_create_task). Then continue in the SAME turn with whatever is pending — ` +
  `the interrupted task, or the user's newer prompt if one is present — without stopping to announce the ` +
  `reconciliation.`;

// State (per-session nudge counters, gitignored, best-effort) lives in a writable dir.
// As a plugin, Claude Code passes the persistent ${CLAUDE_PLUGIN_DATA} as argv[3] — use
// it so state survives plugin updates and never lands in the read-only plugin cache.
// Fallbacks keep an argv[3]-less invocation working: MEMOSYNE_ROOT/data/temp, else a
// dir resolved relative to this file (hooks/ -> the shipped plugin root).
const ROOT = process.env.MEMOSYNE_ROOT || join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEMP_DIR = process.argv[3] ? join(process.argv[3], "nudge-state") : join(ROOT, "data", "temp");

function readStdin() {
  try {
    // Strip a leading UTF-8 BOM: some shells prepend one when piping, and it
    // would otherwise make JSON.parse throw and silently disable the hook.
    return JSON.parse(readFileSync(0, "utf8").replace(/^﻿/, ""));
  } catch {
    return {};
  }
}

function emit(hookEventName, additionalContext) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }));
}

// State file path for this session+repo, so switching projects within one session
// keeps independent counters.
function statePath(input) {
  const cwd = input.cwd || process.cwd();
  const sessionId = String(input.session_id || "nosession").replace(/[^\w-]/g, "_");
  const repoTag = createHash("sha1").update(cwd).digest("hex").slice(0, 8);
  return join(TEMP_DIR, `nudge-${sessionId}-${repoTag}.json`);
}

function loadState(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function saveState(file, state) {
  try {
    mkdirSync(TEMP_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify(state));
  } catch {
    /* best-effort counter */
  }
}

// Bump the `category` counter for this session+repo and report whether its nudge
// should fire now. `total` accumulates for the record; `since` drives the cadence
// and resets to 0 on fire, so the nudge lands exactly every EVERY[category].
function bumpAndCheck(input, category) {
  const file = statePath(input);
  const state = loadState(file);
  const c = (state[category] ||= { total: 0, since: 0 });
  c.total += 1;
  c.since += 1;

  let fire = false;
  if (c.since >= EVERY[category]) {
    c.since = 0;
    fire = true;
  }
  saveState(file, state);
  return fire;
}

// Untracked work since the last Memosyne WRITE (edits + reads). Drives recency.
function untracked(state) {
  return (state.sinceEdits || 0) + (state.sinceReads || 0);
}

// Whether the agent WROTE to Memosyne recently — recorded a hand-off within the last
// RECENT_WITHIN tool calls. Used to suppress the prompt/Stop nudges while tracking
// is fresh. A read never qualifies (reads aren't tracking), and "never recorded"
// (memosyne.writes==0) is never recent — those nudges should still fire to prompt a write.
function isMemosyneRecent(state) {
  if (!state.memosyne || !state.memosyne.writes) return false;
  return untracked(state) < RECENT_WITHIN;
}
function memosyneRecentlyUsed(input) {
  return isMemosyneRecent(loadState(statePath(input)));
}

// Record a Memosyne WRITE: this is the one tracking signal. Count the hand-off and
// zero both work counters (and the Stop baselines), so drift is measured from this
// write onward. Writing to Memosyne never itself emits a nudge.
function recordMemosyneWrite(input) {
  const file = statePath(input);
  const state = loadState(file);
  const memosyne = (state.memosyne ||= { writes: 0 });
  memosyne.writes += 1;
  state.sinceEdits = 0;
  state.sinceReads = 0;
  state.stopEditBase = 0;
  state.stopReadBase = 0;
  saveState(file, state);
}

// Whether `n` just crossed a soft/hard tier: exactly at soft, then at hard and
// every HARD_REPEAT calls beyond it.
function crossesTier(n, soft, hard) {
  return n === soft || (n >= hard && (n - hard) % HARD_REPEAT === 0);
}

// --- PostToolUse(*): tiered untracked-work nudge -------------------------------
// Memosyne writes record a hand-off (reset counters, no nudge). Memosyne reads are ignored
// (not tracking, not work). Every other tool bumps its counter — edits vs reads —
// and nudges when that counter crosses its tier, with create-vs-update wording
// chosen by whether anything has been recorded this session.
function postToolUse(input) {
  const tool = input.tool_name || "";
  if (isMemosyneTool(tool)) {
    // A WRITE records a hand-off (resets counters); a READ is ignored entirely.
    if (MEMOSYNE_WRITE_TOOLS.has(bareToolName(tool))) recordMemosyneWrite(input);
    return;
  }

  const file = statePath(input);
  const state = loadState(file);
  const isEdit = EDIT_TOOLS.has(tool);

  let n, soft, hard;
  if (isEdit) {
    n = state.sinceEdits = (state.sinceEdits || 0) + 1;
    [soft, hard] = [EDIT_SOFT_AT, EDIT_HARD_AT];
  } else {
    n = state.sinceReads = (state.sinceReads || 0) + 1;
    [soft, hard] = [READ_SOFT_AT, READ_HARD_AT];
  }
  saveState(file, state);

  if (!crossesTier(n, soft, hard)) return;

  const recorded = !!(state.memosyne && state.memosyne.writes);
  const kind = isEdit ? "edit" : "read";
  const isHard = n >= hard;
  emit("PostToolUse", recorded ? updateNudge(kind, n, isHard) : createNudge(kind, n, isHard));
}

// --- PreToolUse(TaskCreate|TaskUpdate): mirror harness tasks into Memosyne for hand-off ---
function preToolUse(input) {
  const tool = input.tool_name || "";
  if (tool !== "TaskCreate" && tool !== "TaskUpdate") return;
  if (bumpAndCheck(input, "task")) emit("PreToolUse", TASK_NUDGE);
}

// --- UserPromptSubmit: short Memosyne reminder every Nth prompt --------------------
// Suppressed only while Memosyne was WRITTEN recently (tracking is live → no need to nag).
function userPromptSubmit(input) {
  if (bumpAndCheck(input, "prompt") && !memosyneRecentlyUsed(input)) emit("UserPromptSubmit", PROMPT_NUDGE);
}

// --- Stop / SubagentStop: hand-off nudge once untracked work accumulates --------
// Fire when at least STOP_EDITS edits OR STOP_READS reads have piled up since the
// last Stop-family nudge (so a read-heavy research turn triggers it too), unless
// Memosyne was written recently. Baselines stop it repeating every turn. Passive
// additionalContext only — never blocks the stop.
function stopLike(input, eventName) {
  const file = statePath(input);
  const state = loadState(file);
  if (isMemosyneRecent(state)) return; // just recorded — tracking is live

  const edits = state.sinceEdits || 0;
  const reads = state.sinceReads || 0;
  const newEdits = edits - (state.stopEditBase || 0);
  const newReads = reads - (state.stopReadBase || 0);
  if (newEdits < STOP_EDITS && newReads < STOP_READS) return;

  state.stopEditBase = edits;
  state.stopReadBase = reads;
  saveState(file, state);

  const recorded = !!(state.memosyne && state.memosyne.writes);
  emit(eventName, recorded ? STOP_UPDATE_NUDGE : STOP_CREATE_NUDGE);
}

// --- SessionStart: recover Memosyne context before the first turn ----------------
// startup|clear: fresh context — full recovery nudge. compact: the transcript was
// just summarized — reconcile nudge (resume already carries prior task state).
function sessionStart(input) {
  const source = input.source || "startup";
  if (source === "compact") {
    // Gate on the on-disk counters (keyed session+repo, so they survived the
    // summary): silent when tracking is fresh, or when untracked work sits below the
    // same significance floor the Stop nudge uses — a stray edit or a couple of
    // reads is not worth a reconcile round-trip in the freshly freed context.
    const state = loadState(statePath(input));
    if (isMemosyneRecent(state)) return;
    if ((state.sinceEdits || 0) < STOP_EDITS && (state.sinceReads || 0) < STOP_READS) return;
    emit("SessionStart", postCompactNudge(state.sinceEdits || 0, state.sinceReads || 0));
    return;
  }
  if (source !== "startup" && source !== "clear") return;

  emit(
    "SessionStart",
    `This is session start: before reacting to the user's input, recover Memosyne context as a silent setup step. ` +
      `The Memosyne MCP tools are deferred — load them with ToolSearch (keyword query "memosyne_list_tasks"; the ` +
      `exact tool name is namespaced and differs between the standalone and plugin installs, so don't rely on an ` +
      `exact select:), then call memosyne_list_tasks and review the most recent tasks (up to 10) to reconstruct ` +
      `prior work. This recovery is NOT a turn of its own: the user's first prompt may already be present, so once ` +
      `context is loaded, go straight on to that prompt and act on it in the SAME turn — do not stop to announce ` +
      `that context was loaded, and do not idle for a separate instruction.`,
  );
}

// --- /memosyne:setup: opt this project in by creating its .memosyne/ store --------
// The opt-in command. It is intercepted ahead of the activation gate below (it is
// the very command that CREATES the .memosyne/ the gate checks for), bootstraps the
// store at the project root, then erases the prompt with decision:"block" so it
// never produces a model turn — mirroring how Autonomity's /autonomity:* toggles are
// handled in its UserPromptSubmit hook.
const SETUP_RE = /^\/memosyne:setup\s*$/;

/** True when `prompt` is exactly `/memosyne:setup` (strict — trailing args or
 *  surrounding text do NOT match, so a message that merely mentions the command is
 *  never swallowed). */
function isSetupCommand(prompt) {
  return typeof prompt === "string" && SETUP_RE.test(prompt.trim());
}

// The project root the store belongs to: the git repo top level (so one repo has a
// single .memosyne regardless of the subdir the agent ran from — matching the MCP
// server's resolveProject in src/common/project.mts), falling back to the cwd when
// git is unavailable or this is not a repo.
function resolveProjectRoot(cwd) {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (top) return top;
  } catch {
    /* not a repo / git missing — fall back to cwd */
  }
  return cwd;
}

// Agent guard files dropped into .memosyne/ so coding agents leave the store alone.
// SOURCE OF TRUTH: src/common/storage.mts (GUARD_CONTENT / GUARD_FILENAMES) — kept in
// sync by hand because this hook is a standalone, dependency-free script that cannot
// import the bundled MCP sources. The MCP server re-creates any of these that are
// missing on its next activated startup, so drift here self-heals; this copy only
// makes the store complete and committable the moment it is created.
const GUARD_FILENAMES = ["AGENTS.md", "CLAUDE.md"];
const GUARD_CONTENT = `\
# .memosyne/ — managed by Memosyne

This directory is the on-disk store of the Memosyne MCP server. It is an
implementation detail, not project source.

Do NOT read, write, list, or browse these files directly. Work with tasks
EXCLUSIVELY through the Memosyne MCP tools (memosyne_list_tasks, memosyne_get_task,
memosyne_create_task, memosyne_update_task, …). Reading the raw files wastes tokens and
risks corrupting the on-disk schema.
`;

// UserPromptSubmit decision that erases the prompt: decision:"block" prevents a model
// turn, and `reason`/`systemMessage` surface the outcome to the user (see Autonomity).
function emitDecision(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason, systemMessage: reason }));
}

// Run /memosyne:setup: create and bootstrap <projectRoot>/.memosyne/, or report that
// it already exists. Always erases the prompt (no model turn). Fails safe — on any IO
// error it tells the user to create the folder by hand rather than throwing.
function runSetup(input) {
  const root = resolveProjectRoot(input.cwd || process.cwd());
  const dir = join(root, MEMOSYNE_DIR);
  if (existsSync(dir)) {
    emitDecision(
      `Memosyne: this project is already activated — ${dir} exists. Nothing to do. ` +
        `(If the MCP tools aren't available yet, restart the session — activation is resolved once at startup.)`,
    );
    return;
  }
  try {
    mkdirSync(dir, { recursive: true });
    // config.json: the project display name (basename of the root), matching the MCP
    // server's ensureConfig(project.path, project.name).
    writeFileSync(join(dir, "config.json"), `${JSON.stringify({ name: basename(root) }, null, 2)}\n`);
    for (const name of GUARD_FILENAMES) writeFileSync(join(dir, name), GUARD_CONTENT);
    emitDecision(
      `Memosyne: activated this project — created the store at ${dir} (config.json + agent guard files). ` +
        `RESTART this session (/reload-plugins or reopen) before the Memosyne MCP tools become available: the server ` +
        `resolves activation once at startup. Commit the new .memosyne/ files to share the store with your team.`,
    );
  } catch (err) {
    emitDecision(
      `Memosyne: /memosyne:setup could not create the store at ${dir} (${err && err.message ? err.message : err}). ` +
        `Create it by hand — \`mkdir .memosyne\` at the repo root — then restart the session.`,
    );
  }
}

const handlers = {
  PostToolUse: postToolUse,
  PreToolUse: preToolUse,
  UserPromptSubmit: userPromptSubmit,
  Stop: (input) => stopLike(input, "Stop"),
  SubagentStop: (input) => stopLike(input, "SubagentStop"),
  SessionStart: sessionStart,
};
// OPT-IN GATE — Memosyne stays fully dormant unless the project has adopted it by
// creating a `.memosyne/` directory at its root. Without it the hook emits
// NOTHING for any event (no SessionStart recovery, no nudges) and writes no counter
// state, so a globally installed hook is invisible in projects that never opted in.
// The project root is the agent's cwd: .mcp.json points MEMOSYNE_PROJECT_DIR at the
// project root and Claude runs hooks from that same root, so `<cwd>/.memosyne` is
// the very store the MCP server gates on. Checked with a plain existsSync (no git
// subprocess) to keep the gate cheap on the PostToolUse(*) path, which fires on
// every tool call.
const MEMOSYNE_DIR = ".memosyne";
function isActivated(input) {
  const cwd = input.cwd || process.cwd();
  return existsSync(join(cwd, MEMOSYNE_DIR));
}

const event = process.argv[2];
const handler = handlers[event];
if (handler) {
  const input = readStdin();
  // /memosyne:setup performs the opt-in itself, so it must run BEFORE the gate — its
  // whole job is to create the .memosyne/ that isActivated() checks for.
  if (event === "UserPromptSubmit" && isSetupCommand(input.prompt)) {
    runSetup(input);
  } else if (agentIdOf(input)) {
    // Subagent-scoped event: invisible to Memosyne. A subagent's tool calls must not
    // inflate the parent's untracked-work counters (nor let a subagent Memosyne write
    // silently reset them), and its SubagentStop owns no hand-off to nudge. A legacy
    // harness sends no agent_id, so this branch is never taken and behavior is
    // byte-identical to before. Keep AFTER /memosyne:setup (a main-thread command).
  } else if (isActivated(input)) {
    handler(input);
  }
}

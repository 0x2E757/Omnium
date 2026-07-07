// Tests for the Memosyne adoption hook (plugins/memosyne/hooks/hook.mjs). The hook is a tiny CLI:
// it reads the hook JSON on stdin, prints {hookSpecificOutput:{...}} on stdout (or
// nothing), keyed by the event in argv[2]. We drive it as a subprocess with an
// isolated MEMOSYNE_ROOT so its counter state lands in a temp dir.
//
// Core invariant under test: ONLY a Memosyne WRITE counts as tracking. Reads (incl. the
// SessionStart recovery read) must not flip wording to "you're tracked" nor suppress
// hand-off nudges. Untracked work escalates on TWO tiers: edits (2 soft / 5 hard) and
// reads/research (5 soft / 10 hard), each measured since the last Memosyne write.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugins", "memosyne", "hooks", "hook.mjs");
const SESSION = "test-session";
// An ADOPTED project: a real dir holding a `.memosyne/` folder, so the hook's
// opt-in gate is satisfied and events fire. Fixed for the run so the per-repo state
// file (keyed on cwd) is stable across calls.
const CWD = mkdtempSync(join(tmpdir(), "memosyne-proj-"));
mkdirSync(join(CWD, ".memosyne"), { recursive: true });
// Keep in sync with the hook.
const RECENT_WITHIN = 5;

/** Run the hook for one event with a fresh-or-shared state root, in a given project
 *  cwd (default: the adopted CWD); return the parsed stdout (or null when the hook
 *  emitted nothing). */
function run(root: string, event: string, input: Record<string, unknown>, cwd: string = CWD) {
  const r = spawnSync(process.execPath, [HOOK, event], {
    input: JSON.stringify({ session_id: SESSION, cwd, ...input }),
    env: { ...process.env, MEMOSYNE_ROOT: root },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `hook exited ${r.status}: ${r.stderr}`);
  const out = (r.stdout ?? "").trim();
  return out ? (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } }) : null;
}

const freshRoot = () => mkdtempSync(join(tmpdir(), "memosyne-hook-"));
const tool = (name: string) => ({ tool_name: name });
const ctx = (res: ReturnType<typeof run>) => res?.hookSpecificOutput.additionalContext ?? "";
const post = (root: string, name: string) => run(root, "PostToolUse", tool(name));

// #region Read tier

test("read tier: silent for the first 4 reads, soft create-nudge at the 5th", () => {
  const root = freshRoot();
  for (let i = 0; i < 4; i++) assert.equal(post(root, "Read"), null);
  const fired = post(root, "Read");
  assert.match(ctx(fired), /read\/research tool calls/);
  assert.match(ctx(fired), /memosyne_create_task/); // nothing recorded → create
});

test("read tier: hard nudge at the 10th read", () => {
  const root = freshRoot();
  let fired = null;
  for (let i = 0; i < 10; i++) fired = post(root, "Read");
  assert.match(ctx(fired), /create a task NOW/i); // hard, nothing recorded
});

// #endregion Read tier

// #region Edit tier

test("edit tier: silent on the 1st edit, soft create-nudge on the 2nd", () => {
  const root = freshRoot();
  assert.equal(post(root, "Edit"), null);
  const fired = post(root, "Write");
  assert.match(ctx(fired), /file edit\(s\)/);
  assert.match(ctx(fired), /memosyne_create_task/);
});

test("edit tier: hard nudge at the 5th edit", () => {
  const root = freshRoot();
  let fired = null;
  for (let i = 0; i < 5; i++) fired = post(root, "Edit");
  assert.match(ctx(fired), /create a task NOW/i);
});

// #endregion Edit tier

// #region Tracking = WRITE only (the core fix)

test("a Memosyne READ does NOT count as tracking: still the create variant", () => {
  const root = freshRoot();
  // Mimic the SessionStart recovery read, then a burst of research.
  assert.equal(post(root, "mcp__memosyne__memosyne_list_tasks"), null); // read: ignored
  let fired = null;
  for (let i = 0; i < 5; i++) fired = post(root, "Read");
  // Must still ask to CREATE — the read must not have flipped us to "update".
  assert.match(ctx(fired), /memosyne_create_task/);
  assert.doesNotMatch(ctx(fired), /since your last Memosyne write/);
});

test("a Memosyne WRITE switches wording to update and resets both counters", () => {
  const root = freshRoot();
  for (let i = 0; i < 5; i++) post(root, "Read"); // soft create nudge
  assert.equal(post(root, "mcp__memosyne__memosyne_create_task"), null); // write: records, resets, silent
  // Edits now escalate on their own tier again; 2nd edit fires the UPDATE variant.
  assert.equal(post(root, "Edit"), null);
  const fired = post(root, "Edit");
  assert.match(ctx(fired), /since your last Memosyne write/);
  assert.match(ctx(fired), /memosyne_update_task/);
});

test("a Memosyne READ after a write does not reset the post-write counters", () => {
  const root = freshRoot();
  post(root, "mcp__memosyne__memosyne_update_task"); // record
  post(root, "Edit"); // sinceEdits = 1
  post(root, "mcp__memosyne__memosyne_get_task"); // read: must NOT reset
  const fired = post(root, "Edit"); // sinceEdits = 2 → soft update
  assert.match(ctx(fired), /file edit\(s\)/);
  assert.match(ctx(fired), /memosyne_update_task/);
});

test("memosyne_link / memosyne_unlink count as WRITES (record, reset, switch to update)", () => {
  for (const writeTool of ["memosyne_link", "memosyne_unlink"]) {
    const root = freshRoot();
    for (let i = 0; i < 5; i++) post(root, "Read"); // soft create nudge
    assert.equal(post(root, `mcp__plugin_memosyne_memosyne__${writeTool}`), null); // write: records, resets, silent
    assert.equal(post(root, "Edit"), null); // 1st edit since the write
    const fired = post(root, "Edit"); // 2nd edit → soft UPDATE variant
    assert.match(ctx(fired), /since your last Memosyne write/);
    assert.match(ctx(fired), /memosyne_update_task/);
  }
});

test("memosyne_edit_task counts as a WRITE (record, reset, switch to update)", () => {
  const root = freshRoot();
  for (let i = 0; i < 5; i++) post(root, "Read"); // soft create nudge
  assert.equal(post(root, "mcp__memosyne__memosyne_edit_task"), null); // write: records, resets, silent
  assert.equal(post(root, "Edit"), null); // 1st edit since the write
  const fired = post(root, "Edit"); // 2nd edit → soft UPDATE variant
  assert.match(ctx(fired), /since your last Memosyne write/);
  assert.match(ctx(fired), /memosyne_update_task/);
});

// #endregion Tracking = WRITE only

// #region Plugin namespace (mcp__plugin_memosyne_memosyne__*) — regression guard
// As a Claude plugin the MCP server is registered under a DIFFERENT namespace than
// the standalone install: mcp__plugin_memosyne_memosyne__memosyne_<action> rather
// than mcp__memosyne__memosyne_<action>. The hook must recognize Memosyne tools
// regardless of that prefix, or it never sees a WRITE — counters never reset and
// the Stop/PostToolUse nudges fire every turn, always with the "nothing recorded"
// wording. (This guards the plugin-conversion regression.)
const PLUGIN = "mcp__plugin_memosyne_memosyne__";

test("plugin namespace: a WRITE records, resets counters, switches wording to update", () => {
  const root = freshRoot();
  for (let i = 0; i < 5; i++) post(root, "Read"); // soft create nudge
  assert.equal(post(root, `${PLUGIN}memosyne_create_task`), null); // write: records, resets, silent
  assert.equal(post(root, "Edit"), null); // 1st edit since the write
  const fired = post(root, "Edit"); // 2nd edit → soft UPDATE variant
  assert.match(ctx(fired), /since your last Memosyne write/);
  assert.match(ctx(fired), /memosyne_update_task/);
});

test("plugin namespace: a READ is ignored — not counted, not tracking", () => {
  const root = freshRoot();
  assert.equal(post(root, `${PLUGIN}memosyne_list_tasks`), null); // read: ignored, silent
  // Four generic reads stay below the soft tier — the Memosyne read didn't count.
  for (let i = 0; i < 4; i++) assert.equal(post(root, "Read"), null);
  const fired = post(root, "Read"); // 5th generic read → soft create
  assert.match(ctx(fired), /memosyne_create_task/);
  assert.doesNotMatch(ctx(fired), /since your last Memosyne write/);
});

test("plugin namespace: Stop is suppressed right after a WRITE", () => {
  const root = freshRoot();
  for (let i = 0; i < 5; i++) post(root, "Read");
  post(root, `${PLUGIN}memosyne_update_task`); // recorded → tracking is live
  assert.equal(run(root, "Stop", {}), null); // suppressed
});

// #endregion Plugin namespace

// #region Stop / SubagentStop

test("Stop: read-heavy research with no Memosyne write fires the create hand-off nudge", () => {
  const root = freshRoot();
  for (let i = 0; i < 5; i++) post(root, "Read"); // STOP_READS reads, zero edits
  const fired = run(root, "Stop", {});
  assert.match(ctx(fired), /memosyne_create_task/);
  assert.match(ctx(fired), /research/i);
});

test("Stop: suppressed right after a Memosyne write, then fires once drifted", () => {
  const root = freshRoot();
  post(root, "Edit");
  post(root, "Write");
  post(root, "mcp__memosyne__memosyne_update_task"); // recorded → recent
  assert.equal(run(root, "Stop", {}), null); // suppressed: tracking is live

  for (let i = 0; i < RECENT_WITHIN; i++) post(root, "Edit"); // drift past recency
  const fired = run(root, "Stop", {});
  assert.match(ctx(fired), /memosyne_update_task|hand-off/i);
});

// #endregion Stop / SubagentStop

// #region Subagent scoping (agent_id) — the Stop-nudge loop fix
// The harness tags every hook payload fired INSIDE a subagent with agent_id
// (PostToolUse for its tool calls, SubagentStop when it ends); main-loop payloads
// carry none. Memosyne's counters model the MAIN conversation's hand-off obligation,
// and in this project subagents own no Memosyne write tools — so a subagent's tool
// activity must be invisible to the parent's counters and a SubagentStop owns no
// hand-off to nudge. Without the fix, background subagents' reads inflated the
// parent's sinceReads and re-tripped the Stop nudge every turn (observed live). When
// agent_id is ABSENT (legacy harness) behavior must stay byte-identical to today.
const sub = (root: string, name: string) => run(root, "PostToolUse", { ...tool(name), agent_id: "bg-agent" });

test("subagent scoping: a subagent's reads never inflate the parent (silent past the hard tier)", () => {
  const root = freshRoot();
  for (let i = 0; i < 10; i++) assert.equal(sub(root, "Read"), null); // agent_id-tagged → ignored
  assert.equal(run(root, "Stop", {}), null); // parent drift is 0 → Stop stays silent
});

test("subagent scoping: subagent reads after a write don't re-fire Stop (the reported loop)", () => {
  const root = freshRoot();
  post(root, "mcp__memosyne__memosyne_edit_task"); // record + reset the parent counters
  for (let i = 0; i < 6; i++) sub(root, "Read"); // background subagent reads — ignored
  assert.equal(run(root, "Stop", {}), null); // fired every turn before the fix
  for (let i = 0; i < 6; i++) sub(root, "Read"); // next turn: more background reads
  assert.equal(run(root, "Stop", {}), null); // still silent — no parent drift
});

test("subagent scoping: SubagentStop with agent_id stays silent and leaves the parent's drift intact", () => {
  const root = freshRoot();
  for (let i = 0; i < 5; i++) post(root, "Read"); // real parent drift = STOP_READS
  assert.equal(run(root, "SubagentStop", { agent_id: "bg-agent" }), null); // scoped → silent
  assert.match(ctx(run(root, "Stop", {})), /memosyne_create_task/); // baseline untouched → parent Stop still fires
});

test("subagent scoping: legacy SubagentStop without agent_id still fires the whole-session nudge", () => {
  const root = freshRoot();
  for (let i = 0; i < 5; i++) post(root, "Read");
  assert.match(ctx(run(root, "SubagentStop", {})), /memosyne_create_task/); // byte-identical to today
});

test("subagent scoping: a subagent's Memosyne write does not reset the parent's counters", () => {
  const root = freshRoot();
  for (let i = 0; i < 4; i++) post(root, "Read"); // parent sinceReads = 4
  assert.equal(sub(root, "mcp__memosyne__memosyne_create_task"), null); // subagent write: ignored, no reset
  const fired = post(root, "Read"); // 5th parent read → soft nudge
  assert.match(ctx(fired), /memosyne_create_task/); // still CREATE (parent recorded nothing)…
  assert.doesNotMatch(ctx(fired), /since your last Memosyne write/); // …and the counter was not reset
});

test("subagent scoping: an empty agent_id is treated as absent (legacy path)", () => {
  const root = freshRoot();
  for (let i = 0; i < 4; i++) assert.equal(run(root, "PostToolUse", { ...tool("Read"), agent_id: "" }), null);
  const fired = run(root, "PostToolUse", { ...tool("Read"), agent_id: "" });
  assert.match(ctx(fired), /memosyne_create_task/); // 5th read fires → empty agent_id did NOT scope it out
});

// The guard is dispatch-level (event-agnostic), so a subagent's EDITS and its
// harness-Task PreToolUse mirror are dropped too, not just its reads. Pin both so a
// future narrowing of the guard to specific events would be caught.
test("subagent scoping: a subagent's edits never inflate the parent either", () => {
  const root = freshRoot();
  for (let i = 0; i < 5; i++) assert.equal(sub(root, "Edit"), null); // past the edit hard tier → still ignored
  assert.equal(run(root, "Stop", {}), null); // parent has no drift
});

test("subagent scoping: a subagent's TaskCreate does not fire the parent's mirror nudge", () => {
  const root = freshRoot();
  // The mirror nudge fires every 3rd TaskCreate/TaskUpdate; from a subagent all are dropped.
  for (let i = 0; i < 3; i++) {
    assert.equal(run(root, "PreToolUse", { ...tool("TaskCreate"), agent_id: "bg-agent" }), null);
  }
});

// #endregion Subagent scoping (agent_id)

// #region Prompt nudge

test("prompt nudge: every 3rd prompt, suppressed only by a recent WRITE", () => {
  const root = freshRoot();
  // A read does not suppress: 3rd prompt still nudges.
  post(root, "mcp__memosyne__memosyne_list_tasks");
  run(root, "UserPromptSubmit", {});
  run(root, "UserPromptSubmit", {});
  assert.match(ctx(run(root, "UserPromptSubmit", {})), /Memosyne/);

  // A write makes it recent → next 3rd prompt is suppressed.
  post(root, "mcp__memosyne__memosyne_create_task");
  run(root, "UserPromptSubmit", {});
  run(root, "UserPromptSubmit", {});
  assert.equal(run(root, "UserPromptSubmit", {}), null);
});

// #endregion Prompt nudge

// #region Harness-task mirror nudge

test("PreToolUse(TaskCreate) nudge points to Memosyne tasks, not the removed subtasks", () => {
  const root = freshRoot();
  // The mirror nudge fires every 3rd TaskCreate/TaskUpdate call.
  run(root, "PreToolUse", tool("TaskCreate"));
  run(root, "PreToolUse", tool("TaskCreate"));
  const fired = run(root, "PreToolUse", tool("TaskCreate"));
  assert.match(ctx(fired), /Memosyne/);
  assert.doesNotMatch(ctx(fired), /subtask/i); // the subtask feature is gone
});

// #endregion Harness-task mirror nudge

// #region Opt-in gate (dormant when no .memosyne/)

test("dormant: a project without .memosyne/ emits nothing for any event", () => {
  const root = freshRoot();
  const noProj = mkdtempSync(join(tmpdir(), "memosyne-noproj-")); // no .memosyne/ inside

  // SessionStart recovery is suppressed.
  assert.equal(run(root, "SessionStart", { source: "startup" }, noProj), null);
  // No PostToolUse nudge ever fires, however much work piles up (past both hard tiers).
  for (let i = 0; i < 12; i++) assert.equal(run(root, "PostToolUse", tool("Read"), noProj), null);
  for (let i = 0; i < 6; i++) assert.equal(run(root, "PostToolUse", tool("Edit"), noProj), null);
  // Turn-boundary, post-compaction and prompt nudges stay silent too.
  assert.equal(run(root, "Stop", {}, noProj), null);
  assert.equal(run(root, "SessionStart", { source: "compact" }, noProj), null);
  for (let i = 0; i < 3; i++) assert.equal(run(root, "UserPromptSubmit", {}, noProj), null); // past the 3rd-prompt cadence
});

test("adopting a project flips the same event from silent to active", () => {
  const root = freshRoot();
  const proj = mkdtempSync(join(tmpdir(), "memosyne-adopt-"));
  // Before adoption: SessionStart is silent.
  assert.equal(run(root, "SessionStart", { source: "startup" }, proj), null);
  // After the user creates .memosyne/: the same event now fires.
  mkdirSync(join(proj, ".memosyne"), { recursive: true });
  assert.match(ctx(run(root, "SessionStart", { source: "startup" }, proj)), /recover Memosyne context/i);
});

// #endregion Opt-in gate

// #region SessionStart recovery must not stall the turn
// The recovery additionalContext is delivered in the SAME turn as the user's first
// prompt. If it tells the agent to "wait for the user's prompt", the agent treats
// recovery as the whole turn and replies "context loaded, awaiting instructions",
// silently dropping the prompt that is already present. The wording must instead
// frame recovery as silent setup and send the agent straight on to the prompt.

test("SessionStart recovery: never tells the agent to wait; sends it on to the prompt", () => {
  const root = freshRoot();
  const text = ctx(run(root, "SessionStart", { source: "startup" }));
  assert.match(text, /recover Memosyne context/i); // still the recovery instruction
  assert.doesNotMatch(text, /wait for (the user|further)/i); // must NOT stall the turn
  assert.match(text, /same turn/i); // must act on the first prompt now
});

// #endregion SessionStart recovery must not stall the turn

// #region SessionStart(compact) — post-compaction reconcile nudge
// Fires only when the on-disk counters show untracked work at compaction time;
// silent when there is nothing to reconcile or tracking is fresh. The wording must
// report the counters, scope the mandate to what the summary shows, and yield to a
// newer user prompt (manual /compact lands next to one).

test("compact: untracked work → data-driven reconcile nudge that yields to a newer prompt", () => {
  const root = freshRoot();
  post(root, "Edit");
  post(root, "Edit");
  const text = ctx(run(root, "SessionStart", { source: "compact" }));
  assert.match(text, /^Memosyne: /); // attributed when plugins' contexts concatenate
  assert.match(text, /2 file edit\(s\) and 0 read\/research tool call\(s\)/); // surviving counters, sibling register
  assert.match(text, /visible in the summary/); // asks only what a lossy summary can answer
  assert.match(text, /same turn/i);
  assert.match(text, /newer prompt/); // must not override a fresh user prompt
  assert.doesNotMatch(text, /wait for (the user|further)/i);
});

test("compact: silent when nothing is untracked", () => {
  const root = freshRoot();
  assert.equal(run(root, "SessionStart", { source: "compact" }), null);
});

test("compact: silent below the significance floor (1 edit is not hand-off-worthy)", () => {
  const root = freshRoot();
  post(root, "Edit"); // 1 < STOP_EDITS, 0 < STOP_READS
  assert.equal(run(root, "SessionStart", { source: "compact" }), null);
});

test("compact: silent when tracking is fresh (write, then little work)", () => {
  const root = freshRoot();
  post(root, "Edit");
  post(root, "Edit");
  post(root, "mcp__memosyne__memosyne_create_task"); // write resets the counters
  post(root, "Edit"); // 1 < RECENT_WITHIN → still fresh
  assert.equal(run(root, "SessionStart", { source: "compact" }), null);
});

test("resume stays silent even with untracked work (prior task state is already in context)", () => {
  const root = freshRoot();
  post(root, "Edit");
  post(root, "Edit"); // same state would make compact fire — silence must come from the source filter
  assert.equal(run(root, "SessionStart", { source: "resume" }), null);
});

// #endregion SessionStart(compact)

// #region /memosyne:setup — opt-in command
// /memosyne:setup is intercepted in UserPromptSubmit BEFORE the opt-in gate (it is
// the very command that CREATES the .memosyne/ the gate checks for). It bootstraps
// the store, erases the prompt (decision:"block" → no model turn), and tells the
// user a session RESTART is needed before the MCP tools activate. Strict match: a
// prompt that merely mentions the command must pass through untouched.

/** Submit `prompt` as a UserPromptSubmit in `cwd`; return the raw parsed decision
 *  object (setup emits {decision,reason,systemMessage}, not additionalContext). */
function submit(cwd: string, prompt: string) {
  const r = spawnSync(process.execPath, [HOOK, "UserPromptSubmit"], {
    input: JSON.stringify({ session_id: SESSION, cwd, prompt }),
    env: { ...process.env, MEMOSYNE_ROOT: freshRoot() },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `hook exited ${r.status}: ${r.stderr}`);
  const out = (r.stdout ?? "").trim();
  return out ? (JSON.parse(out) as { decision?: string; reason?: string; systemMessage?: string }) : null;
}

test("setup: bootstraps .memosyne/ in an unadopted project and erases the prompt", () => {
  const proj = mkdtempSync(join(tmpdir(), "memosyne-setup-"));
  assert.ok(!existsSync(join(proj, ".memosyne")));
  const res = submit(proj, "/memosyne:setup");
  assert.equal(res?.decision, "block"); // prompt erased — no model turn
  assert.match(res?.reason ?? "", /restart/i); // must tell the user to restart
  // The store now exists and is fully bootstrapped (committable, agent-guarded).
  assert.ok(existsSync(join(proj, ".memosyne", "config.json")));
  assert.ok(existsSync(join(proj, ".memosyne", "AGENTS.md")));
  assert.ok(existsSync(join(proj, ".memosyne", "CLAUDE.md")));
});

test("setup: idempotent — reports already activated, leaves an existing store intact", () => {
  const proj = mkdtempSync(join(tmpdir(), "memosyne-setup2-"));
  mkdirSync(join(proj, ".memosyne"), { recursive: true });
  writeFileSync(join(proj, ".memosyne", "marker"), "x"); // sentinel: must survive
  const res = submit(proj, "/memosyne:setup");
  assert.equal(res?.decision, "block");
  assert.match(res?.reason ?? "", /already/i);
  assert.ok(existsSync(join(proj, ".memosyne", "marker"))); // not clobbered
});

test("setup: strict match — a prompt that merely mentions the command is not intercepted", () => {
  const proj = mkdtempSync(join(tmpdir(), "memosyne-setup3-"));
  // Not the exact command, and the project is unadopted, so the hook stays silent
  // AND must NOT create the store.
  assert.equal(submit(proj, "please run /memosyne:setup for me"), null);
  assert.ok(!existsSync(join(proj, ".memosyne")));
});

// #endregion /memosyne:setup — opt-in command

// #region argv[3] data dir — the production state location
// As a plugin, hooks.json invokes the hook with ${CLAUDE_PLUGIN_DATA} as
// argv[3]; counter state must then land under <argv3>/nudge-state/ instead of
// the MEMOSYNE_ROOT/data/temp fallback the rest of this suite exercises. Path
// placement only — the state file's contents are the hook's own business.

test("argv[3] data dir: counter state lands under <argv3>/nudge-state/, not the env-root fallback", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "memosyne-plugin-data-"));
  const root = freshRoot();
  const r = spawnSync(process.execPath, [HOOK, "PostToolUse", dataDir], {
    input: JSON.stringify({ session_id: SESSION, cwd: CWD, ...tool("Read") }),
    env: { ...process.env, MEMOSYNE_ROOT: root },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `hook exited ${r.status}: ${r.stderr}`);
  const stateDir = join(dataDir, "nudge-state");
  assert.ok(existsSync(stateDir), "state dir <argv3>/nudge-state/ was created");
  const files = readdirSync(stateDir);
  assert.equal(files.length, 1, `exactly one state file, got: ${files.join(", ")}`);
  assert.match(files[0], /^nudge-test-session-[0-9a-f]{8}\.json$/, "state file keyed on session + repo tag");
  // The fallback location must stay untouched when argv[3] is present.
  assert.ok(!existsSync(join(root, "data", "temp")), "MEMOSYNE_ROOT fallback dir not used");
});

// #endregion argv[3] data dir

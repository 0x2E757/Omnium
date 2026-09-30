import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end checks of the IO shell in spatium.mjs, driving the real process
// the way hooks.json does (argv: event, data dir): the budget declared by a
// UserPromptSubmit survives into later tool ticks through the per-session
// state file, Stop speaks to the user, SessionStart prunes stale state, and
// every malformed input — garbage stdin, an unsafe session id, a corrupt state
// file — fails OPEN with exit 0 instead of breaking the session.

const HOOK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "plugins",
  "spatium",
  "hooks",
  "spatium.mjs",
);

/** A fresh data dir per test, so state never leaks between cases. */
function dataDir() {
  return mkdtempSync(join(tmpdir(), "spatium-test-"));
}

/**
 * Run the hook for one event and return its parsed stdout ({} when silent).
 * @param {string} event
 * @param {unknown} payload a value to JSON-encode, or a raw string to send as-is
 * @param {string} dir the data dir passed as argv[3]
 * @param {NodeJS.ProcessEnv} [env]
 */
function run(event, payload, dir, env) {
  const r = spawnSync(process.execPath, [HOOK, event, dir], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    env: env ?? process.env,
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) : {};
}

/** @param {any} out */
function contextOf(out) {
  return out.hookSpecificOutput?.additionalContext ?? "";
}

test("a budget declared on UserPromptSubmit shows up as a share on later tool ticks", () => {
  const dir = dataDir();
  const prompt = run("UserPromptSubmit", { session_id: "s1", prompt: "/spatium:budget 30m fix it" }, dir);
  assert.equal(prompt.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(contextOf(prompt), /30m/);
  const tick = run("PostToolUse", { session_id: "s1", tool_name: "Bash" }, dir);
  assert.equal(tick.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(contextOf(tick), /of 30m guide budget \(0%\)/);
  assert.ok(existsSync(join(dir, "sessions", "s1.json")));
});

test("PostToolUseFailure ticks exactly like PostToolUse", () => {
  const dir = dataDir();
  run("UserPromptSubmit", { session_id: "s1", prompt: "/spatium:limit 1h x" }, dir);
  const tick = run("PostToolUseFailure", { session_id: "s1", tool_name: "Bash" }, dir);
  assert.equal(tick.hookSpecificOutput.hookEventName, "PostToolUseFailure");
  assert.match(contextOf(tick), /of 1h hard limit/);
});

test("a plain prompt yields ticks with time only, no share", () => {
  const dir = dataDir();
  run("UserPromptSubmit", { session_id: "s1", prompt: "hello" }, dir);
  const text = contextOf(run("PostToolUse", { session_id: "s1", tool_name: "Read" }, dir));
  assert.match(text, /turn time/);
  assert.doesNotMatch(text, /%/);
});

test("the elapsed time is read back from the state file across processes", () => {
  const dir = dataDir();
  run("UserPromptSubmit", { session_id: "s1", prompt: "/spatium:budget 30m x" }, dir);
  const file = join(dir, "sessions", "s1.json");
  const state = JSON.parse(readFileSync(file, "utf8"));
  state.turnStart -= 12 * 60_000;
  writeFileSync(file, JSON.stringify(state));
  assert.match(contextOf(run("PostToolUse", { session_id: "s1", tool_name: "Read" }, dir)), /12m(\d\ds)? of 30m guide budget \(4[01]%\)/);
});

test("Stop shows the budgeted turn to the user as a systemMessage", () => {
  const dir = dataDir();
  run("UserPromptSubmit", { session_id: "s1", prompt: "/spatium:budget 30m x" }, dir);
  const out = run("Stop", { session_id: "s1" }, dir);
  assert.match(out.systemMessage, /of 30m guide budget/);
  assert.equal(out.hookSpecificOutput, undefined);
});

test("UserPromptSubmit and Stop stamp the clock for the user as a systemMessage", () => {
  const dir = dataDir();
  const prompt = run("UserPromptSubmit", { session_id: "s1", prompt: "hello" }, dir);
  assert.match(prompt.systemMessage, /^Spatium: \d\d:\d\d:\d\d$/);
  assert.match(contextOf(prompt), /^Spatium: prompt received at /);
  assert.match(run("Stop", { session_id: "s1" }, dir).systemMessage, /^Spatium: \d\d:\d\d:\d\d · turn \d+s$/);
});

test("SPATIUM_USER_STAMPS=0 turns the stamps off but keeps the budget report", () => {
  const dir = dataDir();
  const env = { ...process.env, SPATIUM_USER_STAMPS: "0" };
  assert.equal(run("UserPromptSubmit", { session_id: "s1", prompt: "hello" }, dir, env).systemMessage, undefined);
  assert.deepEqual(run("Stop", { session_id: "s1" }, dir, env), {});
  run("UserPromptSubmit", { session_id: "s2", prompt: "/spatium:budget 30m x" }, dir, env);
  assert.match(run("Stop", { session_id: "s2" }, dir, env).systemMessage, /of 30m guide budget/);
});

test("an unsafe session id never becomes a path, and the tick falls back to the clock", () => {
  const dir = dataDir();
  run("UserPromptSubmit", { session_id: "../escape", prompt: "/spatium:budget 30m x" }, dir);
  assert.equal(existsSync(join(dir, "escape.json")), false);
  assert.equal(existsSync(join(dir, "sessions")), false);
  const text = contextOf(run("PostToolUse", { session_id: "../escape", tool_name: "Read" }, dir));
  assert.match(text, /^Spatium: \d\d:\d\d:\d\d\.$/);
});

test("garbage stdin fails open: exit 0 and the argv event still ticks the clock", () => {
  const text = contextOf(run("PostToolUse", "not json{", dataDir()));
  assert.match(text, /^Spatium: \d\d:\d\d:\d\d\.$/);
});

test("a corrupt state file is treated as empty, not as an error", () => {
  const dir = dataDir();
  mkdirSync(join(dir, "sessions"));
  writeFileSync(join(dir, "sessions", "s1.json"), "{broken");
  const out = run("UserPromptSubmit", { session_id: "s1", prompt: "/spatium:budget 30m x" }, dir);
  assert.match(contextOf(out), /30m/);
});

test("an Agent prompt's budget marker reaches the subagent it starts, which then ticks on its own clock", () => {
  const dir = dataDir();
  run("UserPromptSubmit", { session_id: "s1", prompt: "hello" }, dir);
  const agentCall = { session_id: "s1", tool_name: "Agent", tool_use_id: "tu1", tool_input: { prompt: "/spatium:limit 10m review" } };
  assert.deepEqual(run("PreToolUse", agentCall, dir), {});
  assert.ok(existsSync(join(dir, "sessions", "s1.spawn.json")));
  const start = run("SubagentStart", { session_id: "s1", agent_id: "a1", agent_type: "general-purpose" }, dir);
  assert.equal(start.hookSpecificOutput.hookEventName, "SubagentStart");
  assert.match(contextOf(start), /Hard time limit for your task: 10m/);
  assert.equal(existsSync(join(dir, "sessions", "s1.spawn.json")), false);
  assert.ok(existsSync(join(dir, "sessions", "s1.agent-a1.json")));
  const tick = run("PostToolUse", { session_id: "s1", agent_id: "a1", agent_type: "general-purpose", tool_name: "Bash" }, dir);
  assert.match(contextOf(tick), /^Spatium: \d\d:\d\d:\d\d, \d+s of 10m hard limit \(\d+%\)\.$/);
  const main = run("PostToolUse", { session_id: "s1", tool_name: "Agent" }, dir);
  assert.match(contextOf(main), /turn time/);
});

test("a subagent started without a marker gets the primer and ticks its own run time", () => {
  const dir = dataDir();
  run("PreToolUse", { session_id: "s1", tool_name: "Agent", tool_use_id: "tu1", tool_input: { prompt: "look" } }, dir);
  assert.match(contextOf(run("SubagentStart", { session_id: "s1", agent_id: "a1" }, dir)), /Spatium is active/);
  const tick = run("PostToolUseFailure", { session_id: "s1", agent_id: "a1", tool_name: "Bash" }, dir);
  assert.match(contextOf(tick), /your run time 0s\./);
});

test("a subagent with no clock of its own ticks the labeled top-level prompt time", () => {
  const dir = dataDir();
  run("UserPromptSubmit", { session_id: "s1", prompt: "hello" }, dir);
  const tick = run("PostToolUse", { session_id: "s1", agent_id: "ghost", tool_name: "Read" }, dir);
  assert.match(contextOf(tick), /top-level prompt time/);
});

test("a failed Agent call drops its budget, so the next subagent does not inherit it", () => {
  const dir = dataDir();
  const agentCall = { session_id: "s1", tool_name: "Agent", tool_use_id: "tu1", tool_input: { prompt: "/spatium:limit 10m x" } };
  run("PreToolUse", agentCall, dir);
  run("PostToolUseFailure", { ...agentCall, error: "Agent type 'fork' not found." }, dir);
  assert.equal(existsSync(join(dir, "sessions", "s1.spawn.json")), false);
  assert.doesNotMatch(contextOf(run("SubagentStart", { session_id: "s1", agent_id: "a1" }, dir)), /time limit/);
});

test("an unsafe agent id never becomes a path", () => {
  const dir = dataDir();
  run("PreToolUse", { session_id: "s1", tool_name: "Agent", tool_use_id: "tu1", tool_input: { prompt: "/spatium:limit 10m x" } }, dir);
  const start = run("SubagentStart", { session_id: "s1", agent_id: "../escape" }, dir);
  assert.match(contextOf(start), /Spatium is active/);
  assert.deepEqual(readdirSync(join(dir, "sessions")), ["s1.spawn.json"]);
});

// A refused or failed API call ends the turn with StopFailure instead of Stop
// (observed live); without it the turn stayed open and the next header lied.
test("StopFailure closes the turn just like Stop", () => {
  const dir = dataDir();
  run("UserPromptSubmit", { session_id: "s1", prompt: "hello" }, dir);
  assert.match(run("StopFailure", { session_id: "s1", error: "refusal" }, dir).systemMessage, /· turn \d+s$/);
  assert.match(contextOf(run("UserPromptSubmit", { session_id: "s1", prompt: "again" }, dir)), /Previous turn: \d+s\./);
});

test("unwired events are silent no-ops", () => {
  const dir = dataDir();
  for (const event of ["Notification", "SubagentStop", "PreCompact", ""]) {
    assert.deepEqual(run(event, { session_id: "s1" }, dir), {}, event);
  }
});

test("SessionStart prunes state files older than a week and keeps fresh ones", () => {
  const dir = dataDir();
  mkdirSync(join(dir, "sessions"));
  const old = join(dir, "sessions", "old.json");
  writeFileSync(old, "{}");
  const weekAndADayAgo = new Date(Date.now() - 8 * 24 * 3_600_000);
  utimesSync(old, weekAndADayAgo, weekAndADayAgo);
  writeFileSync(join(dir, "sessions", "fresh.json"), "{}");
  const out = run("SessionStart", { session_id: "s1", source: "startup" }, dir);
  assert.match(contextOf(out), /Spatium is active/);
  assert.deepEqual(readdirSync(join(dir, "sessions")).sort(), ["fresh.json"]);
});

test("without a data dir argument the state goes under the OS temp dir", () => {
  const temp = dataDir();
  const env = { ...process.env, TMPDIR: temp, TEMP: temp, TMP: temp };
  const r = spawnSync(process.execPath, [HOOK, "UserPromptSubmit"], {
    input: JSON.stringify({ session_id: "s1", prompt: "hi" }),
    encoding: "utf8",
    env,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(temp, "claude-spatium", "sessions", "s1.json")));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end checks of the IO shell: it must thread tool_input and cwd from the
// stdin payload into the policy, AND it must gate every enforcement on the
// per-session on/off flag (default off) that `/autonomity:on|off` toggles.

const HOOK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "plugins",
  "autonomity",
  "hooks",
  "hook.mjs",
);
const ROOT = resolve("autonomity-fixture-root");

/** @param {string} event @param {any} payload */
function run(event, payload) {
  const r = spawnSync(process.execPath, [HOOK, event], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) : {};
}

// A distinct session per test, switched ON so enforcement is active.
let seq = 0;
function activeSession() {
  const id = `dispatch-${process.pid}-${seq++}`;
  const out = run("UserPromptSubmit", { session_id: id, prompt: "/autonomity:on" });
  assert.equal(out.decision, "block"); // the toggle erases the prompt
  return id;
}

/** @param {string} session_id @param {any} payload */
function preToolUse(session_id, payload) {
  return run("PreToolUse", { ...payload, session_id });
}

// --- toggle ------------------------------------------------------------------

test("`/autonomity:on` blocks the prompt and turns enforcement on", () => {
  const id = `dispatch-on-${process.pid}`;
  const out = run("UserPromptSubmit", { session_id: id, prompt: "/autonomity:on" });
  assert.equal(out.decision, "block");
  assert.match(out.reason, /on\b/i);
  // now active: AskUserQuestion is denied for this session
  const d = preToolUse(id, { tool_name: "AskUserQuestion", tool_input: {} });
  assert.equal(d.hookSpecificOutput.permissionDecision, "deny");
});

test("`/autonomity:off` blocks the prompt and turns enforcement off again", () => {
  const id = `dispatch-off-${process.pid}`;
  run("UserPromptSubmit", { session_id: id, prompt: "/autonomity:on" });
  const out = run("UserPromptSubmit", { session_id: id, prompt: "/autonomity:off" });
  assert.equal(out.decision, "block");
  assert.match(out.reason, /off\b/i);
  // now inactive: even AskUserQuestion is left untouched
  const d = preToolUse(id, { tool_name: "AskUserQuestion", tool_input: {} });
  assert.deepEqual(d, {});
});

test("`/autonomity:status` reports OFF without changing state", () => {
  const id = `dispatch-status-off-${process.pid}`;
  const out = run("UserPromptSubmit", { session_id: id, prompt: "/autonomity:status" });
  assert.equal(out.decision, "block");
  assert.match(out.reason, /off\b/i);
  // still off: enforcement untouched
  const d = preToolUse(id, { tool_name: "AskUserQuestion", tool_input: {} });
  assert.deepEqual(d, {});
});

test("`/autonomity:status` reports ON while active", () => {
  const id = activeSession();
  const out = run("UserPromptSubmit", { session_id: id, prompt: "/autonomity:status" });
  assert.equal(out.decision, "block");
  assert.match(out.reason, /on\b/i);
  // still on: AskUserQuestion remains denied
  const d = preToolUse(id, { tool_name: "AskUserQuestion", tool_input: {} });
  assert.equal(d.hookSpecificOutput.permissionDecision, "deny");
});

test("a non-toggle prompt while ON injects the autonomy primer", () => {
  const id = activeSession();
  const out = run("UserPromptSubmit", { session_id: id, prompt: "do the thing" });
  assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(out.hookSpecificOutput.additionalContext, /autonom/i);
});

test("a non-toggle prompt while OFF is left untouched", () => {
  const out = run("UserPromptSubmit", {
    session_id: `dispatch-idle-${process.pid}`,
    prompt: "do the thing",
  });
  assert.deepEqual(out, {});
});

// --- gating: OFF means do nothing --------------------------------------------

test("PreToolUse is a no-op while OFF (normal permission flow)", () => {
  const out = preToolUse(`dispatch-quiet-${process.pid}`, {
    tool_name: "AskUserQuestion",
    tool_input: {},
  });
  assert.deepEqual(out, {});
});

test("SessionStart injects the primer only while ON", () => {
  const off = run("SessionStart", { session_id: `dispatch-ss-off-${process.pid}` });
  assert.deepEqual(off, {});
  const id = activeSession();
  const on = run("SessionStart", { session_id: id });
  assert.match(on.hookSpecificOutput.additionalContext, /autonom/i);
});

// --- enforcement while ON (tool_input / cwd threaded) ------------------------

test("dispatcher denies a Bash git push (tool_input threaded)", () => {
  const out = preToolUse(activeSession(), {
    tool_name: "Bash",
    tool_input: { command: "git push origin main" },
    cwd: ROOT,
  });
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /push/i);
});

test("dispatcher denies an out-of-tree Write (cwd threaded)", () => {
  const out = preToolUse(activeSession(), {
    tool_name: "Write",
    tool_input: { file_path: resolve(ROOT, "..", "escape.ts") },
    cwd: ROOT,
  });
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /working directory/i);
});

test("dispatcher allows an in-tree Write", () => {
  const out = preToolUse(activeSession(), {
    tool_name: "Write",
    tool_input: { file_path: "src/inside.ts" },
    cwd: ROOT,
  });
  assert.equal(out.hookSpecificOutput.permissionDecision, "allow");
});

test("dispatcher allows an ordinary Bash command", () => {
  const out = preToolUse(activeSession(), {
    tool_name: "Bash",
    tool_input: { command: "git status" },
    cwd: ROOT,
  });
  assert.equal(out.hookSpecificOutput.permissionDecision, "allow");
});

// --- Stop: clean-git gate + stop_hook_active loop protection ------------------
// The flag is turn-global (any stop hook's block sets it), so the gate waives
// only once it has itself blocked in the current stop chain — its own marker,
// cleared by the next user prompt.

/** A temp git repo with one untracked file, or null when git is unavailable. */
function dirtyRepo() {
  const root = mkdtempSync(join(tmpdir(), "autonomity-stop-"));
  const init = spawnSync("git", ["init", "-q", root], { encoding: "utf8" });
  if ((init.status ?? -1) !== 0) {
    rmSync(root, { recursive: true, force: true });
    return null; // git unavailable — caller skips the live assertions
  }
  writeFileSync(join(root, "untracked.txt"), "wip\n");
  return root;
}

test("Stop blocks a dirty worktree while ON", (t) => {
  const root = dirtyRepo();
  if (!root) return t.skip("git unavailable");
  try {
    const out = run("Stop", { session_id: activeSession(), cwd: root });
    assert.equal(out.decision, "block");
    assert.match(out.reason, /uncommitted/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Stop with stop_hook_active still blocks when this gate has not yet blocked", (t) => {
  const root = dirtyRepo();
  if (!root) return t.skip("git unavailable");
  try {
    const out = run("Stop", { session_id: activeSession(), cwd: root, stop_hook_active: true });
    assert.equal(out.decision, "block"); // another plugin's block must not disarm this gate
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Stop waives with a warning once this gate already blocked in the chain", (t) => {
  const root = dirtyRepo();
  if (!root) return t.skip("git unavailable");
  try {
    const id = activeSession();
    assert.equal(run("Stop", { session_id: id, cwd: root }).decision, "block"); // arms the marker
    const out = run("Stop", { session_id: id, cwd: root, stop_hook_active: true });
    assert.equal(out.decision, undefined); // must not re-block: loop protection
    assert.match(out.systemMessage, /stop_hook_active/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the string form "true" of stop_hook_active also waives', (t) => {
  const root = dirtyRepo();
  if (!root) return t.skip("git unavailable");
  try {
    const id = activeSession();
    run("Stop", { session_id: id, cwd: root });
    const out = run("Stop", { session_id: id, cwd: root, stop_hook_active: "true" });
    assert.equal(out.decision, undefined);
    assert.match(out.systemMessage, /stop_hook_active/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a new user prompt re-arms the waived gate", (t) => {
  const root = dirtyRepo();
  if (!root) return t.skip("git unavailable");
  try {
    const id = activeSession();
    run("Stop", { session_id: id, cwd: root });
    run("UserPromptSubmit", { session_id: id, prompt: "carry on" }); // a prompt starts a new stop chain
    const out = run("Stop", { session_id: id, cwd: root, stop_hook_active: true });
    assert.equal(out.decision, "block");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a secret inside a fresh directory is still classified (untracked dirs must not collapse)", (t) => {
  const root = dirtyRepo();
  if (!root) return t.skip("git unavailable");
  try {
    mkdirSync(join(root, "config"));
    writeFileSync(join(root, "config", ".env"), "API_KEY=hunter2\n");
    const out = run("Stop", { session_id: activeSession(), cwd: root });
    assert.equal(out.decision, "block");
    assert.match(out.reason, /config\/\.env/);
    assert.match(out.reason, /\.gitignore/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Stop steers a session-written .env toward .gitignore, never a commit", (t) => {
  const root = dirtyRepo(); // one ordinary untracked file
  if (!root) return t.skip("git unavailable");
  try {
    writeFileSync(join(root, ".env"), "API_KEY=hunter2\n");
    const out = run("Stop", { session_id: activeSession(), cwd: root });
    assert.equal(out.decision, "block");
    assert.match(out.reason, /untracked\.txt/); // ordinary file: commit path
    assert.match(out.reason, /\.env/);
    assert.match(out.reason, /\.gitignore/);
    assert.match(out.reason, /Do NOT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Stop with stop_hook_active stays silent when there is nothing to waive", () => {
  const root = mkdtempSync(join(tmpdir(), "autonomity-nonrepo-"));
  try {
    // A non-repo cwd never blocks, so the flag must not conjure a warning.
    const out = run("Stop", { session_id: activeSession(), cwd: root, stop_hook_active: true });
    assert.deepEqual(out, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

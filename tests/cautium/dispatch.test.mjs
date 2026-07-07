import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { securityContext } from "../../plugins/cautium/hooks/hook-lib.mjs";

// End-to-end checks of the IO shell: SessionStart injects the primer; every
// other event is a silent no-op; and a missing/garbled stdin payload must never
// suppress the primer (the event comes from argv, and the hook fails OPEN).

const HOOK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "plugins",
  "cautium",
  "hooks",
  "hook.mjs",
);

/** @param {string|null} event @param {any} payload @param {{rawInput?: string}} [opts] */
function run(event, payload, opts = {}) {
  const input = opts.rawInput !== undefined ? opts.rawInput : JSON.stringify(payload ?? {});
  const args = event === null ? [HOOK] : [HOOK, event];
  const r = spawnSync(process.execPath, args, { input, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) : {};
}

test("SessionStart injects the security primer", () => {
  const out = run("SessionStart", { session_id: "s1" });
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(out.hookSpecificOutput.additionalContext, /cautium/i);
});

test("the injected primer reflects the host platform's risk mapping", () => {
  const out = run("SessionStart", { session_id: "s1" });
  assert.equal(out.hookSpecificOutput.additionalContext, securityContext(process.platform));
});

test("the event name falls back to the stdin payload when argv omits it", () => {
  const out = run(null, { hook_event_name: "SessionStart" });
  assert.match(out.hookSpecificOutput.additionalContext, /cautium/i);
});

test("every non-SessionStart event is a silent no-op", () => {
  for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]) {
    assert.deepEqual(run(event, { session_id: "s" }), {}, event);
  }
});

test("empty stdin still injects on SessionStart (payload is not required)", () => {
  const out = run("SessionStart", null, { rawInput: "" });
  assert.match(out.hookSpecificOutput.additionalContext, /cautium/i);
});

test("malformed stdin fails open — argv event still drives the injection", () => {
  const out = run("SessionStart", null, { rawInput: "not json{" });
  assert.match(out.hookSpecificOutput.additionalContext, /cautium/i);
});

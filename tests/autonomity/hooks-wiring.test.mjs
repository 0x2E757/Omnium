import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const hooks = JSON.parse(
  readFileSync(join(root, "plugins", "autonomity", "hooks", "hooks.json"), "utf8"),
).hooks;

test("the four handled events are wired", () => {
  for (const event of ["UserPromptSubmit", "PreToolUse", "SessionStart", "Stop"]) {
    assert.ok(Array.isArray(hooks[event]) && hooks[event].length > 0, event);
  }
});

test("UserPromptSubmit is wired (the on/off toggle entry point)", () => {
  assert.ok(Array.isArray(hooks.UserPromptSubmit) && hooks.UserPromptSubmit.length > 0);
});

test("SubagentStop is NOT git-gated (subagents do not commit)", () => {
  assert.equal(hooks.SubagentStop, undefined);
});

test("PreToolUse matches every tool", () => {
  assert.equal(hooks.PreToolUse[0].matcher, "*");
});

test("every hook is exec form: bare node + [hook.mjs path, event] args", () => {
  for (const [event, entries] of Object.entries(hooks)) {
    for (const entry of entries) {
      for (const h of entry.hooks) {
        assert.equal(h.type, "command");
        // Exact equality makes shell form unrepresentable: an embedded path,
        // quote, or placeholder cannot equal "node", and missing args fails
        // the deepEqual — no shell is involved on any platform (DESIGN.md).
        assert.equal(h.command, "node");
        assert.deepEqual(h.args, ["${CLAUDE_PLUGIN_ROOT}/hooks/hook.mjs", event]);
      }
    }
  }
});

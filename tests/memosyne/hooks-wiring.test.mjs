// hooks-wiring.test.mjs — pins memosyne's hook wiring: which events are
// handled, their matchers, and that every entry is EXEC form (bare "node"
// plus an args vector ending in the plugin-data dir argv), which spawns
// directly with no shell on any platform. Shell form ran the command string
// through sh / Git Bash / PowerShell, where ${CLAUDE_PLUGIN_ROOT} expansion
// is not portable (cross-platform audit High #2); exact equality below makes
// shell form unrepresentable.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const hooks = JSON.parse(
  readFileSync(join(root, "plugins", "memosyne", "hooks", "hooks.json"), "utf8"),
).hooks;

test("the six handled events are wired", () => {
  const events = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "SubagentStop",
  ];
  for (const event of events) {
    assert.ok(Array.isArray(hooks[event]) && hooks[event].length > 0, event);
  }
});

test("PreToolUse watches the task tools; PostToolUse observes every tool", () => {
  assert.equal(hooks.PreToolUse[0].matcher, "TaskCreate|TaskUpdate");
  assert.equal(hooks.PostToolUse[0].matcher, "*");
});

test("every hook is exec form: node + [hook.mjs path, event, plugin-data dir]", () => {
  for (const [event, entries] of Object.entries(hooks)) {
    for (const entry of entries) {
      for (const h of entry.hooks) {
        assert.equal(h.type, "command");
        assert.equal(h.command, "node");
        assert.deepEqual(h.args, [
          "${CLAUDE_PLUGIN_ROOT}/hooks/hook.mjs",
          event,
          "${CLAUDE_PLUGIN_DATA}",
        ]);
        assert.equal(typeof h.timeout, "number");
      }
    }
  }
});

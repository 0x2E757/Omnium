import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Pins the hooks.json wiring of spatium: exactly the eight events its single
// dispatcher handles, all in exec form with the event and the persistent data
// dir as arguments, and PreToolUse narrowed to the two tools it acts on:
// AskUserQuestion, whose runtime is the user's time and must not be charged to
// the budget, and Agent, whose prompt may carry a budget for the subagent.

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const hooks = JSON.parse(
  readFileSync(join(root, "plugins", "spatium", "hooks", "hooks.json"), "utf8"),
).hooks;

test("exactly the handled events are wired", () => {
  assert.deepEqual(Object.keys(hooks).sort(), [
    "PostToolUse",
    "PostToolUseFailure",
    "PreToolUse",
    "SessionStart",
    "Stop",
    "StopFailure",
    "SubagentStart",
    "UserPromptSubmit",
  ]);
});

test("every hook is exec form: bare node + [spatium.mjs, event, data dir] with a timeout", () => {
  for (const [event, entries] of Object.entries(hooks)) {
    for (const entry of entries) {
      for (const h of entry.hooks) {
        assert.equal(h.type, "command");
        assert.equal(h.command, "node");
        assert.deepEqual(h.args, ["${CLAUDE_PLUGIN_ROOT}/hooks/spatium.mjs", event, "${CLAUDE_PLUGIN_DATA}"]);
        assert.equal(typeof h.timeout, "number");
      }
    }
  }
});

test("PreToolUse fires only for AskUserQuestion and Agent; the tick events match every tool", () => {
  assert.deepEqual(hooks.PreToolUse.map((/** @type {any} */ e) => e.matcher), ["AskUserQuestion|Agent"]);
  // Claude Code matchers are regular expressions over the whole tool name.
  const matcher = new RegExp(`^(?:${hooks.PreToolUse[0].matcher})$`);
  for (const name of ["AskUserQuestion", "Agent"]) assert.ok(matcher.test(name), name);
  for (const name of ["Bash", "SendMessage", "AgentTool"]) assert.equal(matcher.test(name), false, name);
  for (const event of ["PostToolUse", "PostToolUseFailure"]) {
    for (const entry of hooks[event]) assert.equal(entry.matcher, undefined, event);
  }
});

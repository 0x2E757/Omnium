import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const hooks = JSON.parse(
  readFileSync(join(root, "plugins", "statusline", "hooks", "hooks.json"), "utf8"),
).hooks;

test("SessionStart is wired", () => {
  assert.ok(Array.isArray(hooks.SessionStart) && hooks.SessionStart.length > 0);
});

test("ONLY SessionStart is wired — statusline is a passive injector, nothing else", () => {
  assert.deepEqual(Object.keys(hooks), ["SessionStart"]);
});

test("every hook is exec form: bare node + [hook.mjs, event, CLAUDE_PLUGIN_DATA] args", () => {
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
      }
    }
  }
});

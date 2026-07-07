import { test } from "node:test";
import assert from "node:assert/strict";

import { sessionStartOutput, ENV_VAR } from "../../plugins/sessio/hooks/hook-lib.mjs";

test("ENV_VAR is the frozen configuration knob", () => {
  assert.equal(ENV_VAR, "CLAUDE_SESSIONS_DIR");
});

// --- configured: a scratch root is set ---------------------------------------

test("configured: routes generated files under the base with a dated subdir", () => {
  const out = sessionStartOutput("/tmp/scratch", "2026-07-06");
  assert.equal(out.hookEventName, "SessionStart");
  const c = out.additionalContext;
  assert.match(c, /sessio/i);
  assert.match(c, /\/tmp\/scratch/); // the resolved base
  assert.match(c, /2026-07-06/); // today's date in the subdir name
  assert.match(c, /project/i); // the "project files are an exception" carve-out
});

test("configured: an example path joins the base and the dated subdir", () => {
  const c = sessionStartOutput("/tmp/scratch", "2026-07-06").additionalContext;
  assert.match(c, /\/tmp\/scratch\/2026-07-06--/);
});

// --- unconfigured: onboard the user ------------------------------------------

test("unconfigured (empty): onboards — ask the user and persist the env var", () => {
  const c = sessionStartOutput("", "2026-07-06").additionalContext;
  assert.match(c, /CLAUDE_SESSIONS_DIR/);
  assert.match(c, /ask/i);
  assert.match(c, /settings|environment/i); // how to persist it
  assert.doesNotMatch(c, /2026-07-06--/); // no scratch path is offered yet
});

test("unconfigured (undefined or whitespace) also onboards", () => {
  for (const env of [undefined, "   "]) {
    const c = sessionStartOutput(env, "2026-07-06").additionalContext;
    assert.match(c, /CLAUDE_SESSIONS_DIR/);
    assert.match(c, /ask/i);
  }
});

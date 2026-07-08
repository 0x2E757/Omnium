import { test } from "node:test";
import assert from "node:assert/strict";

import { sessionStartOutput, ENV_VAR } from "../../plugins/sessio/hooks/hook-lib.mjs";

// Semantic markers for the "call to action" contract. They assert MEANING, not
// exact prose, so the reword survives copy-edits. Deliberately narrow:
//   - ACTION_REQUIRED: none of these tokens exist in the pre-reword strings.
//   - REPORT_FIRST: excludes "ask"/"tell" (already present in the old text) so
//     the assertion is genuinely RED until new report-to-the-user wording lands.
const ACTION_REQUIRED =
  /\b(action required|needs? (your )?action|act on this|requires your attention|before you proceed|do not (ignore|skip))\b/i;
const REPORT_FIRST =
  /\b(report|surface|raise|flag|inform|notify)\b[^.]{0,40}\buser\b|let the user know|user first/i;

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

test("configured routing is a standing convention, not a call to action (no directive opener)", () => {
  // Locks the intentional asymmetry: only the pending-action nudges (onboarding,
  // statusline install/confirm) get the "action required" directive framing; the
  // always-on routing primer must stay informational or it nags every session.
  const c = sessionStartOutput("/tmp/scratch", "2026-07-06").additionalContext;
  assert.doesNotMatch(c, ACTION_REQUIRED);
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

test("unconfigured: onboarding reads as a call to action, reported to the user first", () => {
  const c = sessionStartOutput("", "2026-07-06").additionalContext;
  // Not passive status/debug text — it directs the agent to act...
  assert.match(c, ACTION_REQUIRED);
  // ...and to surface the situation to the user proactively (beyond the old
  // trailing "tell the user where files landed", which REPORT_FIRST excludes).
  assert.match(c, REPORT_FIRST);
});

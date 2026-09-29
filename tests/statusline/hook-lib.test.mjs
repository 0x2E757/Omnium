import { test } from "node:test";
import assert from "node:assert/strict";

import {
  NAME,
  REFRESH_INTERVAL_S,
  renderCommand,
  classifyStatusLine,
  statusLineNudge,
} from "../../plugins/statusline/hooks/hook-lib.mjs";

// Pure install-decision logic, kept out of the IO shell so it is unit-testable
// without spawning a process or touching a real settings.json.

// Semantic markers for the "call to action" contract (assert meaning, not exact
// prose). ACTION_REQUIRED tokens are absent from the pre-reword nudges;
// REPORT_FIRST excludes "ask"/"tell" (already present) so it is genuinely RED
// until new report-to-the-user wording lands.
const ACTION_REQUIRED =
  /\b(action required|needs? (your )?action|act on this|requires your attention|before you proceed|do not (ignore|skip))\b/i;
const REPORT_FIRST =
  /\b(report|surface|raise|flag|inform|notify)\b[^.]{0,40}\buser\b|let the user know|user first/i;

test("NAME is the human-facing plugin name", () => {
  assert.equal(NAME, "Statusline");
});

// --- renderCommand: the exact statusLine.command string ----------------------

test("renderCommand quotes the path and forces forward slashes (cross-shell safe)", () => {
  assert.equal(renderCommand("C:\\Users\\Jane Doe\\render.mjs"), 'node "C:/Users/Jane Doe/render.mjs"');
  assert.equal(renderCommand("/home/x/render.mjs"), 'node "/home/x/render.mjs"');
});

// --- classifyStatusLine: ok | install | confirm ------------------------------

const DESIRED = renderCommand("/data/statusline-omnium/render.mjs");

test("no statusLine configured -> install", () => {
  assert.equal(classifyStatusLine({}, DESIRED), "install");
  assert.equal(classifyStatusLine({ statusLine: {} }, DESIRED), "install");
  assert.equal(classifyStatusLine({ statusLine: { command: "" } }, DESIRED), "install");
  assert.equal(classifyStatusLine({ statusLine: { command: "   " } }, DESIRED), "install");
});

test("our exact command already present, on a refresh timer -> ok (stay quiet)", () => {
  const settings = { statusLine: { command: DESIRED, refreshInterval: REFRESH_INTERVAL_S } };
  assert.equal(classifyStatusLine(settings, DESIRED), "ok");
});

test("our command with a user-chosen refresh interval -> ok (their choice is kept)", () => {
  assert.equal(classifyStatusLine({ statusLine: { command: DESIRED, refreshInterval: 1 } }, DESIRED), "ok");
});

// The footer clock only moves when the line re-renders; without a timer it
// freezes between assistant messages, so an install without one is refreshed.
test("our command without a usable refresh interval -> install (adds the timer, no need to ask)", () => {
  assert.equal(classifyStatusLine({ statusLine: { command: DESIRED } }, DESIRED), "install");
  assert.equal(classifyStatusLine({ statusLine: { command: DESIRED, refreshInterval: 0 } }, DESIRED), "install");
  assert.equal(classifyStatusLine({ statusLine: { command: DESIRED, refreshInterval: "5" } }, DESIRED), "install");
});

test("REFRESH_INTERVAL_S is whole seconds, at least the documented minimum of 1", () => {
  assert.ok(Number.isInteger(REFRESH_INTERVAL_S) && REFRESH_INTERVAL_S >= 1);
});

test("our command with trailing/leading whitespace -> ok (normalized, no re-nudge)", () => {
  assert.equal(classifyStatusLine({ statusLine: { command: DESIRED + "\n", refreshInterval: 5 } }, DESIRED), "ok");
  assert.equal(classifyStatusLine({ statusLine: { command: "  " + DESIRED + "  ", refreshInterval: 5 } }, DESIRED), "ok");
});

test("our command with backslash path separators -> ok (normalized to forward slashes)", () => {
  const forward = renderCommand("C:/data/statusline-omnium/render.mjs");
  const backslashed = 'node "C:\\data\\statusline-omnium\\render.mjs"';
  assert.equal(classifyStatusLine({ statusLine: { command: backslashed, refreshInterval: 5 } }, forward), "ok");
});

test("our command but a stale (different) path -> install (refresh, no need to ask)", () => {
  const stale = renderCommand("/old/cache/statusline/1.2.3/render.mjs");
  assert.equal(classifyStatusLine({ statusLine: { command: stale } }, DESIRED), "install");
});

test("a foreign statusLine -> confirm (ask before clobbering)", () => {
  assert.equal(classifyStatusLine({ statusLine: { command: "starship prompt" } }, DESIRED), "confirm");
});

test("a non-string / malformed command -> install (defensive, never throws)", () => {
  assert.equal(classifyStatusLine({ statusLine: { command: 123 } }, DESIRED), "install");
  assert.equal(classifyStatusLine({ statusLine: "starship" }, DESIRED), "install");
  assert.equal(classifyStatusLine({ statusLine: null }, DESIRED), "install");
});

// --- statusLineNudge: the additionalContext for each state -------------------

test("ok yields no nudge", () => {
  assert.equal(statusLineNudge("ok", DESIRED, DESIRED), null);
});

// The command contains double-quotes, so the nudge must hand the agent a
// *valid-JSON* value to paste — a raw (unescaped) snippet would be malformed
// JSON and re-nudge every session. The paste value is JSON.stringify of the
// statusLine object, correctly escaped by construction.
const DESIRED_VALUE = JSON.stringify({ type: "command", command: DESIRED, refreshInterval: REFRESH_INTERVAL_S });

test("install nudge names the plugin, settings.json, the statusLine key, and a valid-JSON value", () => {
  const c = statusLineNudge("install", DESIRED, undefined);
  assert.ok(c);
  assert.ok(c.includes(NAME));
  assert.match(c, /settings\.json/);
  assert.match(c, /statusLine/);
  assert.ok(c.includes(DESIRED_VALUE), "the correctly-escaped JSON value must be present to paste");
  // regression guard: the old bug embedded the raw command with unescaped quotes.
  assert.ok(
    !c.includes('"command": "' + DESIRED + '"'),
    "must not embed the raw unescaped command (that is invalid JSON)",
  );
});

test("install nudge is a call to action: action-required + report to the user first", () => {
  const c = statusLineNudge("install", DESIRED, undefined);
  assert.ok(c);
  // Not passive status text — it directs the agent to act, and to let the user
  // know before activating the status line.
  assert.match(c, ACTION_REQUIRED);
  assert.match(c, REPORT_FIRST);
});

test("the value embedded IN the nudge parses back to the statusLine object (not just the fixture)", () => {
  // Pull the backtick-wrapped JSON object out of the actual nudge text and parse
  // THAT — proves the emitted snippet is valid JSON, not a tautology on the fixture.
  const c = statusLineNudge("install", DESIRED, undefined);
  assert.ok(c);
  const m = c.match(/`(\{.*?\})`/);
  assert.ok(m, "nudge must contain a backtick-wrapped JSON object");
  assert.deepEqual(JSON.parse(m[1]), { type: "command", command: DESIRED, refreshInterval: REFRESH_INTERVAL_S });
});

test("confirm nudge tells the agent to ASK and shows both commands", () => {
  const c = statusLineNudge("confirm", DESIRED, "starship prompt");
  assert.ok(c);
  assert.match(c, /ask/i);
  assert.match(c, /starship prompt/); // the existing (foreign) command
  assert.ok(c.includes(DESIRED_VALUE)); // the valid-JSON value it would become
});

test("confirm nudge frames the choice as action-required, surfaced to the user first", () => {
  const c = statusLineNudge("confirm", DESIRED, "starship prompt");
  assert.ok(c);
  // Reads as a required action, not skimmable status...
  assert.match(c, ACTION_REQUIRED);
  // ...and proactively surfaces the conflict to the user (beyond the /ask/i guard
  // above), so a reword can't quietly drop the report-first framing.
  assert.match(c, REPORT_FIRST);
});

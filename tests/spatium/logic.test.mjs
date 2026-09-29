import { test } from "node:test";
import assert from "node:assert/strict";

import {
  emptyState,
  formatDuration,
  highestThreshold,
  onPostTool,
  onPreTool,
  onPrompt,
  onSessionStart,
  onStop,
  parseCommand,
  parseDuration,
} from "../../plugins/spatium/hooks/spatium.mjs";

// Pins the pure core of spatium.mjs: duration parsing and rendering, command
// recognition, threshold stepping, and the per-event reducers that decide when
// a share of the budget is shown, when guidance is announced, and how the
// budget survives /spatium:continue. Importing the module must not run the IO
// shell — that is what makes a one-file hook testable at all.

const MINUTE = 60_000;
// A fixed local wall-clock instant, so rendered clocks are deterministic in any TZ.
const T0 = new Date(2026, 8, 29, 14, 20, 6).getTime();

/** Start a turn with the given prompt at T0 and return the resulting state. @param {string} prompt */
function started(prompt) {
  return onPrompt(emptyState(), prompt, T0).state;
}

test("parseDuration accepts hours, minutes, seconds, decimals and bare minutes", () => {
  assert.equal(parseDuration("30m"), 30 * MINUTE);
  assert.equal(parseDuration("1h30m"), 90 * MINUTE);
  assert.equal(parseDuration("90s"), 90_000);
  assert.equal(parseDuration("1.5h"), 90 * MINUTE);
  assert.equal(parseDuration("45"), 45 * MINUTE);
  assert.equal(parseDuration("2H"), 120 * MINUTE);
  assert.equal(parseDuration("10min"), 10 * MINUTE);
});

test("parseDuration rejects empty, zero, garbage and absurdly long budgets", () => {
  for (const bad of ["", "0m", "abc", "m", "30x", "-5m", "25h", "1h 30m"]) {
    assert.equal(parseDuration(bad), null, bad);
  }
});

test("formatDuration drops zero tails and pads the minor unit", () => {
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(30 * MINUTE), "30m");
  assert.equal(formatDuration(12 * MINUTE + 4_000), "12m04s");
  assert.equal(formatDuration(65 * MINUTE), "1h05m");
  assert.equal(formatDuration(120 * MINUTE), "2h");
  assert.equal(formatDuration(-5), "0s");
});

test("parseCommand recognizes only a spatium command at the very start of the prompt", () => {
  assert.deepEqual(parseCommand("/spatium:budget 30m fix the bug"), { name: "budget", arg: "30m" });
  assert.deepEqual(parseCommand("  /spatium:limit 1h\nmulti\nline task"), { name: "limit", arg: "1h" });
  assert.deepEqual(parseCommand("/spatium:continue"), { name: "continue", arg: "" });
  assert.deepEqual(parseCommand("/spatium:continue +15m"), { name: "continue", arg: "+15m" });
  assert.equal(parseCommand("please run /spatium:budget 30m"), null);
  assert.equal(parseCommand("/spatium:budgetx 30m"), null);
  assert.equal(parseCommand(undefined), null);
});

test("highestThreshold steps 50, 80, 100 and then every further 50%", () => {
  assert.equal(highestThreshold(49), 0);
  assert.equal(highestThreshold(50), 50);
  assert.equal(highestThreshold(99), 80);
  assert.equal(highestThreshold(100), 100);
  assert.equal(highestThreshold(149), 100);
  assert.equal(highestThreshold(212), 200);
});

test("a plain prompt starts a turn without a budget, so ticks show time but no share", () => {
  const { state, context } = onPrompt(emptyState(), "just do it", T0);
  assert.equal(state.turnStart, T0);
  assert.equal(state.budget, null);
  assert.match(context, /2026-09-29 14:20:06 [+-]\d\d:\d\d \(Tue\)/);
  const tick = onPostTool(state, "Read", T0 + 12 * MINUTE + 4_000, false);
  assert.match(tick.context, /14:32:10/);
  assert.match(tick.context, /turn time 12m04s/);
  assert.doesNotMatch(tick.context, /%/);
});

test("/spatium:budget declares a guide budget and ticks report the share used", () => {
  const { state, context } = onPrompt(emptyState(), "/spatium:budget 30m fix it", T0);
  assert.deepEqual(state.budget, { ms: 30 * MINUTE, mode: "soft" });
  assert.match(context, /30m/);
  assert.match(context, /guide/);
  assert.match(context, /correctness/);
  const tick = onPostTool(state, "Bash", T0 + 12 * MINUTE, false);
  assert.match(tick.context, /12m of 30m guide budget \(40%\)/);
});

// These lines stay in the context for the rest of the session, so they name the
// event they happened at: a bare "now" would read as current long after it was.
test("SessionStart anchors the time to the event that fired it, never to a bare 'now'", () => {
  const stamp = "2026-09-29 14:20:06 [+-]\\d\\d:\\d\\d \\(Tue\\)";
  const cases = new Map([
    ["startup", "Session started at"],
    ["clear", "Session started at"],
    ["resume", "Session resumed at"],
    ["compact", "Context compacted at"],
    [undefined, "Session started at"],
  ]);
  for (const [source, phrase] of cases) {
    assert.match(onSessionStart(emptyState(), source, T0), new RegExp(`${phrase} ${stamp}\\.`), String(source));
  }
});

test("the prompt header says when the prompt was received, not 'now'", () => {
  const { context } = onPrompt(emptyState(), "hi", T0);
  assert.match(context, /^Spatium: prompt received at 2026-09-29 14:20:06 [+-]\d\d:\d\d \(Tue\)\./);
  assert.doesNotMatch(context, /\bnow\b/i);
});

test("the share keeps counting past 100% and states the overrun", () => {
  const state = started("/spatium:budget 30m x");
  const tick = onPostTool(state, "Bash", T0 + 33 * MINUTE + 30_000, false);
  assert.match(tick.context, /112%, over by 3m30s/);
});

test("a plain prompt after a budgeted one clears the budget", () => {
  const budgeted = started("/spatium:budget 30m x");
  const { state } = onPrompt(budgeted, "next thing", T0 + 40 * MINUTE);
  assert.equal(state.budget, null);
  assert.equal(state.turnStart, T0 + 40 * MINUTE);
});

test("a background-task notification is not a new prompt: the clock and budget run on", () => {
  const state = started("/spatium:budget 30m x");
  for (const prompt of [
    "<task-notification>\n<task-id>a1</task-id>\n</task-notification>",
    "[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event.\n<task-notification>",
  ]) {
    const result = onPrompt(state, prompt, T0 + 12 * MINUTE);
    assert.equal(result.state, state);
    assert.equal(result.stamp, null);
    assert.match(result.context, /^Spatium: 14:32:06, 12m of 30m guide budget \(40%\)\.$/);
  }
});

test("an unreadable duration runs the prompt without a budget and says so", () => {
  const { state, context } = onPrompt(emptyState(), "/spatium:budget soon do it", T0);
  assert.equal(state.budget, null);
  assert.match(context, /could not read the duration "soon"/);
});

test("guidance is announced once per crossed threshold, then only the tick line remains", () => {
  let state = started("/spatium:budget 10m x");
  const first = onPostTool(state, "Bash", T0 + 5 * MINUTE, false);
  assert.match(first.context, /Half/);
  assert.equal(first.changed, true);
  state = first.state;
  const again = onPostTool(state, "Bash", T0 + 6 * MINUTE, false);
  assert.doesNotMatch(again.context, /Half/);
  assert.equal(again.changed, false);
  const late = onPostTool(state, "Bash", T0 + 10 * MINUTE, false);
  assert.match(late.context, /guide, not a stop/);
  assert.doesNotMatch(late.context, /Half/);
});

test("a hard limit tells the agent to wrap up at 80% and repeats the stop order past 100%", () => {
  let state = started("/spatium:limit 10m x");
  assert.equal(state.budget?.mode, "hard");
  const wrap = onPostTool(state, "Bash", T0 + 8 * MINUTE, false);
  assert.match(wrap.context, /wrap up/);
  state = wrap.state;
  const over = onPostTool(state, "Bash", T0 + 11 * MINUTE, false);
  assert.match(over.context, /HARD LIMIT REACHED \(110%\)/);
  const overAgain = onPostTool(over.state, "Bash", T0 + 11 * MINUTE + 10_000, false);
  assert.match(overAgain.context, /HARD LIMIT REACHED/);
});

test("a subagent sees the parent's budget but never consumes an announcement", () => {
  const state = started("/spatium:budget 10m x");
  const sub = onPostTool(state, "Read", T0 + 5 * MINUTE, true);
  assert.match(sub.context, /Half/);
  assert.match(sub.context, /parent/);
  assert.equal(sub.changed, false);
  assert.match(onPostTool(state, "Read", T0 + 5 * MINUTE, false).context, /Half/);
});

test("time spent waiting on AskUserQuestion is not charged to the budget", () => {
  let state = started("/spatium:budget 30m x");
  state = /** @type {any} */ (onPreTool(state, "AskUserQuestion", T0 + 5 * MINUTE));
  const answered = onPostTool(state, "AskUserQuestion", T0 + 45 * MINUTE, false);
  assert.equal(answered.changed, true);
  assert.match(answered.context, /5m of 30m/);
  assert.match(answered.context, /40m/);
  assert.equal(onPreTool(answered.state, "Read", T0), null);
});

test("Stop reports the budgeted turn to the user and remembers it for the next prompt", () => {
  const state = started("/spatium:budget 30m x");
  const stop = onStop(state, T0 + 23 * MINUTE);
  assert.match(stop.message ?? "", /23m of 30m guide budget \(77%\)/);
  const next = onPrompt(stop.state, "thanks", T0 + 88 * MINUTE);
  assert.match(next.context, /last reply ended 1h05m ago/);
  assert.match(next.context, /Previous turn: 23m of a 30m guide budget \(77%\)/);
});

test("Stop without a budget stamps the clock and turn time for the user, unless stamps are off", () => {
  assert.equal(onStop(started("hi"), T0 + MINUTE + 4_000, true).message, "Spatium: 14:21:10 · turn 1m04s");
  assert.equal(onStop(started("hi"), T0 + MINUTE, false).message, null);
});

test("Stop under a budget always reports it, stamps on or off, and leads with the clock", () => {
  const state = started("/spatium:limit 10m x");
  assert.equal(onStop(state, T0 + 5 * MINUTE, false).message, "Spatium: 14:25:06 · 5m of 10m hard limit (50%)");
  assert.equal(onStop(state, T0 + 5 * MINUTE, true).message, "Spatium: 14:25:06 · 5m of 10m hard limit (50%)");
});

test("every prompt yields a user stamp with the clock, plus the budget when one is declared", () => {
  assert.equal(onPrompt(emptyState(), "hi", T0).stamp, "Spatium: 14:20:06");
  assert.equal(onPrompt(emptyState(), "/spatium:budget 30m x", T0).stamp, "Spatium: 14:20:06 · 30m guide budget");
  const stopped = onStop(started("/spatium:limit 30m x"), T0 + 12 * MINUTE, true).state;
  assert.equal(
    onPrompt(stopped, "/spatium:continue", T0 + 20 * MINUTE).stamp,
    "Spatium: 14:40:06 · 30m hard limit, 12m used (40%)",
  );
});

test("/spatium:continue keeps the budget and does not charge the user's reply time", () => {
  const stopped = onStop(started("/spatium:budget 30m x"), T0 + 12 * MINUTE).state;
  const { state, context } = onPrompt(stopped, "/spatium:continue", T0 + 70 * MINUTE);
  assert.equal(state.turnStart, T0);
  assert.deepEqual(state.budget, { ms: 30 * MINUTE, mode: "soft" });
  assert.match(context, /12m of 30m used so far \(40%\)/);
  assert.match(onPostTool(state, "Bash", T0 + 71 * MINUTE, false).context, /13m of 30m/);
});

test("/spatium:continue can extend the budget or set a new total", () => {
  const stopped = onStop(started("/spatium:limit 30m x"), T0 + 12 * MINUTE).state;
  assert.equal(onPrompt(stopped, "/spatium:continue +15m", T0 + 13 * MINUTE).state.budget?.ms, 45 * MINUTE);
  assert.equal(onPrompt(stopped, "/spatium:continue 1h", T0 + 13 * MINUTE).state.budget?.ms, 60 * MINUTE);
  assert.equal(onPrompt(stopped, "/spatium:continue +15m", T0 + 13 * MINUTE).state.budget?.mode, "hard");
});

test("/spatium:continue followed by plain instructions keeps the budget without a duration complaint", () => {
  const stopped = onStop(started("/spatium:budget 30m x"), T0 + 12 * MINUTE).state;
  const { state, context } = onPrompt(stopped, "/spatium:continue and add tests", T0 + 13 * MINUTE);
  assert.equal(state.budget?.ms, 30 * MINUTE);
  assert.doesNotMatch(context, /could not read/);
  assert.match(onPrompt(stopped, "/spatium:continue +soon", T0).context, /could not read the duration "\+soon"/);
});

test("/spatium:continue with nothing to continue starts a plain turn and says so", () => {
  const { state, context } = onPrompt(emptyState(), "/spatium:continue", T0);
  assert.equal(state.budget, null);
  assert.equal(state.turnStart, T0);
  assert.match(context, /nothing to continue/);
});

test("SessionStart explains the time lines and restates an active budget after compaction", () => {
  assert.match(onSessionStart(emptyState(), "startup", T0), /Spatium is active/);
  assert.doesNotMatch(onSessionStart(emptyState(), "startup", T0), /\bnow\b/i);
  const state = started("/spatium:budget 30m x");
  assert.match(onSessionStart(state, "compact", T0 + 12 * MINUTE), /12m of 30m guide budget/);
  assert.doesNotMatch(onSessionStart(state, "startup", T0 + 12 * MINUTE), /of 30m/);
});

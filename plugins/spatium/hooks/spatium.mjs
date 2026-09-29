#!/usr/bin/env node
// Spatium — Claude Code hook: tells the agent the real time and, when the user
// set one, how much of the prompt's time budget is used.
//
// Wired by hooks/hooks.json as exec form:
//   node "${CLAUDE_PLUGIN_ROOT}/hooks/spatium.mjs" <Event> "${CLAUDE_PLUGIN_DATA}"
// Events: SessionStart (primer), UserPromptSubmit (turn start; parses
// /spatium:budget, /spatium:limit, /spatium:continue from the raw prompt),
// PreToolUse on AskUserQuestion (a wait on the user begins), PostToolUse and
// PostToolUseFailure (the tick line), Stop (records the turn). UserPromptSubmit
// and Stop also stamp the clock for the USER as a systemMessage, which the model
// never sees; SPATIUM_USER_STAMPS=0 turns those stamps off.
//
// ONE file on purpose (DESIGN.md D22): the hook runs on every tool call, so it
// is a single module importing only node builtins — no second module to
// resolve on the hot path. The charter's shell/logic split survives inside the
// file: everything above the "IO shell" banner is pure (no process, stdio, env
// or fs) and exported for tests; the shell below it runs only when this file is
// the entry point, so importing the module has no side effects.
//
// State is one small JSON file per session. Only turn boundaries, threshold
// announcements and user waits write it; ordinary ticks only read it, so
// parallel tool calls never race on a write that matters (a duplicated
// announcement is the worst case). The hook fails OPEN: any error emits
// nothing or a clock-only line, never a failure.

import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The tool whose runtime is the user's time, not the agent's. */
export const ASK_TOOL = "AskUserQuestion";

// A budget above a day is a typo, not a plan; refusing it beats a silent 0%.
const MAX_BUDGET_MS = 24 * 3_600_000;
// Sessions are resumable for days; a week keeps them and still bounds the dir.
const STATE_MAX_AGE_MS = 7 * 24 * 3_600_000;
// Echoed user input is capped so a pasted wall of text cannot flood the context.
const ECHO_LIMIT = 32;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * @typedef {{ ms: number, mode: "soft" | "hard" }} Budget
 * @typedef {{ elapsedMs: number, budget: Budget | null }} TurnSummary
 * @typedef {{
 *   turnStart: number | null,
 *   budget: Budget | null,
 *   announced: number,
 *   waitStart: number | null,
 *   waitedMs: number,
 *   lastStop: number | null,
 *   lastTurn: TurnSummary | null,
 * }} State
 */

/** The state of a session nothing has been recorded for yet. @returns {State} */
export function emptyState() {
  return { turnStart: null, budget: null, announced: 0, waitStart: null, waitedMs: 0, lastStop: null, lastTurn: null };
}

// ---------------------------------------------------------------- durations

/**
 * Parse a budget like "30m", "1h30m", "90s", "1.5h", "10min" or a bare number
 * of minutes. Returns milliseconds, or null for anything empty, zero, malformed
 * or longer than a day.
 * @param {string} text
 * @returns {number | null}
 */
export function parseDuration(text) {
  const trimmed = text.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return checkedBudget(Number(trimmed) * 60_000);
  const match = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?:in)?)?(?:(\d+(?:\.\d+)?)s)?$/.exec(trimmed);
  if (match === null || trimmed === "") return null;
  const [, hours = "0", minutes = "0", seconds = "0"] = match;
  return checkedBudget(Number(hours) * 3_600_000 + Number(minutes) * 60_000 + Number(seconds) * 1_000);
}

/** @param {number} ms */
function checkedBudget(ms) {
  if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_BUDGET_MS) return null;
  return Math.round(ms);
}

/** @param {number} n */
function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * Render a duration compactly with at most two units: "45s", "12m04s", "1h05m",
 * "2h". Negative input renders as "0s".
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h${pad2(minutes)}m` : `${hours}h`;
  if (minutes > 0) return seconds > 0 ? `${minutes}m${pad2(seconds)}s` : `${minutes}m`;
  return `${seconds}s`;
}

/** Local wall-clock time, "14:32:10". @param {number} ms */
function formatClock(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * Full local timestamp with the UTC offset and weekday — without the offset a
 * model tends to assume the clock is UTC.
 * @param {number} ms
 */
function formatStamp(ms) {
  const d = new Date(ms);
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const zone = `${sign}${pad2(Math.floor(Math.abs(offset) / 60))}:${pad2(Math.abs(offset) % 60)}`;
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return `${date} ${formatClock(ms)} ${zone} (${WEEKDAYS[d.getDay()]})`;
}

// ---------------------------------------------------------------- commands

/**
 * Recognize a spatium command at the very start of a prompt. Only a leading
 * command counts, so a prompt that merely mentions one is an ordinary prompt.
 * @param {unknown} prompt
 * @returns {{ name: "budget" | "limit" | "continue", arg: string } | null}
 */
export function parseCommand(prompt) {
  if (typeof prompt !== "string") return null;
  const match = /^\s*\/spatium:(budget|limit|continue)(?:\s+(\S+))?(?:\s[\s\S]*)?$/.exec(prompt);
  if (match === null) return null;
  const name = /** @type {"budget" | "limit" | "continue"} */ (match[1]);
  return { name, arg: match[2] ?? "" };
}

/**
 * Is this "prompt" a harness notification (a background task finishing) rather
 * than the user? Claude Code delivers those through UserPromptSubmit too.
 * @param {unknown} prompt
 */
function isNotification(prompt) {
  if (typeof prompt !== "string") return false;
  const head = prompt.trimStart();
  return head.startsWith("<task-notification>") || head.startsWith("[SYSTEM NOTIFICATION");
}

/** Make echoed user input single-line and short. @param {string} text */
function echo(text) {
  // Keep printable ASCII and everything from U+00A0 up; drop controls and quotes.
  return text.replace(/[^ -~ -￿]|"/g, "").slice(0, ECHO_LIMIT);
}

// ---------------------------------------------------------------- budget math

/**
 * The highest guidance step a share has reached: 50, 80, 100, then every
 * further 50% (150, 200, ...). 0 below the first step.
 * @param {number} percent
 * @returns {number}
 */
export function highestThreshold(percent) {
  if (percent >= 100) return 100 + Math.floor((percent - 100) / 50) * 50;
  if (percent >= 80) return 80;
  if (percent >= 50) return 50;
  return 0;
}

/** Agent time of the current turn: wall time minus waits on the user. @param {State} state @param {number} now */
function agentElapsed(state, now) {
  if (state.turnStart === null) return 0;
  const pendingWait = state.waitStart === null ? 0 : Math.max(0, now - state.waitStart);
  return Math.max(0, now - state.turnStart - state.waitedMs - pendingWait);
}

/** @param {number} elapsed @param {Budget} budget */
function percentOf(elapsed, budget) {
  return Math.round((elapsed / budget.ms) * 100);
}

/** "30m guide budget" or "30m hard limit". @param {Budget} budget */
function describeBudget(budget) {
  return `${formatDuration(budget.ms)} ${budget.mode === "hard" ? "hard limit" : "guide budget"}`;
}

/** "12m of 30m guide budget (40%)", with the overrun spelled out past 100%. @param {number} elapsed @param {Budget} budget */
function shareText(elapsed, budget) {
  const over = elapsed - budget.ms;
  const percent = percentOf(elapsed, budget);
  const share = over >= 1_000 ? `${percent}%, over by ${formatDuration(over)}` : `${percent}%`;
  return `${formatDuration(elapsed)} of ${describeBudget(budget)} (${share})`;
}

const NEVER_SILENTLY =
  "Never trade correctness for time silently: if you skip or cut anything (tests, checks, edge cases) " +
  "because of the budget, say so in your report.";

/** The rules stated when a budget is declared. @param {Budget} budget */
function declaration(budget) {
  if (budget.mode === "hard") {
    return (
      `Hard time limit for this prompt: ${formatDuration(budget.ms)}. You enforce it yourself — nothing will stop ` +
      "you. Scope the work to fit; at 80% start wrapping up; at 100% stop at the next safe point, leave the work " +
      `consistent, and report what is done, what is not, and what remains. ${NEVER_SILENTLY}`
    );
  }
  return (
    `Time budget for this prompt: ${formatDuration(budget.ms)} — a guide, not a stop. The share used is reported ` +
    "after every tool call and may pass 100%. Scope the work to fit; if it clearly needs more, say so early " +
    `rather than rushing. ${NEVER_SILENTLY}`
  );
}

/** Guidance for a newly reached step. @param {Budget} budget @param {number} step @param {number} percent */
function notice(budget, step, percent) {
  const kind = budget.mode === "hard" ? "hard limit" : "guide budget";
  if (step === 50) return `Half the ${kind} is used — check that the remaining work fits the remaining time.`;
  if (budget.mode === "hard") {
    return "80% of the hard limit is used — wrap up: start no new subtasks, finish the current one, and prepare your report.";
  }
  if (step === 80) return "80% of the guide budget is used — prioritize what matters most and plan the finish.";
  if (step === 100) {
    return (
      "The guide budget is used up. It is a guide, not a stop: finish if the end is close and the work is worth " +
      "it; otherwise reach a clean checkpoint and report. Mention the overrun in your final report."
    );
  }
  return `Now at ${percent}% of the guide budget — keep the remaining work tight and mention the overrun in your final report.`;
}

/** Repeated on every tick once a hard limit is spent. @param {number} percent */
function hardStop(percent) {
  return (
    `HARD LIMIT REACHED (${percent}%): stop at the next safe point — leave the work consistent (no half-applied ` +
    "edits), then report what is done, what is not, and what remains."
  );
}

// ---------------------------------------------------------------- reducers

const PRIMER =
  "Spatium is active: you are told the real time in `Spatium:` lines — at the start of each prompt (full date " +
  "and time zone) and after every tool call (the clock and how long the current prompt has run, excluding time " +
  "spent waiting on the user). Use them to judge elapsed time and estimate durations instead of guessing. When " +
  "the user sets a time budget for a prompt (/spatium:budget is a guide, /spatium:limit a hard limit you enforce " +
  "on yourself), the lines also show the share used; it can pass 100%.";

/**
 * SessionStart context: the primer, the current time, and — after compaction
 * or resume, when the primer and the budget declaration may be gone — the
 * active budget restated.
 * @param {State} state
 * @param {unknown} source the payload's source (startup, resume, clear, compact)
 * @param {number} now
 * @returns {string}
 */
export function onSessionStart(state, source, now) {
  // This text stays in the context all session; naming the event keeps it true
  // later, where a bare "now" would pass a stale clock off as the current one.
  let event = "Session started at";
  if (source === "resume") event = "Session resumed at";
  if (source === "compact") event = "Context compacted at";
  let text = `${PRIMER} ${event} ${formatStamp(now)}.`;
  const restate = source === "compact" || source === "resume";
  if (restate && state.budget !== null && state.turnStart !== null) {
    text += ` The current prompt is under a budget: ${shareText(agentElapsed(state, now), state.budget)} used.`;
  }
  return text;
}

/** Opening line of every prompt. @param {State} state @param {number} now */
function promptHeader(state, now) {
  let text = `Spatium: prompt received at ${formatStamp(now)}.`;
  if (state.lastStop !== null) text += ` Your last reply ended ${formatDuration(now - state.lastStop)} ago.`;
  if (state.lastTurn !== null) {
    const { elapsedMs, budget } = state.lastTurn;
    const summary =
      budget === null
        ? formatDuration(elapsedMs)
        : `${formatDuration(elapsedMs)} of a ${describeBudget(budget)} (${percentOf(elapsedMs, budget)}%)`;
    text += ` Previous turn: ${summary}.`;
  }
  return text;
}

/**
 * UserPromptSubmit: start a turn (or continue the last one) and declare its
 * budget. Any prompt that is not a spatium command clears the budget — a budget
 * belongs to one prompt, and /spatium:continue is the explicit way to carry it.
 * `stamp` is the user-facing line (a systemMessage the model never sees): the
 * clock, plus the budget when one applies.
 * @param {State} state
 * @param {unknown} prompt the raw prompt text
 * @param {number} now
 * A background-task notification also arrives through UserPromptSubmit, often
 * mid-turn; it is not the user speaking, so it gets a tick and changes nothing
 * (`stamp` null, the same state object back).
 * @returns {{ state: State, context: string, stamp: string | null }}
 */
export function onPrompt(state, prompt, now) {
  if (isNotification(prompt)) return { state, context: tickLine(state, now, false), stamp: null };
  const result = startTurn(state, prompt, now);
  let stamp = `Spatium: ${formatClock(now)}`;
  const { budget, turnStart } = result.state;
  if (budget !== null && turnStart !== now) {
    const elapsed = agentElapsed(result.state, now);
    stamp += ` · ${describeBudget(budget)}, ${formatDuration(elapsed)} used (${percentOf(elapsed, budget)}%)`;
  } else if (budget !== null) {
    stamp += ` · ${describeBudget(budget)}`;
  }
  return { ...result, stamp };
}

/** @param {State} state @param {unknown} prompt @param {number} now @returns {{ state: State, context: string }} */
function startTurn(state, prompt, now) {
  const header = promptHeader(state, now);
  const command = parseCommand(prompt);
  /** @type {State} */
  const fresh = { ...state, turnStart: now, budget: null, announced: 0, waitStart: null, waitedMs: 0 };
  if (command === null) return { state: fresh, context: header };
  if (command.name === "continue") return continueTurn(state, command.arg, now, header, fresh);
  const ms = parseDuration(command.arg);
  if (ms === null) {
    const hint = "use forms like 30m, 1h30m, 90s or 1.5h";
    const note = `Spatium could not read the duration "${echo(command.arg)}" (${hint}); this prompt runs without a time budget.`;
    return { state: fresh, context: `${header} ${note}` };
  }
  /** @type {Budget} */
  const budget = { ms, mode: command.name === "limit" ? "hard" : "soft" };
  return { state: { ...fresh, budget }, context: `${header} ${declaration(budget)}` };
}

/**
 * /spatium:continue [+dur | dur]: keep the previous turn's clock and budget,
 * charging none of the time the user took to reply; "+15m" extends the budget,
 * "45m" sets a new total, and any other first word is part of the instructions.
 * @param {State} state @param {string} arg @param {number} now @param {string} header @param {State} fresh
 * @returns {{ state: State, context: string }}
 */
function continueTurn(state, arg, now, header, fresh) {
  if (state.turnStart === null || state.lastStop === null) {
    const note = "There is nothing to continue: no earlier turn is recorded, so this prompt runs without a time budget.";
    return { state: fresh, context: `${header} ${note}` };
  }
  let budget = state.budget;
  let note = "";
  // Only a word shaped like a duration is one; "/spatium:continue and add tests"
  // carries instructions, not a malformed budget.
  if (/^[+\d]/.test(arg)) {
    const extend = arg.startsWith("+");
    const ms = parseDuration(extend ? arg.slice(1) : arg);
    if (ms === null) {
      note = ` Spatium could not read the duration "${echo(arg)}"; the budget is unchanged.`;
    } else {
      const total = extend ? (budget?.ms ?? 0) + ms : ms;
      budget = { ms: total, mode: budget?.mode ?? "soft" };
    }
  }
  /** @type {State} */
  const next = {
    ...state,
    budget,
    waitStart: null,
    waitedMs: state.waitedMs + Math.max(0, now - state.lastStop),
  };
  const elapsed = agentElapsed(next, now);
  if (budget === null) {
    return { state: next, context: `${header} Continuing the previous prompt: ${formatDuration(elapsed)} so far.${note}` };
  }
  const percent = percentOf(elapsed, budget);
  next.announced = Math.min(state.announced, highestThreshold(percent));
  const used = `${formatDuration(elapsed)} of ${formatDuration(budget.ms)} used so far (${percent}%)`;
  const text =
    `${header} Continuing the previous prompt under its ${describeBudget(budget)}: ${used}; the time you ` +
    `waited for this reply is not counted.${note} ${declaration(budget)}`;
  return { state: next, context: text };
}

/**
 * The one-line tick: the clock, then the turn time or the budget share, then
 * any time spent waiting on the user.
 * @param {State} state @param {number} now @param {boolean} subagent
 */
function tickLine(state, now, subagent) {
  const clock = formatClock(now);
  if (state.turnStart === null) return `Spatium: ${clock}.`;
  const elapsed = agentElapsed(state, now);
  let line;
  if (state.budget === null) {
    line = `Spatium: ${clock}, turn time ${formatDuration(elapsed)}.`;
  } else {
    const whose = subagent ? " — the parent prompt's budget" : "";
    line = `Spatium: ${clock}, ${shareText(elapsed, state.budget)}${whose}.`;
  }
  if (state.waitedMs >= 1_000) line += ` Waiting on the user (not counted): ${formatDuration(state.waitedMs)}.`;
  return line;
}

/**
 * PreToolUse: a wait on the user begins when AskUserQuestion runs. Returns the
 * new state, or null when nothing changes.
 * @param {State} state @param {unknown} toolName @param {number} now
 * @returns {State | null}
 */
export function onPreTool(state, toolName, now) {
  if (toolName !== ASK_TOOL || state.turnStart === null) return null;
  return { ...state, waitStart: now };
}

/**
 * PostToolUse / PostToolUseFailure: the tick line, plus guidance when a new
 * step is reached (repeated on every tick once a hard limit is spent).
 * `changed` tells the shell whether the state must be written. A subagent sees
 * the parent prompt's budget but never records an announcement — otherwise the
 * main agent, whose turn it is, would miss it.
 * @param {State} state @param {unknown} toolName @param {number} now @param {boolean} subagent
 * @returns {{ state: State, changed: boolean, context: string }}
 */
export function onPostTool(state, toolName, now, subagent) {
  let next = state;
  let changed = false;
  if (toolName === ASK_TOOL && state.waitStart !== null && !subagent) {
    next = { ...state, waitedMs: state.waitedMs + Math.max(0, now - state.waitStart), waitStart: null };
    changed = true;
  }
  let context = tickLine(next, now, subagent);
  if (next.turnStart !== null && next.budget !== null) {
    const percent = percentOf(agentElapsed(next, now), next.budget);
    const step = highestThreshold(percent);
    if (next.budget.mode === "hard" && percent >= 100) {
      context += ` ${hardStop(percent)}`;
    } else if (step > next.announced) {
      context += ` ${notice(next.budget, step, percent)}`;
    }
    if (step > next.announced && !subagent) {
      next = { ...next, announced: step };
      changed = true;
    }
  }
  return { state: next, changed, context };
}

/**
 * Stop: remember the turn for the next prompt's header and give the user a
 * closing stamp (a systemMessage the model never sees) — the clock and the turn
 * time, or the budget share. A budgeted turn is always reported; `stamps`
 * (false when the user turned stamps off) only silences the unbudgeted line.
 * @param {State} state @param {number} now @param {boolean} [stamps]
 * @returns {{ state: State, message: string | null }}
 */
export function onStop(state, now, stamps = true) {
  const clock = formatClock(now);
  if (state.turnStart === null) {
    return { state: { ...state, lastStop: now }, message: stamps ? `Spatium: ${clock}` : null };
  }
  const elapsed = agentElapsed(state, now);
  const next = { ...state, lastStop: now, lastTurn: { elapsedMs: elapsed, budget: state.budget } };
  if (state.budget !== null) return { state: next, message: `Spatium: ${clock} · ${shareText(elapsed, state.budget)}` };
  return { state: next, message: stamps ? `Spatium: ${clock} · turn ${formatDuration(elapsed)}` : null };
}

// ================================================================ IO shell

/** Narrow an untrusted parsed value to a State, falling back to empty. @param {any} raw @returns {State} */
function normalizeState(raw) {
  const state = emptyState();
  if (raw === null || typeof raw !== "object") return state;
  /** @param {unknown} v */
  const time = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  /** @param {any} b @returns {Budget | null} */
  const budget = (b) =>
    b && time(b.ms) !== null && b.ms > 0 && (b.mode === "soft" || b.mode === "hard") ? { ms: b.ms, mode: b.mode } : null;
  state.turnStart = time(raw.turnStart);
  state.budget = budget(raw.budget);
  state.announced = time(raw.announced) ?? 0;
  state.waitStart = time(raw.waitStart);
  state.waitedMs = time(raw.waitedMs) ?? 0;
  state.lastStop = time(raw.lastStop);
  if (raw.lastTurn && time(raw.lastTurn.elapsedMs) !== null) {
    state.lastTurn = { elapsedMs: raw.lastTurn.elapsedMs, budget: budget(raw.lastTurn.budget) };
  }
  return state;
}

/** @param {string} file @returns {State} */
function loadState(file) {
  try {
    return normalizeState(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return emptyState(); // absent or corrupt: a fresh session is the safe reading
  }
}

/** Write via a temp file and rename, so a reader never sees half a file. @param {string} file @param {State} state */
function saveState(file, state) {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(temp, JSON.stringify(state));
    renameSync(temp, file);
  } catch {
    try {
      unlinkSync(temp);
    } catch {
      // nothing to clean up; losing one write only costs a repeated notice
    }
  }
}

/** Delete state files untouched for a week. @param {string} dir @param {number} now */
function pruneStale(dir, now) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return; // no dir yet: nothing to prune
  }
  for (const name of names) {
    try {
      const file = join(dir, name);
      if (now - statSync(file).mtimeMs > STATE_MAX_AGE_MS) unlinkSync(file);
    } catch {
      // raced with another session's prune or a locked file: try again next start
    }
  }
}

/** @param {unknown} obj */
function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

/** @param {string} event @param {string} context */
function emitContext(event, context) {
  emit({ hookSpecificOutput: { hookEventName: event, additionalContext: context } });
}

function main() {
  /** @type {any} */
  let input = {};
  try {
    // A leading BOM (some shells add one when piping) would make JSON.parse throw.
    input = JSON.parse(readFileSync(0, "utf8").replace(/^﻿/, "")) ?? {};
  } catch {
    input = {}; // garbage stdin: still answer the argv event, fail open
  }
  if (typeof input !== "object") input = {};
  const event = process.argv[2] || input.hook_event_name || "";
  const dataDir = process.argv[3] || join(tmpdir(), "claude-spatium");
  const sessionsDir = join(dataDir, "sessions");
  // The session id becomes a file name, so anything but a plain token is refused.
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  const file = /^[A-Za-z0-9_-]{1,128}$/.test(sessionId) ? join(sessionsDir, `${sessionId}.json`) : null;
  const state = file === null ? emptyState() : loadState(file);
  const now = Date.now();
  // User-facing stamps are on unless explicitly switched off; the budget report is not optional.
  const stamps = !/^(0|off|false|no)$/i.test(process.env.SPATIUM_USER_STAMPS ?? "");

  if (event === "SessionStart") {
    pruneStale(sessionsDir, now);
    emitContext(event, onSessionStart(state, input.source, now));
  } else if (event === "UserPromptSubmit") {
    const result = onPrompt(state, input.prompt, now);
    if (file !== null && result.state !== state) saveState(file, result.state);
    /** @type {Record<string, unknown>} */
    const out = { hookSpecificOutput: { hookEventName: event, additionalContext: result.context } };
    if (stamps && result.stamp !== null) out.systemMessage = result.stamp;
    emit(out);
  } else if (event === "PreToolUse") {
    const next = onPreTool(state, input.tool_name, now);
    if (next !== null && file !== null) saveState(file, next);
  } else if (event === "PostToolUse" || event === "PostToolUseFailure") {
    // The harness stamps agent_id on every payload fired inside a subagent.
    const subagent = typeof input.agent_id === "string" && input.agent_id !== "";
    const result = onPostTool(state, input.tool_name, now, subagent);
    if (result.changed && file !== null) saveState(file, result.state);
    emitContext(event, result.context);
  } else if (event === "Stop") {
    const result = onStop(state, now, stamps);
    if (file !== null) saveState(file, result.state);
    if (result.message !== null) emit({ systemMessage: result.message });
  }
}

/** True when node runs this file directly (not when a test imports it). */
function isEntryPoint() {
  if (typeof import.meta.main === "boolean") return import.meta.main;
  // Node before import.meta.main: compare paths, case-folded for Windows drives.
  const entry = process.argv[1] ? resolve(process.argv[1]).toLowerCase() : "";
  return entry === fileURLToPath(import.meta.url).toLowerCase();
}

if (isEntryPoint()) {
  try {
    main();
  } catch {
    // fail open — a broken clock must never break the session
  }
}

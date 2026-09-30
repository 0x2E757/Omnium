#!/usr/bin/env node
// Spatium — Claude Code hook: tells the agent the real time and, when the user
// set one, how much of the prompt's time budget is used.
//
// Wired by hooks/hooks.json as exec form:
//   node "${CLAUDE_PLUGIN_ROOT}/hooks/spatium.mjs" <Event> "${CLAUDE_PLUGIN_DATA}"
// Events: SessionStart (primer), UserPromptSubmit (turn start; parses
// /spatium:budget, /spatium:limit, /spatium:continue from the raw prompt),
// PreToolUse on AskUserQuestion (a wait on the user begins) and on Agent (a
// budget marker at the start of the subagent's prompt is set aside),
// SubagentStart (the subagent's own clock starts, under that budget),
// PostToolUse and PostToolUseFailure (the tick line), Stop and StopFailure
// (record the turn). UserPromptSubmit and Stop also stamp the clock for the
// USER as a systemMessage, which the model never sees; SPATIUM_USER_STAMPS=0
// turns those stamps off.
//
// SubagentStart carries only agent_id and agent_type — no tool_use_id, no
// prompt — so the budget travels through a one-slot "pending spawn" that the
// Agent call's PreToolUse writes and the next SubagentStart takes. That rests
// on an observed ordering (DESIGN.md D23): every Agent call's SubagentStart
// fires before the next Agent call's PreToolUse, sequential or parallel,
// foreground or background, nested or not.
//
// ONE file on purpose (DESIGN.md D22): the hook runs on every tool call, so it
// is a single module importing only node builtins — no second module to
// resolve on the hot path. The charter's shell/logic split survives inside the
// file: everything above the "IO shell" banner is pure (no process, stdio, env
// or fs) and exported for tests; the shell below it runs only when this file is
// the entry point, so importing the module has no side effects.
//
// State is one small JSON file per session, plus one per subagent and the
// pending-spawn slot. Only turn boundaries, threshold announcements, user waits
// and spawns write them, and each agent writes only its own file; ordinary ticks
// only read, so parallel tool calls and parallel subagents never race on a
// write that matters (a duplicated announcement is the worst case). The hook
// fails OPEN: any error emits nothing or a clock-only line, never a failure.

import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The tool whose runtime is the user's time, not the agent's. */
export const ASK_TOOL = "AskUserQuestion";
/** The tool that starts a subagent; its prompt may open with a budget marker. */
export const AGENT_TOOL = "Agent";

// A budget above a day is a typo, not a plan; refusing it beats a silent 0%.
const MAX_BUDGET_MS = 24 * 3_600_000;
// SubagentStart followed its Agent call within ~1 s in every observed run
// (worktree setup included); a minute is generous, yet a slot left behind by a
// launch that never happened cannot budget a subagent started much later.
const PENDING_MAX_AGE_MS = 60_000;
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
 * A subagent's own state uses the same shape: turnStart is when it started.
 * @typedef {{ at: number, toolUseId: string | null, budget: Budget | null, unreadable: string | null }} PendingSpawn
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

/**
 * The rules stated when a budget is declared.
 * @param {Budget} budget @param {string} [scope] whose budget: "this prompt", or "your task" for a subagent
 */
function declaration(budget, scope = "this prompt") {
  if (budget.mode === "hard") {
    return (
      `Hard time limit for ${scope}: ${formatDuration(budget.ms)}. You enforce it yourself — nothing will stop ` +
      "you. Scope the work to fit; at 80% start wrapping up; at 100% stop at the next safe point, leave the work " +
      `consistent, and report what is done, what is not, and what remains. ${NEVER_SILENTLY}`
    );
  }
  return (
    `Time budget for ${scope}: ${formatDuration(budget.ms)} — a guide, not a stop. The share used is reported ` +
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
  "on yourself), the lines also show the share used; it can pass 100%. To give a subagent its own budget, start " +
  "the Agent tool's prompt with /spatium:budget <duration> or /spatium:limit <duration>.";

// A subagent never sees SessionStart or UserPromptSubmit, so without this it
// would get `Spatium:` lines with no idea what they measure.
const SUBAGENT_PRIMER =
  "Spatium is active: after every tool call a `Spatium:` line gives the clock and how long you, this subagent, " +
  "have been running, plus the top-level prompt's time budget when the user set one. Use them to judge elapsed " +
  "time instead of guessing.";

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
  if (isNotification(prompt)) return { state, context: tickLine(state, now), stamp: null };
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
 * The main agent's one-line tick: the clock, then the turn time or the budget
 * share, then any time spent waiting on the user.
 * @param {State} state @param {number} now
 */
function tickLine(state, now) {
  const clock = formatClock(now);
  if (state.turnStart === null) return `Spatium: ${clock}.`;
  const elapsed = agentElapsed(state, now);
  let line;
  if (state.budget === null) {
    line = `Spatium: ${clock}, turn time ${formatDuration(elapsed)}.`;
  } else {
    line = `Spatium: ${clock}, ${shareText(elapsed, state.budget)}.`;
  }
  if (state.waitedMs >= 1_000) line += ` Waiting on the user (not counted): ${formatDuration(state.waitedMs)}.`;
  return line;
}

/**
 * The guidance a budgeted clock owes at this tick — the stop order past a hard
 * limit, or the notice for a newly reached step — and the step reached, which
 * the caller records as announced.
 * @param {State} state @param {number} now
 * @returns {{ text: string, step: number }}
 */
function guidanceFor(state, now) {
  if (state.turnStart === null || state.budget === null) return { text: "", step: 0 };
  const percent = percentOf(agentElapsed(state, now), state.budget);
  const step = highestThreshold(percent);
  if (state.budget.mode === "hard" && percent >= 100) return { text: ` ${hardStop(percent)}`, step };
  if (step > state.announced) return { text: ` ${notice(state.budget, step, percent)}`, step };
  return { text: "", step };
}

/**
 * What a subagent is told about the top-level prompt: its budget share, and to
 * finish once a hard limit there is spent. Guidance steps stay the main agent's
 * business; a subagent could never record them, so it would repeat them.
 * @param {State} parent @param {number} now
 */
function parentNote(parent, now) {
  if (parent.turnStart === null || parent.budget === null) return "";
  const elapsed = agentElapsed(parent, now);
  let note = ` Top-level prompt: ${shareText(elapsed, parent.budget)}.`;
  if (parent.budget.mode === "hard" && elapsed >= parent.budget.ms) {
    note += " Its hard limit is used up: finish at the next safe point and return what you have.";
  }
  return note;
}

/**
 * The tick of a subagent that has no clock of its own (it started before this
 * version, or its SubagentStart failed): the top-level prompt's time, labeled
 * as such so the subagent never takes it for its own.
 * @param {State} parent @param {number} now
 */
function parentTick(parent, now) {
  const clock = formatClock(now);
  if (parent.turnStart === null) return `Spatium: ${clock}.`;
  const elapsed = agentElapsed(parent, now);
  if (parent.budget === null) return `Spatium: ${clock}, top-level prompt time ${formatDuration(elapsed)}.`;
  return `Spatium: ${clock}, top-level prompt: ${shareText(elapsed, parent.budget)}.`;
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
 * PostToolUse / PostToolUseFailure of the main agent: the tick line, plus
 * guidance when a new step is reached (repeated on every tick once a hard limit
 * is spent). `changed` tells the shell whether the state must be written. With
 * `subagent` set, this is the fallback tick of a subagent with no clock of its
 * own: the labeled top-level time, no guidance, nothing recorded.
 * @param {State} state @param {unknown} toolName @param {number} now @param {boolean} subagent
 * @returns {{ state: State, changed: boolean, context: string }}
 */
export function onPostTool(state, toolName, now, subagent) {
  if (subagent) return { state, changed: false, context: parentTick(state, now) };
  let next = state;
  let changed = false;
  if (toolName === ASK_TOOL && state.waitStart !== null) {
    next = { ...state, waitedMs: state.waitedMs + Math.max(0, now - state.waitStart), waitStart: null };
    changed = true;
  }
  const guidance = guidanceFor(next, now);
  if (guidance.step > next.announced) {
    next = { ...next, announced: guidance.step };
    changed = true;
  }
  return { state: next, changed, context: tickLine(next, now) + guidance.text };
}

// ---------------------------------------------------------------- subagents

/**
 * PreToolUse on Agent: set the launch aside for the SubagentStart that follows,
 * with the budget a leading /spatium:budget or /spatium:limit marker in the
 * subagent's prompt asks for. Every Agent call writes the slot, marker or not,
 * so a slot can only ever reach the subagent of the call right before it.
 * @param {unknown} toolInput the Agent call's tool_input
 * @param {unknown} toolUseId
 * @param {number} now
 * @returns {PendingSpawn}
 */
export function onSpawn(toolInput, toolUseId, now) {
  const prompt = toolInput !== null && typeof toolInput === "object" ? /** @type {any} */ (toolInput).prompt : undefined;
  /** @type {PendingSpawn} */
  const spawn = { at: now, toolUseId: typeof toolUseId === "string" ? toolUseId : null, budget: null, unreadable: null };
  const command = parseCommand(prompt);
  // /spatium:continue carries a prompt's own budget over; a fresh subagent has none to carry.
  if (command === null || command.name === "continue") return spawn;
  const ms = parseDuration(command.arg);
  if (ms === null) return { ...spawn, unreadable: command.arg };
  return { ...spawn, budget: { ms, mode: command.name === "limit" ? "hard" : "soft" } };
}

/**
 * PostToolUseFailure on Agent: a launch that failed (an unknown agent type, a
 * denied call) starts no subagent, so its slot is dropped; a slot written by a
 * different call is kept.
 * @param {PendingSpawn | null} pending @param {unknown} toolUseId
 * @returns {PendingSpawn | null} the slot that remains
 */
export function onSpawnFailure(pending, toolUseId) {
  if (pending === null || pending.toolUseId === toolUseId) return null;
  return pending;
}

/**
 * SubagentStart: the subagent's own clock starts, under the pending spawn's
 * budget when that slot is fresh. A subagent that already has a state is being
 * resumed (SendMessage); its new run starts a fresh unbudgeted clock and leaves
 * the slot alone, since no Agent call preceded it. `consumed` tells the shell
 * to delete the slot.
 * @param {PendingSpawn | null} pending @param {State | null} existing @param {number} now
 * @returns {{ state: State, context: string, consumed: boolean }}
 */
export function onSubagentStart(pending, existing, now) {
  const resumed = existing !== null;
  const usable = !resumed && pending !== null && now - pending.at <= PENDING_MAX_AGE_MS ? pending : null;
  const budget = usable === null ? null : usable.budget;
  const state = { ...emptyState(), turnStart: now, budget };
  let context = `${SUBAGENT_PRIMER} You were ${resumed ? "resumed" : "started"} at ${formatStamp(now)}.`;
  if (usable !== null && usable.unreadable !== null) {
    context += ` Spatium could not read the duration "${echo(usable.unreadable)}"; you run without a time budget.`;
  }
  if (budget !== null) context += ` ${declaration(budget, "your task")}`;
  return { state, context, consumed: !resumed && pending !== null };
}

/**
 * PostToolUse / PostToolUseFailure inside a subagent that has its own clock:
 * its run time or its budget share, its own guidance (recorded in its own
 * state), then the top-level prompt's budget when there is one.
 * @param {State} agent the subagent's own state @param {State} parent the session's prompt state @param {number} now
 * @returns {{ state: State, changed: boolean, context: string }}
 */
export function onSubagentTool(agent, parent, now) {
  const clock = formatClock(now);
  const elapsed = agentElapsed(agent, now);
  let context;
  if (agent.budget === null) {
    context = `Spatium: ${clock}, your run time ${formatDuration(elapsed)}.`;
  } else {
    context = `Spatium: ${clock}, ${shareText(elapsed, agent.budget)}.`;
  }
  const guidance = guidanceFor(agent, now);
  context += guidance.text + parentNote(parent, now);
  if (guidance.step > agent.announced) return { state: { ...agent, announced: guidance.step }, changed: true, context };
  return { state: agent, changed: false, context };
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

/** @param {unknown} v @returns {number | null} */
function finiteOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Narrow an untrusted parsed value to a Budget. @param {any} b @returns {Budget | null} */
function normalizeBudget(b) {
  const valid = b && finiteOrNull(b.ms) !== null && b.ms > 0 && (b.mode === "soft" || b.mode === "hard");
  return valid ? { ms: b.ms, mode: b.mode } : null;
}

/** Narrow an untrusted parsed value to a State, falling back to empty. @param {any} raw @returns {State} */
function normalizeState(raw) {
  const state = emptyState();
  if (raw === null || typeof raw !== "object") return state;
  state.turnStart = finiteOrNull(raw.turnStart);
  state.budget = normalizeBudget(raw.budget);
  state.announced = finiteOrNull(raw.announced) ?? 0;
  state.waitStart = finiteOrNull(raw.waitStart);
  state.waitedMs = finiteOrNull(raw.waitedMs) ?? 0;
  state.lastStop = finiteOrNull(raw.lastStop);
  if (raw.lastTurn && finiteOrNull(raw.lastTurn.elapsedMs) !== null) {
    state.lastTurn = { elapsedMs: raw.lastTurn.elapsedMs, budget: normalizeBudget(raw.lastTurn.budget) };
  }
  return state;
}

/** Narrow an untrusted parsed value to a PendingSpawn, or null. @param {any} raw @returns {PendingSpawn | null} */
function normalizePending(raw) {
  if (raw === null || typeof raw !== "object" || finiteOrNull(raw.at) === null) return null;
  return {
    at: raw.at,
    toolUseId: typeof raw.toolUseId === "string" ? raw.toolUseId : null,
    budget: normalizeBudget(raw.budget),
    unreadable: typeof raw.unreadable === "string" ? raw.unreadable : null,
  };
}

/** @param {string} file @returns {unknown} the parsed file, or null when absent or corrupt */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null; // absent or corrupt: nothing recorded is the safe reading
  }
}

/** @param {string} file @returns {State} */
function loadState(file) {
  return normalizeState(readJson(file));
}

/** A subagent's own state, or null when it has none yet. @param {string | null} file @returns {State | null} */
function loadAgentState(file) {
  if (file === null) return null;
  const raw = readJson(file);
  return raw === null ? null : normalizeState(raw);
}

/** Write via a temp file and rename, so a reader never sees half a file. @param {string} file @param {unknown} value */
function saveJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(temp, JSON.stringify(value));
    renameSync(temp, file);
  } catch {
    try {
      unlinkSync(temp);
    } catch {
      // nothing to clean up; losing one write only costs a repeated notice
    }
  }
}

/** @param {string} file */
function removeFile(file) {
  try {
    unlinkSync(file);
  } catch {
    // already gone (a parallel hook took it first) or locked: pruning catches a leftover
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
  // Ids become file names, so anything but a plain token is refused.
  const safeToken = /^[A-Za-z0-9_-]{1,128}$/;
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  const base = safeToken.test(sessionId) ? join(sessionsDir, sessionId) : null;
  const file = base === null ? null : `${base}.json`;
  const spawnFile = base === null ? null : `${base}.spawn.json`;
  // The harness stamps agent_id on every payload fired inside a subagent.
  const agentId = typeof input.agent_id === "string" ? input.agent_id : "";
  const subagent = agentId !== "";
  const agentFile = base !== null && safeToken.test(agentId) ? `${base}.agent-${agentId}.json` : null;
  const state = file === null ? emptyState() : loadState(file);
  const now = Date.now();
  // User-facing stamps are on unless explicitly switched off; the budget report is not optional.
  const stamps = !/^(0|off|false|no)$/i.test(process.env.SPATIUM_USER_STAMPS ?? "");

  if (event === "SessionStart") {
    pruneStale(sessionsDir, now);
    emitContext(event, onSessionStart(state, input.source, now));
  } else if (event === "UserPromptSubmit") {
    const result = onPrompt(state, input.prompt, now);
    if (file !== null && result.state !== state) saveJson(file, result.state);
    /** @type {Record<string, unknown>} */
    const out = { hookSpecificOutput: { hookEventName: event, additionalContext: result.context } };
    if (stamps && result.stamp !== null) out.systemMessage = result.stamp;
    emit(out);
  } else if (event === "PreToolUse") {
    if (input.tool_name === AGENT_TOOL) {
      if (spawnFile !== null) saveJson(spawnFile, onSpawn(input.tool_input, input.tool_use_id, now));
      return;
    }
    const next = onPreTool(state, input.tool_name, now);
    if (next !== null && file !== null) saveJson(file, next);
  } else if (event === "SubagentStart") {
    // Without a file to keep its clock in, the subagent still gets the primer,
    // but the slot is left for a subagent that can use it.
    const pending = agentFile === null || spawnFile === null ? null : normalizePending(readJson(spawnFile));
    const result = onSubagentStart(pending, loadAgentState(agentFile), now);
    if (agentFile !== null) saveJson(agentFile, result.state);
    if (result.consumed && spawnFile !== null) removeFile(spawnFile);
    emitContext(event, result.context);
  } else if (event === "PostToolUse" || event === "PostToolUseFailure") {
    if (event === "PostToolUseFailure" && input.tool_name === AGENT_TOOL && spawnFile !== null) {
      const pending = normalizePending(readJson(spawnFile));
      if (pending !== null && onSpawnFailure(pending, input.tool_use_id) === null) removeFile(spawnFile);
    }
    const agent = subagent ? loadAgentState(agentFile) : null;
    if (agent !== null && agentFile !== null) {
      const result = onSubagentTool(agent, state, now);
      if (result.changed) saveJson(agentFile, result.state);
      emitContext(event, result.context);
      return;
    }
    const result = onPostTool(state, input.tool_name, now, subagent);
    if (result.changed && file !== null) saveJson(file, result.state);
    emitContext(event, result.context);
  } else if (event === "Stop" || event === "StopFailure") {
    // A refused or failed API call ends the turn with StopFailure instead of Stop.
    const result = onStop(state, now, stamps);
    if (file !== null) saveJson(file, result.state);
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

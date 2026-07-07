#!/usr/bin/env node
// Autonomity — Claude Code hook dispatcher (zero-dependency IO shell).
//
// Wired by hooks/hooks.json; the event name is passed as argv[2] (falling back
// to the stdin payload's hook_event_name). All decision logic lives in
// hook-lib.mjs. The dispatcher fails OPEN: any error emits nothing, so a bug
// here can never brick a session (PreToolUse falls back to the normal
// permission flow; Stop is allowed).

import {
  decidePreToolUse,
  sessionStartOutput,
  evaluateStop,
  parseToggle,
  AUTONOMY_CONTEXT,
  TOGGLE_ON_MESSAGE,
  TOGGLE_OFF_MESSAGE,
  isStatusCommand,
  statusMessage,
  isStopHookActive,
  STOP_WAIVE_MESSAGE,
} from "./hook-lib.mjs";
import { readState, writeState, readStopBlocked, writeStopBlocked, clearStopBlocked } from "./state.mjs";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** @param {any} obj */
function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

const input = await readStdin();
const event = process.argv[2] || input.hook_event_name || "";
const sessionId = input.session_id;

try {
  if (event === "UserPromptSubmit") {
    clearStopBlocked(sessionId); // a user prompt starts a new stop chain
    // The on/off toggle owns the flag. A toggle prompt flips the session state
    // and is erased (decision: block) so it never produces a model turn; any
    // other prompt, while active, carries the autonomy primer along.
    const toggle = parseToggle(input.prompt);
    if (toggle) {
      writeState(sessionId, toggle);
      const reason = toggle === "on" ? TOGGLE_ON_MESSAGE : TOGGLE_OFF_MESSAGE;
      emit({ decision: "block", reason, systemMessage: reason });
    } else if (isStatusCommand(input.prompt)) {
      // Read-only: report the current state and erase the prompt.
      const reason = statusMessage(readState(sessionId));
      emit({ decision: "block", reason, systemMessage: reason });
    } else if (readState(sessionId) === "on") {
      emit({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: AUTONOMY_CONTEXT,
        },
      });
    }
  } else if (readState(sessionId) !== "on") {
    // Disabled for this session: every other event is a no-op, so the normal
    // permission flow and Stop behavior apply unchanged.
  } else if (event === "PreToolUse") {
    const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    emit({
      hookSpecificOutput: decidePreToolUse(input.tool_name || "", input.tool_input || {}, cwd),
    });
  } else if (event === "SessionStart") {
    emit({ hookSpecificOutput: sessionStartOutput() });
  } else if (event === "Stop") {
    const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const result = evaluateStop(cwd);
    if (result.block) {
      // The harness sets stop_hook_active when this stop is already a
      // continuation caused by a prior stop-hook block — by ANY stop hook, the
      // flag is turn-global — and only force-overrides after 8 no-progress
      // blocks. Re-blocking forever risks a long loop, but the flag alone
      // would let another plugin's block disarm this gate, so waive (with a
      // warning) only once THIS gate has blocked in the current chain.
      if (isStopHookActive(input) && readStopBlocked(sessionId)) {
        emit({ systemMessage: STOP_WAIVE_MESSAGE });
      } else {
        writeStopBlocked(sessionId);
        emit({ decision: "block", reason: result.reason });
      }
    }
  }
} catch {
  // fail open — emit nothing
}

process.exit(0);

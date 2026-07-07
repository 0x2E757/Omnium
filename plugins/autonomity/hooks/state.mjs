// Autonomity — per-session on/off state (the only stateful, side-effecting part).
//
// Slash commands cannot persist a flag themselves (a command just injects a
// prompt) and a hook subprocess cannot mutate the parent's env, so the toggle
// state lives in a tiny file keyed by the session id. The UserPromptSubmit hook
// WRITES it (when it sees `/autonomity:on|off`); every other hook READS it to
// decide whether to enforce. Kept separate from hook-lib.mjs so that module
// stays pure/easily testable.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const DIR = join(tmpdir(), "claude-autonomity");

/** Make a session id safe to use as a file name (uuid-ish ids already are). @param {unknown} sessionId */
function sanitize(sessionId) {
  return String(sessionId || "default").replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Absolute path of the per-session state file. @param {unknown} sessionId */
export function stateFile(sessionId) {
  return join(DIR, sanitize(sessionId) + ".state");
}

/**
 * Current state for a session. Default is "off": an absent, unreadable, or
 * unrecognized file means the plugin does NOTHING until the user opts in with
 * `/autonomity:on`. Never throws.
 * @param {unknown} sessionId
 */
export function readState(sessionId) {
  try {
    return readFileSync(stateFile(sessionId), "utf8").trim() === "on" ? "on" : "off";
  } catch {
    return "off";
  }
}

/**
 * Persist the state for a session. Coerces to "on"/"off". Returns the value
 * written. Never throws (a write failure leaves the previous state in place).
 * @param {unknown} sessionId @param {unknown} value
 */
export function writeState(sessionId, value) {
  const v = value === "on" ? "on" : "off";
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(stateFile(sessionId), v, "utf8");
  } catch {
    // best-effort — fail open
  }
  return v;
}

// The Stop-gate loop-protection marker: the harness's stop_hook_active flag is
// turn-global (ANY stop hook's block sets it), so the gate additionally tracks
// whether IT blocked in the current stop chain — set when Stop blocks, cleared
// by the next user prompt — and waives only when both hold.

/** Absolute path of the per-session stop-blocked marker. @param {unknown} sessionId */
function stopBlockedFile(sessionId) {
  return join(DIR, sanitize(sessionId) + ".stop-blocked");
}

/** Whether this session's Stop gate already blocked in the current stop chain. @param {unknown} sessionId */
export function readStopBlocked(sessionId) {
  return existsSync(stopBlockedFile(sessionId));
}

/** Mark that the Stop gate blocked. Never throws (fail open). @param {unknown} sessionId */
export function writeStopBlocked(sessionId) {
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(stopBlockedFile(sessionId), "1", "utf8");
  } catch {
    // best-effort — fail open
  }
}

/** Clear the marker (a new user prompt starts a new stop chain). Never throws. @param {unknown} sessionId */
export function clearStopBlocked(sessionId) {
  try {
    rmSync(stopBlockedFile(sessionId), { force: true });
  } catch {
    // best-effort — fail open
  }
}

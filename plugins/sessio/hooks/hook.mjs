#!/usr/bin/env node
// Sessio — Claude Code hook dispatcher (zero-dependency IO shell).
//
// Wired by hooks/hooks.json; the event name is passed as argv[2] (falling back
// to the stdin payload's hook_event_name). The only handled event is
// SessionStart, on which it injects the scratch-file routing primer (routing
// under CLAUDE_SESSIONS_DIR when set, onboarding when not). It fails OPEN: any
// error emits nothing, so a bug here can never brick a session. Sessio has no
// state, no commands, and no other events — a pure, always-on injector.

import { sessionStartOutput } from "./hook-lib.mjs";

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

try {
  if (event === "SessionStart") {
    emit({ hookSpecificOutput: sessionStartOutput() });
  }
} catch {
  // fail open — emit nothing
}

process.exit(0);

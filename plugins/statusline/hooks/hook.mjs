#!/usr/bin/env node
// Statusline — Claude Code hook dispatcher (zero-dependency IO shell).
//
// Wired by hooks/hooks.json as exec form:
//   node "${CLAUDE_PLUGIN_ROOT}/hooks/hook.mjs" SessionStart "${CLAUDE_PLUGIN_DATA}"
// argv[2] is the event, argv[3] is the persistent per-plugin data dir.
//
// On SessionStart it does two things, then exits: (1) copies the shipped
// renderer into the VERSION-STABLE data dir (the plugin cache path is versioned
// and 404s on every bump, so settings.json must point at the data dir instead);
// (2) reads the user's settings.json and, unless our statusLine is already
// installed, injects a primer nudging the agent to install it (asking first if
// a foreign statusLine exists). It never writes settings.json — the agent does.
// It fails OPEN: any error emits nothing, so a bug here can never brick a
// session or the status bar.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyStatusLine, renderCommand, statusLineNudge } from "./hook-lib.mjs";

// plugins/statusline/ — the shipped plugin root (this file lives in hooks/).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const event = process.argv[2] || "";
const dataDir = process.argv[3] || ""; // ${CLAUDE_PLUGIN_DATA}, empty under --plugin-dir

/** The user's settings.json path (honors CLAUDE_CONFIG_DIR like Claude Code does). */
function settingsPath() {
  const base = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return join(base, "settings.json");
}

/**
 * Read the user's settings, distinguishing three cases so a temporarily broken
 * config is not mistaken for a fresh one:
 *   - file absent (or unreadable): { settings: {}, parsed: true }  — safe to nudge.
 *   - present but invalid JSON:    { settings: {}, parsed: false } — a real config
 *       almost certainly exists and is only transiently broken, so the caller must
 *       stay SILENT rather than re-nudge a blind overwrite of a file we can't read.
 *   - present and valid:           { settings: <obj>, parsed: true }.
 * @param {string} path
 * @returns {{ settings: any, parsed: boolean }}
 */
function readSettings(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { settings: {}, parsed: true }; // no settings.json yet — a fresh install
  }
  // An empty / whitespace-only file carries no real config to protect, so treat it
  // as a fresh install (nudge) rather than an unparsable one to stay silent over.
  if (text.trim() === "") return { settings: {}, parsed: true };
  try {
    return { settings: JSON.parse(text), parsed: true };
  } catch {
    return { settings: {}, parsed: false }; // present but unparsable — do not nudge
  }
}

/**
 * Sync the shipped renderer into the version-stable data dir and return the
 * path the statusLine command should point at. When no data dir was passed
 * (dev/--plugin-dir), fall back to the shipped renderer in place.
 * @returns {string}
 */
function resolveRenderPath() {
  const shipped = join(ROOT, "statusline", "render.mjs");
  const source = readFileSync(shipped, "utf8");
  if (!dataDir) return shipped;
  const stable = join(dataDir, "render.mjs");
  try {
    let current = "";
    try {
      current = readFileSync(stable, "utf8");
    } catch {
      /* not synced yet */
    }
    if (current !== source) {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(stable, source);
    }
    return stable;
  } catch {
    // If the copy fails, still hand back a working (if versioned) path.
    return shipped;
  }
}

/** @param {any} obj */
function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

try {
  if (event === "SessionStart") {
    // Sync the renderer first — that is independent of settings.json and must
    // happen even when the config can't be parsed.
    const desired = renderCommand(resolveRenderPath());
    const { settings, parsed } = readSettings(settingsPath());
    if (parsed) {
      const existing = settings && settings.statusLine && settings.statusLine.command;
      const context = statusLineNudge(classifyStatusLine(settings, desired), desired, existing);
      if (context) {
        emit({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } });
      }
    }
  }
} catch {
  // fail open — emit nothing
}

process.exit(0);

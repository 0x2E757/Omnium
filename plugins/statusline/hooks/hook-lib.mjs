// Statusline — install-decision logic for the statusLine (pure data + accessors).
//
// hook.mjs is a zero-dependency IO shell around this module; keeping the
// decision and the nudge text here makes both unit-testable without spawning a
// process or touching a real settings.json.
//
// Claude Code plugins cannot declare a statusLine in their manifest — it lives
// only in the user's settings.json. So this plugin ships the renderer and, on
// SessionStart, NUDGES the agent to install a one-line `statusLine` command
// pointing at the renderer. It never writes settings.json itself: the agent
// does that (visibly, with the user), and is told to ASK first if a foreign
// statusLine is already configured.

/** Human-facing plugin name used in the nudge text. */
export const NAME = "Statusline";

/**
 * Seconds between timer re-renders (`statusLine.refreshInterval`). Without a
 * timer the line only re-renders on events such as a new assistant message, so
 * the footer clock freezes while the agent works. Not 1: every render spawns
 * node and re-reads the whole transcript for the token totals, and a clock that
 * steps by 5 s is fine at a glance.
 */
export const REFRESH_INTERVAL_S = 5;

/**
 * The exact `statusLine.command` string to install. Forward-slashes the path
 * (Git Bash on Windows silently fails on backslashes) and double-quotes it so a
 * path with spaces survives every shell (sh, PowerShell, cmd, Git Bash).
 * @param {string} renderPath absolute path to the renderer
 * @returns {string}
 */
export function renderCommand(renderPath) {
  return `node "${String(renderPath).replace(/\\/g, "/")}"`;
}

/**
 * Is this command one of ours (a statusline renderer), regardless of its exact
 * path? Lets a stale path (e.g. after a version bump) be refreshed silently
 * instead of being mistaken for a foreign statusLine we must ask about.
 * @param {string} command
 * @returns {boolean}
 */
function isOurs(command) {
  return command.includes("render.mjs") && command.includes("statusline");
}

/**
 * Normalize a command for tolerant equality on the "ok" path: trim surrounding
 * whitespace and forward-slash the path (mirroring what renderCommand does at
 * install time). Without this, cosmetic variants of OUR OWN command — a trailing
 * newline from a hand-edit, or backslash separators from a tool that wrote the
 * path — never match the desired string and re-nudge every single session.
 * @param {string} command
 * @returns {string}
 */
function normalizeCommand(command) {
  return command.trim().replace(/\\/g, "/");
}

/**
 * Classify the current settings against the command we want installed:
 *   "ok"      — our command (up to cosmetic normalization) is already there on a
 *               refresh timer; do nothing. Any positive interval counts, so a
 *               user-tuned one is never overwritten.
 *   "install" — nothing, a stale copy of ours, or ours without a timer is
 *               there; (re)install freely.
 *   "confirm" — a foreign statusLine exists; ask the user before replacing it.
 * @param {any} settings the parsed user settings.json (or {})
 * @param {string} desiredCommand the command renderCommand() produced
 * @returns {"ok"|"install"|"confirm"}
 */
export function classifyStatusLine(settings, desiredCommand) {
  const command = settings && settings.statusLine && settings.statusLine.command;
  if (typeof command !== "string" || command.trim() === "") return "install";
  if (normalizeCommand(command) === normalizeCommand(desiredCommand)) {
    const interval = settings.statusLine.refreshInterval;
    return typeof interval === "number" && interval >= 1 ? "ok" : "install";
  }
  if (isOurs(command)) return "install";
  return "confirm";
}

/**
 * The SessionStart additionalContext for a given state, or null when nothing is
 * needed (state "ok"). The install/confirm text carries the exact command so
 * the agent can paste it verbatim.
 * @param {"ok"|"install"|"confirm"} state
 * @param {string} desiredCommand
 * @param {string|undefined} existingCommand the statusLine currently configured
 * @returns {string|null}
 */
export function statusLineNudge(state, desiredCommand, existingCommand) {
  if (state === "ok") return null;

  // The command contains double-quotes, so the value MUST be JSON-escaped when
  // written into settings.json. Build it with JSON.stringify so the escaping is
  // correct by construction — handing the agent a hand-concatenated snippet
  // produced invalid JSON, which silently re-nudged every session.
  const value = JSON.stringify({ type: "command", command: desiredCommand, refreshInterval: REFRESH_INTERVAL_S });
  const target =
    "in the user's Claude Code settings.json (`~/.claude/settings.json`), set the " +
    "top-level `statusLine` key to this exact JSON value (already valid — the inner " +
    'quotes are escaped; paste it verbatim, do NOT un-escape the `\\"`): `' +
    value +
    "`. Write it as valid JSON — the `/update-config` skill writes JSON safely and " +
    "should be preferred over editing the file by hand. This is a one-time setup; " +
    "once set, the status line shows on every session.";

  // Fixed directive opener, shared with the sessio onboarding nudge: agents were
  // reading the old third-person "Statusline … is installed but not active" lead
  // as debug/FYI and skipping it. Naming the agent as the actor and denying the
  // status-output reading is what flips it from "info to file" to "act now".
  const opener =
    "Setup action required — this is a directive to you (the agent), not status " +
    "output: ";

  if (state === "confirm") {
    return (
      opener +
      NAME +
      " (a custom status line) is installed, but a different `statusLine` is " +
      "already configured (`" +
      String(existingCommand) +
      "`). Surface this to the user and do NOT overwrite it silently — ASK " +
      "whether they want to switch to " +
      NAME +
      "'s status line. Only if they agree, " +
      target
    );
  }

  return (
    opener +
    NAME +
    " (a custom status line) is installed but not active — no `statusLine` is " +
    "configured. First, let the user know you are activating " +
    NAME +
    "'s status line, then do it: " +
    target
  );
}

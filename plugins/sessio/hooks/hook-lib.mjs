// Sessio — the injected scratch-file routing conscience (pure data + accessors).
//
// hook.mjs is a zero-dependency IO shell around this module; keeping the primer
// and its accessors here makes both unit-testable without spawning a process.
//
// Sessio directs temporary/generated files into a per-task dated subdirectory of
// a scratch root. That root is deliberately NOT hardcoded — it is user- and
// OS-specific — so it is read from the CLAUDE_SESSIONS_DIR environment variable.
// When it is set, the primer routes files under it; when it is unset, the primer
// ONBOARDS: it tells the agent to ask the user for a base directory and persist
// CLAUDE_SESSIONS_DIR (so future sessions are configured). The hook never writes
// to disk itself — the agent creates the subdirectory on demand.

import { join } from "node:path";

/** The frozen environment knob naming the scratch root (a user/OS-specific path). */
export const ENV_VAR = "CLAUDE_SESSIONS_DIR";

/** Today's date as YYYY-MM-DD (UTC), for the per-task subdirectory name. */
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Primer when a scratch root is configured.
 * @param {string} base the resolved scratch root
 * @param {string} date today's date (YYYY-MM-DD)
 */
export function configuredContext(base, date) {
  const example = join(base, `${date}--parse-csv-data`);
  return (
    "Sessio is active: `" +
    base +
    "` is the scratch root for temporary and generated files on this machine. " +
    "When a task makes you create throwaway files (scripts, data dumps, " +
    "intermediate outputs, logs) and it does not specify where they go, do NOT " +
    "scatter them in the working directory, the user's home, the Desktop, or the " +
    "system temp dir — put them in a per-task subdirectory of the scratch root " +
    "named `" +
    date +
    "--<short-kebab-description>` (e.g. `" +
    example +
    "`), creating it as needed, and keep all of that run's artifacts inside it. " +
    "Exceptions: (1) the task specifies an output path — honor it; (2) files that " +
    "belong to a project (source, configs, tests) go in the project tree, not the " +
    "scratch root."
  );
}

/** Primer when no scratch root is configured yet — onboard the user. */
export const ONBOARD_CONTEXT =
  "Sessio is installed but not configured: the `" +
  ENV_VAR +
  "` environment variable is unset, so there is no scratch root for temporary or " +
  "generated files. Before producing throwaway files, ask the user which base " +
  "directory they want for session scratch files, then persist that path as `" +
  ENV_VAR +
  "` so it is available in future sessions — set it in Claude Code's settings " +
  "`env` (user or project `settings.json`), which applies cross-platform to the " +
  "session and its hooks (the /update-config skill can do this); an OS or shell " +
  "environment variable works too. Once it is set, generated files go under `<" +
  ENV_VAR +
  ">/<YYYY-MM-DD>--<short-description>`. Until then, avoid scattering files and " +
  "tell the user where any unavoidable ones landed.";

/**
 * The SessionStart hookSpecificOutput: route when configured, else onboard.
 * @param {string|undefined} [env] the raw env value (defaults to process.env)
 * @param {string} [date] today's date (defaults to today)
 */
export function sessionStartOutput(env = process.env[ENV_VAR], date = todayISO()) {
  const base = typeof env === "string" ? env.trim() : "";
  const additionalContext = base ? configuredContext(base, date) : ONBOARD_CONTEXT;
  return { hookEventName: "SessionStart", additionalContext };
}

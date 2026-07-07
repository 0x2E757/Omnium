// Runs a project's test command and reports the raw result. Graphyne owns the
// red/green signal by running the tests ITSELF (via the commands in graphyne.json)
// rather than parsing someone else's logs or trusting a self-report: exit code 0
// is green, anything else is red. The FULL combined output is handed back to the
// agent, so it sees the run exactly as if it had run the command directly.
//
// Every run is bounded by a timeout (test.timeoutMs in graphyne.json, or the
// generous default below): the MCP server processes requests serially, so a
// hanging test command would otherwise wedge the whole queue for the session.

import { spawnSync } from "node:child_process";

/** @typedef {{ exitCode: number, output: string, command: string, timedOut: boolean }} TestRun */

// Generous cap so a verbose suite isn't truncated mid-run; spawnSync throws
// ENOBUFS past this, which we surface as a (red) failure rather than crash.
const MAX_BUFFER = 32 * 1024 * 1024;

// Generous like MAX_BUFFER: a hung suite used to wedge forever, so any finite
// bound is a strict improvement; per-project tuning via test.timeoutMs.
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Run `command` in `root` through the shell, capturing combined stdout+stderr.
 * Never throws on a non-zero exit (that's just red); only a spawn failure
 * (command not found, buffer overflow, timeout kill) yields a non-zero code
 * with the error text. On timeout, SIGTERM goes to the direct child (the
 * shell) and Node force-closes the stdio pipes, so the call always returns
 * promptly — but grandchildren the shell spawned may keep running.
 * @param {string} root
 * @param {string} command
 * @param {{ timeoutMs?: number }} [options]
 * @returns {TestRun}
 */
export function runTest(root, command, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const res = spawnSync(command, {
    cwd: root,
    shell: true,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    timeout: timeoutMs,
    killSignal: "SIGTERM",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parts = [res.stdout ?? "", res.stderr ?? ""].filter(Boolean);
  let output = parts.join("");
  // A signal death (timeout kill, OOM killer, manual kill) has status null and
  // must read as red — `?? 0` alone would record a false GREEN in TDD state.
  let exitCode = res.status ?? (res.signal ? 1 : 0);
  const timedOut = res.error != null && /** @type {NodeJS.ErrnoException} */ (res.error).code === "ETIMEDOUT";
  if (timedOut) {
    output +=
      `\n[graphyne] test run TIMED OUT after ${timeoutMs}ms and was killed ` +
      `(processes it spawned may still be running). Raise test.timeoutMs in graphyne.json ` +
      `if the suite legitimately needs longer.`;
    // A trap handler can convert the kill into a clean exit 0 — the timeout
    // verdict must win, so a timed-out run is never green.
    exitCode = res.status ? res.status : 1;
  } else if (res.error) {
    output += `\n[graphyne] failed to run command: ${res.error.message}`;
    exitCode = res.status ?? 1;
  }
  return { exitCode, output, command, timedOut };
}

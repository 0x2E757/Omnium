// Run a user regex against task text under a time budget. Catastrophic backtracking
// (ReDoS) in V8's regex engine is synchronous and cannot be interrupted in-thread,
// so the match runs in a worker (search-worker.mjs, which must stay a sibling of
// this file for the relative URL below to resolve); if it overruns the budget we
// terminate the worker and surface a clean error instead of hanging the single-
// threaded stdio MCP server. The budget is env-tunable (MEMOSYNE_SEARCH_TIMEOUT_MS) for
// tests, which set it low and feed an adversarial pattern.

import { Worker } from "node:worker_threads";

/** @typedef {{ stem: string, summary: string, description: string }} SearchRow */
/** @typedef {{ stem: string, section: "summary" | "description", snippet: string }} SearchMatch */

/**
 * Thrown when the regex match exceeds the time budget — handlers map it to a
 * ToolError that tells the agent to simplify the pattern.
 */
export class RegexTimeout extends Error {}

export function searchTimeoutMs() {
  return Number(process.env.MEMOSYNE_SEARCH_TIMEOUT_MS) || 2000;
}

/**
 * Match `query` (case-insensitive) against each row's summary+description in a
 * worker, returning the hits (newest-first order preserved from `rows`). Rejects
 * with RegexTimeout if the match takes longer than `timeoutMs`.
 * @param {string} query
 * @param {SearchRow[]} rows
 * @param {number} timeoutMs
 * @returns {Promise<SearchMatch[]>}
 */
export function searchWithTimeout(query, rows, timeoutMs) {
  return new Promise((resolve, reject) => {
    // The plugin ships plain .mjs, so unlike the prior dev/dist dual layout
    // there is only one worker flavor to resolve: the .mjs sibling.
    const worker = new Worker(new URL("./search-worker.mjs", import.meta.url), {
      workerData: { query, rows },
    });

    let settled = false;
    /** @param {() => void} fn */
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate(); // kills the thread even mid-backtracking
      fn();
    };

    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new RegexTimeout(
              `The search pattern took longer than ${timeoutMs}ms and was aborted — it likely triggers ` +
                `catastrophic backtracking (ReDoS). Simplify the regex (avoid nested quantifiers such as ` +
                `"(a+)+") or search for a plainer substring.`,
            ),
          ),
        ),
      timeoutMs,
    );

    worker.once("message", (/** @type {{ matches?: SearchMatch[], error?: string }} */ msg) =>
      finish(() => (msg.error ? reject(new Error(msg.error)) : resolve(msg.matches ?? []))),
    );
    worker.once("error", (err) => finish(() => reject(err)));
  });
}

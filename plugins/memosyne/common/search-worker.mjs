// Worker that runs a user-supplied regex over task text on its OWN thread, so a
// catastrophic-backtracking pattern (ReDoS) can be bounded by a timeout and killed
// via Worker.terminate() WITHOUT blocking the MCP server's main event loop. The
// driver lives in search-runner.mjs (same directory — the runner resolves this
// file by a relative URL); this file is the thread body.
//
// Input (workerData): { query: string, rows: { stem, summary, description }[] }.
// Output (postMessage): { matches } on success, or { error } if the regex fails to
// compile (the main thread validates first, so this is defensive).

import { parentPort, workerData } from "node:worker_threads";

import { firstHit } from "./search.mjs";

/** @typedef {{ stem: string, summary: string, description: string }} Row */

const { query, rows } = /** @type {{ query: string, rows: Row[] }} */ (workerData);

try {
  const re = new RegExp(query, "i");
  /** @type {{ stem: string, section: "summary" | "description", snippet: string }[]} */
  const matches = [];
  for (const row of rows) {
    const hit = firstHit(re, row); // may backtrack catastrophically — that's why we're in a worker
    if (hit) matches.push({ stem: row.stem, section: hit.section, snippet: hit.snippet });
  }
  parentPort?.postMessage({ matches });
} catch (err) {
  parentPort?.postMessage({ error: /** @type {Error} */ (err).message });
}

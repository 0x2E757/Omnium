// Per-process, stat-validated cache of parsed tasks — the read path behind the
// multi-task scans (listTasks / findByFile / searchText), which otherwise re-read
// and re-parse every task.md on every call.
//
// Design (see the B5 task): there is NO cache server. The filesystem is the shared
// source of truth and (mtime, size) is the coordination signal; each process (the
// MCP server, the web App) keeps its OWN in-memory cache and revalidates against
// disk. So out-of-band changes — a git checkout/pull, a manual edit, another MCP
// instance — are picked up without a daemon or an (unreliable) file watcher.
//
// On each call we still listTaskStems (a cheap readdir+filter) and statSync each
// task.md (cheap); only files whose (mtime, size) changed are re-read and re-parsed.
// Writes self-heal: writeTask renames atomically → the file's mtime changes → the
// next sweep re-parses it, so no explicit invalidation on the write path is needed.
//
// Not a hard guarantee: an edit that preserves BOTH mtime and size slips through.
// In practice nothing does that — git rewrites bump mtime, and any real content
// edit changes size when mtime resolution is too coarse to notice.

import { statSync } from "node:fs";
import { join } from "node:path";

import { parseTask, taskFilename } from "./task.mjs";
import { storeDir, listTaskStems, readTask } from "./storage.mjs";

/** @typedef {import("./task.mjs").Task} Task */

/** @typedef {{ mtime: number, size: number, task: Task }} Entry */

// Keyed by the absolute task.md path, so entries from different project roots (and
// different processes' caches) never collide. Module-level: lives for the process.
/** @type {Map<string, Entry>} */
const cache = new Map();

/**
 * All top-level tasks for a project, newest first, parsed. Reuses the cached parse
 * for any task.md whose (mtime, size) is unchanged since it was last read; re-reads
 * and re-parses only what changed.
 * @param {string} root
 * @returns {{ stem: string, task: Task }[]}
 */
export function loadTasks(root) {
  /** @type {{ stem: string, task: Task }[]} */
  const out = [];
  for (const stem of listTaskStems(root)) {
    const path = join(storeDir(root), taskFilename(stem));
    let st;
    try {
      st = statSync(path);
    } catch {
      continue; // vanished between readdir and stat — skip it
    }
    const hit = cache.get(path);
    if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) {
      out.push({ stem, task: hit.task });
    } else {
      const task = parseTask(readTask(root, stem));
      cache.set(path, { mtime: st.mtimeMs, size: st.size, task });
      out.push({ stem, task });
    }
  }
  return out;
}

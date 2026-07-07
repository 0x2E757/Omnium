// Cross-process advisory file lock for Memosyne — serializes read-modify-write
// sequences so concurrent writers (multiple MCP servers on one repo, the App's
// registry sync, a manual edit) cannot clobber one another. Used for both the
// discovery registry (one lock for the whole file) and each task (one lock per
// top-level task, so different tasks still write in parallel).
//
// Domain shim over the vendored shared core: the mechanism, the atomic
// single-winner stale reclaim, and the env knobs (MEMOSYNE_LOCK_STALE_MS /
// MEMOSYNE_LOCK_WAIT_MS) live in ./lock-core.mjs (canonical:
// shared/lock-core.mjs) — this file only binds the Memosyne parameters so
// callers and tests keep importing ./lock.mjs.
//
// NOT re-entrant: acquiring the same lock path twice on one call stack
// deadlocks until the stale timeout. Acquire each lock exactly once, at the
// outermost (handler) boundary, and keep inner helpers lock-free.

import { createFileLock } from "./lock-core.mjs";

export const withFileLock = createFileLock({ envPrefix: "MEMOSYNE", product: "Memosyne" });

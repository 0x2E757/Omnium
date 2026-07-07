// Cross-process advisory file lock for Graphyne — serializes read-modify-write
// sequences so concurrent writers (multiple MCP servers on one repo, a hook
// touching session state, a manual edit) cannot clobber one another. Used for
// each meta file (one lock per file, so different files still write in
// parallel) and each session state file.
//
// Domain shim over the vendored shared core: the mechanism, the atomic
// single-winner stale reclaim, and the env knobs (GRAPHYNE_LOCK_STALE_MS /
// GRAPHYNE_LOCK_WAIT_MS) live in ./lock-core.mjs (canonical:
// shared/lock-core.mjs) — this file only binds the Graphyne parameters so
// callers and tests keep importing ./lock.mjs.
//
// NOT re-entrant: acquiring the SAME lock path twice on one call stack
// deadlocks until the stale timeout. Acquire each lock once; nesting two
// DIFFERENT lock paths is fine (see graph-store's two-sided link write).

import { createFileLock } from "./lock-core.mjs";

export const withFileLock = createFileLock({ envPrefix: "GRAPHYNE", product: "Graphyne" });

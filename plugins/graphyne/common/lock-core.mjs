// VENDORED SHARED MODULE — canonical copy: shared/lock-core.mjs. Do not edit any plugins/*/common/ copy; edit shared/ and run: node scripts/sync-shared.mjs
//
// Cross-process advisory file lock, parameterized per plugin (env-knob prefix +
// product name for the error text). Each plugin's common/lock.mjs is a tiny
// domain shim over createFileLock, so callers and tests keep importing
// ./lock.mjs unchanged. Extracted after the two hand-copied lock.mjs twins
// drifted on lockMs parsing; graphyne's explicit-0 semantics are canonical.
//
// Mechanism: an exclusive-create ("wx") .lock file is the token; whoever
// creates it holds the lock (it records "<pid> <iso-time>" for diagnostics). If
// the create fails transiently (Windows sharing violation — see
// TRANSIENT_OPEN_CODES) we re-poll within WAIT_MS rather than aborting. A
// stale lock — its holder crashed and never removed it — is reclaimed once its
// mtime is older than STALE_MS. WAIT_MS deliberately exceeds STALE_MS: a held
// lock either frees (the holder finishes its fast critical section) or ages
// past STALE_MS and gets reclaimed, so within WAIT_MS we essentially always
// acquire. If we still cannot, we THROW rather than fall through to an
// UNLOCKED write. Both bounds are env-tunable via <PREFIX>_LOCK_STALE_MS /
// <PREFIX>_LOCK_WAIT_MS (test knobs).
//
// Stale reclaim is ATOMIC (single-winner). The historical check-then-unlink
// had a race: two contenders could both judge a lock stale, the slower unlink
// then removing the winner's FRESH lock — two holders at once. Instead the
// reclaimer RENAMES the stale lock to a unique graveyard name (a rename of one
// directory entry succeeds for exactly one contender; losers re-poll),
// verifies by (ino, mtimeNs) that it grabbed the generation it judged stale,
// and if it accidentally grabbed a fresh lock created in between restores it
// with no-clobber linkSync (link(2) fails with EEXIST rather than overwriting,
// on POSIX and NTFS alike — rename-restore could clobber an even newer lock);
// where hard links are unsupported the restore falls back to a plain rename
// rather than destroying the holder's lock. A crash between rename and cleanup
// leaves an inert *.reclaim file that can never be mistaken for the lock.
// Known benign residual: if the mis-grabbed holder RELEASES while its lock
// sits in the graveyard, the restore resurrects a lock nobody holds — a ghost
// that contenders wait out via the stale timeout. Self-healing as long as
// STALE_MS < WAIT_MS (the shipped defaults); tuning STALE_MS >= WAIT_MS would
// turn a ghost into a spurious acquisition failure.
//
// NOT re-entrant: acquiring the SAME lock path twice on one call stack
// deadlocks until the stale timeout. Acquire each lock once; nesting two
// DIFFERENT lock paths is fine.

import { mkdirSync, openSync, closeSync, unlinkSync, statSync, renameSync, linkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

// Short enough that an uncontended retry is imperceptible, long enough not to
// hammer the filesystem while waiting.
const LOCK_POLL_MS = 25;

// The exclusive-create open that takes the lock can fail transiently on Windows
// with these sharing-violation codes (an AV scanner, the search indexer, or a
// share briefly holding the path) where POSIX would succeed — the same class
// atomic-write.mjs retries on rename. We re-poll them within the existing
// WAIT_MS budget rather than aborting the acquire. Kept as this operation's own
// set (not shared with atomic-write's rename set): coupling would over-assert
// that the two syscalls' transient policies must stay forever identical. EEXIST
// is NOT here — it means "held by someone" and routes to stale-reclaim.
const TRANSIENT_OPEN_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * @param {string} envVar
 * @param {number} dflt
 * @returns {number}
 */
function lockMs(envVar, dflt) {
  const raw = process.env[envVar];
  if (raw === undefined || raw.trim() === "") return dflt;
  const n = Number(raw);
  // Honour an explicit 0 (a falsy-but-valid value); only unset/blank/non-numeric
  // fall back to the default.
  return Number.isFinite(n) ? n : dflt;
}

/**
 * Synchronous sleep without busy-spinning (the storage APIs are sync).
 * Exported for atomic-write.mjs, which shares it for its rename backoff.
 * @param {number} ms
 */
export function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* SharedArrayBuffer unavailable — fall through (no sleep) */
  }
}

/**
 * Build a plugin's `withFileLock(lockPath, fn)`: run `fn` while holding an
 * exclusive lock at `lockPath` (parent dir created if missing), throwing —
 * without running `fn` — if the lock cannot be acquired within
 * `<envPrefix>_LOCK_WAIT_MS`. Never runs the critical section unlocked.
 * `openFn` and the `statFn`/`renameFn`/`linkFn`/`unlinkFn` group are deterministic
 * test seams: a real transient EPERM open cannot be provoked on POSIX, and the
 * stale-reclaim mis-grab RESTORE branch (a fresh lock created between our stat
 * and rename) cannot be raced open on a real filesystem. Production callers pass
 * none of them, so every path stays the bare `node:fs` sync call it was.
 * @param {{
 *   envPrefix: string,
 *   product: string,
 *   openFn?: typeof openSync,
 *   statFn?: typeof statSync,
 *   renameFn?: typeof renameSync,
 *   linkFn?: typeof linkSync,
 *   unlinkFn?: typeof unlinkSync,
 * }} opts
 */
export function createFileLock({
  envPrefix,
  product,
  openFn = openSync,
  statFn = statSync,
  renameFn = renameSync,
  linkFn = linkSync,
  unlinkFn = unlinkSync,
}) {
  /**
   * @template T
   * @param {string} lockPath
   * @param {() => T} fn
   * @returns {T}
   */
  return function withFileLock(lockPath, fn) {
    // STALE_MS must comfortably exceed the filesystem's mtime granularity. FAT
    // rounds mtimes to ~2s and some network shares are similarly coarse (exFAT is
    // finer at ~10ms), so a lock created "now" may already carry a timestamp up to
    // ~2s in the past; a STALE_MS at or below that granularity could misjudge a
    // just-created lock as stale and reclaim a live holder. The 5s default clears
    // common granularities with margin.
    //
    // Staleness is (local Date.now() - the lock's mtime), so on a NETWORK mount
    // (NFS/CIFS) it further assumes the client and the mtime-stamping server are
    // clock-synced to within STALE_MS — i.e. NTP. If the client runs > STALE_MS
    // AHEAD of the server, a fresh live lock can read as stale and be reclaimed
    // (two holders); the opposite skew is fail-safe (mtime reads as future, the
    // lock is never judged stale, and the acquire THROWS rather than run
    // unlocked). Any unsynchronised network-mounted lock dir is outside the
    // guaranteed envelope — even from a single host, since the skew is between
    // this client and the file server, not between peers; keep the lock dir
    // host-local or NTP the client and server.
    const staleMs = lockMs(`${envPrefix}_LOCK_STALE_MS`, 5000);
    const waitMs = lockMs(`${envPrefix}_LOCK_WAIT_MS`, 7000);
    mkdirSync(dirname(lockPath), { recursive: true });

    /** @type {number | undefined} */
    let fd;
    // The last transient-open error seen, surfaced as the `cause` of the
    // acquire-failure throw so a genuine (non-transient-in-practice) EPERM/EACCES
    // — e.g. a read-only lock directory — is not masked as a plain timeout.
    /** @type {unknown} */
    let lastTransientErr;
    for (let waited = 0; waited < waitMs; waited += LOCK_POLL_MS) {
      try {
        fd = openFn(lockPath, "wx");
        break;
      } catch (err) {
        const code = /** @type {NodeJS.ErrnoException} */ (err).code;
        if (code !== "EEXIST") {
          // A transient Windows sharing violation: re-poll within the WAIT_MS
          // budget (the loop body has no sleep of its own on this path, so sleep
          // here or a persistent code would hot-spin the whole budget away in
          // microseconds). Any other errno is a real failure — throw at once.
          if (!TRANSIENT_OPEN_CODES.has(code ?? "")) throw err;
          lastTransientErr = err;
          sleepSync(LOCK_POLL_MS);
          continue;
        }
      }

      // Held by someone. Fresh -> wait a poll; stale -> atomic reclaim.
      /** @type {import("node:fs").BigIntStats} */
      let st;
      try {
        st = statFn(lockPath, { bigint: true });
      } catch {
        continue; // vanished between open and stat — retry the open right away
      }
      if (Date.now() - Number(st.mtimeMs) <= staleMs) {
        sleepSync(LOCK_POLL_MS);
        continue;
      }

      const grave = `${lockPath}.${process.pid}.${randomBytes(4).toString("hex")}.reclaim`;
      try {
        renameFn(lockPath, grave);
      } catch {
        sleepSync(LOCK_POLL_MS); // lost the reclaim race to another contender
        continue;
      }
      try {
        const gst = statFn(grave, { bigint: true });
        if (gst.ino === st.ino && gst.mtimeNs === st.mtimeNs) {
          unlinkFn(grave); // confirmed: removed exactly the generation judged stale
        } else {
          // Grabbed a FRESH lock created between our stat and rename — restore
          // it without clobbering any even-newer lock.
          try {
            linkFn(grave, lockPath);
            unlinkFn(grave);
          } catch (linkErr) {
            if (/** @type {NodeJS.ErrnoException} */ (linkErr).code === "EEXIST") {
              unlinkFn(grave); // a newer lock already exists; nothing to restore onto
            } else {
              // Hard links unsupported here (exFAT/some network mounts):
              // best-effort rename-restore beats destroying the holder's lock.
              try {
                renameFn(grave, lockPath);
              } catch {
                /* truly stuck — leave the inert grave rather than clobber */
              }
            }
          }
        }
      } catch {
        /* best-effort cleanup; the loop continues */
      }
      // No sleep here: after a reclaim attempt, retry the exclusive open at once.
    }

    if (fd === undefined) {
      throw new Error(
        `Could not acquire the lock at ${lockPath} within ${waitMs}ms. Refusing to run unlocked ` +
          `(it could clobber a concurrent update). If no other ${product} process is running, delete the ` +
          `stale lock file and retry.`,
        lastTransientErr === undefined ? undefined : { cause: lastTransientErr },
      );
    }

    try {
      writeSync(fd, `${process.pid} ${new Date().toISOString()}`);
    } catch {
      /* holder info is diagnostics only */
    }
    try {
      return fn();
    } finally {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
      try {
        // Release is the holder removing its OWN lock, not the stale-reclaim
        // race, so it stays the real unlinkSync — the unlinkFn seam covers only
        // the reclaim/restore region above.
        unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
    }
  };
}

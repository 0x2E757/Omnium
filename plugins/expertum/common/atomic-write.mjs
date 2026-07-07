// VENDORED SHARED MODULE — canonical copy: shared/atomic-write.mjs. Do not edit any plugins/*/common/ copy; edit shared/ and run: node scripts/sync-shared.mjs
//
// Atomic file write: serialize to a sibling temp file, then rename over the
// target. rename is atomic on the same filesystem, so a concurrent reader
// never observes a half-written file and a crash mid-write cannot corrupt an
// existing one; the temp lives next to the target so the rename stays
// intra-filesystem. On Windows an AV scanner or the search indexer can hold
// the rename target open for a few tens of milliseconds, failing the replace
// with a transient EPERM/EACCES/EBUSY where POSIX would succeed — those codes
// are retried on a short doubling backoff. The 300 ms worst case is deliberate:
// every production caller writes inside a held withFileLock, whose staleness
// threshold defaults to 5000 ms (lock-core), so a stall anywhere near that
// would let a contender reclaim the holder's live lock mid-write. Any other
// errno — and the last error once retries are exhausted — is rethrown
// unchanged after best-effort temp cleanup.

import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { sleepSync } from "./lock-core.mjs";

const RETRY_DELAYS_MS = [20, 40, 80, 160];
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * @param {string} from
 * @param {string} to
 * @param {typeof renameSync} renameFn
 */
function renameWithRetry(from, to, renameFn) {
  for (let attempt = 0; ; attempt++) {
    try {
      renameFn(from, to);
      return;
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (attempt >= RETRY_DELAYS_MS.length || !TRANSIENT_RENAME_CODES.has(code ?? "")) throw err;
      sleepSync(RETRY_DELAYS_MS[attempt]);
    }
  }
}

/**
 * Write `data` to `filePath` atomically (see the header). `renameFn` is
 * injectable ONLY as the deterministic test seam for the retry path — a real
 * transient EPERM rename cannot be provoked on POSIX; production callers
 * never pass it.
 * @param {string} filePath
 * @param {string} data
 * @param {typeof renameSync} [renameFn]
 */
export function atomicWrite(filePath, data, renameFn = renameSync) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, data);
    renameWithRetry(tmp, filePath, renameFn);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean */
    }
    throw err;
  }
}

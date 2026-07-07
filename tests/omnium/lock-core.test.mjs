// lock-core.test.mjs — pins the transient-open-failure contract of
// shared/lock-core.mjs (cross-platform audit Low #6, sub-item #2). The
// exclusive-create ("wx") open that takes the lock can fail transiently on
// Windows with EPERM/EACCES/EBUSY (an AV scanner, the search indexer, or a
// share briefly blocking the create) where POSIX would succeed — the same
// class of sharing-violation atomic-write.mjs already retries on rename.
// lock-core must re-poll those codes within its existing WAIT_MS budget rather
// than aborting the acquire, while EEXIST stays the "held -> stale-reclaim"
// signal and every other errno still throws on the first attempt.
//
// openFn is the deterministic test seam (createFileLock({ …, openFn })): a real
// transient EPERM open cannot be provoked on Linux (and not at all as root).
// Production builds never pass it, so the POSIX happy path stays a bare
// openSync(lockPath, "wx").

import assert from 'node:assert/strict';
import {
  mkdtempSync,
  openSync,
  closeSync,
  existsSync,
  readdirSync,
  renameSync,
  linkSync,
  unlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createFileLock } from '../../shared/lock-core.mjs';

/** @param {(dir: string, lockPath: string) => void} fn */
function inTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'omnium-lockcore-'));
  try {
    fn(dir, join(dir, 'a.lock'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run `fn` with the given env overrides, restoring them after. */
function withEnv(/** @type {Record<string,string|undefined>} */ vars, /** @type {() => void} */ fn) {
  const saved = /** @type {Record<string,string|undefined>} */ ({});
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/**
 * A fake openSync that throws `code` for its first `failures` calls, then
 * delegates to the real openSync so the lock gets a genuine fd to write/close.
 * @param {string} code @param {number} failures
 */
function flakyOpen(code, failures) {
  let calls = 0;
  const err = Object.assign(new Error(`${code}: transient open failure`), { code });
  /** @param {import('node:fs').PathLike} path @param {import('node:fs').OpenMode} flags */
  const fn = (path, flags) => {
    calls++;
    if (calls <= failures) throw err;
    return openSync(path, flags);
  };
  return { fn, err, count: () => calls };
}

const TEST_PREFIX = 'OMNIUM_LOCKCORE_TEST';
/** @param {typeof openSync} openFn */
const makeLock = (openFn) =>
  createFileLock({ envPrefix: TEST_PREFIX, product: 'lockcore-test', openFn });

test('a transient EPERM at the exclusive open is re-polled and the lock is acquired', () => {
  inTempDir((dir, lockPath) => {
    const flaky = flakyOpen('EPERM', 2);
    let ran = false;
    withEnv({ [`${TEST_PREFIX}_LOCK_WAIT_MS`]: '5000', [`${TEST_PREFIX}_LOCK_STALE_MS`]: '1000' }, () => {
      const out = makeLock(flaky.fn)(lockPath, () => {
        ran = true;
        return 'ok';
      });
      assert.equal(out, 'ok');
    });
    assert.equal(ran, true, 'the critical section ran after the transient failures cleared');
    assert.equal(flaky.count(), 3, 'two failures then a successful open');
    assert.equal(existsSync(lockPath), false, 'the lock is released');
    assert.deepEqual(readdirSync(dir), [], 'no lock or reclaim orphan left behind');
  });
});

test('a persistent transient code exhausts WAIT_MS and throws, surfacing the errno as cause', () => {
  inTempDir((dir, lockPath) => {
    const flaky = flakyOpen('EACCES', Infinity);
    let ran = false;
    /** @type {any} */
    let caught;
    withEnv({ [`${TEST_PREFIX}_LOCK_WAIT_MS`]: '100', [`${TEST_PREFIX}_LOCK_STALE_MS`]: '1000' }, () => {
      try {
        makeLock(flaky.fn)(lockPath, () => {
          ran = true;
        });
      } catch (err) {
        caught = err;
      }
    });
    assert.equal(ran, false, 'the critical section must not run unlocked');
    assert.match(caught?.message ?? '', /Could not acquire the lock/);
    assert.equal(caught?.cause, flaky.err, 'the last transient errno is attached as cause, not masked');
    assert.ok(flaky.count() > 1, 'the open was retried, not aborted on the first attempt');
    assert.deepEqual(readdirSync(dir), [], 'no lock or reclaim orphan left behind');
  });
});

test('a non-transient errno at the open throws immediately with no retry', () => {
  inTempDir((dir, lockPath) => {
    const flaky = flakyOpen('ENOENT', Infinity);
    let caught;
    withEnv({ [`${TEST_PREFIX}_LOCK_WAIT_MS`]: '5000', [`${TEST_PREFIX}_LOCK_STALE_MS`]: '1000' }, () => {
      try {
        makeLock(flaky.fn)(lockPath, () => {});
      } catch (err) {
        caught = err;
      }
    });
    assert.equal(caught, flaky.err, 'the raw errno propagates unchanged');
    assert.equal(flaky.count(), 1, 'thrown on the first attempt, never re-polled');
  });
});

// --- Stale-reclaim mis-grab RESTORE branch (cross-platform audit residual R1) ---
//
// When a reclaimer renames away a lock it judged stale but the (ino, mtimeNs)
// re-check shows it actually grabbed a FRESH lock created between its stat and
// rename, it must RESTORE that lock rather than destroy it — else two holders
// exist at once (a data-integrity defect). That branch cannot be provoked on a
// real filesystem (the stat/rename race almost never opens), so statFn/linkFn/
// renameFn/unlinkFn are deterministic test seams, defaulted to the real fs so
// production and every happy-path test stay byte-identical. Each fake stat
// returns only the fields the reclaimer reads (ino, mtimeNs, mtimeMs).

/**
 * A BigIntStats-shaped stub carrying only the fields the reclaimer reads
 * (ino, mtimeNs, mtimeMs). Returned as `any` so it satisfies the statFn seam
 * without reconstructing the full Stats surface.
 * @param {bigint} ino @param {bigint} mtimeNs @param {bigint} mtimeMs
 * @returns {any}
 */
const bigStat = (ino, mtimeNs, mtimeMs) => ({ ino, mtimeNs, mtimeMs });

/**
 * A statFn that reports the lock stale on the 1st call (→ reclaim), a MISMATCHED
 * generation for the grave on the 2nd (→ restore branch), then a fresh lock
 * thereafter so the loop stops reclaiming and simply exhausts WAIT_MS.
 * @returns {any} a statSync-shaped seam
 */
function misgrabStatFn() {
  let calls = 0;
  return () => {
    calls++;
    if (calls === 1) return bigStat(11n, 11n, 0n); // lockPath: stale
    if (calls === 2) return bigStat(22n, 22n, 0n); // grave: different generation
    return bigStat(33n, 33n, BigInt(Date.now())); // lockPath: now fresh
  };
}

test('the reclaim restore branch re-links a fresh lock grabbed mid-reclaim, never destroying it', () => {
  inTempDir((dir, lockPath) => {
    closeSync(openSync(lockPath, 'w')); // exists → exclusive open sees EEXIST → reclaim path
    let linkCalls = 0;
    const linkFn = (/** @type {any} */ a, /** @type {any} */ b) => {
      linkCalls++;
      return linkSync(a, b);
    };
    /** @type {any} */
    let caught;
    let ran = false;
    withEnv({ [`${TEST_PREFIX}_LOCK_WAIT_MS`]: '120', [`${TEST_PREFIX}_LOCK_STALE_MS`]: '1000' }, () => {
      try {
        createFileLock({ envPrefix: TEST_PREFIX, product: 'lockcore-test', statFn: misgrabStatFn(), linkFn })(
          lockPath,
          () => {
            ran = true;
          },
        );
      } catch (err) {
        caught = err;
      }
    });
    assert.equal(ran, false, 'the critical section never ran unlocked while the lock was restored');
    assert.ok(linkCalls >= 1, 'the restore used no-clobber linkSync, not a destructive overwrite');
    assert.equal(existsSync(lockPath), true, 'the mis-grabbed fresh lock was restored, not left destroyed');
    assert.ok(!readdirSync(dir).some((f) => f.endsWith('.reclaim')), 'no reclaim graveyard orphan left behind');
    assert.match(caught?.message ?? '', /Could not acquire the lock/);
  });
});

test('when hard links are unsupported the restore falls back to rename, not destruction', () => {
  inTempDir((dir, lockPath) => {
    closeSync(openSync(lockPath, 'w'));
    const linkFn = () => {
      throw Object.assign(new Error('ENOTSUP: hard links unsupported'), { code: 'ENOTSUP' });
    };
    let renameCalls = 0;
    const renameFn = (/** @type {any} */ a, /** @type {any} */ b) => {
      renameCalls++;
      return renameSync(a, b);
    };
    /** @type {any} */
    let caught;
    let ran = false;
    withEnv({ [`${TEST_PREFIX}_LOCK_WAIT_MS`]: '120', [`${TEST_PREFIX}_LOCK_STALE_MS`]: '1000' }, () => {
      try {
        createFileLock({
          envPrefix: TEST_PREFIX,
          product: 'lockcore-test',
          statFn: misgrabStatFn(),
          linkFn,
          renameFn,
        })(lockPath, () => {
          ran = true;
        });
      } catch (err) {
        caught = err;
      }
    });
    assert.equal(ran, false, 'the critical section never ran unlocked while the lock was rename-restored');
    assert.ok(renameCalls >= 2, 'lock->grave then the grave->lock rename-restore both ran');
    assert.equal(existsSync(lockPath), true, 'rename-restore put the lock back');
    assert.ok(!readdirSync(dir).some((f) => f.endsWith('.reclaim')), 'no reclaim orphan left behind');
    assert.match(caught?.message ?? '', /Could not acquire the lock/);
  });
});

test('when a newer lock already holds the path the mis-grab is dropped (EEXIST), not restored over', () => {
  inTempDir((dir, lockPath) => {
    closeSync(openSync(lockPath, 'w'));
    const linkFn = () => {
      throw Object.assign(new Error('EEXIST: a newer lock already exists'), { code: 'EEXIST' });
    };
    let unlinkedGrave = false;
    const unlinkFn = (/** @type {any} */ p) => {
      if (String(p).endsWith('.reclaim')) unlinkedGrave = true;
      return unlinkSync(p);
    };
    withEnv({ [`${TEST_PREFIX}_LOCK_WAIT_MS`]: '120', [`${TEST_PREFIX}_LOCK_STALE_MS`]: '1000' }, () => {
      try {
        createFileLock({
          envPrefix: TEST_PREFIX,
          product: 'lockcore-test',
          statFn: misgrabStatFn(),
          linkFn,
          unlinkFn,
        })(lockPath, () => {});
      } catch {
        /* may or may not acquire afterwards; the branch under test is the EEXIST drop */
      }
    });
    assert.equal(unlinkedGrave, true, 'the mis-grabbed grave was unlinked when a newer lock already holds the path');
    assert.ok(!readdirSync(dir).some((f) => f.endsWith('.reclaim')), 'no reclaim orphan left behind');
  });
});

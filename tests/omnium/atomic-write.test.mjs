// atomic-write.test.mjs — pins the contract of shared/atomic-write.mjs
// (cross-platform audit Medium #3): an atomic write is a sibling-temp-file
// write followed by a rename over the target, and a rename that fails with a
// transient Windows sharing-violation code (EPERM/EACCES/EBUSY — an AV or
// indexer briefly holding the target) is retried on a short bounded backoff.
// The retry budget must stay far below lock-core's stale threshold: every
// production caller writes inside a held file lock, and a long stall would
// age the holder's own lock into stale reclaim. The injectable renameFn is
// the deterministic test seam — a real EPERM rename cannot be provoked on
// Linux (and not at all as root). The POSIX happy path must stay a bare
// write + rename: any non-listed errno propagates on the first attempt.

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import * as lockCore from '../../shared/lock-core.mjs';
import * as atomic from '../../shared/atomic-write.mjs';

/** @param {(dir: string, target: string) => void} fn */
function inTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'omnium-atomic-'));
  try {
    fn(dir, join(dir, 'target.txt'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** @param {string} code @param {number} failures */
function flakyRename(code, failures) {
  let calls = 0;
  const err = Object.assign(new Error(`${code}: transient rename failure`), { code });
  /** @param {import('node:fs').PathLike} from @param {import('node:fs').PathLike} to */
  const fn = (from, to) => {
    calls++;
    if (calls <= failures) throw err;
    renameSync(from, to);
  };
  return { fn, err, count: () => calls };
}

test('atomicWrite writes and replaces content, leaving no temp sibling', () => {
  inTempDir((dir, target) => {
    atomic.atomicWrite(target, 'first');
    assert.equal(readFileSync(target, 'utf8'), 'first');
    atomic.atomicWrite(target, 'second');
    assert.equal(readFileSync(target, 'utf8'), 'second');
    assert.deepEqual(readdirSync(dir), ['target.txt']);
  });
});

test('atomicWrite retries a transient EPERM rename and lands the content', () => {
  inTempDir((dir, target) => {
    const flaky = flakyRename('EPERM', 2);
    atomic.atomicWrite(target, 'payload', flaky.fn);
    assert.equal(flaky.count(), 3);
    assert.equal(readFileSync(target, 'utf8'), 'payload');
    assert.deepEqual(readdirSync(dir), ['target.txt']);
  });
});

test('exhausted retries rethrow the same error object and clean the temp file', () => {
  inTempDir((dir, target) => {
    const flaky = flakyRename('EACCES', Infinity);
    let caught;
    try {
      atomic.atomicWrite(target, 'payload', flaky.fn);
    } catch (err) {
      caught = err;
    }
    assert.equal(caught, flaky.err);
    assert.equal(flaky.count(), 5);
    assert.deepEqual(readdirSync(dir), []);
  });
});

test('a non-transient errno propagates on the first attempt, no retry', () => {
  inTempDir((dir, target) => {
    const flaky = flakyRename('ENOENT', Infinity);
    assert.throws(() => atomic.atomicWrite(target, 'payload', flaky.fn), flaky.err);
    assert.equal(flaky.count(), 1);
    assert.deepEqual(readdirSync(dir), []);
  });
});

test('lock-core exports sleepSync for the retry backoff to reuse', () => {
  assert.equal(typeof lockCore.sleepSync, 'function');
  lockCore.sleepSync(1);
});

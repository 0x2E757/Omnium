// Tests for the cross-process file lock (plugins/memosyne/common/lock.mjs) and the per-task
// lock + atomic write that build on it (plugins/memosyne/common/storage.mjs). The lock's
// timing bounds are env-tunable (MEMOSYNE_LOCK_WAIT_MS / MEMOSYNE_LOCK_STALE_MS); we set
// them per test for speed and restore them afterwards.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync, utimesSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withFileLock } from "../../plugins/memosyne/common/lock.mjs";
import { storeDir, writeTask, withTaskLock, listTaskStems } from "../../plugins/memosyne/common/storage.mjs";
import { serializeTask, buildStem, taskFilename, type Task } from "../../plugins/memosyne/common/task.mjs";

function withTempRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "memosyne-lock-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function withEnv(vars: Record<string, string>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

const mkTask = (summary: string): string =>
  serializeTask({ summary, status: "Backlog", related: [], files: [], description: "" } as Task);

test("withFileLock runs fn and releases the lock file afterwards", () => {
  withTempRoot((root) => {
    const lockPath = join(root, "x.lock");
    const out = withFileLock(lockPath, () => {
      assert.ok(existsSync(lockPath), "lock is held during fn");
      return 42;
    });
    assert.equal(out, 42);
    assert.ok(!existsSync(lockPath), "lock is released after fn");
  });
});

test("withFileLock honours a literal '0' env value (no falsy fallback to default)", () => {
  withTempRoot((root) => {
    const lockPath = join(root, "zero.lock"); // free path, no contention
    let ran = false;
    // A zero wait budget means "make no attempt": even a free lock cannot be
    // taken. Pins that "0" parses as 0 — the old `Number(env) || dflt` parser
    // silently replaced it with the default (a drift from graphyne's copy).
    withEnv({ MEMOSYNE_LOCK_WAIT_MS: "0" }, () => {
      assert.throws(
        () =>
          withFileLock(lockPath, () => {
            ran = true;
          }),
        /Could not acquire the lock/,
      );
    });
    assert.equal(ran, false);
    assert.equal(existsSync(lockPath), false);
  });
});

test("withFileLock falls back to defaults for blank/garbage env", () => {
  withTempRoot((root) => {
    const lockPath = join(root, "dflt.lock");
    let ran = false;
    withEnv({ MEMOSYNE_LOCK_WAIT_MS: "  ", MEMOSYNE_LOCK_STALE_MS: "nope" }, () => {
      withFileLock(lockPath, () => {
        ran = true;
      });
    });
    assert.equal(ran, true);
    assert.equal(existsSync(lockPath), false);
  });
});

test("a stale reclaim leaves no graveyard orphans behind", () => {
  withTempRoot((root) => {
    const lockPath = join(root, "stale.lock");
    writeFileSync(lockPath, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);
    withEnv({ MEMOSYNE_LOCK_STALE_MS: "1000", MEMOSYNE_LOCK_WAIT_MS: "7000" }, () => {
      withFileLock(lockPath, () => {});
    });
    assert.equal(existsSync(lockPath), false);
    assert.deepEqual(readdirSync(root).filter((n) => n.endsWith(".reclaim")), []);
  });
});

test("withFileLock throws (does NOT run fn) when a fresh lock is held", () => {
  withTempRoot((root) => {
    const lockPath = join(root, "held.lock");
    writeFileSync(lockPath, ""); // a holder exists; mtime is now (not stale)
    withEnv({ MEMOSYNE_LOCK_WAIT_MS: "100", MEMOSYNE_LOCK_STALE_MS: "999999" }, () => {
      let ran = false;
      assert.throws(
        () =>
          withFileLock(lockPath, () => {
            ran = true;
          }),
        /Could not acquire the lock/,
      );
      assert.equal(ran, false, "the critical section must not run unlocked");
    });
  });
});

test("withFileLock reclaims a stale lock and proceeds", () => {
  withTempRoot((root) => {
    const lockPath = join(root, "stale.lock");
    writeFileSync(lockPath, "");
    const old = new Date(Date.now() - 10_000); // 10s ago
    utimesSync(lockPath, old, old);
    withEnv({ MEMOSYNE_LOCK_WAIT_MS: "2000", MEMOSYNE_LOCK_STALE_MS: "1000" }, () => {
      const out = withFileLock(lockPath, () => "ok");
      assert.equal(out, "ok");
    });
    assert.ok(!existsSync(lockPath), "the reclaimed lock is released");
  });
});

test("withTaskLock locks the <stem>.lock sibling of the task file", () => {
  withTempRoot((root) => {
    const stem = buildStem(new Date(2026, 5, 4, 15, 8), "demo");
    const expected = join(storeDir(root), `${stem}.lock`);
    withTaskLock(root, stem, () => {
      assert.ok(existsSync(expected), "per-task lock is held during the critical section");
    });
    assert.ok(!existsSync(expected), "per-task lock is released");
  });
});

test("a leftover <stem>.lock sibling is not mistaken for a task", () => {
  withTempRoot((root) => {
    const stem = buildStem(new Date(2026, 5, 4, 15, 8), "demo");
    writeTask(root, stem, mkTask("real task"));
    // Simulate a stray lock file next to the task file.
    writeFileSync(join(storeDir(root), `${stem}.lock`), "");
    const stems = listTaskStems(root);
    assert.deepEqual(stems, [stem], "the .lock sibling is filtered out of the task listing");
  });
});

test("writeTask is atomic: full content, no leftover .tmp file", () => {
  withTempRoot((root) => {
    const stem = buildStem(new Date(2026, 5, 4, 15, 8), "demo");
    writeTask(root, stem, mkTask("hello"));
    const dir = storeDir(root);
    const leftovers = readdirSync(dir).filter((n) => n.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "no temp file is left behind");
    assert.ok(statSync(join(dir, taskFilename(stem))).isFile());
  });
});

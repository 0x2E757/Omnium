import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, openSync, closeSync, utimesSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { withTempRoot } from "../helpers.mts";
import { withFileLock } from "../../../plugins/graphyne/common/lock.mjs";

const LOCK_MJS = fileURLToPath(new URL("../../../plugins/graphyne/common/lock.mjs", import.meta.url));

// Run `fn` with the given GRAPHYNE_LOCK_* env overrides, restoring them after.
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
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

test("withFileLock runs fn, returns its value, and removes the lock", () => {
  withTempRoot((root) => {
    const lockPath = join(root, "a.lock");
    let ranWhileLocked = false;
    const out = withFileLock(lockPath, () => {
      ranWhileLocked = existsSync(lockPath); // token present during critical section
      return 42;
    });
    assert.equal(out, 42);
    assert.equal(ranWhileLocked, true);
    assert.equal(existsSync(lockPath), false); // released in finally
  });
});

test("withFileLock creates the lock's parent directory if missing", () => {
  withTempRoot((root) => {
    const lockPath = join(root, "nested", "deep", "a.lock");
    const out = withFileLock(lockPath, () => "ok");
    assert.equal(out, "ok");
    assert.equal(existsSync(lockPath), false);
  });
});

test("withFileLock releases the lock even if fn throws", () => {
  withTempRoot((root) => {
    const lockPath = join(root, "a.lock");
    assert.throws(() =>
      withFileLock(lockPath, () => {
        throw new Error("boom");
      }),
    );
    assert.equal(existsSync(lockPath), false);
  });
});

test("withFileLock reclaims a stale lock (mtime older than STALE_MS)", () => {
  withTempRoot((root) => {
    const lockPath = join(root, "a.lock");
    // Pre-create a held lock and age its mtime well past STALE_MS so it is
    // reclaimed on the first poll (no real wait).
    closeSync(openSync(lockPath, "wx"));
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);
    let ran = false;
    withEnv({ GRAPHYNE_LOCK_STALE_MS: "1000", GRAPHYNE_LOCK_WAIT_MS: "7000" }, () => {
      withFileLock(lockPath, () => {
        ran = true;
      });
    });
    assert.equal(ran, true);
    assert.equal(existsSync(lockPath), false);
    // The atomic reclaim renames the stale lock to a unique graveyard name and
    // must clean it up — no *.reclaim orphans may remain.
    assert.deepEqual(readdirSync(root).filter((n) => n.endsWith(".reclaim")), []);
  });
});

test("the lock file records its holder's pid for diagnostics", () => {
  withTempRoot((root) => {
    const lockPath = join(root, "a.lock");
    withFileLock(lockPath, () => {
      assert.match(readFileSync(lockPath, "utf8"), new RegExp(`^${process.pid} `));
    });
  });
});

test("concurrent stale-lock reclaim admits exactly one holder at a time", async () => {
  // The old check-then-unlink reclaim let two contenders both judge a lock stale
  // and both take it. Spawn several children racing over ONE pre-aged stale lock;
  // each appends "S <pid>" / "E <pid>" around its critical section. Any overlap
  // (a second S before the previous E) means two simultaneous holders. STALE_MS
  // far exceeds the hold time so a LIVE lock is never misjudged stale — only the
  // seeded stale one is ever reclaimed. 3 rounds x 6 children is a deliberate
  // CI-time trade: as a must-never-fail guard on the FIXED code it is hermetic;
  // it only lowers the odds of catching a reintroduced race in a single run.
  await withTempRootAsync(async (dir) => {
    const child = join(dir, "child.mjs");
    writeFileSync(
      child,
      `import { withFileLock } from ${JSON.stringify(pathToFileURL(LOCK_MJS).href)};\n` +
        `import { appendFileSync } from "node:fs";\n` +
        `const [lock, log] = process.argv.slice(2);\n` +
        `withFileLock(lock, () => {\n` +
        `  appendFileSync(log, "S " + process.pid + "\\n");\n` +
        `  const end = Date.now() + 30;\n` +
        `  while (Date.now() < end) {}\n` +
        `  appendFileSync(log, "E " + process.pid + "\\n");\n` +
        `});\n`,
    );
    for (let round = 0; round < 3; round++) {
      const lock = join(dir, `race-${round}.lock`);
      const log = join(dir, `race-${round}.log`);
      writeFileSync(lock, "stale");
      const old = new Date(Date.now() - 60_000);
      utimesSync(lock, old, old);
      const kids = Array.from({ length: 6 }, () =>
        new Promise<number>((resolve) => {
          const p = spawn(process.execPath, [child, lock, log], {
            env: { ...process.env, GRAPHYNE_LOCK_STALE_MS: "2000", GRAPHYNE_LOCK_WAIT_MS: "10000" },
            stdio: "ignore",
          });
          p.on("exit", (code) => resolve(code ?? 1));
        }),
      );
      const codes = await Promise.all(kids);
      assert.deepEqual(codes, [0, 0, 0, 0, 0, 0], `round ${round}: every child must acquire`);
      let inside = 0;
      for (const line of readFileSync(log, "utf8").trim().split("\n")) {
        if (line.startsWith("S ")) {
          inside++;
          assert.ok(inside <= 1, `round ${round}: two simultaneous holders:\n${readFileSync(log, "utf8")}`);
        } else if (line.startsWith("E ")) inside--;
      }
    }
  });
});

async function withTempRootAsync(fn: (root: string) => Promise<void>): Promise<void> {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const root = mkdtempSync(join(tmpdir(), "graphyne-lockrace-"));
  try {
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("withFileLock throws (does not run fn) when a fresh lock cannot be acquired", () => {
  withTempRoot((root) => {
    const lockPath = join(root, "a.lock");
    // A fresh, non-stale lock held by someone else.
    closeSync(openSync(lockPath, "wx"));
    let ran = false;
    withEnv({ GRAPHYNE_LOCK_STALE_MS: "60000", GRAPHYNE_LOCK_WAIT_MS: "1" }, () => {
      assert.throws(
        () =>
          withFileLock(lockPath, () => {
            ran = true;
          }),
        /Could not acquire the lock/,
      );
    });
    assert.equal(ran, false);
    assert.equal(existsSync(lockPath), true); // the pre-existing lock is left untouched
  });
});

test("withFileLock nests two different lock paths", () => {
  withTempRoot((root) => {
    const outer = join(root, "outer.lock");
    const inner = join(root, "inner.lock");
    const out = withFileLock(outer, () =>
      withFileLock(inner, () => {
        assert.equal(existsSync(outer), true);
        assert.equal(existsSync(inner), true);
        return "nested";
      }),
    );
    assert.equal(out, "nested");
    assert.equal(existsSync(outer), false);
    assert.equal(existsSync(inner), false);
  });
});

test("withFileLock honours a literal '0' env value (no falsy fallback to default)", () => {
  withTempRoot((root) => {
    const lockPath = join(root, "a.lock"); // free path, no contention
    let ran = false;
    // A zero wait budget means "make no attempt": the acquire loop never runs, so
    // even a free lock cannot be taken and we throw immediately. This pins down
    // that "0" is parsed as 0, not silently replaced by the default wait.
    withEnv({ GRAPHYNE_LOCK_WAIT_MS: "0" }, () => {
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

test("withFileLock falls back to defaults for unset/blank/garbage env", () => {
  withTempRoot((root) => {
    const lockPath = join(root, "a.lock");
    let ran = false;
    // Blank and non-numeric values are NOT 0 — they must use the defaults, so a
    // free lock is acquired normally.
    withEnv({ GRAPHYNE_LOCK_WAIT_MS: "  ", GRAPHYNE_LOCK_STALE_MS: "nope" }, () => {
      withFileLock(lockPath, () => {
        ran = true;
      });
    });
    assert.equal(ran, true);
    assert.equal(existsSync(lockPath), false);
  });
});
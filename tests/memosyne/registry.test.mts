import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, utimesSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { upsertProject, getProject, hasPath, listProjects, removePath } from "../../plugins/memosyne/common/registry.mjs";

/** Run with the lock timeouts overridden (env), restoring them after. */
function withLockEnv(waitMs: string, staleMs: string, fn: () => void): void {
  const pw = process.env.MEMOSYNE_LOCK_WAIT_MS;
  const ps = process.env.MEMOSYNE_LOCK_STALE_MS;
  process.env.MEMOSYNE_LOCK_WAIT_MS = waitMs;
  process.env.MEMOSYNE_LOCK_STALE_MS = staleMs;
  try {
    fn();
  } finally {
    if (pw === undefined) delete process.env.MEMOSYNE_LOCK_WAIT_MS;
    else process.env.MEMOSYNE_LOCK_WAIT_MS = pw;
    if (ps === undefined) delete process.env.MEMOSYNE_LOCK_STALE_MS;
    else process.env.MEMOSYNE_LOCK_STALE_MS = ps;
  }
}

// Isolate the store by pointing MEMOSYNE_ROOT at a temp install root;
// the registry then resolves to <root>/data/registry.json. The data/ dir is
// pre-created so tests that writeFileSync the registry directly (before any
// upsert mkdir's it) work. The resolved file path is handed to the callback.
function withTempRegistry(fn: (file: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "memosyne-reg-"));
  const prev = process.env.MEMOSYNE_ROOT;
  process.env.MEMOSYNE_ROOT = root;
  const file = join(root, "data", "registry.json");
  mkdirSync(dirname(file), { recursive: true });
  try {
    fn(file);
  } finally {
    if (prev === undefined) delete process.env.MEMOSYNE_ROOT;
    else process.env.MEMOSYNE_ROOT = prev;
    rmSync(root, { recursive: true, force: true });
  }
}

const ID_RE = /^[0-9a-z]{8}$/;

test("upsertProject assigns a unique base62 id, stable across refreshes", () => {
  withTempRegistry(() => {
    const a = upsertProject({ path: "/proj/a" });
    assert.match(a.id!, ID_RE);

    // A refresh of the same path keeps the same id.
    const a2 = upsertProject({ path: "/proj/a", name: "Renamed", kind: "git", branch: "main" });
    assert.equal(a2.id, a.id);
    assert.equal(getProject("/proj/a")!.id, a.id);

    // A different path gets a different id.
    const b = upsertProject({ path: "/proj/b" });
    assert.match(b.id!, ID_RE);
    assert.notEqual(b.id, a.id);

    // ids survive the write/read round-trip and are unique across the registry.
    const ids = listProjects().map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

// Audit Low #7: on a case-insensitive FS (win32/darwin) the same project path
// under different casing must resolve to ONE entry; on linux the two are distinct.
// Fold-at-compare — the stored path spelling is never rewritten.
test("registry folds project-path case on win32, dedups into one entry (Low #7)", () => {
  withTempRegistry(() => {
    const a = upsertProject({ path: "/Proj/A", name: "A" });
    assert.equal(getProject("/proj/a", "win32")?.path, "/Proj/A"); // folded match; first-seen path kept
    assert.equal(hasPath("/proj/a", "win32"), true);
    const b = upsertProject({ path: "/proj/a", name: "A2" }, "win32");
    assert.equal(b.id, a.id, "case-variant refresh updates the same entry");
    assert.deepEqual(listProjects().map((p) => p.path), ["/Proj/A"]); // one entry, first-seen spelling
    assert.equal(removePath("/proj/a", "win32"), true); // folded delete
    assert.deepEqual(listProjects(), []);
  });
});

test("registry keeps project-path case distinct on linux", () => {
  withTempRegistry(() => {
    upsertProject({ path: "/Proj/A" }, "linux");
    upsertProject({ path: "/proj/a" }, "linux");
    assert.equal(listProjects().length, 2);
    assert.equal(getProject("/proj/a", "linux")?.path, "/proj/a");
  });
});

test("normalize migrates prior registry shapes (v2 paths[], v1 hash-keyed)", () => {
  withTempRegistry((file) => {
    // v2: a bare list of paths -> entries keyed by path, sorted, no id yet.
    writeFileSync(file, JSON.stringify({ paths: ["/x/b", "/x/a"] }));
    assert.deepEqual(listProjects().map((p) => p.path), ["/x/a", "/x/b"]);
    assert.deepEqual(getProject("/x/a"), { path: "/x/a" });

    // v1: projects keyed by an opaque hash -> re-keyed by entry.path, fields kept.
    writeFileSync(
      file,
      JSON.stringify({
        projects: { someHash: { path: "/x/a", id: "abc12345", name: "N", kind: "git", branch: "main" } },
      }),
    );
    assert.deepEqual(getProject("/x/a"), { path: "/x/a", id: "abc12345", name: "N", kind: "git", branch: "main" });
  });
});

test("a corrupt registry is refused, not silently treated as empty", () => {
  withTempRegistry((file) => {
    writeFileSync(file, "{ this is not json");
    // Swallowing this would let the next write wipe a (recoverable) file.
    assert.throws(() => listProjects(), /corrupt/);
  });
});

test("removePath removes once, reports presence, and listProjects sorts by path", () => {
  withTempRegistry(() => {
    upsertProject({ path: "/z" });
    upsertProject({ path: "/a" });
    assert.deepEqual(listProjects().map((p) => p.path), ["/a", "/z"]);
    assert.equal(removePath("/a"), true);
    assert.equal(removePath("/a"), false); // already gone
    assert.equal(getProject("/a"), null);
  });
});

// M2: when the lock can't be acquired, withLock must NOT silently fall through to
// an unguarded read-modify-write (which could clobber a concurrent writer's
// update). With a fresh (non-stale) foreign lock held and a short wait budget, it
// must fail LOUDLY instead of writing behind the lock.
test("withLock throws instead of writing unlocked while a fresh lock is held (M2)", () => {
  withTempRegistry((file) => {
    const lockPath = `${file}.lock`;
    writeFileSync(lockPath, ""); // a foreign lock, freshly created -> not stale
    withLockEnv("100", "100000", () => {
      // give up after 100ms; never deem the lock stale within that window
      assert.throws(() => upsertProject({ path: "/proj/contended" }), /lock/i);
      assert.equal(getProject("/proj/contended"), null); // and nothing was written
    });
  });
});

// A crashed holder leaves a lock behind; once older than the stale threshold it
// must be reclaimed, the write must go through, and the lock released (not leaked).
test("withLock reclaims a stale lock, writes, and releases it", () => {
  withTempRegistry((file) => {
    const lockPath = `${file}.lock`;
    writeFileSync(lockPath, "");
    const old = new Date(Date.now() - 60_000); // 60s ago > 5s default stale threshold
    utimesSync(lockPath, old, old);
    upsertProject({ path: "/proj/stale" });
    assert.ok(getProject("/proj/stale"));
    assert.equal(existsSync(lockPath), false);
  });
});

// A normal, uncontended write must leave no lock file behind.
test("withLock releases the lock after a normal write (no leak)", () => {
  withTempRegistry((file) => {
    const lockPath = `${file}.lock`;
    upsertProject({ path: "/proj/normal" });
    assert.equal(existsSync(lockPath), false);
  });
});

// L4: writeRegistry writes a `*.pid.tmp` then atomically renames it over the file.
// If the rename fails (here: the target is read-only, so the rename is denied on
// Windows), the temp file must be cleaned up, not left behind as litter.
test("writeRegistry cleans up its temp file when the atomic rename fails (L4)", () => {
  withTempRegistry((file) => {
    const dir = dirname(file);
    writeFileSync(file, JSON.stringify({ projects: {} })); // valid -> read() succeeds
    chmodSync(file, 0o444); // read-only target -> rename over it is denied (Windows)
    let threw = false;
    try {
      upsertProject({ path: "/proj/x" });
    } catch {
      threw = true;
    } finally {
      chmodSync(file, 0o666); // restore so the temp dir can be removed
    }
    // Only meaningful when the rename actually failed (POSIX may allow it); when it
    // did, no `*.tmp` sibling may remain.
    if (threw) {
      const leftover = readdirSync(dir).filter((n) => n.endsWith(".tmp"));
      assert.deepEqual(leftover, [], `leaked temp file(s): ${leftover}`);
    }
  });
});

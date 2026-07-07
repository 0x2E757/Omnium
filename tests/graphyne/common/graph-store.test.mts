import { test } from "node:test";
import assert from "node:assert/strict";

import { withTempRoot } from "../helpers.mts";
import { linkFiles, unlinkFiles, ensureMeta, neighbors, readMeta, forgetFile } from "../../../plugins/graphyne/common/graph-store.mjs";
import { metaExists } from "../../../plugins/graphyne/common/storage.mjs";

test("linkFiles writes BOTH sides with the same tags", () => {
  withTempRoot((root) => {
    linkFiles(root, "src/a.ts", "test/a.test.ts", ["Test"]);
    assert.deepEqual(readMeta(root, "src/a.ts").related, [
      { path: "test/a.test.ts", tags: ["test"] },
    ]);
    assert.deepEqual(readMeta(root, "test/a.test.ts").related, [
      { path: "src/a.ts", tags: ["test"] },
    ]);
  });
});

test("linkFiles is idempotent and unions tags", () => {
  withTempRoot((root) => {
    linkFiles(root, "a.ts", "b.ts", ["x"]);
    linkFiles(root, "a.ts", "b.ts", ["y"]);
    assert.deepEqual(neighbors(root, "a.ts"), [{ path: "b.ts", tags: ["x", "y"] }]);
    assert.deepEqual(neighbors(root, "b.ts"), [{ path: "a.ts", tags: ["x", "y"] }]);
  });
});

test("linkFiles rejects self-link", () => {
  withTempRoot((root) => {
    assert.throws(() => linkFiles(root, "a.ts", "a.ts", []));
  });
});

// Audit Low #7 (item 5): on a case-insensitive FS a case-variant of the same file
// is a self-link. Left unfolded, linkFiles would create a bogus self-edge and the
// two spellings would take two locks on the ONE meta file (a stale-timeout hang);
// folding the guard rejects it. On linux the two are genuinely distinct files.
test("linkFiles rejects a case-variant self-link on win32, allows it on linux", () => {
  withTempRoot((root) => {
    assert.throws(() => linkFiles(root, "src/Foo.ts", "src/foo.ts", ["x"], "win32"), /itself/i);
    // linux: two different files, so the link is legitimate and both sides written.
    linkFiles(root, "src/Foo.ts", "src/foo.ts", ["x"], "linux");
    assert.deepEqual(neighbors(root, "src/Foo.ts"), [{ path: "src/foo.ts", tags: ["x"] }]);
  });
});

test("unlinkFiles removes from both sides", () => {
  withTempRoot((root) => {
    linkFiles(root, "a.ts", "b.ts", ["x"]);
    assert.equal(unlinkFiles(root, "a.ts", "b.ts"), true);
    assert.deepEqual(neighbors(root, "a.ts"), []);
    assert.deepEqual(neighbors(root, "b.ts"), []);
    assert.equal(unlinkFiles(root, "a.ts", "b.ts"), false);
  });
});

test("ensureMeta creates an empty meta only if absent", () => {
  withTempRoot((root) => {
    assert.equal(ensureMeta(root, "a.ts"), true);
    assert.equal(metaExists(root, "a.ts"), true);
    assert.equal(ensureMeta(root, "a.ts"), false);
  });
});

test("forgetFile prunes a file's edges from every neighbor and deletes its own meta", () => {
  withTempRoot((root) => {
    linkFiles(root, "src/gone.ts", "src/a.ts", ["consumer"]);
    linkFiles(root, "src/gone.ts", "src/b.ts", ["consumer"]);
    const pruned = forgetFile(root, "src/gone.ts");
    assert.deepEqual(pruned.slice().sort(), ["src/a.ts", "src/b.ts"]);
    assert.equal(metaExists(root, "src/gone.ts"), false); // its own (orphan) meta removed
    assert.deepEqual(neighbors(root, "src/a.ts"), []); // reciprocal edge pruned
    assert.deepEqual(neighbors(root, "src/b.ts"), []);
  });
});

test("forgetFile on a file with no meta is a no-op returning []", () => {
  withTempRoot((root) => {
    assert.deepEqual(forgetFile(root, "src/none.ts"), []);
    assert.equal(metaExists(root, "src/none.ts"), false);
  });
});

test("readMeta reuses the cached parse while (mtime, size) is unchanged", () => {
  withTempRoot((root) => {
    linkFiles(root, "a.ts", "b.ts", ["x"]);
    const first = readMeta(root, "a.ts");
    const second = readMeta(root, "a.ts");
    // Unchanged file -> the parse is reused, so the very same object comes back.
    assert.equal(first, second);
  });
});

test("readMeta re-parses after the meta file changes", () => {
  withTempRoot((root) => {
    linkFiles(root, "a.ts", "b.ts", ["x"]);
    const before = readMeta(root, "a.ts");
    linkFiles(root, "a.ts", "c.ts", ["y"]);
    const after = readMeta(root, "a.ts");
    // The write bumps (mtime, size), so the stale cache entry is discarded.
    assert.notEqual(before, after);
    assert.deepEqual(after.related, [
      { path: "b.ts", tags: ["x"] },
      { path: "c.ts", tags: ["y"] },
    ]);
  });
});

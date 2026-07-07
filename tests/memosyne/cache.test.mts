// Tests for the stat-validated task cache (plugins/memosyne/common/cache.mjs). The cache is
// module-level (per process), so tests use a fresh temp root each — distinct
// task-file paths never collide across tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadTasks } from "../../plugins/memosyne/common/cache.mjs";
import { storeDir, writeTask } from "../../plugins/memosyne/common/storage.mjs";
import { serializeTask, buildStem, taskFilename, type Task } from "../../plugins/memosyne/common/task.mjs";

function withTempRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "memosyne-cache-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const mkTask = (summary: string): string =>
  serializeTask({ summary, status: "Backlog", related: [], files: [], description: "" } as Task);

const taskFile = (root: string, stem: string) => join(storeDir(root), taskFilename(stem));

test("loadTasks returns all tasks newest-first with parsed content", () => {
  withTempRoot((root) => {
    const a = buildStem(new Date(2026, 5, 4, 10, 0), "alpha");
    const b = buildStem(new Date(2026, 5, 4, 11, 0), "beta");
    writeTask(root, a, mkTask("alpha summary"));
    writeTask(root, b, mkTask("beta summary"));

    const rows = loadTasks(root);
    assert.deepEqual(
      rows.map((r) => r.stem),
      [b, a], // newest first
    );
    assert.equal(rows[0].task.summary, "beta summary");
    assert.equal(rows[1].task.summary, "alpha summary");
  });
});

test("loadTasks picks up an out-of-band edit (mtime/size change)", () => {
  withTempRoot((root) => {
    const s = buildStem(new Date(2026, 5, 4, 10, 0), "x");
    writeTask(root, s, mkTask("original"));
    assert.equal(loadTasks(root)[0].task.summary, "original"); // primes the cache

    // Simulate an external editor / git checkout overwriting the file with new
    // content (different length -> different size, caught even if mtime is coarse).
    writeFileSync(taskFile(root, s), mkTask("edited out of band, clearly different length"));

    assert.equal(loadTasks(root)[0].task.summary, "edited out of band, clearly different length");
  });
});

test("loadTasks drops a task whose file was removed", () => {
  withTempRoot((root) => {
    const s = buildStem(new Date(2026, 5, 4, 10, 0), "gone");
    writeTask(root, s, mkTask("here"));
    assert.equal(loadTasks(root).length, 1);

    rmSync(taskFile(root, s), { force: true });
    assert.ok(!existsSync(taskFile(root, s)));
    assert.equal(loadTasks(root).length, 0);
  });
});

test("repeated loadTasks calls return equal data (cache hit path)", () => {
  withTempRoot((root) => {
    const s = buildStem(new Date(2026, 5, 4, 10, 0), "y");
    writeTask(root, s, mkTask("stable"));
    assert.deepEqual(loadTasks(root), loadTasks(root));
  });
});

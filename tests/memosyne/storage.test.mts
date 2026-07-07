import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serializeTask, type Task } from "../../plugins/memosyne/common/task.mjs";
import {
  storeDir,
  writeTask,
  readTask,
  listTaskStems,
  taskExists,
  deleteTask,
  readConfig,
  writeConfig,
  ensureConfig,
  ensureAgentGuides,
  GUARD_FILENAMES,
  GUARD_CONTENT,
} from "../../plugins/memosyne/common/storage.mjs";
import { readFileSync } from "node:fs";

function mkTask(summary: string): string {
  const t: Task = { summary, status: "Backlog", related: [], files: [], description: "" };
  return serializeTask(t);
}

function withTempRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "memosyne-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a task lives flat in .memosyne/<stem>.md", () => {
  withTempRoot((root) => {
    const stem = "2026-06-04--15-58--example";

    writeTask(root, stem, mkTask("parent"));

    assert.ok(existsSync(join(storeDir(root), `${stem}.md`)));
    assert.ok(taskExists(root, stem));
    assert.deepEqual(listTaskStems(root), [stem]);
    assert.match(readTask(root, stem), /parent/);
  });
});

test("listTaskStems ignores stray files and dirs that aren't <stem>.md", () => {
  withTempRoot((root) => {
    writeTask(root, "2026-01-01--00-00--real", mkTask("real"));
    // A directory whose name looks like a stem is not a task (tasks are flat files).
    mkdirSync(join(storeDir(root), "2026-01-02--00-00--ghost"), { recursive: true });
    // A non-.md file with a stem-like name is not a task either.
    writeFileSync(join(storeDir(root), "2026-01-03--00-00--note.txt"), "x");

    assert.deepEqual(listTaskStems(root), ["2026-01-01--00-00--real"]);
  });
});

test("deleting a task removes its file", () => {
  withTempRoot((root) => {
    const stem = "2026-06-04--15-58--example";
    writeTask(root, stem, mkTask("parent"));

    assert.ok(deleteTask(root, stem));
    assert.ok(!taskExists(root, stem));
    assert.ok(!existsSync(join(storeDir(root), `${stem}.md`)));
  });
});

test("project config: ensureConfig creates a name, never overwrites; readConfig reads it", () => {
  withTempRoot((root) => {
    assert.deepEqual(readConfig(root), {}); // none yet
    assert.deepEqual(ensureConfig(root, "My Repo"), { name: "My Repo" });
    assert.deepEqual(readConfig(root), { name: "My Repo" });
    assert.deepEqual(ensureConfig(root, "Other"), { name: "My Repo" }); // no overwrite
    writeConfig(root, { name: "Renamed" });
    assert.equal(readConfig(root).name, "Renamed");
    assert.deepEqual(listTaskStems(root), []); // config.json is not a task
  });
});

test("ensureAgentGuides drops AGENTS.md/CLAUDE.md once, never overwriting edits", () => {
  withTempRoot((root) => {
    ensureAgentGuides(root);
    for (const name of GUARD_FILENAMES) {
      const p = join(storeDir(root), name);
      assert.ok(existsSync(p));
      assert.equal(readFileSync(p, "utf8"), GUARD_CONTENT);
    }
    // a user edit survives a second call (created if missing, never overwritten)
    const edited = join(storeDir(root), GUARD_FILENAMES[0]);
    writeFileSync(edited, "custom");
    ensureAgentGuides(root);
    assert.equal(readFileSync(edited, "utf8"), "custom");

    assert.deepEqual(listTaskStems(root), []); // guard files are not tasks
  });
});

test("invalid stems are rejected (path-traversal guard)", () => {
  withTempRoot((root) => {
    assert.throws(() => writeTask(root, "../escape", mkTask("x")));
  });
});

test("listings are newest-first and exclude foreign entries", () => {
  withTempRoot((root) => {
    for (const s of ["2026-01-01--00-00--a", "2026-03-03--00-00--c", "2026-02-02--00-00--b"])
      writeTask(root, s, mkTask(s));
    assert.deepEqual(listTaskStems(root), [
      "2026-03-03--00-00--c",
      "2026-02-02--00-00--b",
      "2026-01-01--00-00--a",
    ]);
  });
});

test("existence checks are lenient; deleting an absent target returns false", () => {
  withTempRoot((root) => {
    const stem = "2026-06-04--15-58--example";
    // Unlike writeTask, the existence/delete helpers never throw on a bad/missing target.
    assert.equal(taskExists(root, "../escape"), false);
    assert.equal(taskExists(root, stem), false);
    assert.equal(deleteTask(root, stem), false);
  });
});

test("readConfig is lenient: malformed JSON or a non-string name reads as empty", () => {
  withTempRoot((root) => {
    mkdirSync(storeDir(root), { recursive: true });
    const p = join(storeDir(root), "config.json");

    writeFileSync(p, "{ not valid json");
    assert.deepEqual(readConfig(root), {}); // never throws -> a bad config can't break listing

    writeFileSync(p, JSON.stringify({ name: 123 })); // wrong type
    assert.deepEqual(readConfig(root), {});

    // ensureConfig fills in a name when the file exists but lacks a usable one.
    writeFileSync(p, JSON.stringify({ other: "x" }));
    assert.deepEqual(ensureConfig(root, "Fallback"), { name: "Fallback" });
    assert.equal(readConfig(root).name, "Fallback");
  });
});

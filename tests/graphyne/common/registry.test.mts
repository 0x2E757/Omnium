// Registry tests. The discovery index lives at <installRoot>/data/registry.json,
// where installRoot = GRAPHYNE_ROOT. Each test points that env at a fresh temp dir
// so the store is isolated and auto-cleaned.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listProjects,
  getProject,
  hasPath,
  upsertProject,
  removePath,
  registryPath,
} from "../../../plugins/graphyne/common/registry.mjs";

let roots: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "graphyne-reg-"));
  process.env.GRAPHYNE_ROOT = root;
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
  delete process.env.GRAPHYNE_ROOT;
});

test("upsert assigns a stable id, preserved across refreshes", () => {
  tempRoot();
  const first = upsertProject({ path: "/proj/a", name: "A", kind: "folder" });
  assert.ok(first.id && first.id.length === 8);
  const again = upsertProject({ path: "/proj/a", name: "A renamed", kind: "git", branch: "main" });
  assert.equal(again.id, first.id, "id is preserved");
  const got = getProject("/proj/a");
  assert.equal(got?.name, "A renamed");
  assert.equal(got?.branch, "main");
});

test("listProjects is sorted by path; hasPath/removePath", () => {
  tempRoot();
  upsertProject({ path: "/proj/b" });
  upsertProject({ path: "/proj/a" });
  assert.deepEqual(listProjects().map((p) => p.path), ["/proj/a", "/proj/b"]);
  assert.equal(hasPath("/proj/a"), true);
  assert.equal(hasPath("/proj/zzz"), false);
  assert.equal(removePath("/proj/a"), true);
  assert.equal(removePath("/proj/a"), false);
  assert.equal(hasPath("/proj/a"), false);
});

test("missing registry reads empty; corrupt registry throws", () => {
  const root = tempRoot();
  assert.deepEqual(listProjects(), []);
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(registryPath(), "{ not json");
  assert.throws(() => listProjects(), /corrupt/i);
});

// Audit Low #7: the registry keys by absolute project path; on a case-insensitive
// FS (win32/darwin) the same project under different casing must resolve to ONE
// entry, while on linux the two are genuinely distinct. Fold-at-compare — the
// stored path spelling is never rewritten.
test("getProject/hasPath fold project-path case on win32, stay exact on linux", () => {
  tempRoot();
  upsertProject({ path: "/Proj/A" });
  assert.equal(getProject("/proj/a", "win32")?.path, "/Proj/A"); // folded match; first-seen path kept
  assert.equal(hasPath("/proj/a", "win32"), true);
  assert.equal(getProject("/proj/a", "linux"), null); // distinct file on linux
  assert.equal(hasPath("/proj/a", "linux"), false);
});

test("upsertProject dedups a case-variant into one entry on win32 (id + first-seen path kept)", () => {
  tempRoot();
  const a = upsertProject({ path: "/Proj/A", name: "A" });
  const b = upsertProject({ path: "/proj/a", name: "A2" }, "win32");
  assert.equal(b.id, a.id, "same entry: id preserved");
  assert.deepEqual(listProjects().map((p) => p.path), ["/Proj/A"]); // one entry, first-seen spelling
  assert.equal(getProject("/Proj/A")?.name, "A2", "other fields refreshed");
  assert.equal(removePath("/proj/a", "win32"), true); // folded delete
  assert.deepEqual(listProjects(), []);
});

test("upsertProject keeps case-variants distinct on linux", () => {
  tempRoot();
  upsertProject({ path: "/Proj/A" }, "linux");
  upsertProject({ path: "/proj/a" }, "linux");
  assert.equal(listProjects().length, 2);
});

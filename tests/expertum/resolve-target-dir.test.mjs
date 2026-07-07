import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";

import { resolveTargetDir, ROOT_DIR_NAME } from "../../plugins/expertum/common/server-lib.mjs";

// An absolute project root for the pure path math (resolveTargetDir touches no fs).
const ROOT = path.resolve(os.tmpdir(), "expertum-resolve-proj");
const EXPECTED_ROOT = path.resolve(ROOT, ROOT_DIR_NAME);

test("default root when directory is null/empty/whitespace", () => {
  for (const v of [null, undefined, "", "   "]) {
    const r = resolveTargetDir(v, ROOT);
    assert.equal(r.error, undefined, "should not error for " + JSON.stringify(v));
    assert.equal(r.dir, EXPECTED_ROOT);
    assert.equal(r.relDir, ROOT_DIR_NAME);
  }
});

test("accepts .expertum and nested run dirs", () => {
  assert.deepEqual(resolveTargetDir(".expertum", ROOT), { dir: EXPECTED_ROOT, relDir: ".expertum" });

  const nested = resolveTargetDir(".expertum/2026-06-11--run", ROOT);
  assert.equal(nested.error, undefined);
  assert.equal(nested.relDir, ".expertum/2026-06-11--run");
  assert.ok(nested.dir && nested.dir.startsWith(EXPECTED_ROOT + path.sep));
});

test("strips a leading ./", () => {
  const r = resolveTargetDir("./.expertum/run", ROOT);
  assert.equal(r.error, undefined);
  assert.equal(r.relDir, ".expertum/run");
});

test("rejects a first segment that is not .expertum", () => {
  for (const v of ["notexpertum/x", "tmp/.expertum", "expertum/x"]) {
    assert.match(resolveTargetDir(v, ROOT).error || "", /must be a relative path starting with/);
  }
});

test("rejects `..` segments", () => {
  assert.match(resolveTargetDir(".expertum/../etc", ROOT).error || "", /must not contain '\.\.'/);
  assert.match(resolveTargetDir(".expertum/a/../b", ROOT).error || "", /must not contain '\.\.'/);
});

test("rejects a segment that sanitizes to empty", () => {
  assert.match(resolveTargetDir(".expertum/!!!", ROOT).error || "", /empty or invalid path segment/);
});

test("sanitizes a hidden-style segment instead of rejecting", () => {
  const r = resolveTargetDir(".expertum/.hidden", ROOT);
  assert.equal(r.error, undefined);
  assert.equal(r.relDir, ".expertum/hidden");
});

test("rejects absolute / UNC / drive-letter inputs (separator-sensitive)", () => {
  for (const v of ["/etc/passwd", "C:\\Windows\\system32", "C:/Windows", "\\\\server\\share"]) {
    const r = resolveTargetDir(v, ROOT);
    assert.ok(r.error, "should reject " + JSON.stringify(v) + " (got " + JSON.stringify(r) + ")");
  }
});

test("every successful resolution stays inside the root", () => {
  for (const v of [null, ".expertum", ".expertum/a/b/c", "./.expertum/x"]) {
    const r = resolveTargetDir(v, ROOT);
    assert.equal(r.error, undefined);
    assert.ok(r.dir === EXPECTED_ROOT || (r.dir && r.dir.startsWith(EXPECTED_ROOT + path.sep)));
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  handleWriteReport,
  MAX_CONTENT_BYTES,
} from "../../plugins/expertum/common/server-lib.mjs";

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "expertum-write-"));
}

/** @param {any} res */
function isError(res) {
  return res && res.isError === true;
}

test("writes the report and reports the path + byte count", () => {
  const proj = tmpProject();
  const res = handleWriteReport(
    { filename: "review-security.md", content: "hello", directory: ".expertum/run" },
    proj
  );
  assert.equal(isError(res), false);
  const written = fs.readFileSync(path.join(proj, ".expertum", "run", "review-security.md"), "utf8");
  assert.equal(written, "hello");
  assert.match(res.content[0].text, /Wrote report to .*review-security\.md \(5 bytes\)\./);
});

test("defaults to .expertum/ when no directory is given", () => {
  const proj = tmpProject();
  const res = handleWriteReport({ filename: "r.md", content: "x" }, proj);
  assert.equal(isError(res), false);
  assert.ok(fs.existsSync(path.join(proj, ".expertum", "r.md")));
});

test("prepends a title heading, but not when the body already starts with '# '", () => {
  const proj = tmpProject();

  const a = handleWriteReport({ filename: "a.md", content: "body", title: "My Title" }, proj);
  assert.equal(isError(a), false);
  assert.equal(
    fs.readFileSync(path.join(proj, ".expertum", "a.md"), "utf8"),
    "# My Title\n\nbody"
  );

  const b = handleWriteReport({ filename: "b.md", content: "# Existing\n\nx", title: "Ignored" }, proj);
  assert.equal(isError(b), false);
  assert.equal(
    fs.readFileSync(path.join(proj, ".expertum", "b.md"), "utf8"),
    "# Existing\n\nx"
  );
});

test("rejects missing/blank filename and non-string content", () => {
  const proj = tmpProject();
  assert.equal(isError(handleWriteReport({ content: "x" }, proj)), true);
  assert.equal(isError(handleWriteReport({ filename: "   ", content: "x" }, proj)), true);
  assert.equal(isError(handleWriteReport({ filename: "r.md", content: 123 }, proj)), true);
});

test("passes through a resolveTargetDir rejection", () => {
  const proj = tmpProject();
  const res = handleWriteReport({ filename: "r.md", content: "x", directory: "notexpertum" }, proj);
  assert.equal(isError(res), true);
  assert.match(res.content[0].text, /must be a relative path starting with/);
});

test("rejects a body over the size cap", () => {
  const proj = tmpProject();
  const big = "a".repeat(MAX_CONTENT_BYTES + 1);
  const res = handleWriteReport({ filename: "r.md", content: big }, proj);
  assert.equal(isError(res), true);
  assert.match(res.content[0].text, /over the .* limit/);
  assert.equal(fs.existsSync(path.join(proj, ".expertum", "r.md")), false);
});

test("surfaces a filesystem failure as a toolError (project dir is a file)", () => {
  const dir = tmpProject();
  const fileAsProject = path.join(dir, "not-a-dir");
  fs.writeFileSync(fileAsProject, "x");
  const res = handleWriteReport({ filename: "r.md", content: "x" }, fileAsProject);
  assert.equal(isError(res), true);
  assert.match(res.content[0].text, /Failed to write report/);
});

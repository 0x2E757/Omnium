import { test } from "node:test";
import assert from "node:assert/strict";

import { isPureDeletion } from "../../../plugins/graphyne/common/deletion.mjs";

// Edit: new_string empty removes the matched span entirely (whole lines) -> deletion.
test("Edit: emptying a whole-line span is a pure deletion", () => {
  const cur = "a\nb\nc\n";
  const ok = isPureDeletion(cur, "Edit", { old_string: "b\n", new_string: "" });
  assert.equal(ok, true);
});

// Edit: new_string is a line-subsequence of old_string (drops a line within the span).
test("Edit: dropping a line inside the matched span is a pure deletion", () => {
  const cur = "x\nkeep\ndrop\ny\n";
  const ok = isPureDeletion(cur, "Edit", { old_string: "keep\ndrop\n", new_string: "keep\n" });
  assert.equal(ok, true);
});

// Edit: changing a line (not removing it) is NOT a pure deletion.
test("Edit: a within-line modification is not a pure deletion", () => {
  const cur = "return a + b;\n";
  const ok = isPureDeletion(cur, "Edit", { old_string: "return a + b;", new_string: "return a;" });
  assert.equal(ok, false);
});

// Edit: adding content is never a deletion.
test("Edit: adding a line is not a pure deletion", () => {
  const cur = "a\nb\n";
  const ok = isPureDeletion(cur, "Edit", { old_string: "a\n", new_string: "a\nNEW\n" });
  assert.equal(ok, false);
});

// Edit: a no-op (identical result) is not a deletion.
test("Edit: a no-op edit is not a deletion", () => {
  const cur = "a\nb\n";
  const ok = isPureDeletion(cur, "Edit", { old_string: "a\n", new_string: "a\n" });
  assert.equal(ok, false);
});

// Edit: old_string absent from the file -> can't reconstruct -> conservative false.
test("Edit: an unmatched old_string is rejected", () => {
  const cur = "a\nb\n";
  const ok = isPureDeletion(cur, "Edit", { old_string: "zzz\n", new_string: "" });
  assert.equal(ok, false);
});

// Edit: a non-unique old_string without replace_all mirrors the harness error -> rejected.
test("Edit: a non-unique old_string without replace_all is rejected", () => {
  const cur = "dup\nmid\ndup\n";
  const ok = isPureDeletion(cur, "Edit", { old_string: "dup\n", new_string: "" });
  assert.equal(ok, false);
});

// Edit: replace_all emptying every occurrence (whole lines) is a deletion.
test("Edit: replace_all removing every occurrence is a deletion", () => {
  const cur = "dup\nmid\ndup\n";
  const ok = isPureDeletion(cur, "Edit", { old_string: "dup\n", new_string: "", replace_all: true });
  assert.equal(ok, true);
});

// Write: rewriting the file with one line removed (line-subsequence) is a deletion.
test("Write: content that is a line-subsequence of the current file is a deletion", () => {
  const cur = "a\nb\nc\n";
  const ok = isPureDeletion(cur, "Write", { content: "a\nc\n" });
  assert.equal(ok, true);
});

// Write: adding a line is not a deletion.
test("Write: content with an added line is not a deletion", () => {
  const cur = "a\nb\n";
  const ok = isPureDeletion(cur, "Write", { content: "a\nb\nc\n" });
  assert.equal(ok, false);
});

// MultiEdit: a sequence of whole-line deletions is a deletion.
test("MultiEdit: sequential whole-line deletions are a deletion", () => {
  const cur = "a\nb\nc\nd\n";
  const ok = isPureDeletion(cur, "MultiEdit", {
    edits: [
      { old_string: "b\n", new_string: "" },
      { old_string: "d\n", new_string: "" },
    ],
  });
  assert.equal(ok, true);
});

// MultiEdit: any add anywhere in the sequence disqualifies it.
test("MultiEdit: an added line anywhere disqualifies the whole edit", () => {
  const cur = "a\nb\n";
  const ok = isPureDeletion(cur, "MultiEdit", {
    edits: [
      { old_string: "a\n", new_string: "" },
      { old_string: "b\n", new_string: "b\nNEW\n" },
    ],
  });
  assert.equal(ok, false);
});

// Edit: a whole-line deletion on a CRLF file, where the tool delivers LF-only
// old_string/new_string, must still be recognized as a pure deletion. The on-disk
// content is CRLF; the comparison must be EOL-insensitive.
test("Edit: a whole-line deletion on a CRLF file is a pure deletion", () => {
  const cur = "a\r\nb\r\nc\r\n";
  const ok = isPureDeletion(cur, "Edit", { old_string: "b\n", new_string: "" });
  assert.equal(ok, true);
});

// Edit: a within-line modification on a CRLF file is still NOT a pure deletion.
test("Edit: a within-line modification on a CRLF file is not a pure deletion", () => {
  const cur = "return a + b;\r\n";
  const ok = isPureDeletion(cur, "Edit", { old_string: "return a + b;", new_string: "return a;" });
  assert.equal(ok, false);
});

// Write: CRLF current file, LF replacement content dropping a line is a deletion.
test("Write: an LF subsequence of a CRLF current file is a deletion", () => {
  const cur = "a\r\nb\r\nc\r\n";
  const ok = isPureDeletion(cur, "Write", { content: "a\nc\n" });
  assert.equal(ok, true);
});

// Unknown / unsupported tools are conservatively rejected.
test("an unsupported tool is not treated as a deletion", () => {
  assert.equal(isPureDeletion("a\n", "NotebookEdit", { new_source: "" }), false);
});

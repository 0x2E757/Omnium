import { test } from "node:test";
import assert from "node:assert/strict";

import {
  type Meta,
  parseMeta,
  serializeMeta,
  mergeEdge,
  removeEdge,
  normalizeTag,
  edgesWithTag,
  MAX_TAGS_PER_EDGE,
} from "../../../plugins/graphyne/common/graph.mjs";

test("normalizeTag lowercases and collapses whitespace", () => {
  assert.equal(normalizeTag("  Test "), "test");
  assert.equal(normalizeTag("two words"), "two-words");
});

test("parse/serialize round-trips and canonicalizes", () => {
  const meta = parseMeta(`
related:
  - path: src/b.ts
    tags: [Consumer, consumer]
  - path: test/a.test.ts
    tags: [test]
`);
  // deduped tags, sorted edges by path
  assert.deepEqual(meta.related, [
    { path: "src/b.ts", tags: ["consumer"] },
    { path: "test/a.test.ts", tags: ["test"] },
  ]);
  const out = serializeMeta(meta);
  assert.deepEqual(parseMeta(out).related, meta.related);
});

test("parseMeta is lenient on garbage and missing related", () => {
  assert.deepEqual(parseMeta("not: valid: yaml: [").related, []);
  assert.deepEqual(parseMeta("foo: 1").related, []);
  assert.deepEqual(parseMeta("").related, []);
});

test("parseMeta drops unsafe paths and self-edges", () => {
  const meta = parseMeta(
    `related:\n  - path: ../escape.ts\n    tags: []\n  - path: src/self.ts\n    tags: [x]\n`,
    "src/self.ts",
  );
  assert.deepEqual(meta.related, []);
});

test("mergeEdge unions tags and drops self", () => {
  let meta: Meta = { related: [] };
  meta = mergeEdge(meta, { path: "src/b.ts", tags: ["test"] });
  meta = mergeEdge(meta, { path: "src/b.ts", tags: ["consumer"] });
  assert.deepEqual(meta.related, [{ path: "src/b.ts", tags: ["consumer", "test"] }]);
  meta = mergeEdge(meta, { path: "src/a.ts", tags: ["x"] }, "src/a.ts");
  assert.equal(meta.related.find((e) => e.path === "src/a.ts"), undefined);
});

test("mergeEdge caps an edge at 5 tags", () => {
  // up to 5 is fine
  const five = mergeEdge({ related: [] }, { path: "src/b.ts", tags: ["a", "b", "c", "d", "e"] });
  assert.equal(five.related[0].tags.length, 5);
  assert.equal(MAX_TAGS_PER_EDGE, 5);

  // a 6th distinct tag in one call is rejected
  assert.throws(
    () => mergeEdge({ related: [] }, { path: "src/b.ts", tags: ["a", "b", "c", "d", "e", "f"] }),
    /maximum is 5 tags/i,
  );

  // and rejected cumulatively: 5 already there, adding a new one overflows
  assert.throws(() => mergeEdge(five, { path: "src/b.ts", tags: ["f"] }), /maximum is 5 tags/i);

  // re-adding an existing tag (no growth past 5) is still fine
  assert.deepEqual(mergeEdge(five, { path: "src/b.ts", tags: ["a"] }).related[0].tags.length, 5);
});

test("removeEdge reports change", () => {
  const meta = { related: [{ path: "src/b.ts", tags: ["test"] }] };
  const r1 = removeEdge(meta, "src/b.ts");
  assert.equal(r1.removed, true);
  assert.deepEqual(r1.meta.related, []);
  const r2 = removeEdge(meta, "nope.ts");
  assert.equal(r2.removed, false);
});

test("edgesWithTag filters by tag", () => {
  const meta = {
    related: [
      { path: "t.test.ts", tags: ["test"] },
      { path: "b.ts", tags: ["consumer"] },
    ],
  };
  assert.deepEqual(edgesWithTag(meta, "test").map((e) => e.path), ["t.test.ts"]);
});

// #region Case-insensitive dedup (audit Low #7) — fold at COMPARE, preserve display

test("mergeEdge folds edge case for dedup on case-insensitive platforms, keeping first-seen spelling", () => {
  const base = mergeEdge({ related: [] }, { path: "src/Foo.ts", tags: ["type"] }, undefined, "win32");
  const merged = mergeEdge(base, { path: "src/foo.ts", tags: ["consumer"] }, undefined, "win32");
  assert.equal(merged.related.length, 1);
  assert.equal(merged.related[0].path, "src/Foo.ts"); // first-seen casing retained (display-preserving)
  assert.deepEqual(merged.related[0].tags, ["consumer", "type"]); // tags unioned across the case variants
});

test("mergeEdge keeps differently-cased paths distinct on linux (case-sensitive FS)", () => {
  const base = mergeEdge({ related: [] }, { path: "src/Foo.ts", tags: ["type"] }, undefined, "linux");
  const merged = mergeEdge(base, { path: "src/foo.ts", tags: ["consumer"] }, undefined, "linux");
  assert.equal(merged.related.length, 2); // genuinely two files on linux — no fold
});

test("parseMeta folds duplicate-cased edges to one on darwin, two on linux", () => {
  const raw = "related:\n  - path: src/Foo.ts\n    tags: [type]\n  - path: src/foo.ts\n    tags: [consumer]\n";
  assert.equal(parseMeta(raw, undefined, "darwin").related.length, 1);
  assert.equal(parseMeta(raw, undefined, "linux").related.length, 2);
});

test("mergeEdge drops a case-variant self-edge on win32 but keeps it on linux", () => {
  const dropped = mergeEdge({ related: [] }, { path: "src/Foo.ts", tags: ["x"] }, "src/foo.ts", "win32");
  assert.equal(dropped.related.length, 0); // folded self match drops the self-loop
  const kept = mergeEdge({ related: [] }, { path: "src/Foo.ts", tags: ["x"] }, "src/foo.ts", "linux");
  assert.equal(kept.related.length, 1);
});

test("removeEdge folds case on win32 but not on linux", () => {
  const meta = mergeEdge({ related: [] }, { path: "src/Foo.ts", tags: [] }, undefined, "linux");
  assert.equal(removeEdge(meta, "src/foo.ts", "win32").removed, true); // case-insensitive match removes
  assert.equal(removeEdge(meta, "src/foo.ts", "linux").removed, false); // distinct file, nothing removed
});

// #endregion Case-insensitive dedup

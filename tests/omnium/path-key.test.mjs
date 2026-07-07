// Unit tests for the shared path-key module: separator normalization plus a
// platform-conditional case fold for lookup/dedup keys. The `platform` arg is
// injected so the win32/darwin fold and the Linux no-op are both exercised on
// any host (mirrors project-canonical.test.mjs injecting pathImpl).

import assert from "node:assert/strict";
import { test } from "node:test";

import { toPosixSep, foldPathCase, pathKey, foldedGet, foldedKeyOf } from "../../shared/path-key.mjs";

test("toPosixSep folds backslashes to forward slashes, unconditionally", () => {
  assert.equal(toPosixSep("src\\foo\\bar.mjs"), "src/foo/bar.mjs");
  assert.equal(toPosixSep("src/foo.mjs"), "src/foo.mjs");
  assert.equal(toPosixSep(""), "");
});

test("foldPathCase lowercases on win32 and darwin", () => {
  assert.equal(foldPathCase("Src/Foo.MJS", "win32"), "src/foo.mjs");
  assert.equal(foldPathCase("Src/Foo.MJS", "darwin"), "src/foo.mjs");
});

test("foldPathCase is identity on linux (case-sensitive FS)", () => {
  assert.equal(foldPathCase("Src/Foo.MJS", "linux"), "Src/Foo.MJS");
  // Distinct casings stay distinct on linux.
  assert.notEqual(foldPathCase("Foo.mjs", "linux"), foldPathCase("foo.mjs", "linux"));
});

test("pathKey composes separator + case: same file, different spelling, one key on win32/darwin", () => {
  assert.equal(pathKey("Src\\Foo.mjs", "win32"), pathKey("src/foo.mjs", "win32"));
  assert.equal(pathKey("Src\\Foo.mjs", "darwin"), pathKey("src/foo.mjs", "darwin"));
  assert.equal(pathKey("Src\\Foo.mjs", "win32"), "src/foo.mjs");
});

test("pathKey keeps separator folding but NOT case folding on linux", () => {
  // separators still normalize (always spurious for a repo-relative path)...
  assert.equal(pathKey("src\\foo.mjs", "linux"), "src/foo.mjs");
  // ...but case is preserved, so two real distinct files do not collide.
  assert.notEqual(pathKey("Src/Foo.mjs", "linux"), pathKey("src/foo.mjs", "linux"));
});

// foldedGet/foldedKeyOf resolve a Record<string,T> entry whose key folds equal to
// the probe, so a store keyed by first-seen real spelling can still be indexed by
// a case-variant on a case-insensitive FS — without ever rewriting the stored key.
// They fold CASE only (callers pass already-POSIX keys); on linux they degrade to
// exact-match lookup, so distinct casings stay distinct.
test("foldedGet finds a value under a case-variant key on win32/darwin, exact-only on linux", () => {
  const rec = { "Src/Foo.ts": 1, "src/bar.ts": 2 };
  assert.equal(foldedGet(rec, "src/foo.ts", "win32"), 1);
  assert.equal(foldedGet(rec, "SRC/FOO.TS", "darwin"), 1);
  assert.equal(foldedGet(rec, "src/foo.ts", "linux"), undefined); // distinct file on linux
  assert.equal(foldedGet(rec, "Src/Foo.ts", "linux"), 1); // exact match still works
  assert.equal(foldedGet({}, "x", "win32"), undefined); // empty map
});

test("foldedKeyOf returns the existing first-seen key for a case-variant on win32, undefined on linux/miss", () => {
  /** @type {Record<string, number>} */
  const rec = { "Src/Foo.ts": 1 };
  assert.equal(foldedKeyOf(rec, "src/foo.ts", "win32"), "Src/Foo.ts");
  assert.equal(foldedKeyOf(rec, "src/foo.ts", "linux"), undefined); // no exact key on linux
  assert.equal(foldedKeyOf(rec, "Src/Foo.ts", "linux"), "Src/Foo.ts");
  assert.equal(foldedKeyOf(rec, "other.ts", "win32"), undefined);
  // The returned key indexes the map, and `?? fallback` handles the miss (write-dedup contract).
  assert.equal(rec[foldedKeyOf(rec, "src/foo.ts", "win32") ?? "src/foo.ts"], 1);
});

test("foldedKeyOf prefers an exact key over a folded co-resident (deterministic on a legacy dupe)", () => {
  // Write-dedup normally prevents two case-variant keys, but a pre-upgrade store
  // could carry both. The exact-hit shortcut must return the exact spelling, not
  // whichever the fold-scan reaches first — so a lookup is deterministic.
  /** @type {Record<string, number>} */
  const rec = { "src/Foo.ts": 1, "src/foo.ts": 2 };
  assert.equal(foldedKeyOf(rec, "src/foo.ts", "win32"), "src/foo.ts"); // exact wins over the folded co-resident
  assert.equal(foldedKeyOf(rec, "src/Foo.ts", "win32"), "src/Foo.ts");
});

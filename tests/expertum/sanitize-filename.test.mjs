import test from "node:test";
import assert from "node:assert/strict";

import { sanitizeFilename } from "../../plugins/expertum/common/server-lib.mjs";

test("sanitizeFilename: null/undefined/empty -> report.md", () => {
  assert.equal(sanitizeFilename(null), "report.md");
  assert.equal(sanitizeFilename(undefined), "report.md");
  assert.equal(sanitizeFilename(""), "report.md");
  // whitespace-only collapses to "-" then the leading dash is trimmed -> empty -> "report"
  assert.equal(sanitizeFilename("   "), "report.md");
});

test("sanitizeFilename: strips directory parts to a basename", () => {
  assert.equal(sanitizeFilename("a/b/c.md"), "c.md");
  assert.equal(sanitizeFilename("a\\b\\c.md"), "c.md");
  assert.equal(sanitizeFilename(".expertum/run/review-security.md"), "review-security.md");
});

test("sanitizeFilename: removes `..` and never escapes", () => {
  assert.equal(sanitizeFilename("../../etc/passwd"), "passwd.md");
  // `..` is stripped *after* basename pop, so a bare `..md` collapses to md.md.
  assert.equal(sanitizeFilename("..md"), "md.md");
});

test("sanitizeFilename: collapses disallowed chars and trims leading dot/dash", () => {
  assert.equal(sanitizeFilename("RE port!.md"), "RE-port-.md");
  assert.equal(sanitizeFilename(".hidden.md"), "hidden.md");
  assert.equal(sanitizeFilename("--lead.md"), "lead.md");
});

test("sanitizeFilename: appends .md when missing (case-insensitive)", () => {
  assert.equal(sanitizeFilename("report"), "report.md");
  assert.equal(sanitizeFilename("evil.txt"), "evil.txt.md");
  assert.equal(sanitizeFilename("DONE.MD"), "DONE.MD");
});

test("sanitizeFilename: non-string coerces via String()", () => {
  assert.equal(sanitizeFilename(123), "123.md");
});

// Audit Low #9: a Windows reserved DEVICE name (CON, PRN, AUX, NUL, COM1-9, LPT1-9),
// with or without an extension, must be mangled — `con.md` still IS the CON device.
test("sanitizeFilename: mangles Windows reserved device names, with or without extension", () => {
  assert.equal(sanitizeFilename("con"), "_con.md");
  assert.equal(sanitizeFilename("CON.md"), "_CON.md");
  assert.equal(sanitizeFilename("nul.txt"), "_nul.txt.md");
  assert.equal(sanitizeFilename("com1"), "_com1.md");
  assert.equal(sanitizeFilename("LPT9.md"), "_LPT9.md");
  assert.equal(sanitizeFilename("aux"), "_aux.md");
  assert.equal(sanitizeFilename("prn.md"), "_prn.md");
});

test("sanitizeFilename: leaves non-reserved lookalikes (and com0/lpt0) untouched", () => {
  assert.equal(sanitizeFilename("console.md"), "console.md"); // contains 'con', not reserved
  assert.equal(sanitizeFilename("connect.md"), "connect.md");
  assert.equal(sanitizeFilename("com0"), "com0.md"); // COM0/LPT0 are not Windows devices
  assert.equal(sanitizeFilename("lpt0.md"), "lpt0.md");
});

// Windows silently strips trailing dots from a filename, so a name ending in `.`
// would mis-name or collide; trim them (mirrors the existing leading-dot trim).
test("sanitizeFilename: trims trailing dots", () => {
  assert.equal(sanitizeFilename("report."), "report.md");
  assert.equal(sanitizeFilename("summary.md."), "summary.md");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { win32 } from "node:path";

import { projectInfo } from "../../plugins/graphyne/handlers.mjs";

// The "Store:" line in projectInfo must not render a mixed separator on Windows
// (C:\repo/.graphyne reads as a bug). It joins root + ".graphyne" through an
// injectable path.join (default native), so win32 rules are exercised on any
// host — the same seam project-canonical.test.mjs uses for normalizeRoot.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cfg = { source: [], tests: [], test: { file: undefined, all: undefined } } as any;

test("projectInfo Store line joins with the platform separator (no mixed slashes on Windows)", () => {
  const out = projectInfo("demo", "C:\\repo", cfg, win32.join);
  assert.match(out, /^Store: C:\\repo\\\.graphyne$/m);
  assert.ok(!out.includes("C:\\repo/.graphyne"), "no mixed backslash/forward-slash store path");
});

test("projectInfo Store line defaults to the native join", () => {
  const out = projectInfo("demo", "/srv/repo", cfg);
  assert.match(out, /^Store: \/srv\/repo\/\.graphyne$/m);
});

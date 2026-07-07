// globs.test.mjs — pins the vendored glob matcher (DESIGN.md D5,
// design-code-reviewer.md §Q4) against the differential fixture captured from
// picomatch@4.0.4 {dot:true} in the reference checkout: every recorded
// pattern x path verdict must match, EXCEPT the divergentByDesign patterns
// ({a,b}, [abc], !(x), @(x), +(x)) whose extglob/brace syntax the vendored
// matcher deliberately does not implement — §Q4 row 16 makes that punctuation
// LITERAL, so for those patterns the asserted verdict is exact literal
// equality with the pattern text instead of picomatch's recorded answer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { compile, matchesAny } from "../../plugins/graphyne/common/globs.mjs";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../parity/fixtures/globs.json", import.meta.url)), "utf8"),
);

test("globs fixtures: every picomatch@4 {dot:true} verdict is reproduced (minus divergent-by-design)", () => {
  const divergent = new Set(fixture.divergentByDesign);
  let rows = 0;
  for (const [pattern, verdicts] of Object.entries(fixture.patterns)) {
    if (divergent.has(pattern)) continue;
    const matches = compile([pattern]);
    for (const [path, expected] of Object.entries(verdicts)) {
      rows++;
      assert.equal(matches(path), expected, `pattern ${JSON.stringify(pattern)} vs ${JSON.stringify(path)}`);
    }
  }
  assert.ok(rows > 8000, `replayed ${rows} rows — corpus intact`);
});

test("divergent-by-design patterns match LITERALLY (section Q4 row 16), not as extglobs/braces", () => {
  for (const pattern of fixture.divergentByDesign) {
    const matches = compile([pattern]);
    for (const path of Object.keys(fixture.patterns[pattern])) {
      assert.equal(
        matches(path),
        path === pattern,
        `pattern ${JSON.stringify(pattern)} must be literal vs ${JSON.stringify(path)}`,
      );
    }
    // The literal itself always matches itself.
    assert.equal(matches(pattern), true, `literal self-match for ${JSON.stringify(pattern)}`);
  }
});

// Doubled-globstar runs are not in the recorded corpus, so pin them directly.
// Expected verdicts were verified against picomatch@4.0.4 {dot:true}: a run of
// `**` segments collapses to a single `**`, so `**/**` matches everything `**`
// matches (never the `.`/`..` pseudo-segments), and interior/trailing runs
// behave exactly like their single-`**` equivalents.
test("doubled globstar runs collapse like picomatch: **/** is **, not match-nothing", () => {
  /** @type {Array<[string, Record<string, boolean>]>} */
  const rows = [
    ["**/**", { a: true, "a/b": true, ".x": true, "a/b/c": true, ".": false, "..": false }],
    ["**/**/*.md", { "a.md": true, "x/a.md": true, "x/y/a.md": true, ".a.md": true, "a.txt": false, "x/a.txt": false }],
    ["**/**/**", { a: true, "a/b/c/d": true, ".x/.y": true }],
    ["a/**/**", { a: true, "a/b": true, "a/b/c": true, b: false, "a/.h": true }],
    ["a/**/**/b", { "a/b": true, "a/x/b": true, "a/x/y/b": true, a: false, b: false }],
  ];
  for (const [pattern, verdicts] of rows) {
    const matches = compile([pattern]);
    for (const [path, expected] of Object.entries(verdicts)) {
      assert.equal(matches(path), expected, `pattern ${JSON.stringify(pattern)} vs ${JSON.stringify(path)}`);
    }
  }
});

test("empty pattern list matches nothing; matchesAny mirrors compile", () => {
  assert.equal(compile([])("anything"), false);
  assert.equal(matchesAny("tests/a.ts", ["tests/**"]), true);
  assert.equal(matchesAny("tests", ["tests/**"]), true); // row 8: bare parent
  assert.equal(matchesAny("tests2/a", ["tests/**"]), false); // row 9: anchoring
});

// Differential fixture generator: globs.json (design-code-reviewer §Q4 tests item 2).
//
// MUST be run from inside the reference checkout (cwd = <ref-checkout>),
// which has the real `picomatch` package installed — the library is resolved from
// the CURRENT WORKING DIRECTORY, and the path corpus includes `git ls-files` of
// that repo:
//
//   cd <ref-checkout> && node /path/to/Omnium/tests/parity/fixtures/generators/gen-globs.mjs
//
// Records picomatch(pattern, {dot: true})(path) for every pattern from both
// repos' graphyne.json, ALWAYS_EXEMPT, the init.md documented examples, and the
// normative 17-row table (incl. `?` and intra-segment `**` rows), against a
// corpus of every git-tracked Graphyne path plus synthesized dot-variants and
// the table's literal path/pattern pairs.

import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(join(process.cwd(), "package.json"));
const picomatch = require("picomatch");
const picomatchVersion = require("picomatch/package.json").version;

/** Collect every glob pattern from a graphyne.json (all array-of-string fields). */
function configPatterns(configPath) {
  const cfg = JSON.parse(readFileSync(configPath, "utf8"));
  const out = [];
  for (const value of Object.values(cfg)) {
    if (Array.isArray(value)) {
      for (const p of value) if (typeof p === "string") out.push(p);
    }
  }
  return out;
}

const patterns = [
  ...new Set([
    // Both real configs (source/exclude/ignore/tests/docs/specs/metaExclude — all fields).
    // The reference checkouts predate graphyne 0.8.0, so their config is still the
    // root graphyne.json; a checkout on 0.8.0+ keeps it at .graphyne/config.json.
    ...configPatterns((process.env.REF_GRAPHYNE_DIR ?? "/path/to/graphyne-checkout") + "/graphyne.json"),
    ...configPatterns((process.env.REF_MEMOSYNE_DIR ?? "/path/to/memosyne-checkout") + "/graphyne.json"),
    // ALWAYS_EXEMPT (Graphyne src/common/config.mts:68) — since 0.8.0 that is
    // `.graphyne/**` alone. The bare `graphyne.json` literal stays in the corpus as
    // the §Q4 row-15 literal/anchored fixture; dropping it would shrink globs.json.
    ".graphyne/**",
    "graphyne.json",
    // init.md documented examples.
    "spec/**/*.md",
    "**/*_test.py",
    "**/*_test.go",
    "plugin/**",
    // 17-row table patterns not already covered.
    "**",
    "**/*.md",
    "node_modules/**",
    "tests/**",
    "src/**/*.mts",
    "*.md",
    // Row 13: `?` behavior.
    "?",
    "a?c",
    "src/?.mts",
    "tests?/a",
    // Row 14: intra-segment `**` (treated as `*` by picomatch).
    "foo**bar",
    "a**",
    "foo**/bar",
    // Row 16: unsupported punctuation — see _notes (divergent by design).
    "{a,b}",
    "[abc]",
    "!(x)",
    "@(x)",
    "+(x)",
  ]),
];

const trackedPaths = execSync("git ls-files", { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);

const synthesizedPaths = [
  // Dot-variants.
  ".bin/x",
  "a/.b/c.md",
  "node_modules/.bin/esbuild",
  ".claude/settings.json",
  ".md",
  ".claude/x",
  ".claude/notes.md",
  ".graphyne/meta/src/x.mts.yaml",
  // Bare dirs / anchoring.
  "tests",
  "tests2/a",
  "node_modules",
  "src",
  // 17-row table paths.
  "a/b",
  "README.md",
  "docs/a/b.md",
  "a/b.mdx",
  "node_modules/.bin/x",
  "tests/a/b",
  "src/a.mts",
  "src/a/b/c.mts",
  "x/src/a.mts",
  "docs/a.md",
  "graphyne.json",
  "x/graphyne.json",
  // `?` row paths.
  "a",
  "ab",
  ".",
  "abc",
  "axc",
  "a.c",
  "aXYc",
  "src/b.mts",
  "src/bc.mts",
  "src/.mts",
  "testsX/a",
  // Intra-segment `**` paths.
  "foobar",
  "fooxbar",
  "fooxybar",
  "foo/bar",
  "fooX/bar",
  "ax",
  "a/x",
  // Row 16 paths (literal-vs-expansion probes).
  "b",
  "c",
  "x",
  "{a,b}",
  "[abc]",
  "!(x)",
  "@(x)",
  "+(x)",
  // init.md example probes.
  "spec/x/y.md",
  "spec/y.md",
  "foo_test.py",
  "a/b_test.go",
  "plugin/cmd.md",
  "tests/common/graph.test.mts",
];

const corpus = [...new Set([...trackedPaths, ...synthesizedPaths])];

/** @type {Record<string, Record<string, boolean>>} */
const table = {};
for (const pattern of patterns) {
  const isMatch = picomatch(pattern, { dot: true });
  const row = {};
  for (const path of corpus) row[path] = isMatch(path);
  table[pattern] = row;
}

const fixture = {
  _notes:
    "Oracle: picomatch@" + picomatchVersion + " with {dot: true}. patterns[pattern][path] = " +
    "picomatch(pattern, {dot:true})(path). Corpus = git ls-files of the reference checkout + " +
    "synthesized dot-variants + the normative 17-row table's paths. DIVERGENT BY DESIGN (table row " +
    "16): for the patterns {a,b} [abc] !(x) @(x) +(x) this fixture records picomatch's expansion " +
    "behavior, but the vendored matcher deliberately treats that punctuation as literal characters — " +
    "parity tests must SKIP those five patterns. All other patterns require zero disagreements. " +
    "Generated by gen-globs.mjs run inside the reference checkout.",
  library: "picomatch",
  version: picomatchVersion,
  options: { dot: true },
  divergentByDesign: ["{a,b}", "[abc]", "!(x)", "@(x)", "+(x)"],
  corpusSize: corpus.length,
  patterns: table,
};

const out = new URL("../globs.json", import.meta.url);
writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n");
console.log(
  `wrote ${out.pathname}: ${patterns.length} patterns x ${corpus.length} paths = ` +
    `${patterns.length * corpus.length} pairs (picomatch@${picomatchVersion})`,
);

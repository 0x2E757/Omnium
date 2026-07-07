// Differential fixture generator: yaml-parse.json (design-code-reviewer §Q3 parser grammar).
//
// MUST be run from inside the reference checkout (cwd = <ref-checkout>),
// which has the real `yaml` package installed — the library is resolved from the
// CURRENT WORKING DIRECTORY, not from Omnium:
//
//   cd <ref-checkout> && node /path/to/Omnium/tests/parity/fixtures/generators/gen-yaml-parse.mjs
//
// Records eemeli yaml's ACTUAL behavior for each raw input: either the parsed
// value ({"value": ...}) or {"throws": true, "message": ...}. Non-JSON numbers
// (Infinity/-Infinity/NaN) are encoded as {"$nonJson": "..."} so the fixture
// stays valid JSON. The vendored yaml-lite parser must match every
// parseMeta-relevant outcome (same value, or throw where eemeli throws — plus
// the documented accepted deltas listed in the design, e.g. anchors).

import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(join(process.cwd(), "package.json"));
const yaml = require("yaml");
const yamlVersion = require("yaml/package.json").version;

/** Encode Infinity/-Infinity/NaN so JSON round-trips losslessly. */
function sanitize(v) {
  if (typeof v === "number") {
    if (v === Infinity) return { $nonJson: "Infinity" };
    if (v === -Infinity) return { $nonJson: "-Infinity" };
    if (Number.isNaN(v)) return { $nonJson: "NaN" };
    return v;
  }
  if (Array.isArray(v)) return v.map(sanitize);
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = sanitize(val);
    return out;
  }
  return v === undefined ? { $nonJson: "undefined" } : v;
}

/** @type {Array<{name: string, raw: string}>} */
const cases = [
  // --- block mappings / sequences (the canonical store shape) ---
  { name: "canonical-meta", raw: "related:\n  - path: src/bar.ts\n    tags:\n      - test\n" },
  { name: "canonical-meta-two-edges", raw: "related:\n  - path: a.ts\n    tags:\n      - doc\n  - path: b.ts\n    tags:\n      - test\n      - type\n" },
  { name: "simple-mapping", raw: "key: value\n" },
  { name: "nested-mapping", raw: "a:\n  b: c\n  d: e\n" },
  { name: "block-seq-of-scalars", raw: "items:\n  - a\n  - b\n" },
  { name: "top-level-seq-inline-map", raw: "- path: x\n  tags:\n    - t\n" },
  { name: "unindented-seq-dash-at-parent-column", raw: "related:\n- path: a\n  tags:\n  - test\n" },

  // --- flow collections ---
  { name: "flow-tags", raw: "related:\n  - path: a\n    tags: [test]\n" },
  { name: "flow-tags-multi", raw: "tags: [a, b, c]\n" },
  { name: "flow-empty-seq", raw: "related: []\n" },
  { name: "flow-mapping", raw: "a: {b: c}\n" },
  { name: "flow-empty-mapping", raw: "a: {}\n" },
  { name: "nested-flow-seq", raw: "a: [[1, 2], [3]]\n" },
  { name: "nested-flow-map-in-seq", raw: "a: [{b: c}]\n" },
  { name: "flow-with-trailing-comment", raw: "tags: [test] # c\n" },

  // --- quoted scalars ---
  { name: "single-quoted", raw: "path: 'a b'\n" },
  { name: "single-quoted-escape", raw: "path: 'it''s'\n" },
  { name: "double-quoted-escapes", raw: "path: \"a\\tb\\nc\"\n" },
  { name: "double-quoted-unicode", raw: "path: \"\\u0041\\u00e9\"\n" },
  { name: "double-quoted-unknown-escape", raw: "path: \"\\q\"\n" },
  { name: "double-quoted-number-lookalike", raw: "path: \"123\"\n" },

  // --- comments / blank lines ---
  { name: "full-line-comment", raw: "# header comment\nrelated: []\n" },
  { name: "trailing-comment", raw: "path: a # comment\n" },
  { name: "hash-without-space-is-content", raw: "path: a#b\n" },
  { name: "blank-lines", raw: "\nrelated:\n\n  - path: a\n\n    tags:\n      - test\n\n" },
  { name: "only-comment", raw: "# nothing else\n" },

  // --- document markers ---
  { name: "leading-doc-start", raw: "---\nrelated: []\n" },
  { name: "doc-start-and-end", raw: "---\npath: a\n...\n" },
  { name: "second-document", raw: "a: 1\n---\nb: 2\n" },
  { name: "yaml-directive", raw: "%YAML 1.2\n---\na: b\n" },

  // --- CRLF ---
  { name: "crlf-canonical-meta", raw: "related:\r\n  - path: a\r\n    tags:\r\n      - test\r\n" },

  // --- plain-scalar resolution (YAML 1.2 core schema) ---
  { name: "plain-int", raw: "path: 123\n" },
  { name: "plain-negative-int", raw: "path: -7\n" },
  { name: "plain-plus-int", raw: "path: +3\n" },
  { name: "plain-hex-int", raw: "path: 0x1F\n" },
  { name: "plain-octal-int", raw: "path: 0o17\n" },
  { name: "plain-float", raw: "path: 1.5\n" },
  { name: "plain-exp-float", raw: "path: 1e3\n" },
  { name: "plain-inf", raw: "path: .inf\n" },
  { name: "plain-neg-inf", raw: "path: -.inf\n" },
  { name: "plain-nan", raw: "path: .nan\n" },
  { name: "plain-true", raw: "path: true\n" },
  { name: "plain-True-False", raw: "a: True\nb: FALSE\n" },
  { name: "plain-null-tilde", raw: "path: ~\n" },
  { name: "plain-null-word-variants", raw: "a: null\nb: Null\nc: NULL\n" },
  { name: "empty-value-is-null", raw: "path:\n" },
  { name: "yes-no-on-off-are-strings-in-core", raw: "a: yes\nb: no\nc: on\nd: off\n" },
  { name: "colon-no-space-is-plain", raw: "a:b\n" },
  { name: "plain-multiline-folds", raw: "path: a\n  b\n" },
  { name: "version-lookalike-string", raw: "path: 1.2.3\n" },

  // --- duplicate keys (record actual eemeli default behavior) ---
  { name: "duplicate-keys-top", raw: "a: 1\na: 2\n" },
  { name: "duplicate-keys-in-edge", raw: "related:\n  - path: a\n    path: b\n    tags:\n      - t\n" },

  // --- anchors / aliases / tags (record actual behavior) ---
  { name: "anchor-and-alias", raw: "a: &x 1\nb: *x\n" },
  { name: "unresolved-alias", raw: "b: *nope\n" },
  { name: "core-tag", raw: "a: !!str 123\n" },
  { name: "custom-tag", raw: "a: !foo bar\n" },

  // --- block scalars ---
  { name: "block-scalar-literal", raw: "a: |\n  line1\n  line2\n" },
  { name: "block-scalar-folded", raw: "a: >\n  line1\n  line2\n" },

  // --- tabs / structural errors ---
  { name: "tab-indentation", raw: "a:\n\tb: c\n" },
  { name: "tab-after-dash", raw: "related:\n  -\tpath: a\n" },
  { name: "unclosed-flow-seq", raw: "tags: [a, b\n" },
  { name: "unclosed-double-quote", raw: "path: \"abc\n" },
  { name: "bad-indent-dedent-into-value", raw: "a:\n    b: c\n  d: e\n" },

  // --- degenerate documents ---
  { name: "empty-string", raw: "" },
  { name: "bare-scalar-document", raw: "just a string\n" },
  { name: "whitespace-only", raw: "   \n\n" },
];

const results = cases.map(({ name, raw }) => {
  try {
    const value = yaml.parse(raw);
    return { name, raw, value: sanitize(value) };
  } catch (err) {
    return { name, raw, throws: true, errorName: err.name, message: err.message };
  }
});

const fixture = {
  _notes:
    "Oracle: yaml@" + yamlVersion + " parse(raw) at default options (YAML 1.2 core schema, uniqueKeys on). " +
    "Each case records the ACTUAL observed outcome: {value} (with Infinity/-Infinity/NaN encoded as " +
    "{\"$nonJson\": ...}) or {throws: true, errorName, message}. The vendored parser must match every " +
    "parseMeta-relevant outcome (same value, or throw where eemeli throws); documented accepted deltas " +
    "(design §Q3): the vendored subset MAY throw where eemeli succeeds for anchors/aliases, tags, block " +
    "scalars, directives and nested flow — parseMeta maps a throw to {related: []}. " +
    "Generated by gen-yaml-parse.mjs run inside the reference checkout.",
  library: "yaml",
  version: yamlVersion,
  cases: results,
};

const out = new URL("../yaml-parse.json", import.meta.url);
writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n");
const thrown = results.filter((r) => r.throws).length;
console.log(`wrote ${out.pathname}: ${results.length} cases (${thrown} throw) (yaml@${yamlVersion})`);

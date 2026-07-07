// yaml-lite.test.mjs — pins the vendored YAML subset (DESIGN.md D4,
// design-code-reviewer.md §Q3) against the differential fixtures captured
// from yaml@2.9.0 in the reference checkout:
//
//   yaml-stringify.json      serializer byte-parity. Plain-safe rows are the
//                            Tier-1 contract; the tier2QuoteStyle rows record
//                            eemeli's double-quote pick for @-leading scalars,
//                            which the JSON.stringify fallback reproduces — so
//                            byte parity is asserted for ALL 30 rows.
//   yaml-parse.json          value-or-throw parity per case. The design-accepted
//                            divergence (§Q3 grammar rule 9): the vendored
//                            parser THROWS on anchors/aliases, tags, block
//                            scalars, directives and nested flow where eemeli
//                            parsed — those cases are listed explicitly below
//                            and asserted as throws.
//   yaml-roundtrip-real.json parse -> serialize byte-identity on 10 real
//                            committed meta files from the reference meta stores
//                            (the Tier-1 proof on real data, and the C1
//                            write-compat evidence at module level).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseYamlLite } from "../../plugins/graphyne/common/yaml-lite.mjs";
import { parseMeta, serializeMeta } from "../../plugins/graphyne/common/graph.mjs";

/** @param {string} name */
function fixture(name) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../parity/fixtures/${name}`, import.meta.url)), "utf8"));
}

// The fixtures' _notes flag these as design-accepted divergence: eemeli parsed
// them, the vendored subset must THROW (parseMeta maps the throw to an empty
// Meta, which is the §Q3 "bounded delta" for hand-edited exotica).
const SUBSET_MUST_THROW = new Set([
  "nested-flow-seq",
  "nested-flow-map-in-seq",
  "yaml-directive",
  "anchor-and-alias",
  "core-tag",
  "custom-tag",
  "block-scalar-literal",
  "block-scalar-folded",
]);

/**
 * Fixture values encode Infinity/-Infinity/NaN as {"$nonJson": ...}; decode
 * them back so deep-equality sees the real numbers.
 * @param {unknown} v
 * @returns {unknown}
 */
function decodeNonJson(v) {
  if (Array.isArray(v)) return v.map(decodeNonJson);
  if (v && typeof v === "object") {
    const o = /** @type {Record<string, unknown>} */ (v);
    if (typeof o.$nonJson === "string") {
      return { Infinity: Infinity, "-Infinity": -Infinity, NaN: NaN }[o.$nonJson];
    }
    return Object.fromEntries(Object.entries(o).map(([k, val]) => [k, decodeNonJson(val)]));
  }
  return v;
}

test("yaml-stringify fixtures: serializeMeta is byte-identical to yaml@2.9.0 on every row (Tier 1 + Tier 2)", () => {
  const { cases } = fixture("yaml-stringify.json");
  assert.ok(cases.length >= 30, "fixture corpus present");
  for (const c of cases) {
    assert.equal(serializeMeta(c.input), c.output, `case ${c.name}`);
  }
});

test("yaml-parse fixtures: value-or-throw parity with yaml@2.9.0, subset throws on the flagged exotica", () => {
  const { cases } = fixture("yaml-parse.json");
  assert.ok(cases.length >= 66, "fixture corpus present");
  for (const c of cases) {
    const wantThrow = c.throws === true || SUBSET_MUST_THROW.has(c.name);
    if (wantThrow) {
      assert.throws(() => parseYamlLite(c.raw), `case ${c.name} must throw`);
    } else {
      assert.deepEqual(parseYamlLite(c.raw), decodeNonJson(c.value), `case ${c.name}`);
    }
  }
});

test("yaml-roundtrip-real fixtures: real store files parse to eemeli's value and round-trip byte-for-byte", () => {
  const { files } = fixture("yaml-roundtrip-real.json");
  assert.equal(files.length, 10, "all ten real files present");
  for (const f of files) {
    assert.deepEqual(parseYamlLite(f.rawBytes), f.parsedValue, `${f.relativeName} parse value`);
    assert.equal(serializeMeta(parseMeta(f.rawBytes)), f.rawBytes, `${f.relativeName} byte round-trip`);
  }
});

test("property: parse(serialize(meta)) deep-equals meta for generated canonical Metas", () => {
  /** @type {Array<{ related: Array<{ path: string, tags: string[] }> }>} */
  const metas = [
    { related: [] },
    { related: [{ path: "a", tags: ["b"] }] },
    { related: [{ path: "src/x.mts", tags: [] }] }, // tag-less edge -> `tags: []`
    {
      related: [
        { path: ".claude/settings.json", tags: ["config"] },
        { path: "@types/node/index.d.ts", tags: ["type"] }, // Tier-2 quoted path
        { path: "docs/a b c.md", tags: ["doc"] }, // internal spaces stay plain
        { path: "src/deep/e/f/g.mts", tags: ["consumer", "test", "type"] },
      ],
    },
  ];
  for (const meta of metas) {
    assert.deepEqual(parseMeta(serializeMeta(meta)), meta);
  }
});

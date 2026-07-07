// Differential fixture generator: yaml-stringify.json (design-code-reviewer §Q3 tests item 2).
//
// MUST be run from inside the reference checkout (cwd = <ref-checkout>),
// which has the real `yaml` package installed — the library is resolved from the
// CURRENT WORKING DIRECTORY, not from Omnium:
//
//   cd <ref-checkout> && node /path/to/Omnium/tests/parity/fixtures/generators/gen-yaml-stringify.mjs
//
// Records { input Meta object -> yaml.stringify({related}, {lineWidth: 0}) exact bytes }
// across the plain-safe scalar domain. The vendored Meta emitter must reproduce
// every output byte-for-byte (Tier 1 of the compat bar).

import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(join(process.cwd(), "package.json"));
const yaml = require("yaml");
const yamlVersion = require("yaml/package.json").version;

/** @type {Array<{name: string, input: {related: Array<{path: string, tags: string[]}>}}>} */
const cases = [
  // --- empty related ---
  { name: "empty-related", input: { related: [] } },

  // --- single edge, single tag (the modal real-store shape) ---
  { name: "single-edge-single-tag", input: { related: [{ path: "src/bar.ts", tags: ["type"] }] } },
  { name: "single-edge-test-tag", input: { related: [{ path: "tests/foo.test.mts", tags: ["test"] }] } },

  // --- multi-tag edges (2..5 tags) ---
  { name: "edge-2-tags", input: { related: [{ path: "src/bar.ts", tags: ["consumer", "type"] }] } },
  { name: "edge-3-tags", input: { related: [{ path: "src/mcp/handlers.mts", tags: ["consumer", "doc", "type"] }] } },
  { name: "edge-4-tags", input: { related: [{ path: "src/common/engine.mts", tags: ["config", "consumer", "doc", "type"] }] } },
  { name: "edge-5-tags-cap", input: { related: [{ path: "src/common/storage.mts", tags: ["a", "b", "c", "d", "e"] }] } },
  { name: "edge-5-real-tags-cap", input: { related: [{ path: "src/x.mts", tags: ["config", "consumer", "doc", "test", "type"] }] } },

  // --- multiple edges, mixed tag counts ---
  {
    name: "three-edges-mixed-tags",
    input: {
      related: [
        { path: "DESIGN.md", tags: ["doc"] },
        { path: "src/common/graph.mts", tags: ["consumer", "type"] },
        { path: "tests/common/graph.test.mts", tags: ["test"] },
      ],
    },
  },
  {
    name: "nine-edges-like-real-design-md",
    input: {
      related: [
        { path: "src/claude/hook.mts", tags: ["doc"] },
        { path: "src/common/config.mts", tags: ["doc"] },
        { path: "src/common/engine.mts", tags: ["doc"] },
        { path: "src/common/graph-store.mts", tags: ["doc"] },
        { path: "src/common/graph.mts", tags: ["doc"] },
        { path: "src/common/session.mts", tags: ["doc"] },
        { path: "src/common/storage.mts", tags: ["doc"] },
        { path: "src/mcp/handlers.mts", tags: ["doc"] },
        { path: "src/mcp/server.mts", tags: ["doc"] },
      ],
    },
  },

  // --- deep paths ---
  { name: "deep-path-6-segments", input: { related: [{ path: "src/claude/plugin/mcp/servers/main.json", tags: ["config"] }] } },
  { name: "deep-path-8-segments", input: { related: [{ path: "a/b/c/d/e/f/g/h.mts", tags: ["type"] }] } },
  { name: "deep-path-assets", input: { related: [{ path: "src/web/assets/js/components/index.js", tags: ["consumer"] }] } },

  // --- @- and .-leading segments ---
  { name: "at-leading-segment", input: { related: [{ path: "@scope/pkg/index.ts", tags: ["type"] }] } },
  { name: "at-leading-nested", input: { related: [{ path: "src/@internal/util.mts", tags: ["consumer"] }] } },
  { name: "dot-leading-segment", input: { related: [{ path: ".claude/settings.json", tags: ["config"] }] } },
  { name: "dot-leading-nested", input: { related: [{ path: ".graphyne/meta/src/x.mts.yaml", tags: ["doc"] }] } },
  { name: "dot-plugin-dir", input: { related: [{ path: ".claude-plugin/marketplace.json", tags: ["config"] }] } },

  // --- single-char names ---
  { name: "single-char-path", input: { related: [{ path: "a", tags: ["doc"] }] } },
  { name: "single-char-segments", input: { related: [{ path: "a/b/c", tags: ["t"] }] } },
  { name: "single-char-tag", input: { related: [{ path: "src/x.mts", tags: ["x"] }] } },

  // --- dots / dashes / underscores in names ---
  { name: "dotted-filename", input: { related: [{ path: "src/my.file.name.md", tags: ["doc"] }] } },
  { name: "dashed-filename", input: { related: [{ path: "scripts/build-plugin.mjs", tags: ["consumer"] }] } },
  { name: "underscored-filename", input: { related: [{ path: "tests/foo_bar_test.py", tags: ["test"] }] } },
  { name: "mixed-punct-filename", input: { related: [{ path: "src/foo-bar_baz.test.v2.mts", tags: ["test"] }] } },
  { name: "dashed-tag", input: { related: [{ path: "src/web/server.mts", tags: ["http-client"] }] } },
  { name: "underscore-leading-file", input: { related: [{ path: "src/_internal/_util.mts", tags: ["consumer"] }] } },

  // --- numeric-looking but plain-safe (contain non-digits) ---
  { name: "digits-in-segments", input: { related: [{ path: "src2/v2/file2.ts", tags: ["type"] }] } },
  { name: "semver-ish-dirname", input: { related: [{ path: "vendor/lib-1.2.3/index.js", tags: ["consumer"] }] } },

  // --- combined stress: many edges, deep + dot + @ paths, tag fan-out ---
  {
    name: "combined-stress",
    input: {
      related: [
        { path: ".claude/commands/init.md", tags: ["doc"] },
        { path: "@types/node/index.d.ts", tags: ["type"] },
        { path: "a", tags: ["b", "c"] },
        { path: "src/a/b/c/d/e.mts", tags: ["config", "consumer", "doc", "test", "type"] },
        { path: "tests/x_y-z.test.mts", tags: ["test"] },
      ],
    },
  },
];

const fixture = {
  _notes:
    "Oracle: yaml@" + yamlVersion + " stringify({related}, {lineWidth: 0}) exact bytes. " +
    "Inputs are pre-canonicalized Metas (edges/tags sorted). Cases marked tier2QuoteStyle: true " +
    "contain a scalar eemeli quotes (observed: only @-LEADING scalars; @ is a YAML reserved " +
    "indicator, so they fall outside the plain-safe domain) — they capture eemeli's actual " +
    "Tier-2 quote-style pick (double quotes, per design §Open questions). All other cases are " +
    "plain-safe and the vendored Meta emitter must match `output` byte-for-byte (Tier 1). " +
    "Generated by gen-yaml-stringify.mjs run inside the reference checkout.",
  library: "yaml",
  version: yamlVersion,
  cases: cases.map(({ name, input }) => {
    const output = yaml.stringify({ related: input.related }, { lineWidth: 0 });
    const quoted = output.includes('"') || output.includes("'");
    return quoted ? { name, tier2QuoteStyle: true, input, output } : { name, input, output };
  }),
};

const out = new URL("../yaml-stringify.json", import.meta.url);
writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n");
console.log(`wrote ${out.pathname}: ${fixture.cases.length} cases (yaml@${yamlVersion})`);

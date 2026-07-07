// Per-project config at `<repoRoot>/graphyne.json` (committed). It declares the
// test commands Graphyne runs and the globs that classify files:
//
//   {
//     "name": "My Project",
//     "source": ["src/**/*.ts"],                 // files under the TDD gate
//     "exclude": ["**/*.test.ts", "**/*.d.ts"],  // out of the TDD gate (still tracked)
//     "tests":  ["**/*.test.ts"],                // which files ARE tests
//     "docs":   ["**/*.md"],                     // docs: not gated, must carry meta
//     "specs":  ["spec/**/*.md"],                // specs the code must conform to
//     "metaExclude": ["**/*.json"],              // tracked, but edits need no meta
//     "ignore": ["dist/**", ".memosyne/**"],     // out of scope ENTIRELY
//     "test": { "file": "npm test -- {test}", "all": "npm test", "timeoutMs": 600000 }
//   }
//
// Three tiers of "back off", from softest to hardest: `metaExclude` (tracked, but
// editing needs no meta) < `exclude` (out of the TDD gate, still tracked + classified)
// < `ignore` (invisible: never gated, classified, meta-required, or flagged). Reads are
// lenient: a missing or malformed file yields safe empty defaults so a bad config never
// crashes the server or hook (it just disables gating).

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { matchesAny } from "./globs.mjs";
import { normalizeRel, isShellSafeRel } from "./paths.mjs";

export const CONFIG_FILENAME = "graphyne.json";

/**
 * `timeoutMs` caps a single test run (the runner applies its own generous
 * default when unset) so a hanging command cannot wedge the serial MCP queue.
 * @typedef {{ file?: string, all?: string, timeoutMs?: number }} TestCommands
 */

/**
 * @typedef {object} Config
 * @property {string} [name]
 * @property {string[]} source
 * @property {string[]} exclude
 * @property {string[]} tests
 * @property {string[]} metaExclude
 * @property {string[]} docs Documentation files (.md). NOT under the TDD gate, but required
 *   to carry meta (overrides metaExclude) so they participate in the graph. Globs are matched
 *   against repo-relative paths, so root files like "README.md" match natively — no directory
 *   scoping is involved.
 * @property {string[]} specs Specification files (.md) the code must conform to. Same
 *   gate/meta treatment as `docs`; the doc-vs-spec distinction (truth direction) lives in edge tags.
 * @property {string[]} ignore Paths Graphyne IGNORES entirely — never gated, never classified
 *   (doc/spec/test), never required to carry meta, never flagged as a neighbor. The "out of
 *   scope" tier: vendored/generated trees and foreign stores (node_modules, dist, .memosyne,
 *   the plugin command tree). Distinct from `exclude` (out of the TDD gate only, still tracked)
 *   and `metaExclude` (tracked, but no meta required).
 * @property {TestCommands} test
 */

/** @type {Config} */
export const DEFAULT_CONFIG = {
  source: [],
  exclude: [],
  tests: [],
  metaExclude: [],
  docs: [],
  specs: [],
  ignore: [],
  test: {},
};

// Graphyne's own store and config are ALWAYS ignored: never project source, never
// classified, never required to carry meta — regardless of the user's globs.
const ALWAYS_EXEMPT = [".graphyne/**", CONFIG_FILENAME];

/** @param {string} root */
export function configPath(root) {
  return join(root, CONFIG_FILENAME);
}

/**
 * @param {unknown} v
 * @returns {string[]}
 */
function asStringArray(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
}

/**
 * @param {string} root
 * @returns {Config}
 */
export function readConfig(root) {
  const p = configPath(root);
  if (!existsSync(p)) return { ...DEFAULT_CONFIG };
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
  if (!parsed || typeof parsed !== "object") return { ...DEFAULT_CONFIG };
  const o = /** @type {Record<string, unknown>} */ (parsed);
  const test = o.test && typeof o.test === "object" ? /** @type {Record<string, unknown>} */ (o.test) : {};
  return {
    name: typeof o.name === "string" ? o.name : undefined,
    source: asStringArray(o.source),
    exclude: asStringArray(o.exclude),
    tests: asStringArray(o.tests),
    metaExclude: asStringArray(o.metaExclude),
    docs: asStringArray(o.docs),
    specs: asStringArray(o.specs),
    ignore: asStringArray(o.ignore),
    test: {
      file: typeof test.file === "string" ? test.file : undefined,
      all: typeof test.all === "string" ? test.all : undefined,
      timeoutMs:
        typeof test.timeoutMs === "number" && Number.isInteger(test.timeoutMs) && test.timeoutMs > 0
          ? test.timeoutMs
          : undefined,
    },
  };
}

/**
 * Whether Graphyne IGNORES `p` entirely (built-in store/config ∪ the user's
 * `ignore` globs). Operates on an already-normalized path. The "Graphyne can't see
 * it" tier — distinct from `exclude` (out of the TDD gate only) and `metaExclude`
 * (no meta required, but still tracked).
 * @param {Config} config
 * @param {string} p
 * @returns {boolean}
 */
function ignored(config, p) {
  return matchesAny(p, ALWAYS_EXEMPT) || matchesAny(p, config.ignore);
}

/**
 * Public form of {@link ignored}: never gated, never classified, never needs meta,
 * never flagged as a neighbor.
 * @param {Config} config
 * @param {string} rel
 * @returns {boolean}
 */
export function isIgnored(config, rel) {
  return ignored(config, normalizeRel(rel));
}

/**
 * A doc or spec file: a first-class graph participant that is NEVER under the TDD
 * gate but IS required to carry meta (overriding metaExclude). Ignored paths are
 * not classified. `exclude` does NOT carve docs (it is gate-only); use `ignore` to
 * drop a `.md` from doc/spec classification.
 * @param {Config} config
 * @param {string} p
 * @returns {boolean}
 */
function isDocClass(config, p) {
  if (ignored(config, p)) return false;
  return matchesAny(p, config.docs) || matchesAny(p, config.specs);
}

/**
 * A production file under the TDD gate: matches `source`, not `exclude`, not
 * ignored, and not a doc/spec file (those are never gated even if a broad source
 * glob catches them). (A test file can also match source; the gate exempts tests
 * separately — see the gate logic, which checks isTestFile first.)
 * @param {Config} config
 * @param {string} rel
 * @returns {boolean}
 */
export function isGatedSource(config, rel) {
  const p = normalizeRel(rel);
  if (ignored(config, p)) return false;
  if (isDocClass(config, p)) return false;
  return matchesAny(p, config.source) && !matchesAny(p, config.exclude);
}

/**
 * Whether `rel` is a test file (matches the `tests` globs and is not ignored).
 * @param {Config} config
 * @param {string} rel
 * @returns {boolean}
 */
export function isTestFile(config, rel) {
  const p = normalizeRel(rel);
  if (ignored(config, p)) return false;
  return matchesAny(p, config.tests);
}

/**
 * Whether `rel` is a documentation file (matches `docs`, not ignored).
 * @param {Config} config
 * @param {string} rel
 * @returns {boolean}
 */
export function isDocFile(config, rel) {
  const p = normalizeRel(rel);
  if (ignored(config, p)) return false;
  return matchesAny(p, config.docs);
}

/**
 * Whether an edited file is required to carry a meta entry before Stop: any file
 * that isn't ignored and isn't matched by `metaExclude` — but doc/spec files always
 * need meta (they override metaExclude so docs join the graph). `ignore` exempts
 * here too, so a fully-ignored file never needs meta regardless of metaExclude.
 * @param {Config} config
 * @param {string} rel
 * @returns {boolean}
 */
export function needsMeta(config, rel) {
  const p = normalizeRel(rel);
  if (ignored(config, p)) return false;
  if (isDocClass(config, p)) return true;
  return !matchesAny(p, config.metaExclude);
}

/**
 * The shell command to run a single test file, or null if not configured.
 * Substitutes every `{test}` placeholder with the test's repo-relative path.
 * @param {Config} config
 * @param {string} testRel
 * @returns {string | null}
 */
export function testFileCommand(config, testRel) {
  if (!config.test.file) return null;
  const rel = normalizeRel(testRel);
  // The template is trusted; the substituted path is not. Reject any path
  // carrying shell metacharacters BEFORE it is spliced into the shell:true
  // command — otherwise a poisoned path (direct arg, or a covering-test edge
  // read from committed .graphyne/meta) would inject commands. Throw rather
  // than return null: null already means "no test.file configured" (a benign
  // "add a command" message), whereas a poisoned value must be a hard denial.
  if (!isShellSafeRel(rel)) {
    throw new Error(
      `Refusing to build a test command for unsafe path ${JSON.stringify(testRel)}: a test ` +
        `path substituted into the shell command may contain only [A-Za-z0-9._/-] (no spaces ` +
        `or shell metacharacters). Rejected as a command-injection risk.`,
    );
  }
  return config.test.file.replaceAll("{test}", rel);
}

/**
 * The shell command to run the whole suite, or null if not configured.
 * @param {Config} config
 * @returns {string | null}
 */
export function testAllCommand(config) {
  return config.test.all ?? null;
}

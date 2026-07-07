// The graph model + its canonical YAML (de)serialization. A meta file describes
// ONE node's edges and nothing else — deliberately minimal:
//
//   related:
//     - path: test/foo.test.ts
//       tags: [test]
//     - path: src/bar.ts
//       tags: [type, consumer]   # an edge may carry several tags (up to 5)
//
// The node's own path is DERIVED from the meta file's location (see storage), so
// there is no redundant `file:` field, and no free-text `note:` to corrupt or
// merge-conflict. Edges are undirected: the link orchestrator (graph-store)
// writes the same edge into both endpoints' meta files.
//
// Reading goes through the vendored subset parser (yaml-lite.mjs); writing
// through the dedicated emitter below, which is byte-identical to what
// `yaml@2` stringify({related}, {lineWidth: 0}) produced for every plain-safe
// scalar (design-code-reviewer.md §Q3 Tier 1) — mixed-version checkouts must
// never see serialization churn in committed meta files. Exotic scalars fall
// back to JSON.stringify double-quoting, eemeli's observed Tier-2 pick.

import { parseYamlLite, resolvePlainScalar } from "./yaml-lite.mjs";
import { normalizeRel, isSafeRel } from "./paths.mjs";
import { foldPathCase } from "./path-key.mjs";

/** @typedef {{ path: string, tags: string[] }} Edge */
/** @typedef {{ related: Edge[] }} Meta */

/** @type {Meta} */
export const EMPTY_META = { related: [] };

/** An edge may carry several tags, but not unbounded: a relation is described by a
 *  small set of one-word labels, not a free-form tag soup. Enforced on the active
 *  write path (mergeEdge); parseMeta stays lenient on hand-edited committed files. */
export const MAX_TAGS_PER_EDGE = 5;

/**
 * Canonicalize a tag: trimmed, lowercased, internal whitespace collapsed to a
 * single hyphen (tags are one-word labels). Empty after trimming -> "".
 * @param {string} raw
 * @returns {string}
 */
export function normalizeTag(raw) {
  return String(raw).trim().toLowerCase().replace(/\s+/g, "-");
}

/**
 * @param {unknown} tags
 * @returns {string[]}
 */
function cleanTags(tags) {
  if (!Array.isArray(tags)) return [];
  const out = new Set();
  for (const t of tags) {
    if (typeof t !== "string" && typeof t !== "number") continue;
    const tag = normalizeTag(String(t));
    if (tag) out.add(tag);
  }
  return [...out].sort();
}

/**
 * Merge `edge` into `meta.related`: dedupe by path (unioning tags), drop a
 * self-edge to `self` when given. Returns a new Meta (sorted, canonical).
 * The dedup key folds path case on case-insensitive platforms (foldPathCase),
 * so a differently-cased spelling of the same file collapses to ONE edge; the
 * map value keeps the FIRST-SEEN real spelling, so the emitted/committed path
 * is display-preserving. `platform` is injectable for tests (defaults to host).
 * @param {Meta} meta
 * @param {Edge} edge
 * @param {string} [self]
 * @param {string} [platform]
 * @returns {Meta}
 */
export function mergeEdge(meta, edge, self, platform) {
  /** @type {Map<string, { path: string, tags: Set<string> }>} */
  const byPath = new Map();
  for (const e of meta.related) {
    const k = foldPathCase(e.path, platform);
    const entry = byPath.get(k) ?? { path: e.path, tags: new Set() };
    for (const t of e.tags) entry.tags.add(t);
    byPath.set(k, entry);
  }
  const key = foldPathCase(edge.path, platform);
  const existing = byPath.get(key) ?? { path: edge.path, tags: new Set() };
  for (const t of edge.tags) existing.tags.add(t);
  if (existing.tags.size > MAX_TAGS_PER_EDGE) {
    throw new Error(
      `Edge to "${edge.path}" would carry ${existing.tags.size} tags ` +
        `(${[...existing.tags].sort().join(", ")}); the maximum is ${MAX_TAGS_PER_EDGE} tags per edge.`,
    );
  }
  byPath.set(key, existing);
  return finalize(byPath, self, platform);
}

/**
 * Remove the edge to `path`. Returns the new Meta and whether anything changed.
 * Matching folds path case on case-insensitive platforms, so a differently-cased
 * spelling still removes the edge. `platform` is injectable for tests.
 * @param {Meta} meta
 * @param {string} path
 * @param {string} [platform]
 * @returns {{ meta: Meta, removed: boolean }}
 */
export function removeEdge(meta, path, platform) {
  const targetKey = foldPathCase(normalizeRel(path), platform);
  const kept = meta.related.filter((e) => foldPathCase(e.path, platform) !== targetKey);
  return { meta: { related: kept }, removed: kept.length !== meta.related.length };
}

/**
 * @param {Map<string, { path: string, tags: Set<string> }>} byPath keyed by folded path key; value keeps the real spelling
 * @param {string} [self]
 * @param {string} [platform]
 * @returns {Meta}
 */
function finalize(byPath, self, platform) {
  /** @type {Edge[]} */
  const related = [];
  const selfKey = self === undefined ? undefined : foldPathCase(self, platform);
  for (const [key, entry] of byPath) {
    if (!entry.path || key === selfKey) continue; // drop self-loops (case-folded) and empties
    related.push({ path: entry.path, tags: [...entry.tags].sort() });
  }
  related.sort((a, b) => a.path.localeCompare(b.path));
  return { related };
}

/**
 * Parse meta YAML leniently: a missing/garbled file, or a missing `related`,
 * yields an empty graph rather than throwing — the meta files are committed and
 * may be hand-edited, so a single bad file must never break the whole graph.
 * Each edge is canonicalized (path normalized + safety-checked, tags cleaned),
 * deduped by path (case-folded on case-insensitive platforms; first-seen spelling
 * kept), and self-edges to `self` dropped. `platform` is injectable for tests.
 * @param {string} raw
 * @param {string} [self]
 * @param {string} [platform]
 * @returns {Meta}
 */
export function parseMeta(raw, self, platform) {
  /** @type {unknown} */
  let doc;
  try {
    doc = parseYamlLite(raw);
  } catch {
    return { related: [] };
  }
  if (!doc || typeof doc !== "object") return { related: [] };
  const rel = /** @type {Record<string, unknown>} */ (doc).related;
  if (!Array.isArray(rel)) return { related: [] };

  /** @type {Map<string, { path: string, tags: Set<string> }>} */
  const byPath = new Map();
  for (const item of rel) {
    if (!item || typeof item !== "object") continue;
    const rawPath = /** @type {Record<string, unknown>} */ (item).path;
    if (typeof rawPath !== "string") continue;
    const path = normalizeRel(rawPath);
    if (!isSafeRel(path)) continue;
    const tags = cleanTags(/** @type {Record<string, unknown>} */ (item).tags);
    const k = foldPathCase(path, platform);
    const entry = byPath.get(k) ?? { path, tags: new Set() };
    for (const t of tags) entry.tags.add(t);
    byPath.set(k, entry);
  }
  return finalize(byPath, self, platform);
}

// #region Meta emitter (the §Q3 serializer spec)

// First characters that force quoting: YAML indicator characters, plus `-`,
// `?`, `:` when followed by space-or-end (handled separately below).
const UNSAFE_FIRST_CHARS = new Set([
  "#", "&", "*", "!", "|", ">", "'", '"', "%", "@", "`", "[", "]", "{", "}", ",",
]);

/**
 * Whether `scalar` can be emitted as a bare (plain) YAML scalar and re-read
 * as the SAME string by both eemeli `yaml` and the vendored parser — the §Q3
 * plain-safe rule. Everything in both real stores is plain-safe; the quoted
 * fallback (Tier 2) exists for pathological filenames only.
 * @param {string} scalar
 * @returns {boolean}
 */
function isPlainSafe(scalar) {
  if (scalar === "") return false;
  if (scalar !== scalar.trim()) return false; // leading/trailing whitespace
  if (/[\u0000-\u001f\u007f]/.test(scalar)) return false; // TAB/newline/control chars
  const first = scalar[0];
  if (UNSAFE_FIRST_CHARS.has(first)) return false;
  if ((first === "-" || first === "?" || first === ":") && (scalar.length === 1 || scalar[1] === " ")) {
    return false;
  }
  if (scalar.includes(": ") || scalar.endsWith(":") || scalar.includes(" #")) return false;
  // A scalar that core-schema-resolves to null/bool/number would come back as
  // the wrong TYPE if emitted bare — quote it. yes/no/on/off are strings in
  // YAML 1.2 core, so they deliberately stay bare (eemeli agrees).
  return typeof resolvePlainScalar(scalar) === "string";
}

/**
 * Emit one scalar: bare when plain-safe, else JSON double-quoting — the
 * Tier-2 style eemeli was observed to pick (fixtures record `"@scope/..."`).
 * @param {string} scalar
 * @returns {string}
 */
function emitScalar(scalar) {
  return isPlainSafe(scalar) ? scalar : JSON.stringify(scalar);
}

/**
 * Serialize a Meta to canonical YAML — sorted edges and tags, so two equivalent
 * graphs produce byte-identical files (clean diffs, no merge churn). The output
 * is byte-identical to the prior `yaml.stringify({related}, {lineWidth: 0})`
 * for the plain-safe domain: 2-space indent ladder, LF only, trailing newline,
 * `related: []` for the empty case.
 * @param {Meta} meta
 * @returns {string}
 */
export function serializeMeta(meta) {
  const related = [...meta.related]
    .map((e) => ({ path: e.path, tags: [...e.tags].sort() }))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (related.length === 0) return "related: []\n";
  let out = "related:\n";
  for (const edge of related) {
    out += `  - path: ${emitScalar(edge.path)}\n`;
    if (edge.tags.length === 0) {
      out += "    tags: []\n";
    } else {
      out += "    tags:\n";
      for (const tag of edge.tags) out += `      - ${emitScalar(tag)}\n`;
    }
  }
  return out;
}

// #endregion Meta emitter

/**
 * All edges of `meta` carrying `tag`.
 * @param {Meta} meta
 * @param {string} tag
 * @returns {Edge[]}
 */
export function edgesWithTag(meta, tag) {
  const t = normalizeTag(tag);
  return meta.related.filter((e) => e.tags.includes(t));
}

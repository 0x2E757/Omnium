// Pure full-text search primitives shared by the MCP tool (regex search over
// summary + description) and the web App's plain-word filter (in the standalone
// install; the plugin ships only the MCP consumer). No I/O here — callers
// read/parse tasks themselves and hand a compiled RegExp to firstHit.

/** @typedef {{ section: "summary" | "description", snippet: string }} SearchHit */

// How much surrounding context (characters) to keep on each side of a match.
export const SNIPPET_PAD = 60;

/**
 * A whitespace-collapsed excerpt of `text` around [idx, idx+len), padded by
 * SNIPPET_PAD on each side and ellipsised where it was clipped.
 * @param {string} text
 * @param {number} idx
 * @param {number} len
 */
export function snippetAround(text, idx, len) {
  const start = Math.max(0, idx - SNIPPET_PAD);
  const end = Math.min(text.length, idx + len + SNIPPET_PAD);
  const slice = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${slice}${end < text.length ? "…" : ""}`;
}

/**
 * First match of `re` in the task — summary (the headline) before description —
 * as a section + snippet, or null. `re` must carry no `g` flag so exec stays
 * stateless and the same instance is reusable across tasks/sections. Only the
 * searchable text fields are needed, so it accepts any object carrying them (the
 * ReDoS-bounded search worker passes plain {summary, description} rows).
 * @param {RegExp} re
 * @param {{ summary: string, description: string }} t
 * @returns {SearchHit | null}
 */
export function firstHit(re, t) {
  for (const section of /** @type {const} */ (["summary", "description"])) {
    const m = re.exec(t[section]);
    if (m) return { section, snippet: snippetAround(t[section], m.index, m[0].length) };
  }
  return null;
}

/**
 * Escape a string so it matches literally inside a RegExp (no metacharacters).
 * Used by the web filter, where the query is human-typed words, not a pattern.
 * @param {string} s
 */
export function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

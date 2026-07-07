// Glob matching for the config's source/exclude/tests/metaExclude lists.
// Vendored minimal matcher replacing picomatch (DESIGN.md D5,
// design-code-reviewer.md §Q4): exactly `**` (whole-segment), `*`, `?` and
// literals, with picomatch `{dot: true}` semantics — dot files are ordinary
// characters, because the TDD gate and Stop blockers must keep seeing paths
// like `node_modules/.bin/x` and `.claude/notes.md` exactly as they always
// did. The §Q4 17-row table is the normative spec; parity with picomatch@4
// is pinned by tests/graphyne/globs.test.mjs replaying
// tests/parity/fixtures/globs.json. All inputs are canonical repo-relative
// POSIX paths (see paths.mjs), so matching is platform-independent.
//
// Non-obvious decisions, all picomatch-compat and deliberately kept:
// - a trailing `/**` also matches the BARE parent (`tests/**` matches
//   `tests`) — picomatch issue #21, kept upstream for back-compat;
// - `**` inside a segment (`foo**bar`, `a**`) is just `*` — globstar only
//   works as a whole segment;
// - unsupported punctuation (`{a,b}`, `[abc]`, `!(x)`, …) matches LITERALLY
//   (§Q4 row 16) — verified absent from every real graphyne.json;
// - there is NO dot-file special-casing anywhere: `{dot: true}` means that
//   absence IS the semantics.

import { normalizeRel } from "./paths.mjs";

// Regex metacharacters that must match themselves when they appear in a
// pattern segment (row 16: unsupported glob punctuation stays literal).
const REGEX_SPECIALS = /[.+^$()|[\]{}\\!,@]/g;

// A path segment a globstar may span: anything but a bare "." or ".." —
// picomatch's globstar never crosses those pseudo-segments even with
// dot:true (its `**` matches ".claude" but not "."), and the fixture table
// pins `**` vs "." as a miss. Single-char wildcards are NOT restricted:
// picomatch's `?` does match ".".
const GLOBSTAR_SEGMENT = "(?!\\.{1,2}(?:/|$))[^/]+";

/**
 * Translate one non-globstar pattern segment to regex source: escape
 * everything, then open up `*` (any run of non-separator chars, intra-segment
 * `**` collapsed first) and `?` (exactly one non-separator char).
 * @param {string} segment
 * @returns {string}
 */
function segmentToRegex(segment) {
  const collapsed = segment.replace(/\*{2,}/g, "*"); // `foo**bar` ≡ `foo*bar` (picomatch rule)
  let out = "";
  for (const ch of collapsed) {
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += ch.replace(REGEX_SPECIALS, "\\$&");
  }
  return out;
}

/**
 * Compile one glob pattern to an anchored RegExp implementing the §Q4 table.
 * @param {string} pattern
 * @returns {RegExp}
 */
function patternToRegExp(pattern) {
  const segments = pattern.split("/");
  let source = "^";
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === "**") {
      // Collapse runs of `**` segments — `a/**/**/b` means the same as `a/**/b`.
      // Remember where the run STARTED: the whole-pattern test below must see
      // `**/**` as `**` (run starts at segment 0), not as a trailing `/**`
      // hanging off nothing — the post-collapse index would mis-route it into
      // the strip-a-separator branch and compile a match-nothing regex.
      const runStart = i;
      while (segments[i + 1] === "**") i++;
      if (i === segments.length - 1) {
        if (runStart === 0) {
          // The whole pattern is `**`: any run of real segments (row 1).
          source += `(?:${GLOBSTAR_SEGMENT}(?:/${GLOBSTAR_SEGMENT})*)?`;
        } else {
          // Trailing `/**`: strip the separator already emitted and make the
          // whole tail optional so the bare parent matches too (row 8).
          source = source.replace(/\/$/, "");
          source += `(?:/${GLOBSTAR_SEGMENT})*`;
        }
      } else {
        // Leading/interior `**`: zero or more WHOLE segments, folding the
        // following separator into the group so zero segments works (rows 2, 10).
        source += `(?:${GLOBSTAR_SEGMENT}/)*`;
      }
      continue;
    }
    source += segmentToRegex(segment);
    if (i < segments.length - 1) source += "/";
  }
  return new RegExp(source + "$");
}

/**
 * Compile a list of glob patterns into a single matcher. An empty list matches
 * nothing. Patterns are matched against canonical POSIX paths with dotfiles
 * enabled (so `.graphyne`-style paths are reachable).
 * @param {string[]} patterns
 * @returns {(path: string) => boolean}
 */
export function compile(patterns) {
  if (!patterns || patterns.length === 0) return () => false;
  const regexes = patterns.map(patternToRegExp);
  return (path) => {
    const rel = normalizeRel(path);
    return regexes.some((re) => re.test(rel));
  };
}

/**
 * One-shot: does `path` match any of `patterns`?
 * @param {string} path
 * @param {string[]} patterns
 * @returns {boolean}
 */
export function matchesAny(path, patterns) {
  return compile(patterns)(path);
}

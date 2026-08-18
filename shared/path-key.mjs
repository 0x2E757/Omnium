// VENDORED SHARED MODULE — canonical copy: shared/path-key.mjs. Do not edit any plugins/*/common/ copy; edit shared/ and run: node scripts/sync-shared.mjs
//
// Case- and separator-normalization for path LOOKUP/DEDUP keys. A repo-relative
// path is used as a Map/object key or a membership value in several stores; on a
// case-insensitive filesystem (Windows/NTFS, default macOS APFS/HFS+) the same
// file spelled with different casing is ONE file and must resolve to ONE key,
// while on Linux (case-sensitive ext4) two differently-cased paths are genuinely
// distinct files and must NOT be conflated. Separator differences (`\` vs `/`)
// are always spurious for a repo-relative path, so they are folded unconditionally.
//
// Fold at COMPARE/lookup time only — never rewrite a stored or displayed path.
// Callers key their maps by pathKey()/foldPathCase() while keeping the original
// spelling in the value, so committed stores and user-facing output keep true
// casing (a strict no-op on Linux for correctly-cased paths).
//
// `platform` is injectable ONLY so the win32/darwin branch is unit-testable from a
// Linux CI (process.platform binds to the host); production callers omit it — the
// same injectable-platform pattern as project.mjs normalizeRoot.
//
// CASE_INSENSITIVE_PLATFORMS is the single definition of that policy in the repo:
// every consumer reaches it through a vendored copy of THIS module, so widening it
// (a new case-insensitive platform) is one edit here plus scripts/sync-shared.mjs.

import process from "node:process";

// Platforms whose DEFAULT filesystem compares paths case-insensitively (NTFS;
// APFS/HFS+). Linux (ext4) is case-sensitive and is intentionally NOT folded.
const CASE_INSENSITIVE_PLATFORMS = new Set(["win32", "darwin"]);

/**
 * Backslashes -> forward slashes. A repo-relative path is canonically POSIX, so a
 * `\`-separated spelling denotes the same path and must compare equal.
 * @param {string} p
 * @returns {string}
 */
export function toPosixSep(p) {
  return p.replace(/\\/g, "/");
}

/**
 * Fold a path's case for lookup ONLY on case-insensitive platforms; identity on
 * Linux. `toLowerCase` is not a full Unicode casefold (it misses e.g. Turkish
 * dotted-I, ß) — the same accepted approximation the rest of the codebase uses;
 * a miss degrades to the pre-existing case-sensitive behavior, never to corruption.
 * @param {string} p
 * @param {string} [platform]
 * @returns {string}
 */
export function foldPathCase(p, platform = process.platform) {
  return CASE_INSENSITIVE_PLATFORMS.has(platform) ? p.toLowerCase() : p;
}

/**
 * Canonical lookup/dedup key for a repo-relative path: separator-normalized and
 * platform-conditionally case-folded. NOT for storage or display — the caller
 * keeps the original spelling in its map value / record field.
 * @param {string} p
 * @param {string} [platform]
 * @returns {string}
 */
export function pathKey(p, platform = process.platform) {
  return foldPathCase(toPosixSep(p), platform);
}

// fold-at-COMPARE probes for a `Record<string, T>` whose keys are stored in their
// first-seen real spelling: find the entry whose key folds equal to the probe, so
// the same path under different casing resolves to the ONE stored entry on a
// case-insensitive FS, without ever rewriting a stored key. This is how the object-
// keyed session/registry stores stay display-preserving (path-key.mjs contract:
// "never rewrite a stored or displayed path") while still deduping/looking up
// case-insensitively. CASE-only fold: callers pass keys already separator-normalized
// (repo-relative via normalizeRel) or native absolute (registry, where backslashes
// must survive), so toPosixSep is intentionally NOT applied here. On Linux the fold
// is identity, so both degrade to an exact-match lookup — distinct casings stay
// distinct, matching the case-sensitive FS.

/**
 * The value in `rec` under the existing key that folds equal to `key`, else
 * undefined (behaves like `rec[key]` on Linux / for an exact hit).
 * @template T
 * @param {Record<string, T>} rec
 * @param {string} key
 * @param {string} [platform]
 * @returns {T | undefined}
 */
export function foldedGet(rec, key, platform = process.platform) {
  const found = foldedKeyOf(rec, key, platform);
  return found === undefined ? undefined : rec[found];
}

/**
 * The existing key of `rec` that folds equal to `key` (its first-seen real
 * spelling), else undefined. Use `foldedKeyOf(rec, key) ?? key` to pick the
 * write slot: reuse the stored spelling when present, else insert under `key`.
 * @template T
 * @param {Record<string, T>} rec
 * @param {string} key
 * @param {string} [platform]
 * @returns {string | undefined}
 */
export function foldedKeyOf(rec, key, platform = process.platform) {
  if (Object.hasOwn(rec, key)) return key; // exact hit: no scan (and the common case)
  const fk = foldPathCase(key, platform);
  for (const k of Object.keys(rec)) {
    if (foldPathCase(k, platform) === fk) return k;
  }
  return undefined;
}

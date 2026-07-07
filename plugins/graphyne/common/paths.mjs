// Canonical path handling. Every path Graphyne stores or compares is a
// repo-root-relative, POSIX-separated string (no leading "./", no trailing
// slash) — so a meta file written on Windows and read on Linux refers to the
// same node, and the graph keys are stable across machines and git checkouts.

import { relative, isAbsolute } from "node:path";

/**
 * Backslashes -> forward slashes (Windows paths -> POSIX).
 * @param {string} p
 * @returns {string}
 */
export function toPosix(p) {
  return p.replace(/\\/g, "/");
}

/**
 * Normalize a relative path to canonical form: POSIX separators, no leading
 * "./", collapsed duplicate slashes, no trailing slash, trimmed. Does NOT
 * validate safety — pair with isSafeRel.
 * @param {string} input
 * @returns {string}
 */
export function normalizeRel(input) {
  return toPosix(input.trim())
    .replace(/^(\.\/)+/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
}

const DRIVE_OR_ROOT_RE = /^(?:[A-Za-z]:|\/|\\)/;

/**
 * True if `p` is a safe repo-relative path: not absolute (no leading slash or
 * drive letter), and with no "." or ".." segment that could escape the root or
 * alias a node. Run this on every agent-supplied path before using it as a key.
 * @param {string} p
 * @returns {boolean}
 */
export function isSafeRel(p) {
  if (!p || DRIVE_OR_ROOT_RE.test(p)) return false;
  return !p.split("/").some((seg) => seg === "." || seg === "..");
}

// Charset of a canonical repo-relative path. Everything outside it — spaces and
// every shell metacharacter (; | & ` $ ( ) { } < > * \ ' " and newline) — is
// refused, so a path can never inject tokens when spliced into a shell:true
// command string. Shell-agnostic (safe for sh AND cmd.exe): we reject the
// dangerous bytes outright rather than trying to quote them per-platform.
const SHELL_SAFE_REL_RE = /^[A-Za-z0-9._/-]+$/;

/**
 * True if `p` (a normalized repo-relative path) is safe to substitute into a
 * shell command: it passes isSafeRel AND contains only canonical path chars.
 * The isSafeRel half preserves the no-".."/no-absolute guarantee (the regex
 * alone would accept "a/../b" since "." and "/" are in its class), so the
 * composition matters. Run this before splicing any path into a test command.
 * @param {string} p
 * @returns {boolean}
 */
export function isShellSafeRel(p) {
  return isSafeRel(p) && SHELL_SAFE_REL_RE.test(p);
}

/**
 * Convert an absolute path to a canonical repo-relative one, or null if it lies
 * outside `root`. Used by the hook, which receives absolute tool file paths.
 * @param {string} root
 * @param {string} abs
 * @returns {string | null}
 */
export function relFromAbs(root, abs) {
  const rel = normalizeRel(relative(root, abs));
  if (rel === "" || !isSafeRel(rel) || isAbsolute(rel)) return null;
  return rel;
}

/**
 * Accept either an absolute path (under `root`) or a repo-relative one and
 * return the canonical repo-relative form, or null if unsafe / outside root.
 * @param {string} root
 * @param {string} input
 * @returns {string | null}
 */
export function toRel(root, input) {
  const trimmed = input.trim();
  if (DRIVE_OR_ROOT_RE.test(toPosix(trimmed)) && isAbsolute(trimmed)) {
    return relFromAbs(root, trimmed);
  }
  const rel = normalizeRel(trimmed);
  return isSafeRel(rel) ? rel : null;
}

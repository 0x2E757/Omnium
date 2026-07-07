// Per-project storage under `<repoRoot>/.graphyne/`.
//
//   <repoRoot>/.graphyne/
//     .gitignore                  # ignores tasks/ (meta/ is committed)
//     AGENTS.md, CLAUDE.md        # guard notes: don't hand-edit, use the MCP
//     meta/                       # the graph — one <srcPath>.yaml per file, COMMITTED
//       src/foo.ts.yaml
//     tasks/<session-id>/         # session-scoped state — NOT committed
//
// A node's source path is derived from its meta file's location: strip the
// meta/ prefix and the trailing ".yaml". Every function takes the project root
// explicitly. Paths are canonical repo-relative POSIX (see paths.mjs); they are
// safety-checked here to block traversal out of the store.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { atomicWrite } from "./atomic-write.mjs";
import { join, dirname } from "node:path";

import { isSafeRel, toPosix } from "./paths.mjs";
import { withFileLock } from "./lock.mjs";

export const GRAPHYNE_DIR = ".graphyne";
export const META_SUBDIR = "meta";
export const TASKS_SUBDIR = "tasks";
export const META_EXT = ".yaml";

/** @param {string} root */
export function storeDir(root) {
  return join(root, GRAPHYNE_DIR);
}
/** @param {string} root */
export function metaDir(root) {
  return join(storeDir(root), META_SUBDIR);
}
/** @param {string} root */
export function tasksDir(root) {
  return join(storeDir(root), TASKS_SUBDIR);
}

/** @param {string} srcRel */
function assertSafe(srcRel) {
  if (!isSafeRel(srcRel)) throw new Error(`Unsafe path: ${srcRel}`);
}

/**
 * Absolute path of the meta file backing source `srcRel`.
 * @param {string} root
 * @param {string} srcRel
 * @returns {string}
 */
export function metaFilePath(root, srcRel) {
  assertSafe(srcRel);
  return join(metaDir(root), srcRel) + META_EXT;
}

/**
 * Run `fn` while holding the per-file lock for source `srcRel`. Two-sided link
 * writes nest two of these on DIFFERENT paths (safe) in a stable order.
 * @template T
 * @param {string} root
 * @param {string} srcRel
 * @param {() => T} fn
 * @returns {T}
 */
export function withMetaLock(root, srcRel, fn) {
  return withFileLock(`${metaFilePath(root, srcRel)}.lock`, fn);
}

/**
 * @param {string} root
 * @param {string} srcRel
 * @returns {boolean}
 */
export function metaExists(root, srcRel) {
  return isSafeRel(srcRel) && existsSync(metaFilePath(root, srcRel));
}

/**
 * Raw YAML text of a meta file, or null if it doesn't exist.
 * @param {string} root
 * @param {string} srcRel
 * @returns {string | null}
 */
export function readMetaRaw(root, srcRel) {
  const p = metaFilePath(root, srcRel);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8");
}

/**
 * @param {string} root
 * @param {string} srcRel
 * @param {string} raw
 */
export function writeMetaRaw(root, srcRel, raw) {
  const p = metaFilePath(root, srcRel);
  mkdirSync(dirname(p), { recursive: true });
  atomicWrite(p, raw);
}

/**
 * @param {string} root
 * @param {string} srcRel
 * @returns {boolean}
 */
export function deleteMetaFile(root, srcRel) {
  const p = metaFilePath(root, srcRel);
  if (!existsSync(p)) return false;
  rmSync(p);
  return true;
}

/**
 * Every source path that currently has a meta file (canonical POSIX, no .yaml).
 * @param {string} root
 * @returns {string[]}
 */
export function listMetaSources(root) {
  const base = metaDir(root);
  if (!existsSync(base)) return [];
  return readdirSync(base, { recursive: true })
    .map((e) => toPosix(String(e)))
    .filter((rel) => rel.endsWith(META_EXT))
    .map((rel) => rel.slice(0, -META_EXT.length))
    .filter((rel) => isSafeRel(rel))
    .sort();
}

// #region Store bootstrap (guard files, gitignore)

export const GITIGNORE_CONTENT = `\
# Graphyne session state — local to each session, never committed.
${TASKS_SUBDIR}/
`;

export const GUARD_FILENAMES = /** @type {const} */ (["AGENTS.md", "CLAUDE.md"]);

export const GUARD_CONTENT = `\
# .graphyne/ — managed by Graphyne

This directory is the Graphyne plugin's store. \`meta/\` is the committed graph of
related files; \`tasks/\` is per-session state (gitignored).

Do NOT hand-edit these files. Work with the graph EXCLUSIVELY through the Graphyne
MCP tools (graphyne_neighbors, graphyne_meta, graphyne_link, graphyne_unlink, …)
and the session state through graphyne_checklist / graphyne_review / graphyne_test.
Hand-editing risks corrupting the on-disk schema and bypasses the bidirectional
link invariant the tools maintain.
`;

/**
 * Ensure the store skeleton exists: `.graphyne/`, `meta/`, `.gitignore`, and the
 * guard files. Never overwrites an existing guard/.gitignore (the project may
 * customize them); the `.graphyne/` directory itself is the user's opt-in and is
 * created here too so first use is frictionless once the MCP/hook activate.
 * @param {string} root
 */
export function ensureStore(root) {
  mkdirSync(metaDir(root), { recursive: true });
  const gi = join(storeDir(root), ".gitignore");
  if (!existsSync(gi)) writeFileSync(gi, GITIGNORE_CONTENT);
  for (const name of GUARD_FILENAMES) {
    const p = join(storeDir(root), name);
    if (!existsSync(p)) writeFileSync(p, GUARD_CONTENT);
  }
}

// #endregion Store bootstrap

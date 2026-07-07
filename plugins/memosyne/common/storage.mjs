// Per-project task storage under `<projectRoot>/.memosyne/`.
//
//   <projectRoot>/.memosyne/
//     <stem>.md                     # one flat file per task (5 <memosyne-*> sections)
//     <stem>.lock                   # transient per-task lock (see withTaskLock)
//     config.json                   # project display config
//     AGENTS.md / CLAUDE.md         # agent guard files
//
// Every function takes the project root explicitly: the MCP server passes the
// git repo root it resolved; the App passes the absolute path from the registry.
// Stems are validated to block path traversal.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./atomic-write.mjs";
import { isTaskStem, taskFilename, stemFromFilename } from "./task.mjs";
import { withFileLock } from "./lock.mjs";

export const MEMOSYNE_DIR = ".memosyne";

/** @param {string} stem */
function assertStem(stem) {
  if (!isTaskStem(stem)) throw new Error(`Invalid task name: ${stem}`);
}

/** @param {string} root */
export function storeDir(root) {
  return join(root, MEMOSYNE_DIR);
}

/** @param {string} root @param {string} stem */
function taskFilePath(root, stem) {
  assertStem(stem);
  return join(storeDir(root), taskFilename(stem));
}

/**
 * Run `fn` while holding the per-task lock for `stem`, serializing the whole
 * read-modify-write of that task's `<stem>.md`. Different tasks lock independently.
 * The lock file is a `<stem>.lock` sibling of the task file — its name is not a
 * `<stem>.md`, so listTaskStems ignores it. NOT re-entrant: acquire once at the
 * handler boundary (see common/lock.mjs). When an op must touch TWO tasks (the
 * link/unlink handlers), acquire the locks in a fixed (sorted) order to avoid
 * deadlock — distinct lock paths nest safely.
 * @template T
 * @param {string} root
 * @param {string} stem
 * @param {() => T} fn
 * @returns {T}
 */
export function withTaskLock(root, stem, fn) {
  assertStem(stem);
  return withFileLock(join(storeDir(root), `${stem}.lock`), fn);
}

// #region Listing

/** @param {string} p */
function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Top-level task stems (the `<stem>.md` files under .memosyne/), newest first.
 * @param {string} root
 * @returns {string[]}
 */
export function listTaskStems(root) {
  const base = storeDir(root);
  if (!isDir(base)) return [];
  return readdirSync(base)
    .map((name) => stemFromFilename(name)) // null for config.json, *.lock, dirs, etc.
    .filter(/** @returns {stem is string} */ (stem) => stem !== null && existsSync(join(base, taskFilename(stem))))
    .sort()
    .reverse();
}

// #endregion Listing

// #region Read / write

/** @param {string} root @param {string} stem */
export function taskExists(root, stem) {
  return isTaskStem(stem) && existsSync(taskFilePath(root, stem));
}

/** @param {string} root @param {string} stem */
export function readTask(root, stem) {
  return readFileSync(taskFilePath(root, stem), "utf8");
}

/** @param {string} root @param {string} stem @param {string} raw */
export function writeTask(root, stem, raw) {
  mkdirSync(storeDir(root), { recursive: true });
  atomicWrite(taskFilePath(root, stem), raw);
}

/** @param {string} root @param {string} stem */
export function deleteTask(root, stem) {
  if (!taskExists(root, stem)) return false;
  rmSync(taskFilePath(root, stem));
  return true;
}

// #endregion Read / write

// #region Project config

// Per-project settings live in .memosyne/config.json (committed with the
// tasks). Currently just a display `name`; reads are lenient (a missing or
// malformed file is treated as empty) so a bad config never breaks listing.
// It is a plain file, so it is ignored by the stem-pattern task listing.
export const CONFIG_JSON = "config.json";

/** @typedef {{ name?: string }} ProjectConfig */

/** @param {string} root */
function configPath(root) {
  return join(storeDir(root), CONFIG_JSON);
}

/**
 * @param {string} root
 * @returns {ProjectConfig}
 */
export function readConfig(root) {
  const p = configPath(root);
  if (!existsSync(p)) return {};
  try {
    const parsed = /** @type {unknown} */ (JSON.parse(readFileSync(p, "utf8")));
    if (parsed && typeof parsed === "object") {
      const name = /** @type {Record<string, unknown>} */ (parsed).name;
      return typeof name === "string" ? { name } : {};
    }
  } catch {
    /* fall through to empty */
  }
  return {};
}

/** @param {string} root @param {ProjectConfig} config */
export function writeConfig(root, config) {
  mkdirSync(storeDir(root), { recursive: true });
  writeFileSync(configPath(root), `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Ensure .memosyne/config.json has a name; create it with `defaultName`
 * when missing. Never overwrites an existing name. Returns the effective config.
 * @param {string} root
 * @param {string} defaultName
 * @returns {ProjectConfig}
 */
export function ensureConfig(root, defaultName) {
  const existing = readConfig(root);
  if (existing.name !== undefined) return existing;
  /** @type {ProjectConfig} */
  const config = { name: defaultName };
  writeConfig(root, config);
  return config;
}

// #endregion Project config

// #region Agent guard files

// Files dropped into .memosyne/ so coding agents (and the CLAUDE.md / AGENTS.md
// auto-loaders that read a directory's local instructions) are told to leave the
// store alone and go through Memosyne instead. Both files share the same text.
export const GUARD_FILENAMES = ["AGENTS.md", "CLAUDE.md"];

export const GUARD_CONTENT = `\
# .memosyne/ — managed by Memosyne

This directory is the on-disk store of the Memosyne MCP server. It is an
implementation detail, not project source.

Do NOT read, write, list, or browse these files directly. Work with tasks
EXCLUSIVELY through the Memosyne MCP tools (memosyne_list_tasks, memosyne_get_task,
memosyne_create_task, memosyne_update_task, …). Reading the raw files wastes tokens and
risks corrupting the on-disk schema.
`;

/**
 * Ensure .memosyne/ contains the agent guard files (AGENTS.md, CLAUDE.md).
 * Creates any that are missing; never overwrites an existing one, so a project
 * can customize the text.
 * @param {string} root
 */
export function ensureAgentGuides(root) {
  mkdirSync(storeDir(root), { recursive: true });
  for (const name of GUARD_FILENAMES) {
    const p = join(storeDir(root), name);
    if (!existsSync(p)) writeFileSync(p, GUARD_CONTENT);
  }
}

// #endregion Agent guard files

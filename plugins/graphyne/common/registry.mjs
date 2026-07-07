// Central discovery index — the only shared state outside each repo's own
// .graphyne/. It records each project path the MCP server has operated in, plus a
// little cached metadata: whether the path is a git repo or a plain folder, and
// (for git) the current branch. Reachability and graph size are read live by the
// App; the cached vcs/branch is refreshed whenever the MCP runs in a project and
// on a forced Sync from the App.
//
// This module stays git-free: callers (MCP server, App sync) compute the vcs info
// via project.mjs and hand it in, so the registry remains a pure, easily testable
// store. Written by the MCP server, read+refreshed by the App. The store lives at
// <root>/data/registry.json, where <root> is the single Graphyne install root —
// GRAPHYNE_ROOT if set, else resolved from this file. In the prior bundle the
// resolving file sat at the plugin root, so "two levels up" landed the registry
// beside the plugin's cache directory; this module now lives in common/, so it
// climbs THREE levels to keep the registry at that same level relative to the
// shipped plugin folder (agents' stores depend on today's placement).

import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

import { atomicWrite } from "./atomic-write.mjs";
import { withFileLock } from "./lock.mjs";
import { foldedKeyOf } from "./path-key.mjs";

/**
 * @typedef {object} ProjectMeta
 * @property {string} path
 * @property {string} [id] stable unique short handle (base36), assigned on first upsert
 * @property {string} [name] display name, taken from graphyne.json
 * @property {"git" | "folder"} [kind] undefined = not yet probed
 * @property {string | null} [branch] git branch, or null when detached / no branch
 */

// Short, URL-safe, per-entry identifier. 8 base36 chars (0-9a-z, ~41 bits) —
// collisions are unlikely and re-checked against the registry on assignment.
const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const ID_LENGTH = 8;

function genId() {
  const bytes = randomBytes(ID_LENGTH);
  let s = "";
  for (let i = 0; i < ID_LENGTH; i++) s += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return s;
}

/** @param {Record<string, ProjectMeta>} projects */
function uniqueId(projects) {
  const used = new Set(Object.values(projects).map((p) => p.id));
  let id = genId();
  while (used.has(id)) id = genId();
  return id;
}

/** @typedef {{ projects: Record<string, ProjectMeta> }} RegistryFile */

// The install root locates the whole Graphyne deployment: GRAPHYNE_ROOT when set
// (the test suite points it at a temp dir to isolate the store; nothing sets it in
// production), otherwise resolved from this file's location so the registry lands
// one level above the shipped plugin folder from any cwd (see the header note on
// why common/ climbs three levels where the bundled file climbed two).
const FILE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function installRoot() {
  return process.env.GRAPHYNE_ROOT ?? FILE_ROOT;
}

export function registryPath() {
  return join(installRoot(), "data", "registry.json");
}

// A missing registry is empty; a present-but-unparseable one is an error we refuse
// to swallow — silently treating it as empty would let the next write wipe it.
// Atomic writes (writeRegistry) keep this from happening normally.
/** @returns {RegistryFile} */
function read() {
  const file = registryPath();
  if (!existsSync(file)) return { projects: {} };
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(
      `Registry at ${file} is corrupt (not valid JSON): ${err instanceof Error ? err.message : err}. ` +
        `Fix or remove the file to recover.`,
    );
  }
  return { projects: normalize(parsed) };
}

// Accepts the current shape `{ projects: { <path>: meta } }`. Any entry carrying a
// string `path` is salvaged; kind/branch/id/name are kept when present. Kept
// tolerant so a hand-edit or future shape change can't crash the reader.
/**
 * @param {unknown} parsed
 * @returns {Record<string, ProjectMeta>}
 */
function normalize(parsed) {
  /** @type {Record<string, ProjectMeta>} */
  const out = {};
  if (!parsed || typeof parsed !== "object") return out;
  const obj = /** @type {Record<string, unknown>} */ (parsed);
  if (obj.projects && typeof obj.projects === "object") {
    for (const entry of Object.values(/** @type {Record<string, unknown>} */ (obj.projects))) {
      if (!entry || typeof entry !== "object") continue;
      const e = /** @type {Record<string, unknown>} */ (entry);
      if (typeof e.path !== "string") continue;
      /** @type {ProjectMeta} */
      const meta = { path: e.path };
      if (typeof e.id === "string") meta.id = e.id;
      if (typeof e.name === "string") meta.name = e.name;
      if (e.kind === "git" || e.kind === "folder") meta.kind = e.kind;
      if (typeof e.branch === "string" || e.branch === null) meta.branch = e.branch;
      out[e.path] = meta;
    }
  }
  return out;
}

// Write the registry atomically (temp file + rename via atomic-write.mjs, so a
// reader never observes a half-written file).
/**
 * @param {string} file
 * @param {RegistryFile} reg
 */
function writeRegistry(file, reg) {
  mkdirSync(dirname(file), { recursive: true });
  atomicWrite(file, JSON.stringify(reg, null, 2));
}

// Cross-process guard for the registry's read-modify-write. Multiple writers (one
// MCP server per project + the App's sync) share one registry file; the atomic
// write keeps it intact, but without a lock a concurrent write could clobber
// another's update. One lock for the whole file serializes all writers.
/**
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
function withLock(fn) {
  return withFileLock(`${registryPath()}.lock`, fn);
}

/**
 * Every project the registry knows about.
 * @returns {ProjectMeta[]}
 */
export function listProjects() {
  return Object.values(read().projects).sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The recorded metadata for a path, or null. On a case-insensitive FS a path
 * spelled differently than when it was recorded still resolves to its entry
 * (fold-at-compare); identity on Linux.
 * @param {string} path
 * @param {string} [platform] Injectable for tests; folds path case on case-insensitive platforms.
 * @returns {ProjectMeta | null}
 */
export function getProject(path, platform) {
  const projects = read().projects;
  const key = foldedKeyOf(projects, path, platform);
  return key === undefined ? null : projects[key];
}

/**
 * Whether `path` is recorded — the App refuses to serve the .graphyne of any
 * directory not in the registry. Case-folded on a case-insensitive FS.
 * @param {string} path
 * @param {string} [platform] Injectable for tests; folds path case on case-insensitive platforms.
 * @returns {boolean}
 */
export function hasPath(path, platform) {
  return foldedKeyOf(read().projects, path, platform) !== undefined;
}

/**
 * Record or refresh a project (full replace of its fields). The entry's unique
 * `id` is assigned on first insert and preserved across refreshes. Idempotent;
 * returns the stored entry. On a case-insensitive FS a case-variant of an
 * existing path refreshes THAT entry — keyed under, and keeping, the first-seen
 * path spelling (a stored path is never rewritten); identity on Linux.
 * @param {ProjectMeta} meta
 * @param {string} [platform] Injectable for tests; folds path case on case-insensitive platforms.
 * @returns {ProjectMeta}
 */
export function upsertProject(meta, platform) {
  return withLock(() => {
    const reg = read();
    const key = foldedKeyOf(reg.projects, meta.path, platform) ?? meta.path;
    const prev = reg.projects[key];
    const id = prev?.id ?? meta.id ?? uniqueId(reg.projects);
    /** @type {ProjectMeta} */
    const entry = { ...meta, id, path: prev?.path ?? meta.path };
    reg.projects[key] = entry;
    writeRegistry(registryPath(), reg);
    return entry;
  });
}

/**
 * Forget a project path. Returns true if it was present and removed. Case-folded
 * on a case-insensitive FS, so any spelling of a recorded path removes it.
 * @param {string} path
 * @param {string} [platform] Injectable for tests; folds path case on case-insensitive platforms.
 * @returns {boolean}
 */
export function removePath(path, platform) {
  return withLock(() => {
    const reg = read();
    const key = foldedKeyOf(reg.projects, path, platform);
    if (key === undefined) return false;
    delete reg.projects[key];
    writeRegistry(registryPath(), reg);
    return true;
  });
}

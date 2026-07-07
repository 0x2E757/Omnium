// Graph operations with the bidirectional invariant. An edge is undirected, so
// every mutation writes BOTH endpoints' meta files under their locks: link adds
// the same {path, tags} to each side, unlink removes it from each. This is the
// single place the symmetry is enforced — handlers and the hook go through here,
// never poke meta files directly.

import {
  parseMeta,
  serializeMeta,
  mergeEdge,
  removeEdge,
  normalizeTag,
} from "./graph.mjs";
import {
  readMetaRaw,
  writeMetaRaw,
  withMetaLock,
  metaExists,
  metaFilePath,
  deleteMetaFile,
} from "./storage.mjs";
import { statSync } from "node:fs";
import { foldPathCase } from "./path-key.mjs";

/** @typedef {import("./graph.mjs").Meta} Meta */
/** @typedef {import("./graph.mjs").Edge} Edge */

// Per-process, stat-validated cache of parsed meta files. readMeta is the single
// read path (neighbors, the hook, engine, and the web graphPayload all went through
// it), and without a cache every call re-runs the YAML parse. As in Memosyne's
// cache there is NO cache server: the filesystem is the source of truth and
// (mtimeMs, size) is the coordination signal. Each process keeps its own Map and
// revalidates against disk, so out-of-band changes (git checkout/pull, a hand edit,
// another instance) are picked up without a daemon. Writes self-heal: writeMetaRaw
// renames atomically, so the file's mtime changes and the next read re-parses it —
// no explicit invalidation.
/** @typedef {{ mtime: number, size: number, meta: Meta }} CacheEntry */

// Keyed by the absolute meta-file path so entries from different project roots never
// collide. Module-level: lives for the process.
/** @type {Map<string, CacheEntry>} */
const metaCache = new Map();

/**
 * Read + parse a file's meta (self-edges to itself dropped). Missing -> empty.
 * Reuses the cached parse while the meta file's (mtime, size) is unchanged.
 * @param {string} root
 * @param {string} srcRel
 * @returns {Meta}
 */
export function readMeta(root, srcRel) {
  const path = metaFilePath(root, srcRel);
  let st;
  try {
    st = statSync(path);
  } catch {
    return { related: [] }; // no meta file -> empty graph (nothing to cache)
  }
  const hit = metaCache.get(path);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) {
    return hit.meta;
  }
  const raw = readMetaRaw(root, srcRel);
  const meta = raw === null ? { related: [] } : parseMeta(raw, srcRel);
  metaCache.set(path, { mtime: st.mtimeMs, size: st.size, meta });
  return meta;
}

/**
 * @param {string} root
 * @param {string} srcRel
 * @param {Meta} meta
 */
function writeMeta(root, srcRel, meta) {
  writeMetaRaw(root, srcRel, serializeMeta(meta));
}

// Lock two DIFFERENT meta files in a stable (sorted) order, so two concurrent
// links on the same pair can never deadlock. Same path -> a single lock. On a
// case-insensitive FS two case-variant spellings are the SAME meta file, so they
// must collapse to one lock too — taking two would re-lock the one file and hang
// until the stale timeout. Identity on Linux (fold is a no-op there).
/**
 * @template T
 * @param {string} root
 * @param {string} a
 * @param {string} b
 * @param {() => T} fn
 * @param {string} [platform]
 * @returns {T}
 */
function withTwoLocks(root, a, b, fn, platform) {
  if (foldPathCase(a, platform) === foldPathCase(b, platform)) return withMetaLock(root, a, fn);
  const [x, y] = [a, b].sort();
  return withMetaLock(root, x, () => withMetaLock(root, y, fn));
}

/**
 * Add an undirected edge a—b with `tags`, writing both meta files. Tags are
 * canonicalized and applied to both sides. Returns the resulting edge.
 * @param {string} root
 * @param {string} a
 * @param {string} b
 * @param {string[]} tags
 * @param {string} [platform] Injectable for tests; folds the self-link/lock comparison on case-insensitive platforms.
 * @returns {Edge}
 */
export function linkFiles(root, a, b, tags, platform) {
  if (foldPathCase(a, platform) === foldPathCase(b, platform)) throw new Error("Cannot link a file to itself.");
  const clean = [...new Set(tags.map(normalizeTag).filter(Boolean))].sort();
  return withTwoLocks(root, a, b, () => {
    const metaA = mergeEdge(readMeta(root, a), { path: b, tags: clean }, a);
    const metaB = mergeEdge(readMeta(root, b), { path: a, tags: clean }, b);
    writeMeta(root, a, metaA);
    writeMeta(root, b, metaB);
    return { path: b, tags: clean };
  }, platform);
}

/**
 * Remove the undirected edge a—b from both meta files. Returns whether anything
 * was removed. The (now possibly empty) meta files are kept, not deleted.
 * @param {string} root
 * @param {string} a
 * @param {string} b
 * @param {string} [platform] Injectable for tests; folds the same-file comparison on case-insensitive platforms.
 * @returns {boolean}
 */
export function unlinkFiles(root, a, b, platform) {
  if (foldPathCase(a, platform) === foldPathCase(b, platform)) return false;
  return withTwoLocks(root, a, b, () => {
    const ra = removeEdge(readMeta(root, a), b);
    const rb = removeEdge(readMeta(root, b), a);
    if (ra.removed) writeMeta(root, a, ra.meta);
    if (rb.removed) writeMeta(root, b, rb.meta);
    return ra.removed || rb.removed;
  }, platform);
}

/**
 * Ensure a file has a meta entry, creating an empty one if absent. Returns true
 * if it created the file. Used to satisfy the "every edited file has meta" rule
 * when a file genuinely has no links.
 * @param {string} root
 * @param {string} srcRel
 * @returns {boolean}
 */
export function ensureMeta(root, srcRel) {
  return withMetaLock(root, srcRel, () => {
    if (metaExists(root, srcRel)) return false;
    writeMeta(root, srcRel, { related: [] });
    return true;
  });
}

/**
 * The related files of `srcRel` (its edges), or [].
 * @param {string} root
 * @param {string} srcRel
 * @returns {Edge[]}
 */
export function neighbors(root, srcRel) {
  return readMeta(root, srcRel).related;
}

/**
 * Prune a deleted file from the graph: remove the reciprocal edge from EACH of its
 * neighbors' meta files (preserving the bidirectional invariant via unlinkFiles),
 * then delete the file's own (now orphan) meta. Returns the neighbor paths whose meta
 * was updated. The caller must ensure the source file is actually gone — this is graph
 * cleanup for a real deletion (see graphyne_forget), not an unlink-by-name shortcut.
 * @param {string} root
 * @param {string} srcRel
 * @returns {string[]}
 */
export function forgetFile(root, srcRel) {
  // Snapshot the edges first: unlinkFiles rewrites srcRel's meta as it goes.
  /** @type {string[]} */
  const pruned = [];
  for (const edge of neighbors(root, srcRel)) {
    if (unlinkFiles(root, srcRel, edge.path)) pruned.push(edge.path);
  }
  deleteMetaFile(root, srcRel);
  return pruned;
}

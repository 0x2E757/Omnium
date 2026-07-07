// version-guard.mjs — the bump-discipline gate for the Omnium plugins
// (DESIGN.md D8, design-monorepo-architect.md section 6.2).
//
// The plugin install cache is keyed on the version string, so any change to a
// plugin's shipped bytes MUST be accompanied by a version change or installed
// copies silently go stale. This script makes that invariant mechanical: it
// hashes every plugins/<name>/ tree (sorted relative paths plus file bytes,
// sha256) and compares against the committed stamp file .plugin-versions.json.
//
// Modes:
//   check (default) — exit non-zero listing every plugin whose tree no longer
//     matches its stamp. This mode runs inside `npm run check` and in
//     tests/omnium/manifest.test.mjs, so a stale version cannot pass the gate
//     even on a clone that never installed the git hook.
//   --fix — bump PATCH in plugins/<name>/.claude-plugin/plugin.json for each
//     changed plugin, unless the version was already hand-changed since the
//     stamp (a deliberate MINOR bump); then only the stamp is refreshed.
//     Idempotent. Wired into scripts/git-hooks/pre-commit and `npm run stamp`.
//
// Bootstrap: with no plugin directories yet, check passes and --fix writes an
// empty stamp object. Non-obvious decision: the PATCH bump edits plugin.json
// by targeted string replacement rather than a JSON round-trip, so the hand
// formatting of the shipped manifest is never disturbed by tooling.

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLUGINS_DIR = join(REPO_ROOT, 'plugins');
const STAMP_PATH = join(REPO_ROOT, '.plugin-versions.json');

/** @typedef {{ version: string, hash: string }} StampEntry */

/**
 * Prints a fatal problem and exits non-zero. Reserved for malformed inputs
 * the guard cannot reason about (missing or unparsable manifests).
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  console.error(`version-guard: ${message}`);
  process.exit(1);
}

/**
 * Lists the plugin directory names under plugins/, sorted. An absent or empty
 * plugins/ directory is the bootstrap case and yields an empty list.
 * @returns {string[]}
 */
function listPluginNames() {
  if (!existsSync(PLUGINS_DIR)) return [];
  return readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

// Editor/OS junk that can appear in a working tree without being part of the
// shipped plugin (Finder metadata, Windows thumbnails, vim/emacs swap and
// backup files). The guard hashes the working tree, so without this filter a
// stray junk file would trigger a spurious PATCH bump the moment it appears.
const JUNK_BASENAMES = new Set(['.DS_Store', 'Thumbs.db']);
const JUNK_SUFFIXES = ['.swp', '.swo', '~'];

/**
 * Decides whether a directory entry is ignorable junk rather than shipped
 * plugin content, by basename and suffix.
 * @param {string} basename
 * @returns {boolean}
 */
function isJunkFile(basename) {
  if (JUNK_BASENAMES.has(basename)) return true;
  return JUNK_SUFFIXES.some((suffix) => basename.endsWith(suffix));
}

/**
 * Recursively collects every file under a directory as sorted POSIX-style
 * relative paths, so the tree hash is independent of readdir order. Junk
 * files (see isJunkFile) are excluded from the hash.
 * @param {string} rootDir
 * @returns {string[]}
 */
function listFiles(rootDir) {
  /** @type {string[]} */
  const files = [];
  /**
   * @param {string} dir
   * @param {string} prefix
   */
  function walk(dir, prefix) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), relativePath);
      else if (entry.isFile() && !isJunkFile(entry.name)) files.push(relativePath);
    }
  }
  walk(rootDir, '');
  return files.sort();
}

/**
 * Hashes a plugin tree: sha256 over each sorted relative path and its file
 * bytes, NUL-separated so path/content boundaries cannot be confused.
 * @param {string} rootDir
 * @returns {string}
 */
function hashTree(rootDir) {
  const hash = createHash('sha256');
  for (const relativePath of listFiles(rootDir)) {
    hash.update(relativePath, 'utf8');
    hash.update(Buffer.from([0]));
    hash.update(readFileSync(join(rootDir, relativePath)));
    hash.update(Buffer.from([0]));
  }
  return hash.digest('hex');
}

/**
 * Reads the committed stamp file. A missing file is the bootstrap case and
 * reads as an empty object.
 * @returns {Record<string, StampEntry>}
 */
function readStamp() {
  if (!existsSync(STAMP_PATH)) return {};
  return /** @type {Record<string, StampEntry>} */ (
    JSON.parse(readFileSync(STAMP_PATH, 'utf8'))
  );
}

/**
 * Reads and validates the plain X.Y.Z version of one plugin from its shipped
 * manifest. Anything else (missing manifest, missing or exotic version) is a
 * hard error: the guard must not guess about the compat-critical field.
 * @param {string} name
 * @returns {{ version: string, manifestPath: string }}
 */
function readPluginVersion(name) {
  const manifestPath = join(PLUGINS_DIR, name, '.claude-plugin', 'plugin.json');
  if (!existsSync(manifestPath)) {
    fail(`plugins/${name} has no .claude-plugin/plugin.json; every plugin directory must carry a shipped manifest.`);
  }
  const manifest = /** @type {{ version?: unknown }} */ (
    JSON.parse(readFileSync(manifestPath, 'utf8'))
  );
  const version = manifest.version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    fail(`plugins/${name} declares version ${JSON.stringify(version)}; expected plain X.Y.Z semver in ${manifestPath}.`);
  }
  return { version: /** @type {string} */ (version), manifestPath };
}

/**
 * Returns the version with PATCH incremented. MINOR stays hand-managed and
 * MAJOR is banned (no-breaking-changes rule), per DESIGN.md D7/D8.
 * @param {string} version
 * @returns {string}
 */
function bumpPatch(version) {
  const [major, minor, patch] = version.split('.').map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * Rewrites the version value inside plugin.json by targeted string
 * replacement, preserving every other byte of the shipped manifest.
 * @param {string} manifestPath
 * @param {string} oldVersion
 * @param {string} newVersion
 */
function writeVersion(manifestPath, oldVersion, newVersion) {
  const text = readFileSync(manifestPath, 'utf8');
  const match = text.match(/"version"\s*:\s*"([^"]*)"/);
  if (match === null || match[1] !== oldVersion) {
    fail(`could not locate "version": "${oldVersion}" verbatim in ${manifestPath}; bump the version by hand and re-run.`);
  }
  writeFileSync(manifestPath, text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${newVersion}$2`));
}

/**
 * Check mode: reports every plugin whose tree no longer matches its stamp and
 * returns the process exit code. A hand-bumped version with a stale stamp is
 * also reported — otherwise later edits would compare against a dead hash.
 * @param {string[]} names
 * @param {Record<string, StampEntry>} stamp
 * @returns {number}
 */
function check(names, stamp) {
  /** @type {string[]} */
  const problems = [];
  for (const name of names) {
    const { version } = readPluginVersion(name);
    const stamped = stamp[name];
    if (stamped === undefined) {
      problems.push(`plugins/${name} is new and has no stamp yet; run \`npm run stamp\`.`);
      continue;
    }
    const hash = hashTree(join(PLUGINS_DIR, name));
    if (hash === stamped.hash) continue;
    if (version === stamped.version) {
      problems.push(`plugins/${name} changed without a version bump (still ${version}); run \`npm run stamp\`.`);
    } else {
      problems.push(`plugins/${name} was hand-bumped to ${version} but its stamp is stale; run \`npm run stamp\`.`);
    }
  }
  for (const name of Object.keys(stamp)) {
    if (!names.includes(name)) {
      problems.push(`.plugin-versions.json stamps "${name}" but plugins/${name} does not exist; run \`npm run stamp\`.`);
    }
  }
  if (problems.length === 0) {
    console.log(`version-guard: ${names.length} plugin(s), all trees match their stamps.`);
    return 0;
  }
  for (const problem of problems) console.error(`version-guard: ${problem}`);
  return 1;
}

/**
 * Fix mode: bumps PATCH for every changed plugin (unless the version was
 * already hand-changed since the stamp), then rewrites the stamp file.
 * Idempotent: a second run finds every hash matching and writes nothing.
 * @param {string[]} names
 * @param {Record<string, StampEntry>} stamp
 * @returns {number}
 */
function fix(names, stamp) {
  /** @type {Record<string, StampEntry>} */
  const next = {};
  for (const name of names) {
    const { version, manifestPath } = readPluginVersion(name);
    const pluginDir = join(PLUGINS_DIR, name);
    const hash = hashTree(pluginDir);
    const stamped = stamp[name];
    if (stamped === undefined) {
      next[name] = { version, hash };
      console.log(`version-guard: stamped new plugin ${name} at ${version}.`);
      continue;
    }
    if (hash === stamped.hash) {
      next[name] = stamped;
      continue;
    }
    if (version !== stamped.version) {
      // A deliberate hand bump (typically MINOR) outranks the automatic PATCH:
      // respect the manifest and only refresh the stamp.
      next[name] = { version, hash };
      console.log(`version-guard: ${name} hand-bumped ${stamped.version} -> ${version}; stamp refreshed.`);
      continue;
    }
    const bumped = bumpPatch(version);
    writeVersion(manifestPath, version, bumped);
    // Re-hash after the bump: the version edit itself changed the tree bytes,
    // and the stamp must describe the tree as committed.
    next[name] = { version: bumped, hash: hashTree(pluginDir) };
    console.log(`version-guard: ${name} content changed; PATCH bumped ${version} -> ${bumped}.`);
  }
  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  const current = existsSync(STAMP_PATH) ? readFileSync(STAMP_PATH, 'utf8') : '';
  if (serialized !== current) writeFileSync(STAMP_PATH, serialized);
  return 0;
}

const pluginNames = listPluginNames();
const stampEntries = readStamp();
process.exit(process.argv.includes('--fix') ? fix(pluginNames, stampEntries) : check(pluginNames, stampEntries));

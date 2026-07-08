// manifest.test.mjs — pins manifest coherence and the versioning discipline
// (DESIGN.md D7/D8, design-monorepo-architect.md section 8.3): every
// plugins/* directory must be listed in .claude-plugin/marketplace.json with
// a well-formed source path, marketplace entries must never carry a version
// field, each shipped plugin.json version must be plain X.Y.Z sorting
// strictly after its frozen floor from the old marketplaces, and
// scripts/version-guard.mjs check mode must pass so no stale stamp can hide.
// During the port window, marketplace entries legitimately precede their
// directories, so the entry-to-directory direction is skipped until all
// four plugin ports have landed.
//
// It also pins the naming/identity convention: every plugin.json carries a
// lowercase kebab-case name equal to its directory and NO displayName, so the
// /plugin UI shows the lowercase slug uniformly (matching Anthropic's
// first-party plugins) rather than one plugin branding a Capitalized label.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PLUGINS_DIR = join(REPO_ROOT, 'plugins');
const MARKETPLACE_PATH = join(REPO_ROOT, '.claude-plugin', 'marketplace.json');
const README_PATH = join(REPO_ROOT, 'README.md');

// Frozen floors: the last versions ever shipped from the old single-plugin
// marketplaces. Omnium versions must sort strictly after them (DESIGN.md D7).
const VERSION_FLOORS = new Map([
  ['autonomity', '0.1.5'],
  ['expertum', '0.3.5'],
  ['graphyne', '0.1.28'],
  ['memosyne', '0.1.64'],
]);

/** @typedef {{ name: string, source: string }} MarketplaceEntry */

const marketplace = /** @type {{ plugins: MarketplaceEntry[] }} */ (
  JSON.parse(readFileSync(MARKETPLACE_PATH, 'utf8'))
);
const entries = marketplace.plugins;

const pluginDirNames = existsSync(PLUGINS_DIR)
  ? readdirSync(PLUGINS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  : [];

/**
 * Compares two plain X.Y.Z versions numerically per component, returning a
 * negative, zero, or positive number in the usual comparator convention.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareSemver(a, b) {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (partsA[i] !== partsB[i]) return partsA[i] - partsB[i];
  }
  return 0;
}

test('every plugins/* directory has a marketplace.json entry', () => {
  const entryNames = new Set(entries.map((entry) => entry.name));
  const missing = pluginDirNames.filter((name) => !entryNames.has(name));
  assert.deepEqual(missing, [], `plugin directories without a marketplace entry: ${missing.join(', ')}`);
});

test('every marketplace entry source is a well-formed ./plugins/<name> path matching the entry name', () => {
  for (const entry of entries) {
    assert.match(
      entry.source,
      /^\.\/plugins\/[a-z0-9-]+$/,
      `entry "${entry.name}" has malformed source "${entry.source}"; expected "./plugins/<name>".`,
    );
    assert.equal(
      entry.source,
      `./plugins/${entry.name}`,
      `entry "${entry.name}" points at "${entry.source}" instead of its own directory.`,
    );
  }
});

// Entry-to-directory tightens to a hard assertion once all four ports land;
// until then entries whose directory does not exist yet are the CURRENT,
// intended state of the port window, so the test is skipped with a message
// rather than weakened into a silent pass.
test(
  'every marketplace entry has an existing plugins/<name> directory',
  { skip: pluginDirNames.length < VERSION_FLOORS.size ? 'port window: entries may precede their directories until all four plugin ports land' : false },
  () => {
    const missing = entries
      .map((entry) => entry.name)
      .filter((name) => !existsSync(join(PLUGINS_DIR, name)));
    assert.deepEqual(missing, [], `marketplace entries without a plugin directory: ${missing.join(', ')}`);
  },
);

test('marketplace entries carry no version field', () => {
  for (const entry of entries) {
    // A marketplace-entry version is redundant (plugin.json wins) and a known
    // update-blocking footgun; DESIGN.md D7 bans it outright.
    assert.equal(
      'version' in entry,
      false,
      `entry "${entry.name}" carries a version field; versions live only in plugin.json.`,
    );
  }
});

test('each existing plugin.json version is plain X.Y.Z and sorts strictly after its frozen floor', () => {
  for (const name of pluginDirNames) {
    const manifestPath = join(PLUGINS_DIR, name, '.claude-plugin', 'plugin.json');
    assert.ok(existsSync(manifestPath), `plugins/${name} has no .claude-plugin/plugin.json.`);
    const manifest = /** @type {{ version?: unknown }} */ (
      JSON.parse(readFileSync(manifestPath, 'utf8'))
    );
    const version = manifest.version;
    assert.equal(typeof version, 'string', `plugins/${name} plugin.json has no string version.`);
    assert.match(
      /** @type {string} */ (version),
      /^\d+\.\d+\.\d+$/,
      `plugins/${name} version ${JSON.stringify(version)} is not plain X.Y.Z semver.`,
    );
    const floor = VERSION_FLOORS.get(name);
    if (floor === undefined) continue;
    assert.ok(
      compareSemver(/** @type {string} */ (version), floor) > 0,
      `plugins/${name} version ${version} must sort strictly after its frozen floor ${floor}.`,
    );
  }
});

test('every plugin.json declares a lowercase kebab-case name matching its directory and no displayName', () => {
  for (const name of pluginDirNames) {
    const manifestPath = join(PLUGINS_DIR, name, '.claude-plugin', 'plugin.json');
    assert.ok(existsSync(manifestPath), `plugins/${name} has no .claude-plugin/plugin.json.`);
    const manifest = /** @type {{ name?: unknown, displayName?: unknown }} */ (
      JSON.parse(readFileSync(manifestPath, 'utf8'))
    );
    assert.equal(typeof manifest.name, 'string', `plugins/${name} plugin.json has no string name.`);
    assert.match(
      /** @type {string} */ (manifest.name),
      /^[a-z0-9]+(-[a-z0-9]+)*$/,
      `plugins/${name} name ${JSON.stringify(manifest.name)} is not lowercase kebab-case.`,
    );
    assert.equal(
      manifest.name,
      name,
      `plugins/${name} plugin.json name ${JSON.stringify(manifest.name)} must equal its directory name.`,
    );
    // Omnium plugins carry their lowercase name only. A displayName is a second
    // identity string to keep in sync, and diverges from Anthropic's first-party
    // convention (the /plugin UI falls back to name). Converge, do not re-add.
    assert.equal(
      'displayName' in manifest,
      false,
      `plugins/${name} declares displayName; Omnium plugins show their lowercase name in the /plugin UI.`,
    );
  }
});

// The README plugin table and its `/plugin install` block are the ONLY
// human-facing plugin rosters; marketplace.json's `plugins` array is the
// machine source of truth. Prose no longer hand-maintains a plugin count or a
// duplicated name list (they drifted — statusline was once missing from the
// table). This test is the drift guard: adding a plugin to marketplace.json
// without adding its README table row and install line (or vice-versa) fails
// here. Both README rosters are parsed straight from the shipped file.
const readmeText = readFileSync(README_PATH, 'utf8');
// Scope the table parse to the plugin table only (its `| Plugin | What it does |`
// header down to the first blank line), so a second Markdown table added to the
// README later cannot silently feed rows into this roster.
const tableStart = readmeText.indexOf('| Plugin | What it does |');
const pluginTableBlock = tableStart === -1 ? '' : readmeText.slice(tableStart).split('\n\n')[0];
const readmeTableNames = [...pluginTableBlock.matchAll(/^\| ([a-z0-9-]+) \| /gm)].map((m) => m[1]).sort();
const readmeInstallNames = [...readmeText.matchAll(/^\/plugin install ([a-z0-9-]+)@omnium\b/gm)]
  .map((m) => m[1])
  .sort();
const marketplaceNames = entries.map((entry) => entry.name).sort();

test('the README plugin table lists exactly the marketplace plugins (no drift)', () => {
  assert.deepEqual(
    readmeTableNames,
    marketplaceNames,
    'README plugin table and marketplace.json disagree; every plugin needs a table row and only real plugins may appear.',
  );
});

test('the README install block lists exactly the marketplace plugins (no drift)', () => {
  assert.deepEqual(
    readmeInstallNames,
    marketplaceNames,
    'README `/plugin install` block and marketplace.json disagree; every plugin needs an install line.',
  );
});

test('version-guard check mode passes (every plugin tree matches its stamp)', () => {
  const result = spawnSync(
    process.execPath,
    [join(REPO_ROOT, 'scripts', 'version-guard.mjs')],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  assert.equal(
    result.status,
    0,
    `version-guard check mode failed:\n${result.stdout}${result.stderr}`,
  );
});

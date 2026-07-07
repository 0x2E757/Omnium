// vendoring.test.mjs — pins the vendoring contract for the shared modules
// (MCP core, lock-core, project — every shared/*.mjs; DESIGN.md D2/D13,
// docs/development.md "Vendoring contract"). Canonical modules
// live in shared/ and are copied byte-for-byte into plugins/*/common/ by
// scripts/sync-shared.mjs; this suite is the entire enforcement mechanism:
// any copy that drifts from its canonical fails here with the first differing
// line and both sha256 digests. While the plugin ports have not landed yet,
// shared/ may have files with zero copies in existence — that state passes,
// because there is nothing to drift.
//
// The guard runs in BOTH directions: the canonical-driven comparison above,
// and an orphan scan over plugins/*/common/ — any file carrying the
// "VENDORED SHARED MODULE" marker in its first lines must have a same-name
// canonical in shared/ and byte-match it, so a stale copy whose canonical was
// deleted (or a hand-created vendored-looking file) cannot pass forever.
// Domain modules without the marker are untouched by the orphan scan.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SHARED_DIR = join(REPO_ROOT, 'shared');
const PLUGINS_DIR = join(REPO_ROOT, 'plugins');

/**
 * Lists the immediate child directory names of a directory, sorted; an
 * absent directory yields an empty list (bootstrap: no plugins yet).
 * @param {string} dir
 * @returns {string[]}
 */
function listChildDirectories(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Returns the sha256 hex digest of a buffer, for the mismatch report.
 * @param {import('node:buffer').Buffer} bytes
 * @returns {string}
 */
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Builds the human-oriented drift report: the first line where the copy
 * diverges from the canonical, plus both digests for exact identification.
 * @param {import('node:buffer').Buffer} canonicalBytes
 * @param {import('node:buffer').Buffer} copyBytes
 * @param {string} canonicalPath
 * @param {string} copyPath
 * @returns {string}
 */
function describeDrift(canonicalBytes, copyBytes, canonicalPath, copyPath) {
  const canonicalLines = canonicalBytes.toString('utf8').split('\n');
  const copyLines = copyBytes.toString('utf8').split('\n');
  const lineCount = Math.max(canonicalLines.length, copyLines.length);
  let lineNumber = lineCount;
  let canonicalLine = '<absent>';
  let copyLine = '<absent>';
  for (let i = 0; i < lineCount; i++) {
    if (canonicalLines[i] !== copyLines[i]) {
      lineNumber = i + 1;
      canonicalLine = canonicalLines[i] === undefined ? '<absent>' : canonicalLines[i];
      copyLine = copyLines[i] === undefined ? '<absent>' : copyLines[i];
      break;
    }
  }
  return [
    `${copyPath} has drifted from ${canonicalPath}; edit under shared/ and run \`npm run sync:shared\`.`,
    `first difference at line ${lineNumber}:`,
    `  canonical: ${canonicalLine}`,
    `  copy:      ${copyLine}`,
    `canonical sha256: ${sha256(canonicalBytes)}`,
    `copy sha256:      ${sha256(copyBytes)}`,
  ].join('\n');
}

const sharedFiles = existsSync(SHARED_DIR)
  ? readdirSync(SHARED_DIR).filter((name) => name.endsWith('.mjs')).sort()
  : [];
const pluginNames = listChildDirectories(PLUGINS_DIR);

test('every plugins/*/common copy of a shared module is byte-identical to its shared/ canonical', () => {
  for (const name of sharedFiles) {
    const canonicalPath = join(SHARED_DIR, name);
    const canonicalBytes = readFileSync(canonicalPath);
    for (const pluginName of pluginNames) {
      const copyPath = join(PLUGINS_DIR, pluginName, 'common', name);
      // Only existing copies are compared: a consumer whose port has not
      // landed yet has no copy, and that is a legitimate interim state.
      if (!existsSync(copyPath)) continue;
      const copyBytes = readFileSync(copyPath);
      if (!copyBytes.equals(canonicalBytes)) {
        assert.fail(describeDrift(canonicalBytes, copyBytes, canonicalPath, copyPath));
      }
    }
  }
});

// The DO-NOT-EDIT header sync-shared.mjs stamps on every canonical and copy;
// its presence is what marks a common/ file as vendored rather than domain code.
const VENDORED_MARKER = 'VENDORED SHARED MODULE';

test('every marker-carrying plugins/*/common file has a byte-identical shared/ canonical', () => {
  for (const pluginName of pluginNames) {
    const commonDir = join(PLUGINS_DIR, pluginName, 'common');
    if (!existsSync(commonDir)) continue;
    const commonFiles = readdirSync(commonDir).filter((name) => name.endsWith('.mjs')).sort();
    for (const name of commonFiles) {
      const copyPath = join(PLUGINS_DIR, pluginName, 'common', name);
      const copyBytes = readFileSync(copyPath);
      // Only the first few lines are inspected: the sync script always puts
      // the marker on line 1, and a deeper mention (e.g. in prose) must not
      // reclassify a domain module as vendored.
      const head = copyBytes.toString('utf8').split('\n').slice(0, 3).join('\n');
      if (!head.includes(VENDORED_MARKER)) continue;
      const canonicalPath = join(SHARED_DIR, name);
      assert.ok(
        existsSync(canonicalPath),
        `${copyPath} carries the "${VENDORED_MARKER}" marker but shared/${name} does not exist; ` +
          'either restore the canonical under shared/ or delete the orphaned copy.',
      );
      const canonicalBytes = readFileSync(canonicalPath);
      if (!copyBytes.equals(canonicalBytes)) {
        assert.fail(describeDrift(canonicalBytes, copyBytes, canonicalPath, copyPath));
      }
    }
  }
});

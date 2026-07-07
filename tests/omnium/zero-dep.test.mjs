// zero-dep.test.mjs — pins the zero-runtime-dependency invariant, prime
// directive 2 of DESIGN.md: plugins/<name>/ is byte-for-byte what installs,
// so an import that is not a node:* builtin or a relative path is a defect,
// and no package.json or node_modules may exist anywhere under plugins/.
// This suite turns that convention into a failing test (charter rule 11).
// It passes trivially while plugins/ is still empty during the port window.
//
// The specifier scan is regex-based on purpose: a real parser would be a
// dependency or a maintenance burden, and over-matching (for example a
// commented-out import) fails loudly, which is the safe direction for a
// guard over our own small codebase.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PLUGINS_DIR = join(REPO_ROOT, 'plugins');

// The shipped runtime is .mjs-only (DESIGN.md D3), but the guard also scans
// .js and .mts so a stray file in the wrong dialect cannot smuggle imports.
const SOURCE_EXTENSIONS = ['.mjs', '.js', '.mts'];

/**
 * Recursively lists every file, directory, and symlink under a root as
 * POSIX-style relative paths; an absent root yields empty listings
 * (bootstrap case). Symlinks are reported separately and never followed:
 * dirent type checks come from lstat semantics, so a link is neither a file
 * nor a directory here and cannot smuggle out-of-tree content past the scan.
 * @param {string} rootDir
 * @returns {{ files: string[], directories: string[], symlinks: string[] }}
 */
function listTree(rootDir) {
  /** @type {string[]} */
  const files = [];
  /** @type {string[]} */
  const directories = [];
  /** @type {string[]} */
  const symlinks = [];
  if (!existsSync(rootDir)) return { files, directories, symlinks };
  /**
   * @param {string} dir
   * @param {string} prefix
   */
  function walk(dir, prefix) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        symlinks.push(relativePath);
      } else if (entry.isDirectory()) {
        directories.push(relativePath);
        walk(join(dir, entry.name), relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  }
  walk(rootDir, '');
  return { files: files.sort(), directories: directories.sort(), symlinks: symlinks.sort() };
}

/**
 * Extracts every import/require specifier from a module's source text:
 * static imports, re-exports, bare side-effect imports, dynamic import()
 * and require() calls.
 * @param {string} source
 * @returns {string[]}
 */
function extractSpecifiers(source) {
  const patterns = [
    /^[ \t]*import\b[^;'"]*?\bfrom\s*["']([^"']+)["']/gm,
    /^[ \t]*import\s*["']([^"']+)["']/gm,
    /^[ \t]*export\b[^;'"]*?\bfrom\s*["']([^"']+)["']/gm,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  ];
  /** @type {string[]} */
  const specifiers = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.push(/** @type {string} */ (match[1]));
    }
  }
  return specifiers;
}

/**
 * Decides whether one specifier is allowed under the zero-dep rule:
 * a node:-prefixed builtin or a relative path, nothing else.
 * @param {string} specifier
 * @returns {boolean}
 */
function isAllowedSpecifier(specifier) {
  if (specifier.startsWith('./') || specifier.startsWith('../')) return true;
  return specifier.startsWith('node:') && isBuiltin(specifier);
}

const tree = listTree(PLUGINS_DIR);
const sourceFiles = tree.files.filter((file) =>
  SOURCE_EXTENSIONS.some((extension) => file.endsWith(extension)),
);

test('every import specifier under plugins/ is a node:-prefixed builtin or a relative path', () => {
  /** @type {string[]} */
  const violations = [];
  for (const file of sourceFiles) {
    const source = readFileSync(join(PLUGINS_DIR, file), 'utf8');
    for (const specifier of extractSpecifiers(source)) {
      if (!isAllowedSpecifier(specifier)) {
        violations.push(`plugins/${file} imports "${specifier}"`);
      }
    }
  }
  assert.deepEqual(violations, [], `Forbidden import specifiers found:\n${violations.join('\n')}`);
});

// A dynamic import whose argument is not a string literal (a variable, a
// template literal, a computed expression) cannot be checked by the specifier
// scan above, so it is banned outright: an unanalyzable import could load an
// absolute path outside the plugin and evade the zero-dep rule silently.
const NON_LITERAL_DYNAMIC_IMPORT = /\bimport\(\s*(?!["'])/;

test('no unanalyzable (non-literal) dynamic import exists under plugins/', () => {
  /** @type {string[]} */
  const violations = [];
  for (const file of sourceFiles) {
    const source = readFileSync(join(PLUGINS_DIR, file), 'utf8');
    if (NON_LITERAL_DYNAMIC_IMPORT.test(source)) {
      violations.push(`plugins/${file} contains an unanalyzable dynamic import`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `Unanalyzable dynamic imports found (import() must take a string literal so the zero-dep scan can check it):\n${violations.join('\n')}`,
  );
});

test('no symlink exists anywhere under plugins/', () => {
  assert.deepEqual(
    tree.symlinks,
    [],
    'Symlinks must never exist inside a plugin: a marketplace install skips ' +
      'out-of-tree links and the zero-dep/version-guard scans cannot see through them. ' +
      `Found: ${tree.symlinks.join(', ')}`,
  );
});

test('no package.json exists anywhere under plugins/', () => {
  const found = tree.files.filter(
    (file) => file === 'package.json' || file.endsWith('/package.json'),
  );
  assert.deepEqual(found, [], `package.json must never ship inside a plugin: ${found.join(', ')}`);
});

test('no node_modules directory exists anywhere under plugins/', () => {
  const found = tree.directories.filter(
    (dir) => dir === 'node_modules' || dir.endsWith('/node_modules'),
  );
  assert.deepEqual(found, [], `node_modules must never exist inside a plugin: ${found.join(', ')}`);
});

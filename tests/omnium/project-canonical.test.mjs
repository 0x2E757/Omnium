// project-canonical.test.mjs — pins the canonical-form contract of
// shared/project.mjs (cross-platform audit High #1). resolveProject must
// yield ONE canonical native spelling for a project root regardless of the
// producer: git-for-Windows emits forward-slash paths ("C:/Repos/x"),
// process.cwd()/env dirs yield backslashes and may drift in drive-letter
// case or carry a trailing separator — without one spelling the same repo
// registers under two identity strings in the memosyne/graphyne registries.
// The win32 rules are exercised on any host by injecting path.win32 into
// normalizeRoot (Node's default `path` binds to the host platform); the
// POSIX identity case doubles as the registry-key-stability pin for
// existing Linux/macOS users.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, posix, sep, win32 } from 'node:path';
import { test } from 'node:test';

import * as project from '../../shared/project.mjs';

test('resolveProject strips a trailing separator from the non-git fallback root', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omnium-proj-'));
  try {
    const p = project.resolveProject(dir + sep);
    assert.equal(p.path, dir);
    assert.equal(p.name, basename(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizeRoot canonicalizes git-for-Windows roots under win32 rules', () => {
  assert.equal(project.normalizeRoot('C:/Repos/x', win32), 'C:\\Repos\\x');
  assert.equal(project.normalizeRoot('c:\\repos\\x', win32), 'C:\\repos\\x');
  assert.equal(project.normalizeRoot('C:/Repos/x/', win32), 'C:\\Repos\\x');
  assert.equal(project.normalizeRoot('C:/', win32), 'C:\\');
  assert.equal(project.normalizeRoot('//server/share/repo', win32), '\\\\server\\share\\repo');
});

test('normalizeRoot is the identity for a clean absolute POSIX path', () => {
  assert.equal(project.normalizeRoot('/home/me/proj', posix), '/home/me/proj');
});

test('normalizeRoot collapses trailing separators and dot segments on POSIX', () => {
  assert.equal(project.normalizeRoot('/home/me/proj/', posix), '/home/me/proj');
  assert.equal(project.normalizeRoot('/home/me/./proj/../proj', posix), '/home/me/proj');
});

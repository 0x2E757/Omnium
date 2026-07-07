// eol.test.mjs — pins the repo's line-ending policy (cross-platform audit
// Medium #4). scripts/version-guard.mjs hashes raw working-tree bytes, so the
// D8 stamp discipline silently requires byte-identical checkouts on every
// platform: without a committed .gitattributes, Git-for-Windows' default
// core.autocrlf=true checks text out as CRLF, every plugin tree hash
// mismatches its stamp, and the pre-commit hook spuriously PATCH-bumps all
// plugins. The policy line forces LF checkout everywhere; the byte scan is
// the outcome invariant — checkin normalization runs only client-side at
// `git add`, so a CRLF file smuggled in past it (web-UI upload, weakened
// local attributes) would ship forever-green under a policy-line-only test.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

test('.gitattributes forces LF checkout for all text files', () => {
  const attributes = readFileSync(join(REPO_ROOT, '.gitattributes'), 'utf8');
  assert.match(attributes, /^\*\s+text=auto\s+eol=lf\s*$/m);
});

test('no shipped or tooling file carries a CR byte', () => {
  for (const dir of ['plugins', 'scripts']) {
    const entries = readdirSync(join(REPO_ROOT, dir), {
      recursive: true,
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const path = join(entry.parentPath, entry.name);
      assert.ok(!readFileSync(path).includes(0x0d), `CR byte in ${path}`);
    }
  }
});

// sync-shared.mjs — copies the canonical shared modules (MCP core, lock-core,
// project — every shared/*.mjs) into each consuming
// plugin (DESIGN.md D2/D13). A marketplace install copies exactly one plugin
// folder and skips out-of-tree symlinks, so byte-identical physical copies
// are the only way to share code between plugins. Canonical files live in
// shared/; each consumer carries copies in its common/ folder, and
// tests/omnium/vendoring.test.mjs byte-compares every copy, so editing a copy
// in place cannot survive the gate. Exposed as `npm run sync:shared`.
//
// Non-obvious decision: the consumer list is literal, not a scan — the plugins
// that ship no MCP server must never grow a common/ folder by accident, and a
// scan would silently start vendoring into any future directory. A consumer
// whose directory is missing is skipped with a note on stderr; this script
// creates no directories.

import { copyFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHARED_DIR = join(REPO_ROOT, 'shared');

// Exactly the three MCP-server plugins consume the shared modules (DESIGN.md
// D2/D13); the hooks-only and commands-only plugins are deliberately absent.
const CONSUMER_DIRS = [
  'plugins/expertum/common',
  'plugins/graphyne/common',
  'plugins/memosyne/common',
];

const sharedFiles = existsSync(SHARED_DIR)
  ? readdirSync(SHARED_DIR).filter((name) => name.endsWith('.mjs')).sort()
  : [];

if (sharedFiles.length === 0) {
  console.log('sync-shared: shared/ has no .mjs files yet; nothing to sync.');
  process.exit(0);
}

for (const consumerRelative of CONSUMER_DIRS) {
  const consumerDir = join(REPO_ROOT, consumerRelative);
  if (!existsSync(consumerDir)) {
    console.error(`sync-shared: ${consumerRelative} does not exist yet; skipped.`);
    continue;
  }
  for (const name of sharedFiles) {
    copyFileSync(join(SHARED_DIR, name), join(consumerDir, name));
  }
  console.log(`sync-shared: copied ${sharedFiles.length} file(s) into ${consumerRelative}.`);
}

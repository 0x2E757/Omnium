import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { withTempRoot } from "../helpers.mts";
import {
  metaFilePath,
  metaExists,
  readMetaRaw,
  writeMetaRaw,
  deleteMetaFile,
  listMetaSources,
  ensureStore,
  storeDir,
  metaDir,
  configPath,
  CONFIG_JSON,
  GUARD_CONTENT,
  GUARD_FILENAMES,
} from "../../../plugins/graphyne/common/storage.mjs";

test("metaFilePath maps source -> meta/<path>.yaml", () => {
  withTempRoot((root) => {
    assert.equal(metaFilePath(root, "src/a.ts"), join(metaDir(root), "src", "a.ts.yaml"));
  });
});

test("metaFilePath rejects traversal", () => {
  withTempRoot((root) => {
    assert.throws(() => metaFilePath(root, "../evil.ts"));
  });
});

test("write/read/exists/delete meta", () => {
  withTempRoot((root) => {
    assert.equal(metaExists(root, "src/a.ts"), false);
    assert.equal(readMetaRaw(root, "src/a.ts"), null);
    writeMetaRaw(root, "src/a.ts", "related: []\n");
    assert.equal(metaExists(root, "src/a.ts"), true);
    assert.equal(readMetaRaw(root, "src/a.ts"), "related: []\n");
    assert.equal(deleteMetaFile(root, "src/a.ts"), true);
    assert.equal(metaExists(root, "src/a.ts"), false);
    assert.equal(deleteMetaFile(root, "src/a.ts"), false);
  });
});

test("listMetaSources walks recursively, strips .yaml, posix", () => {
  withTempRoot((root) => {
    writeMetaRaw(root, "src/a.ts", "related: []\n");
    writeMetaRaw(root, "src/sub/b.ts", "related: []\n");
    assert.deepEqual(listMetaSources(root), ["src/a.ts", "src/sub/b.ts"]);
  });
});

test("configPath resolves the config inside the store", () => {
  withTempRoot((root) => {
    assert.equal(CONFIG_JSON, "config.json");
    assert.equal(configPath(root), join(storeDir(root), CONFIG_JSON));
  });
});

test("the guard carves config.json out of the do-not-hand-edit rule", () => {
  assert.match(GUARD_CONTENT, /`config\.json` is the ONE hand-editable file/);
  assert.match(GUARD_CONTENT, /Do NOT hand-edit anything else/);
});

test("ensureStore does not seed a config.json (/graphyne:init writes it)", () => {
  withTempRoot((root) => {
    ensureStore(root);
    assert.equal(existsSync(configPath(root)), false);
  });
});

test("ensureStore creates skeleton, guards, gitignore (no overwrite)", () => {
  withTempRoot((root) => {
    ensureStore(root);
    assert.ok(existsSync(metaDir(root)));
    assert.ok(existsSync(join(storeDir(root), ".gitignore")));
    assert.match(readFileSync(join(storeDir(root), ".gitignore"), "utf8"), /tasks\//);
    for (const g of GUARD_FILENAMES) assert.ok(existsSync(join(storeDir(root), g)));
    // does not overwrite
    const p = join(storeDir(root), GUARD_FILENAMES[0]);
    writeMetaRaw(root, "noop.ts", ""); // unrelated
    const before = readFileSync(p, "utf8");
    ensureStore(root);
    assert.equal(readFileSync(p, "utf8"), before);
  });
});

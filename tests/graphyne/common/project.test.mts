// Project resolution + vcs classification. resolveProject derives the root (git
// toplevel or the dir itself); gitInfo classifies a root as a git work tree (with
// its branch) or a plain folder. The folder branch is deterministic without git;
// the git branch is asserted opportunistically only when `git init` succeeds.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";

import { resolveProject, gitInfo } from "../../../plugins/graphyne/common/project.mjs";

function withTemp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "graphyne-proj-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("resolveProject names a plain folder by its basename", () => {
  withTemp((dir) => {
    const p = resolveProject(dir);
    assert.equal(p.name, basename(p.path));
  });
});

test("gitInfo: a non-repo directory is a folder", () => {
  withTemp((dir) => {
    assert.deepEqual(gitInfo(dir), { kind: "folder" });
  });
});

test("gitInfo: a git work tree reports its branch", () => {
  withTemp((dir) => {
    const init = spawnSync("git", ["init", "-b", "trunk", dir], { encoding: "utf8" });
    if ((init.status ?? -1) !== 0) return; // git unavailable — skip the live assertion
    const info = gitInfo(dir);
    assert.equal(info.kind, "git");
    assert.equal(info.kind === "git" ? info.branch : null, "trunk");
  });
});

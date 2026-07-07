import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

import { gitInfo, resolveProject } from "../../plugins/memosyne/common/project.mjs";

test("gitInfo: plain folder vs git repo with a branch", () => {
  const dir = mkdtempSync(join(tmpdir(), "memosyne-vcs-"));
  try {
    // Not a repo yet -> folder.
    assert.deepEqual(gitInfo(dir), { kind: "folder" });

    // Init with an explicit branch; --show-current reports it even pre-commit.
    execFileSync("git", ["init", "-b", "feature-x", dir], { stdio: "ignore" });
    assert.deepEqual(gitInfo(dir), { kind: "git", branch: "feature-x" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gitInfo: a detached HEAD reports a null branch", () => {
  const dir = mkdtempSync(join(tmpdir(), "memosyne-vcs-"));
  try {
    execFileSync("git", ["init", dir], { stdio: "ignore" });
    // Hermetic identity + no signing so the empty commit always succeeds in CI.
    const git = (args: string[]) =>
      execFileSync(
        "git",
        ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args],
        { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" },
      );
    git(["commit", "--allow-empty", "-m", "init"]);
    const head = git(["rev-parse", "HEAD"]).trim();
    execFileSync("git", ["-C", dir, "checkout", "--detach", head], { stdio: "ignore" });
    assert.deepEqual(gitInfo(dir), { kind: "git", branch: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveProject roots at the git top level from a nested subdirectory", () => {
  const dir = mkdtempSync(join(tmpdir(), "memosyne-proj-"));
  try {
    execFileSync("git", ["init", dir], { stdio: "ignore" });
    mkdirSync(join(dir, "nested", "deep"), { recursive: true });
    const top = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    const p = resolveProject(join(dir, "nested", "deep"));
    assert.equal(p.path, top); // same repo root no matter which subdir the agent ran from
    assert.equal(p.name, basename(top));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

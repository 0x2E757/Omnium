// VENDORED SHARED MODULE — canonical copy: shared/project.mjs. Do not edit any plugins/*/common/ copy; edit shared/ and run: node scripts/sync-shared.mjs
//
// Project resolution. A project's identity is simply its absolute root path.
// If the directory sits inside a git repository, the repo's top level is used
// as the root, so one repo has a single per-plugin store no matter which
// subdirectory the agent ran from; otherwise the directory itself is the root.
// git is OPTIONAL — a folder without git is a perfectly valid project.
//
// Canonical-form contract: the root is always host-native — absolute, native
// separators, no trailing separator (except a bare filesystem root such as "/"
// or "C:\"), an UPPERCASE drive letter on Windows, and UNC roots kept in
// \\server\share form. git for Windows emits forward-slash paths ("C:/Repos/x")
// while process.cwd() yields backslashes and either may drift in drive-letter
// case, so without one canonical spelling the same repo would register under
// two identity strings and break native-path comparisons in consumers.

import { execFileSync } from "node:child_process";
import path from "node:path";

/** @typedef {{ name: string, path: string }} ProjectIdentity */

/**
 * Normalize a project-root path to the host's canonical native form (see the
 * header contract): lexical resolve (never realpath — symlinks are part of the
 * identity the caller chose) plus a deterministic uppercase fold of a Windows
 * drive letter, which resolve() preserves verbatim. `pathImpl` is injectable
 * ONLY so the win32 rules can be unit-tested from POSIX (Node's default `path`
 * binds to the host platform); production callers never pass it.
 * @param {string} rawPath
 * @param {import("node:path").PlatformPath} [pathImpl]
 * @returns {string}
 */
export function normalizeRoot(rawPath, pathImpl = path) {
  const resolved = pathImpl.resolve(rawPath);
  // A resolved POSIX path always starts with "/", so the drive-letter fold
  // can never touch it — win32-only effect without a process.platform branch.
  return resolved.replace(/^[a-z]:/, (drive) => drive.toUpperCase());
}

/**
 * The git repository root containing `cwd`, or null if `cwd` is not in a repo.
 * @param {string} cwd
 * @returns {string | null}
 */
function gitToplevel(cwd) {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the project rooted at `cwd`: the git repo root if any, else `cwd`.
 * @param {string} cwd
 * @returns {ProjectIdentity}
 */
export function resolveProject(cwd) {
  const root = normalizeRoot(gitToplevel(cwd) ?? cwd);
  return { name: path.basename(root), path: root };
}

/** @typedef {{ kind: "git", branch: string | null } | { kind: "folder" }} VcsInfo */

/**
 * Classify a project root: a git work tree (with its current branch, or null when
 * detached) or a plain folder. One git call; `--show-current` is empty on a
 * detached HEAD and the command fails (→ folder) outside a repo.
 * @param {string} path
 * @returns {VcsInfo}
 */
export function gitInfo(path) {
  try {
    const branch = execFileSync("git", ["-C", path, "branch", "--show-current"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return { kind: "git", branch: branch || null };
  } catch {
    return { kind: "folder" };
  }
}

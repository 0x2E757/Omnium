import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

import {
  decidePreToolUse,
  BLOCKED_TOOLS,
  sessionStartOutput,
  evaluateStop,
  formatDirtyReason,
  AUTONOMY_CONTEXT,
  commandPushesToRemote,
  editTargetOutsideCwd,
  PUSH_DENY_REASON,
  OUTSIDE_CWD_DENY_REASON,
  CRON_DELETE_DENY_REASON,
  parseToggle,
  TOGGLE_ON_MESSAGE,
  TOGGLE_OFF_MESSAGE,
  isStatusCommand,
  statusMessage,
  isStopHookActive,
  STOP_WAIVE_MESSAGE,
  isLikelySecretPath,
} from "../../plugins/autonomity/hooks/hook-lib.mjs";

const ROOT = resolve("autonomity-fixture-root");

// --- PreToolUse policy -------------------------------------------------------

test("AskUserQuestion is denied with a reason", () => {
  const d = decidePreToolUse("AskUserQuestion");
  assert.equal(d.hookEventName, "PreToolUse");
  assert.equal(d.permissionDecision, "deny");
  assert.match(d.permissionDecisionReason, /autonomous/i);
});

test("ExitPlanMode is allowed (never trapped in plan mode)", () => {
  const d = decidePreToolUse("ExitPlanMode");
  assert.equal(d.permissionDecision, "allow");
});

test("ordinary tools are allowed (prompt-free autonomy)", () => {
  for (const tool of ["Bash", "Edit", "Write", "Read", "WebFetch", "mcp__x__y"]) {
    assert.equal(decidePreToolUse(tool).permissionDecision, "allow", tool);
  }
});

test("only AskUserQuestion is in the blocked set", () => {
  assert.deepEqual([...BLOCKED_TOOLS], ["AskUserQuestion"]);
});

// --- Guard: no push to a remote ----------------------------------------------

test("commandPushesToRemote detects git push as a subcommand", () => {
  for (const cmd of [
    "git push",
    "git push origin main",
    "git push --force",
    "cd repo && git push",
    "git -C /some/repo push",
    'git -c user.name=x push origin HEAD',
    "ls && git push; echo done",
  ]) {
    assert.equal(commandPushesToRemote(cmd), true, cmd);
  }
});

test("commandPushesToRemote folds Windows git spellings (git.exe, GIT)", () => {
  for (const cmd of [
    "git.exe push",
    "GIT push",
    "Git.EXE push origin main",
    "C:\\tools\\git.exe push",
  ]) {
    assert.equal(commandPushesToRemote(cmd), true, cmd);
  }
  // The .exe strip is anchored: only a real extension folds, lookalikes don't.
  assert.equal(commandPushesToRemote("git.exercise push"), false);
  assert.equal(commandPushesToRemote("legit push"), false);
  // The strip is SINGLE-suffix: "git.exe.exe" folds to "git.exe" (not "git"), so it
  // is not treated as git — a real git binary is never named this.
  assert.equal(commandPushesToRemote("git.exe.exe push"), false);
});

test("commandPushesToRemote ignores non-push git and lookalikes", () => {
  for (const cmd of [
    "git status",
    "git commit -m 'push the button'",
    'git commit -m "ready to push"',
    "git log | grep push",
    "echo git push",
    "npm run push",
    "",
  ]) {
    assert.equal(commandPushesToRemote(cmd), false, cmd);
  }
});

test("Bash git push is denied with the push reason", () => {
  const d = decidePreToolUse("Bash", { command: "git push origin main" }, ROOT);
  assert.equal(d.permissionDecision, "deny");
  assert.equal(d.permissionDecisionReason, PUSH_DENY_REASON);
});

test("Bash non-push command is allowed", () => {
  const d = decidePreToolUse("Bash", { command: "git commit -m wip" }, ROOT);
  assert.equal(d.permissionDecision, "allow");
});

// --- Guard: no edits outside the working directory ---------------------------

test("editTargetOutsideCwd is false for in-tree edit tools", () => {
  assert.equal(editTargetOutsideCwd("Write", { file_path: "src/a.ts" }, ROOT), false);
  assert.equal(editTargetOutsideCwd("Edit", { file_path: "./README.md" }, ROOT), false);
  assert.equal(
    editTargetOutsideCwd("NotebookEdit", { notebook_path: "nb/x.ipynb" }, ROOT),
    false,
  );
});

test("editTargetOutsideCwd is true for paths escaping the cwd", () => {
  assert.equal(editTargetOutsideCwd("Write", { file_path: "../escape.ts" }, ROOT), true);
  assert.equal(
    editTargetOutsideCwd("Edit", { file_path: resolve(ROOT, "..", "x.ts") }, ROOT),
    true,
  );
});

test("editTargetOutsideCwd folds case on case-insensitive platforms only", () => {
  const cased = ROOT.toUpperCase() + "/src/a.ts";
  // darwin (APFS/HFS+ default): same directory spelled differently — inside.
  assert.equal(editTargetOutsideCwd("Write", { file_path: cased }, ROOT, "darwin"), false);
  // linux (case-sensitive default): /FOO and /foo are genuinely different
  // directories — folding here would be the guard's only fail-open direction.
  assert.equal(editTargetOutsideCwd("Write", { file_path: cased }, ROOT, "linux"), true);
  assert.equal(editTargetOutsideCwd("Write", { file_path: cased }, ROOT, "win32"), false);
});

test("editTargetOutsideCwd works from a filesystem-root cwd", () => {
  // resolve("/") already ends with the separator; a naive `cwd + sep` prefix
  // would judge EVERYTHING outside a root cwd.
  assert.equal(editTargetOutsideCwd("Write", { file_path: "/etc/hosts" }, "/"), false);
});

test("editTargetOutsideCwd only applies to edit tools", () => {
  assert.equal(editTargetOutsideCwd("Bash", { command: "rm -rf /" }, ROOT), false);
  assert.equal(editTargetOutsideCwd("Read", { file_path: "/etc/passwd" }, ROOT), false);
});

test("editTargetOutsideCwd fails open when cwd is unknown", () => {
  assert.equal(editTargetOutsideCwd("Write", { file_path: "../escape.ts" }, ""), false);
});

test("an out-of-tree edit is denied with the outside reason", () => {
  const d = decidePreToolUse("Write", { file_path: "../escape.ts" }, ROOT);
  assert.equal(d.permissionDecision, "deny");
  assert.equal(d.permissionDecisionReason, OUTSIDE_CWD_DENY_REASON);
});

test("an in-tree edit is allowed", () => {
  const d = decidePreToolUse("Write", { file_path: "src/a.ts" }, ROOT);
  assert.equal(d.permissionDecision, "allow");
});

// --- Guard: no cancelling a user's scheduled loop ----------------------------

test("CronDelete is denied with the loop-guard reason", () => {
  const d = decidePreToolUse("CronDelete", { id: "abc" }, ROOT);
  assert.equal(d.permissionDecision, "deny");
  assert.equal(d.permissionDecisionReason, CRON_DELETE_DENY_REASON);
});

test("the loop-guard reason mentions the loop and not cancelling", () => {
  assert.match(CRON_DELETE_DENY_REASON, /loop/i);
  assert.match(CRON_DELETE_DENY_REASON, /autonom/i);
});

// --- SessionStart ------------------------------------------------------------

test("SessionStart injects the autonomy primer", () => {
  const o = sessionStartOutput();
  assert.equal(o.hookEventName, "SessionStart");
  assert.equal(o.additionalContext, AUTONOMY_CONTEXT);
  assert.match(o.additionalContext, /commit/i);
});

test("the primer mentions both guards", () => {
  assert.match(AUTONOMY_CONTEXT, /push/i);
  assert.match(AUTONOMY_CONTEXT, /working directory/i);
});

// --- UserPromptSubmit toggle -------------------------------------------------

test("parseToggle recognizes the on/off commands", () => {
  assert.equal(parseToggle("/autonomity:on"), "on");
  assert.equal(parseToggle("/autonomity:off"), "off");
});

test("parseToggle tolerates surrounding whitespace", () => {
  assert.equal(parseToggle("  /autonomity:on  "), "on");
  assert.equal(parseToggle("/autonomity:off\n"), "off");
});

test("parseToggle returns null for anything else", () => {
  for (const p of [
    "/autonomity:status",
    "/autonomity",
    "please /autonomity:on",
    "/autonomity:on now",
    "turn autonomity on",
    "",
    null,
    undefined,
    42,
  ]) {
    assert.equal(parseToggle(p), null, JSON.stringify(p));
  }
});

test("the toggle messages name the resulting state", () => {
  assert.match(TOGGLE_ON_MESSAGE, /\bon\b/i);
  assert.match(TOGGLE_OFF_MESSAGE, /\boff\b/i);
});

test("isStatusCommand recognizes the status command", () => {
  assert.equal(isStatusCommand("/autonomity:status"), true);
  assert.equal(isStatusCommand("  /autonomity:status \n"), true);
});

test("isStatusCommand returns false for anything else", () => {
  for (const p of [
    "/autonomity:on",
    "/autonomity:off",
    "/autonomity:status please",
    "status",
    "",
    null,
    undefined,
  ]) {
    assert.equal(isStatusCommand(p), false, JSON.stringify(p));
  }
});

test("statusMessage reports the current state", () => {
  assert.match(statusMessage("on"), /\bon\b/i);
  assert.match(statusMessage("off"), /\boff\b/i);
});

test("parseToggle does not match the status command", () => {
  assert.equal(parseToggle("/autonomity:status"), null);
});

// --- Stop / git gate ---------------------------------------------------------

/** @param {string} stdout */
const OK = (stdout) => ({ ok: true, stdout, code: 0 });

/** @param {any} map */
function fakeGit(map) {
  return /** @param {string[]} args */ (args) => {
    const key = args.join(" ");
    if (key.startsWith("rev-parse")) return map.revParse;
    if (key.startsWith("status")) return map.status;
    // `diff --cached` is the staged probe; a bare `diff` is the worktree probe.
    if (key.startsWith("diff --cached")) return map.diffStaged ?? OK("");
    if (key.startsWith("diff")) return map.diffUnstaged ?? OK("");
    return { ok: false, stdout: "", code: null };
  };
}

test("clean tree does not block", () => {
  const res = evaluateStop(
    "/repo",
    fakeGit({
      revParse: OK("true\n"),
      status: OK(""),
    }),
  );
  assert.equal(res.block, false);
});

test("dirty tree blocks and lists the files", () => {
  const res = evaluateStop(
    "/repo",
    fakeGit({
      revParse: OK("true\n"),
      status: OK(" M src/a.ts\n?? src/b.ts\n"),
      diffUnstaged: OK("src/a.ts\n"),
    }),
  );
  assert.equal(res.block, true);
  assert.match(res.reason, /src\/a\.ts/);
  assert.match(res.reason, /src\/b\.ts/);
  assert.match(res.reason, /commit/i);
});

test("a CRLF/LF-only change does not block (ignored at EOL)", () => {
  // status reports the file modified, but the EOL-insensitive diff is empty.
  const res = evaluateStop(
    "/repo",
    fakeGit({
      revParse: OK("true\n"),
      status: OK(" M crlf.txt\n"),
      diffUnstaged: OK(""),
      diffStaged: OK(""),
    }),
  );
  assert.equal(res.block, false);
});

test("a real change alongside CRLF noise still blocks, listing only the real file", () => {
  const res = evaluateStop(
    "/repo",
    fakeGit({
      revParse: OK("true\n"),
      status: OK(" M real.ts\n M crlf.txt\n"),
      diffUnstaged: OK("real.ts\n"), // crlf.txt absent → EOL-only, suppressed
    }),
  );
  assert.equal(res.block, true);
  assert.match(res.reason, /real\.ts/);
  assert.doesNotMatch(res.reason, /crlf\.txt/);
});

test("a staged EOL-only change does not block", () => {
  const res = evaluateStop(
    "/repo",
    fakeGit({
      revParse: OK("true\n"),
      status: OK("M  staged.txt\n"),
      diffStaged: OK(""),
      diffUnstaged: OK(""),
    }),
  );
  assert.equal(res.block, false);
});

test("an untracked file always blocks, even with empty diffs", () => {
  const res = evaluateStop(
    "/repo",
    fakeGit({
      revParse: OK("true\n"),
      status: OK("?? new.ts\n"),
    }),
  );
  assert.equal(res.block, true);
  assert.match(res.reason, /new\.ts/);
});

test("not a git repo does not block", () => {
  const res = evaluateStop(
    "/tmp",
    fakeGit({
      revParse: { ok: false, stdout: "", code: 128 },
      status: { ok: false, stdout: "", code: null },
    }),
  );
  assert.equal(res.block, false);
});

test("rev-parse reporting non-true does not block", () => {
  const res = evaluateStop(
    "/tmp",
    fakeGit({
      revParse: { ok: true, stdout: "false\n", code: 0 },
      status: { ok: true, stdout: " M x\n", code: 0 },
    }),
  );
  assert.equal(res.block, false);
});

// --- formatting --------------------------------------------------------------

test("dirty reason truncates long lists", () => {
  const lines = Array.from({ length: 42 }, (_, i) => ` M file${i}.ts`);
  const reason = formatDirtyReason(lines);
  assert.match(reason, /file0\.ts/);
  assert.match(reason, /\.\.\.and 12 more/);
  assert.doesNotMatch(reason, /file41\.ts/);
});

// --- secret-aware clean-git gate ----------------------------------------------
// The gate must never pressure the agent into committing likely-secret files:
// pattern-matched paths get their own "gitignore/stash + report, do NOT commit"
// section, chosen by the hook (never by the agent).

test("isLikelySecretPath matches credential-shaped paths by name alone", () => {
  for (const p of [
    ".env",
    ".env.local",
    "config/prod.env",
    "deploy/key.pem",
    "server.key",
    "id_rsa",
    ".ssh/id_ed25519",
    "deploy_rsa",
    "release.jks",
    "app.keystore",
    "bundle.p12",
    ".npmrc",
    ".netrc",
    ".pgpass",
    ".git-credentials",
    ".aws/credentials",
    ".kube/config",
    "kubeconfig",
    "gcp-service-account.json",
    "aws-credentials.json",
    "secrets.yaml",
    "secrets.json",
    "api.token",
    "token.txt",
    "db.dump",
    "prod-dump.sql",
    "backup2020.sql",
    ".bash_history",
    "vault.kdbx",
    "client.ovpn",
    ".envrc",
    "AuthKey_ABC123.p8",
    "signing.pk8",
    ".ENV", // case-insensitive
    "conf\\key.pem", // Windows separators normalized
    '"my secrets.env"', // core.quotePath-style quoted porcelain entry
  ]) {
    assert.equal(isLikelySecretPath(p), true, `should match: ${p}`);
  }
});

test("isLikelySecretPath leaves ordinary work product alone", () => {
  for (const p of [
    ".env.example",
    ".env.sample",
    ".env.template",
    ".env.dist",
    "src/main.ts",
    "key.pub",
    "id_rsa.pub",
    "README.md",
    "migrations/001-init.sql",
    "schema.sql",
    "docs/tokens.md",
    "package.json",
    "keyboard.ts",
    "monkey.js",
    "environment.d.ts",
    "tests/env.test.ts",
    "dumpling.sql", // 'dump' must be a word start, not a substring
    "src/", // a bare directory entry never classifies by its emptiness
  ]) {
    assert.equal(isLikelySecretPath(p), false, `should NOT match: ${p}`);
  }
});

test("evaluateStop lists untracked files individually (-uall), so a secret inside a new directory is classified", () => {
  /** @type {string[][]} */
  const calls = [];
  const res = evaluateStop("/repo", (args) => {
    calls.push(args);
    const key = args.join(" ");
    if (key.startsWith("rev-parse")) return OK("true\n");
    if (key.startsWith("status")) return OK("?? config/.env\n?? config/app.ts\n");
    return OK("");
  });
  const statusCall = calls.find((a) => a[0] === "status");
  assert.ok(statusCall && statusCall.includes("-uall"), "status must run with -uall so directories don't collapse");
  assert.equal(res.block, true);
  assert.match(res.reason, /config\/\.env/);
  assert.match(res.reason, /\.gitignore/);
  assert.match(res.reason, /config\/app\.ts/);
});

test("formatDirtyReason caps the sensitive list without hiding that more exist", () => {
  const sensitive = Array.from({ length: 35 }, (_, i) => ({ path: `keys/k${i}.pem`, tracked: false }));
  const reason = formatDirtyReason([], sensitive);
  assert.match(reason, /keys\/k0\.pem/);
  assert.doesNotMatch(reason, /keys\/k34\.pem/);
  assert.match(reason, /and 5 more secret-shaped/);
});

test("the sensitive section marks tracked files", () => {
  const reason = formatDirtyReason([], [{ path: "conf/key.pem", tracked: true }]);
  assert.match(reason, /conf\/key\.pem \(tracked\)/);
});

test("formatDirtyReason without sensitive files keeps the plain commit instruction", () => {
  const reason = formatDirtyReason(["src/a.ts"]);
  assert.match(reason, /Commit your work/);
  assert.doesNotMatch(reason, /secret/i);
  assert.doesNotMatch(reason, /\.gitignore/);
});

test("formatDirtyReason renders a sensitive section with gitignore/stash guidance", () => {
  const reason = formatDirtyReason(
    ["src/a.ts"],
    [
      { path: ".env", tracked: false },
      { path: "conf/key.pem", tracked: true },
    ],
  );
  assert.match(reason, /src\/a\.ts/);
  assert.match(reason, /\.env/);
  assert.match(reason, /secrets or credentials/i);
  assert.match(reason, /Do NOT/);
  assert.match(reason, /\.gitignore/);
  assert.match(reason, /git stash push -- /);
  assert.match(reason, /final summary/i);
  assert.match(reason, /do NOT add anything else to \.gitignore/);
  assert.match(reason, /Commit your work/); // ordinary files keep their instruction
});

test("formatDirtyReason with ONLY sensitive files omits the commit instruction", () => {
  const reason = formatDirtyReason([], [{ path: ".env", tracked: false }]);
  assert.doesNotMatch(reason, /Commit your work/);
  assert.match(reason, /\.gitignore/);
});

test("evaluateStop splits an untracked .env out of the commit pressure", () => {
  const res = evaluateStop(
    "/repo",
    fakeGit({
      revParse: OK("true\n"),
      status: OK("?? .env\n?? src/new.ts\n"),
    }),
  );
  assert.equal(res.block, true);
  assert.match(res.reason, /src\/new\.ts/);
  assert.match(res.reason, /\.env/);
  assert.match(res.reason, /\.gitignore/);
  assert.match(res.reason, /Do NOT/);
});

test("evaluateStop marks a modified tracked key file for stashing, not committing", () => {
  const res = evaluateStop(
    "/repo",
    fakeGit({
      revParse: OK("true\n"),
      status: OK(" M conf/key.pem\n"),
      diffUnstaged: OK("conf/key.pem\n"),
    }),
  );
  assert.equal(res.block, true);
  assert.match(res.reason, /git stash push -- /);
  assert.match(res.reason, /conf\/key\.pem/);
});

test("the primer forbids committing secrets proactively", () => {
  assert.match(AUTONOMY_CONTEXT, /secret/i);
  assert.match(AUTONOMY_CONTEXT, /\.gitignore/);
});

test("the waive message does not instruct committing secrets", () => {
  assert.match(STOP_WAIVE_MESSAGE, /never commit/i);
  assert.match(STOP_WAIVE_MESSAGE, /stash/); // tracked secrets: .gitignore alone is ineffective
});

test("the primer offers both the gitignore and stash paths", () => {
  assert.match(AUTONOMY_CONTEXT, /\.gitignore/);
  assert.match(AUTONOMY_CONTEXT, /stash/);
});

// --- stop_hook_active loop protection -----------------------------------------

test("isStopHookActive accepts exactly boolean true and string 'true'", () => {
  assert.equal(isStopHookActive({ stop_hook_active: true }), true);
  assert.equal(isStopHookActive({ stop_hook_active: "true" }), true);
});

test("isStopHookActive rejects false, garbage truthy values, and absence", () => {
  assert.equal(isStopHookActive({ stop_hook_active: false }), false);
  assert.equal(isStopHookActive({ stop_hook_active: "false" }), false);
  assert.equal(isStopHookActive({ stop_hook_active: 1 }), false);
  assert.equal(isStopHookActive({ stop_hook_active: "yes" }), false);
  assert.equal(isStopHookActive({}), false);
});

test("the waive message names the flag and the leftover obligation", () => {
  assert.match(STOP_WAIVE_MESSAGE, /stop_hook_active/);
  assert.match(STOP_WAIVE_MESSAGE, /uncommitted/i);
});

// Autonomity — pure hook logic (no process IO except an injectable git runner).
// Kept dependency-free (Node built-ins only) and side-effect-free so it can be
// unit-tested directly. The thin IO shell lives in hook.mjs.

import { execFileSync } from "node:child_process";
import { resolve, sep } from "node:path";

// ---------------------------------------------------------------------------
// PreToolUse — keep the agent autonomous.
//
// Policy: a single PreToolUse hook matches every tool ("*").
//   - AskUserQuestion is DENIED: there is no way to auto-answer it, so we send
//     the agent back to decide for itself.
//   - everything else is ALLOWED, which "bypasses the permission system
//     entirely" (per the hooks docs) so no permission/plan-approval prompt ever
//     reaches the user. ExitPlanMode is therefore auto-approved — denying it
//     would trap the agent in plan mode forever.
//
// A hook "allow" does NOT override a user's *explicit* deny/ask rules in
// settings (those still take precedence), so the user keeps an escape hatch.
// ---------------------------------------------------------------------------

export const BLOCKED_TOOLS = new Set(["AskUserQuestion"]);
export const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export const DENY_REASON =
  "Autonomity: autonomous mode is active — you must not prompt the user. " +
  "Resolve the ambiguity yourself using the conversation, the code, and " +
  "sensible defaults, then continue without asking.";

export const PUSH_DENY_REASON =
  "Autonomity: pushing to a remote is not allowed in autonomous mode. " +
  "Do not work around this — keep the commits local and defer the push for the " +
  "user to perform when they take control.";

export const OUTSIDE_CWD_DENY_REASON =
  "Autonomity: edits outside the working directory are not allowed in " +
  "autonomous mode. Do not work around this — defer the change for the user to " +
  "make when they take control.";

export const CRON_DELETE_DENY_REASON =
  "Autonomity: deleting a scheduled task is not allowed in autonomous mode. " +
  "The schedule (e.g. a /loop the user set up) is the user's to cancel, not " +
  "yours — keep iterating and do not work around this. If your work is genuinely " +
  "done, simply finish the turn and let the loop run again or have the user stop " +
  "it when they take control.";

/**
 * The PreToolUse hook output shape Claude Code expects; a deny always carries
 * its reason, an allow never does.
 * @typedef {{ hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: string }
 *         | { hookEventName: "PreToolUse", permissionDecision: "allow" }} PreToolUseDecision
 */

/**
 * @param {string} reason
 * @returns {PreToolUseDecision}
 */
function deny(reason) {
  return {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: reason,
  };
}

/**
 * Decide the PreToolUse outcome.
 *
 * @param {string} toolName  the tool being invoked
 * @param {any} toolInput the tool's input (command, file_path, ...)
 * @param {string} cwd       the session working directory (for the out-of-tree guard)
 * @returns {PreToolUseDecision}
 */
export function decidePreToolUse(toolName, toolInput = {}, cwd = "") {
  // Hard stop: the agent must never ask the user.
  if (BLOCKED_TOOLS.has(toolName)) return deny(DENY_REASON);
  // Guard: never cancel a scheduled task (e.g. the user's /loop).
  if (toolName === "CronDelete") return deny(CRON_DELETE_DENY_REASON);
  // Guard: never push to a remote.
  if (toolName === "Bash" && commandPushesToRemote(toolInput && toolInput.command)) {
    return deny(PUSH_DENY_REASON);
  }
  // Guard: never edit outside the working directory.
  if (editTargetOutsideCwd(toolName, toolInput, cwd)) return deny(OUTSIDE_CWD_DENY_REASON);
  // Otherwise auto-approve for prompt-free autonomy.
  return { hookEventName: "PreToolUse", permissionDecision: "allow" };
}

// Git global options that consume the following token as their argument; used
// to skip past them when locating the subcommand.
const GIT_OPTS_WITH_ARG = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
]);

/**
 * True when `command` invokes `git push` as a real subcommand (in any of the
 * shell segments). Best-effort: it walks each `;`/`&&`/`||`/`|`/newline-separated
 * segment, and for a `git` invocation skips global options to find the
 * subcommand, so `git commit -m "push"` is NOT a push.
 * @param {unknown} command
 */
export function commandPushesToRemote(command) {
  if (!command || typeof command !== "string") return false;
  for (const segment of command.split(/\|\||&&|[;&|\n]/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    // basename of argv[0]; Windows spellings fold to "git" (`git.exe`, `GIT` —
    // PATH lookup there is case-insensitive and appends .exe). Folding is
    // unconditional: on Linux a folded lookalike could not have run anyway,
    // so the guard only ever over-denies (fail closed).
    const cmd = tokens[0].replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase();
    if (cmd !== "git") continue;
    let i = 1;
    while (i < tokens.length) {
      const t = tokens[i];
      if (!t.startsWith("-")) break; // first bare token is the subcommand
      i += GIT_OPTS_WITH_ARG.has(t) && !t.includes("=") ? 2 : 1;
    }
    if (tokens[i] === "push") return true;
  }
  return false;
}

// Platforms whose DEFAULT filesystems compare paths case-insensitively (NTFS;
// APFS/HFS+ on macOS). Linux is NOT folded: its default filesystems are
// case-sensitive, and folding there would equate /Foo with /foo — the guard's
// only fail-OPEN direction. Residuals sit on non-default volumes and are
// accepted: case-sensitive APFS/NTFS folds too much (opt-in, rare), a
// case-insensitive Linux mount folds too little (spurious deny, fail closed).
// toLowerCase() is not a full Unicode casefold (Turkish dotted I, ß) — those
// misses are also fail closed, also accepted.
const CASE_INSENSITIVE_PLATFORMS = new Set(["win32", "darwin"]);

/** @param {string} base @param {string} target @param {string} [platform] injectable for tests */
function isInside(base, target, platform = process.platform) {
  let b = resolve(base);
  let t = resolve(base, target);
  if (CASE_INSENSITIVE_PLATFORMS.has(platform)) {
    b = b.toLowerCase();
    t = t.toLowerCase();
  }
  // resolve("/") and resolve("C:\\") already end with the separator; a naive
  // `b + sep` would double it and judge EVERYTHING outside a root cwd.
  const prefix = b.endsWith(sep) ? b : b + sep;
  return t === b || t.startsWith(prefix);
}

/**
 * True when an edit tool targets a path outside `cwd`. Fails open (returns false)
 * for non-edit tools, a missing target, or an unknown cwd, so it never blocks
 * spuriously.
 * @param {string} toolName @param {any} toolInput @param {string} cwd
 * @param {string} [platform] injectable for tests
 */
export function editTargetOutsideCwd(toolName, toolInput, cwd, platform = process.platform) {
  if (!EDIT_TOOLS.has(toolName)) return false;
  if (!cwd) return false;
  const target = toolInput && (toolInput.file_path || toolInput.notebook_path);
  if (!target || typeof target !== "string") return false;
  return !isInside(cwd, target, platform);
}

// ---------------------------------------------------------------------------
// UserPromptSubmit — the per-session on/off toggle.
//
// `/autonomity:on` and `/autonomity:off` are intercepted here (the literal text
// reaches UserPromptSubmit before the slash command expands), so the dispatcher
// can flip the session flag and erase the prompt — the toggle never produces a
// model turn. Anything else returns null and is left untouched.
// ---------------------------------------------------------------------------

const TOGGLE_RE = /^\/autonomity:(on|off)\s*$/;

export const TOGGLE_ON_MESSAGE =
  "Autonomity: autonomous mode is now ON for this session.";
export const TOGGLE_OFF_MESSAGE =
  "Autonomity: autonomous mode is now OFF for this session.";

/**
 * If `prompt` is exactly the on/off toggle command (ignoring surrounding
 * whitespace), return "on"/"off"; otherwise null. Strict on purpose: trailing
 * arguments or embedded text do NOT match, so a normal message that merely
 * mentions the command is never swallowed.
 * @param {unknown} prompt
 */
export function parseToggle(prompt) {
  if (typeof prompt !== "string") return null;
  const m = prompt.trim().match(TOGGLE_RE);
  return m ? m[1] : null;
}

const STATUS_RE = /^\/autonomity:status\s*$/;

/** True when `prompt` is exactly `/autonomity:status` (read-only, no write). @param {unknown} prompt */
export function isStatusCommand(prompt) {
  return typeof prompt === "string" && STATUS_RE.test(prompt.trim());
}

/** A user-facing line reporting the current session state. @param {string} state */
export function statusMessage(state) {
  return state === "on"
    ? "Autonomity: autonomous mode is currently ON for this session."
    : "Autonomity: autonomous mode is currently OFF for this session.";
}

// ---------------------------------------------------------------------------
// SessionStart — prime the agent so it does not even attempt to stall.
// ---------------------------------------------------------------------------

export const AUTONOMY_CONTEXT =
  "Autonomity is active: you operate fully autonomously. Do NOT ask the user " +
  "questions — the AskUserQuestion tool is blocked; resolve ambiguity yourself " +
  "with the conversation, the code, and sensible defaults. Plan approval and " +
  "tool-permission prompts are auto-approved, so never wait on the user. " +
  "Two hard guards apply: never push to a remote (keep commits local), and " +
  "never edit files outside the working directory. If either is genuinely " +
  "needed, do NOT work around it — defer that task for the user to do when they " +
  "take control. Before finishing, commit your work: Stop is blocked while the " +
  "git working tree has uncommitted changes. Never stage or commit files that " +
  "may hold secrets (.env files, keys, credentials, tokens) — add them to " +
  ".gitignore instead (or `git stash push -- <path>` if already tracked) and " +
  "name them in your final summary; the user decides their fate.";

export function sessionStartOutput() {
  return { hookEventName: "SessionStart", additionalContext: AUTONOMY_CONTEXT };
}

// ---------------------------------------------------------------------------
// Stop — refuse to finish while the git working tree is dirty.
// ---------------------------------------------------------------------------

const MAX_LISTED = 30;

// ---------------------------------------------------------------------------
// Secret-shaped paths. The gate must never pressure the agent into committing
// these, so they get their own "gitignore/stash + report" section instead of
// the commit instruction. Path/basename patterns only — no content reads (slow,
// and the hook itself would ingest the secret). Precision-first: a false
// positive costs the user one review of an uncommitted, reported file; a false
// negative is a credential in git history. Patterns follow the gitleaks/Gitrob
// filename lineage.
// ---------------------------------------------------------------------------

const SECRET_BASENAMES = new Set([
  ".netrc", "_netrc", ".npmrc", ".pypirc", ".pgpass", ".my.cnf",
  ".git-credentials", ".htpasswd", ".s3cfg", ".dockercfg", "kubeconfig",
  ".envrc", "secrets.yml", "secrets.yaml", "secrets.json", "token.txt",
  ".bash_history", ".zsh_history", ".psql_history", ".mysql_history",
]);

// Directory-qualified forms matched against the full (posix, lowercased) path.
const SECRET_PATH_SUFFIXES = [".aws/credentials", ".kube/config", ".docker/config.json"];

// dotenv shapes (.env, .env.local, prod.env) — with the committed-on-purpose
// variants exempted (.env.example / sample / template / dist).
const DOTENV_RE = /^\.env(\..+)?$|\.env$/;
const DOTENV_EXEMPT_RE = /example|sample|template|dist/;

const SECRET_BASENAME_RES = [
  /^id_(rsa|dsa|ecdsa|ed25519)/, // ssh private keys
  /_(rsa|dsa|ecdsa|ed25519)$/, // Gitrob's extensionless *_rsa family
  /\.(key|pem|p8|pk8|p12|pfx|pkcs12|ppk|jks|keystore|kdb|kdbx|agilekeychain|keychain|ovpn|tblk|token|dump|sqldump)$/,
  /credentials.*\.json$/,
  /service[-_. ]?account.*\.json$/,
  /(^|[-_.])dump\.sql$/, // pg_dump-style exports; bare *.sql (migrations, schema) stays ordinary
  /^backup.*\.sql$/,
];

/**
 * Whether a repo-relative path looks like a secret/credential by NAME alone.
 * Tolerates `core.quotePath`-style quoted porcelain entries and Windows
 * separators; octal escapes inside quoted names are NOT decoded (a matching
 * suffix still classifies; a fully escaped basename is an accepted miss).
 * @param {string} p
 */
export function isLikelySecretPath(p) {
  const path = String(p)
    .replace(/^"|"$/g, "") // git quotes names with spaces/non-ASCII
    .replace(/\\/g, "/")
    .replace(/\/+$/, "") // a bare directory entry classifies by its name, not ""
    .toLowerCase();
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (base.endsWith(".pub")) return false; // public halves are meant to be shared
  if (SECRET_PATH_SUFFIXES.some((s) => path.endsWith(s))) return true;
  if (SECRET_BASENAMES.has(base)) return true;
  if (DOTENV_RE.test(base)) return !DOTENV_EXEMPT_RE.test(base);
  return SECRET_BASENAME_RES.some((re) => re.test(base));
}

/**
 * Build the block reason from repo-relative dirty paths (bare paths from the
 * `--name-only` diffs plus stripped untracked entries — NOT raw porcelain
 * lines). `files` should be committed; `sensitive` entries are secret-shaped
 * and must NEVER be committed — they get the gitignore/stash + report path,
 * and the guardrail footer renders only alongside them, so when nothing
 * matches the message carries no .gitignore affordance at all.
 * @param {string[]} files
 * @param {{ path: string, tracked: boolean }[]} [sensitive]
 */
export function formatDirtyReason(files, sensitive = []) {
  const parts = ["Autonomity: the git working tree has uncommitted changes, so this turn cannot finish."];
  if (files.length > 0) {
    const shown = files.slice(0, MAX_LISTED);
    const more = files.length - shown.length;
    parts.push("", ...shown.map((l) => "  " + l));
    if (more > 0) parts.push(`  ...and ${more} more`);
    parts.push(
      "",
      "Commit your work (stage these files by explicit path, then `git commit`) — or " +
        "`git stash` if it is genuinely throwaway — then stop again.",
    );
  }
  if (sensitive.length > 0) {
    const shownSensitive = sensitive.slice(0, MAX_LISTED);
    const moreSensitive = sensitive.length - shownSensitive.length;
    parts.push(
      "",
      "These files look like secrets or credentials — committing them would put them " +
        "into git history, where they survive later deletion and leak on any future " +
        "push. Do NOT `git add` or commit them:",
      "",
      ...shownSensitive.map((s) => `  ${s.path}${s.tracked ? " (tracked)" : ""}`),
      ...(moreSensitive > 0 ? [`  ...and ${moreSensitive} more secret-shaped files — the same rules apply to them`] : []),
      "",
      "For each file above: if it is untracked, add its path to .gitignore (and commit " +
        "that .gitignore change); if it is tracked, set it aside with `git stash push -- " +
        "<path>`. Then name every one of them in your final summary — the user decides " +
        "their fate. Never commit a file from this list, even if you believe its contents " +
        "are fake or example data. And do NOT add anything else to .gitignore to make " +
        "this gate pass — ordinary source and work product must be committed, not hidden.",
    );
  }
  return parts.join("\n");
}

/**
 * True when the payload marks this stop as a continuation already caused by a
 * prior stop-hook block. The harness sends a JSON boolean, but the documented
 * recipe compares the string form, so both are accepted; absence or any other
 * value (including garbage truthy ones) keeps the gate armed.
 * @param {Record<string, unknown>} input
 */
export function isStopHookActive(input) {
  return input.stop_hook_active === true || input.stop_hook_active === "true";
}

export const STOP_WAIVE_MESSAGE =
  "Autonomity: a previous stop was already blocked (stop_hook_active) — " +
  "allowing this one to avoid an infinite loop. The working tree still has " +
  "uncommitted changes; commit or stash them — but never commit files that may " +
  "hold secrets: gitignore those (or stash them if tracked) and report them in " +
  "your summary.";

/**
 * @typedef {{ ok: boolean, stdout: string, code: number | null }} GitResult
 * @typedef {(args: string[], cwd: string) => GitResult} RunGit
 */

/**
 * Default git runner. Returns { ok, stdout, code } and never throws, so callers
 * can treat "git missing / not a repo" as a clean no-op rather than a crash.
 * @param {string[]} args @param {string} cwd @returns {GitResult}
 */
export function defaultRunGit(args, cwd) {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { ok: true, stdout, code: 0 };
  } catch (e) {
    // Same truthiness rule as the original `e && e.status != null` — an
    // execFileSync failure carries the child's exit status when it ran at all.
    const status = e && typeof e === "object" && "status" in e && e.status != null ? e.status : null;
    return { ok: false, stdout: "", code: /** @type {number | null} */ (status) };
  }
}

/**
 * File names from a `--name-only` git command; [] when the call fails.
 * @param {RunGit} runGit @param {string[]} args @param {string} cwd
 */
function gitNames(runGit, args, cwd) {
  const r = runGit(args, cwd);
  if (!r.ok) return [];
  return r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** Untracked paths (the `??` entries) from `git status --porcelain` output. @param {string} statusStdout */
function untrackedPaths(statusStdout) {
  return statusStdout
    .split(/\r?\n/)
    .filter((l) => l.startsWith("??"))
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
}

/**
 * Decide whether Stop should be blocked for the given working directory.
 * Returns { block: false } when there is nothing to enforce (not a git repo,
 * git unavailable, or a clean tree) so the agent is never trapped, and
 * { block: true, reason } when uncommitted changes remain.
 *
 * CRLF/LF-only differences are IGNORED: a file that `git status` reports as
 * modified is only counted when a change survives `git diff --ignore-cr-at-eol`
 * (checked for both the staged and the worktree sides). This prevents the gate
 * from trapping the agent over phantom line-ending churn that nothing actually
 * changed. Untracked files always count — they are new content, never an EOL
 * artifact.
 *
 * `runGit` is injectable for testing.
 * @param {string} cwd @param {RunGit} [runGit]
 * @returns {{ block: false, reason?: undefined } | { block: true, reason: string }}
 */
export function evaluateStop(cwd, runGit = defaultRunGit) {
  const probe = runGit(["rev-parse", "--is-inside-work-tree"], cwd);
  if (!probe.ok || probe.stdout.trim() !== "true") {
    return { block: false }; // not a git repo, or git not installed
  }
  // -uall lists untracked files individually: the default mode collapses a new
  // directory to one `dir/` entry, which would hide a secret inside it from
  // the classifier below (and the gate would then instruct committing it).
  const status = runGit(["status", "--porcelain", "-uall"], cwd);
  if (!status.ok) return { block: false };

  // Tracked changes that survive line-ending normalization (staged + worktree).
  const staged = gitNames(runGit, ["diff", "--cached", "--ignore-cr-at-eol", "--name-only"], cwd);
  const unstaged = gitNames(runGit, ["diff", "--ignore-cr-at-eol", "--name-only"], cwd);

  // De-duplicate, preserving first-seen order: staged, worktree, then untracked.
  const untracked = new Set(untrackedPaths(status.stdout));
  const files = [...new Set([...staged, ...unstaged, ...untracked])];
  if (files.length === 0) return { block: false };

  // Secret-shaped paths are split out of the commit pressure: the reason gives
  // them a gitignore/stash + report path instead, chosen HERE — the agent is
  // never asked to classify.
  /** @type {string[]} */
  const ordinary = [];
  /** @type {{ path: string, tracked: boolean }[]} */
  const sensitive = [];
  for (const f of files) {
    if (isLikelySecretPath(f)) sensitive.push({ path: f, tracked: !untracked.has(f) });
    else ordinary.push(f);
  }
  return { block: true, reason: formatDirtyReason(ordinary, sensitive) };
}

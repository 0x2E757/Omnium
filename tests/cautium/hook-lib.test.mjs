import { test } from "node:test";
import assert from "node:assert/strict";

import { securityContext, sessionStartOutput } from "../../plugins/cautium/hooks/hook-lib.mjs";

// --- the injected payload ----------------------------------------------------

test("sessionStartOutput wraps securityContext for the given platform", () => {
  const out = sessionStartOutput("linux");
  assert.equal(out.hookEventName, "SessionStart");
  assert.equal(out.additionalContext, securityContext("linux"));
});

test("sessionStartOutput defaults to the host platform", () => {
  assert.equal(sessionStartOutput().additionalContext, securityContext(process.platform));
});

// --- universal core (same on every platform) ---------------------------------

test("every platform gets the plugin name, the security duties, and the risk rubric", () => {
  /** @type {NodeJS.Platform[]} */
  const platforms = ["linux", "win32", "darwin", "sunos", "freebsd"];
  for (const p of platforms) {
    const ctx = securityContext(p);
    assert.match(ctx, /cautium/i, p);
    assert.match(ctx, /secret|credential/i, p); // duty: secrets
    assert.match(ctx, /inject|untrusted input/i, p); // duty: input
    assert.match(ctx, /privilege|authoriz|authoris/i, p); // duty: authZ
    assert.match(ctx, /crypto|tls/i, p); // duty: crypto
    assert.match(ctx, /proceed autonomously/i, p); // rubric: low tier
    assert.match(ctx, /explicit approval/i, p); // rubric: high tier
    assert.match(ctx, /\bPID\b/i, p); // process management (OS-neutral in the rubric)
  }
});

test("the risk tiers read least- to most-privileged", () => {
  const ctx = securityContext("linux");
  assert.ok(
    ctx.indexOf("proceed autonomously") < ctx.indexOf("explicit approval"),
    "the autonomous tier should precede the explicit-approval tier",
  );
});

// --- scope: the machine, not the project -------------------------------------
// The rubric guards the machine the user works on. When its scope was left
// implicit, agents applied it to project work too: they scored writes to a
// shared test database as 7-10, "rounded up", and shipped unverified code to
// production instead. The boundary is stated outright; only git stays global.

/** @type {NodeJS.Platform[]} */
const ALL = ["linux", "win32", "darwin", "freebsd"];

test("every platform scopes the rubric to the machine, not the project", () => {
  for (const p of ALL) {
    const ctx = securityContext(p);
    assert.match(ctx, /protects the machine you work on/i, p);
    // project work, databases and deploys included, follows the project's rules
    assert.match(ctx, /work inside the project[^.]*databases[^.]*deploys[^.]*not scored by this rubric/i, p);
    assert.match(ctx, /project's own rules and the user's instructions/i, p);
    // git is the one exception that applies everywhere
    assert.match(ctx, /git operations named below apply everywhere/i, p);
  }
});

test("every platform defines 'the project' and refuses a home or root directory as one", () => {
  for (const p of ALL) {
    const ctx = securityContext(p);
    // the term is anchored to something the agent can see: its working directory
    assert.match(ctx, /"the project" is the working directory this session started in/i, p);
    assert.match(ctx, /empty folder, the project is that folder/i, p);
    // launched in ~ or C:\ there is no project, so nothing escapes the machine rubric
    assert.match(ctx, /home directory[^.]*root[^.]*there is no project/i, p);
  }
});

test("no tier scores project work: production and test databases are not rubric items", () => {
  for (const p of ALL) {
    const ctx = securityContext(p);
    const tiers = ctx.slice(ctx.indexOf("0-2 ("), ctx.indexOf("explicit approval"));
    assert.doesNotMatch(tiers, /production|test database|staging/i, p);
  }
});

test("every platform forbids letting machine caution decide a project question", () => {
  for (const p of ALL) {
    const ctx = securityContext(p);
    assert.match(ctx, /never let machine-level caution decide a project question/i, p);
    assert.match(ctx, /moves it to production/i, p);
    // rounding up means asking, never skipping the check
    assert.match(ctx, /round up[^.]*ask/i, p);
  }
});

test("file deletion is a high-tier item only outside the project; git items stay", () => {
  for (const p of /** @type {NodeJS.Platform[]} */ (["linux", "win32", "darwin"])) {
    const ctx = securityContext(p);
    assert.match(ctx, /deleting files outside the project/i, p);
    assert.doesNotMatch(ctx, /deleting files(?! outside the project)/i, p);
    assert.match(ctx, /`git push`/, p);
  }
  for (const p of /** @type {NodeJS.Platform[]} */ (["linux", "win32"])) {
    assert.match(securityContext(p), /`git reset --hard`/, p);
  }
});

// --- OS-dependent risk mapping -----------------------------------------------

test("the Linux context carries Linux-specific 7-10 examples", () => {
  const ctx = securityContext("linux");
  assert.match(ctx, /\/etc\b/);
  assert.match(ctx, /systemd/i);
  assert.match(ctx, /fstab|grub|bootloader/i);
  assert.match(ctx, /ssh/i);
  assert.match(ctx, /pkill|killall/i); // Linux-specific broad-kill warning
});

test("the Windows context carries Windows-specific 7-10 examples", () => {
  const ctx = securityContext("win32");
  assert.match(ctx, /registry/i);
  assert.match(ctx, /\bPATH\b/); // uppercase env var, not the lowercase 'file paths'
  assert.match(ctx, /taskkill|elevat|administrator|UAC/i);
  assert.doesNotMatch(ctx, /systemd/i);
  assert.doesNotMatch(ctx, /\/etc\b/);
});

test("the macOS context carries macOS-specific 7-10 examples", () => {
  const ctx = securityContext("darwin");
  assert.match(ctx, /launchd|launchctl/i);
  assert.match(ctx, /\bSIP\b|System Integrity/);
  assert.match(ctx, /keychain/i);
  assert.match(ctx, /gatekeeper/i);
  assert.doesNotMatch(ctx, /systemd/i);
  assert.doesNotMatch(ctx, /registry/i);
});

test("a platform without its own mapping gets the generic one, not Linux/Windows internals", () => {
  const ctx = securityContext("freebsd");
  assert.doesNotMatch(ctx, /systemd/i);
  assert.doesNotMatch(ctx, /\/etc\b/);
  assert.doesNotMatch(ctx, /registry/i);
  // still a real high-tier mapping, just OS-neutral
  assert.match(ctx, /system (service|configuration)|remote-access|network|firewall/i);
});

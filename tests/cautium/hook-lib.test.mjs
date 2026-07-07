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

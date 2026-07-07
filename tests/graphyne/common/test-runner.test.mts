import { test } from "node:test";
import assert from "node:assert/strict";

import { withTempRoot } from "../helpers.mts";
import { runTest, DEFAULT_TIMEOUT_MS } from "../../../plugins/graphyne/common/test-runner.mjs";

// Use the running Node binary so the tests don't depend on `node` being on PATH.
const NODE = JSON.stringify(process.execPath);

test("runTest reports exit 0 as green and captures stdout", () => {
  withTempRoot((root) => {
    const r = runTest(root, `${NODE} -e "console.log('hello-green')"`);
    assert.equal(r.exitCode, 0);
    assert.match(r.output, /hello-green/);
  });
});

test("runTest reports a non-zero exit (red) without throwing", () => {
  withTempRoot((root) => {
    const r = runTest(root, `${NODE} -e "process.exit(3)"`);
    assert.equal(r.exitCode, 3);
  });
});

test("runTest captures stderr alongside stdout", () => {
  withTempRoot((root) => {
    const r = runTest(root, `${NODE} -e "console.log('out'); console.error('err')"`);
    assert.equal(r.exitCode, 0);
    assert.match(r.output, /out/);
    assert.match(r.output, /err/);
  });
});

test("runTest echoes the command back in the result", () => {
  withTempRoot((root) => {
    const cmd = `${NODE} -e "0"`;
    const r = runTest(root, cmd);
    assert.equal(r.command, cmd);
  });
});

test("runTest runs in the given root (cwd)", () => {
  withTempRoot((root) => {
    const r = runTest(root, `${NODE} -e "process.stdout.write(process.cwd())"`);
    assert.equal(r.exitCode, 0);
    // realpath differences (e.g. /var vs /private/var) — compare the basename tail.
    assert.ok(r.output.length > 0);
    assert.ok(root.endsWith(r.output.split(/[\\/]/).pop()!));
  });
});

test("runTest surfaces a missing command as red rather than throwing", () => {
  withTempRoot((root) => {
    const r = runTest(root, "graphyne-no-such-command-xyz");
    assert.notEqual(r.exitCode, 0);
  });
});

// A hanging test command must not wedge the caller (the MCP server processes
// requests serially): the run is killed at timeoutMs and reported red with an
// explicit timed-out marker naming the configured limit.

test("runTest kills a command exceeding timeoutMs and reports it red with a timed-out marker", () => {
  withTempRoot((root) => {
    const start = Date.now();
    const r = runTest(root, `${NODE} -e "setTimeout(()=>{}, 10e3)"`, { timeoutMs: 300 });
    assert.notEqual(r.exitCode, 0); // red, never green
    assert.equal(r.timedOut, true);
    assert.match(r.output, /timed out/i); // recognizable marker
    assert.match(r.output, /300/); // states the configured limit
    assert.ok(Date.now() - start < 5000, "returned promptly, not after the child's 10s sleep");
  });
});

test("runTest does not time out a fast command", () => {
  withTempRoot((root) => {
    const r = runTest(root, `${NODE} -e "console.log('quick')"`, { timeoutMs: 5000 });
    assert.equal(r.exitCode, 0);
    assert.equal(r.timedOut, false);
    assert.match(r.output, /quick/);
    assert.doesNotMatch(r.output, /timed out/i);
  });
});

test("runTest does not hang when the command waits on stdin (EOF'd, timeout as backstop)", () => {
  withTempRoot((root) => {
    // Exits 0 only when stdin reaches EOF; hangs forever if stdin stays open.
    const r = runTest(
      root,
      `${NODE} -e "process.stdin.on('data',()=>{}); process.stdin.on('end',()=>process.exit(0)); process.stdin.on('error',()=>process.exit(0))"`,
      { timeoutMs: 5000 },
    );
    assert.equal(r.exitCode, 0);
    assert.doesNotMatch(r.output, /timed out/i);
  });
});

test("a timed-out run is red even when the child traps SIGTERM and exits 0", () => {
  withTempRoot((root) => {
    // The trap converts the kill into a clean exit 0 — the timeout verdict must win.
    const r = runTest(root, `${NODE} -e "process.on('SIGTERM',()=>process.exit(0)); setTimeout(()=>{},10e3)"`, {
      timeoutMs: 300,
    });
    assert.equal(r.timedOut, true);
    assert.notEqual(r.exitCode, 0);
    assert.match(r.output, /timed out/i);
  });
});

test("a child killed by an external signal reads red, not green", () => {
  withTempRoot((root) => {
    // Signal death has status null and no res.error — it must never read green.
    const r = runTest(root, `${NODE} -e "process.kill(process.pid,'SIGKILL')"`);
    assert.notEqual(r.exitCode, 0);
    assert.equal(r.timedOut, false);
  });
});

test("the default timeout is generous (a typo can't ship a milliseconds-scale cap)", () => {
  assert.ok(DEFAULT_TIMEOUT_MS >= 60_000);
});

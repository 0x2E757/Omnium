import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end checks of the IO shell: SessionStart routes to CLAUDE_SESSIONS_DIR
// when set and onboards when not; every other event is a silent no-op; and a
// garbled stdin payload never suppresses the primer (the hook fails OPEN).

const HOOK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "plugins",
  "sessio",
  "hooks",
  "hook.mjs",
);

/** @param {string|null} event @param {any} payload @param {NodeJS.ProcessEnv} [env] */
function run(event, payload, env) {
  const r = spawnSync(process.execPath, event === null ? [HOOK] : [HOOK, event], {
    input: JSON.stringify(payload ?? {}),
    encoding: "utf8",
    env: env ?? process.env,
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) : {};
}

test("SessionStart with CLAUDE_SESSIONS_DIR set routes to that base", () => {
  const out = run("SessionStart", { session_id: "s" }, { ...process.env, CLAUDE_SESSIONS_DIR: "/tmp/sessio-fixture" });
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(out.hookSpecificOutput.additionalContext, /\/tmp\/sessio-fixture/);
});

test("SessionStart without the env var onboards", () => {
  const env = { ...process.env };
  delete env.CLAUDE_SESSIONS_DIR;
  const out = run("SessionStart", { session_id: "s" }, env);
  assert.match(out.hookSpecificOutput.additionalContext, /CLAUDE_SESSIONS_DIR/);
  assert.match(out.hookSpecificOutput.additionalContext, /ask/i);
});

test("every non-SessionStart event is a silent no-op", () => {
  const env = { ...process.env, CLAUDE_SESSIONS_DIR: "/tmp/x" };
  for (const event of ["UserPromptSubmit", "PreToolUse", "Stop"]) {
    assert.deepEqual(run(event, { session_id: "s" }, env), {}, event);
  }
});

test("malformed stdin fails open — the argv event still injects", () => {
  const r = spawnSync(process.execPath, [HOOK, "SessionStart"], {
    input: "not json{",
    encoding: "utf8",
    env: { ...process.env, CLAUDE_SESSIONS_DIR: "/tmp/x" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /\/tmp\/x/);
});

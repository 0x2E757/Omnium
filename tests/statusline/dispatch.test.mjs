import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderCommand } from "../../plugins/statusline/hooks/hook-lib.mjs";

// End-to-end checks of the IO shell: on SessionStart it syncs the renderer into
// the persistent data dir (argv[3] = ${CLAUDE_PLUGIN_DATA}), then nudges the
// agent to install a statusLine pointing at that stable copy — unless one is
// already installed (quiet) or a foreign one exists (ask first). It fails OPEN
// and every non-SessionStart event is a silent no-op. The user's settings.json
// is located via CLAUDE_CONFIG_DIR, so these tests never touch the real one.

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugins", "statusline");
const HOOK = join(PLUGIN_DIR, "hooks", "hook.mjs");
const SHIPPED_RENDER = join(PLUGIN_DIR, "statusline", "render.mjs");

/** Fresh isolated CLAUDE_CONFIG_DIR + CLAUDE_PLUGIN_DATA per case. */
function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "statusline-"));
  const configDir = join(base, "config");
  const dataDir = join(base, "data");
  mkdirSync(configDir, { recursive: true });
  return { configDir, dataDir, dataRender: join(dataDir, "render.mjs") };
}

/** @param {string|null} event @param {{configDir:string,dataDir:string}} box @param {any} [payload] @param {string} [rawInput] */
function run(event, box, payload, rawInput) {
  const args = event === null ? [HOOK] : [HOOK, event, box.dataDir];
  const r = spawnSync(process.execPath, args, {
    input: rawInput ?? JSON.stringify(payload ?? { session_id: "s" }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CONFIG_DIR: box.configDir },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) : {};
}

/** @param {string} configDir @param {any} settings */
function writeSettings(configDir, settings) {
  writeFileSync(join(configDir, "settings.json"), JSON.stringify(settings, null, 2));
}

test("no settings.json: nudges to install and syncs the renderer into the data dir", () => {
  const box = sandbox();
  const out = run("SessionStart", box);
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  const c = out.hookSpecificOutput.additionalContext;
  assert.match(c, /statusLine/);
  assert.match(c, /settings\.json/);
  // the renderer was copied into the persistent data dir, byte-for-byte...
  assert.ok(existsSync(box.dataRender), "render.mjs must be synced into the data dir");
  assert.equal(readFileSync(box.dataRender, "utf8"), readFileSync(SHIPPED_RENDER, "utf8"));
  // ...and the nudge carries a valid-JSON statusLine value pointing at that copy
  // (the inner quotes escaped, so pasting it produces parseable settings.json).
  assert.ok(
    c.includes(JSON.stringify({ type: "command", command: renderCommand(box.dataRender) })),
    "the nudge must carry the correctly-escaped JSON value to paste",
  );
});

test("our command already installed at the data path: stays quiet", () => {
  const box = sandbox();
  writeSettings(box.configDir, {
    statusLine: { type: "command", command: renderCommand(box.dataRender) },
  });
  assert.deepEqual(run("SessionStart", box), {});
});

test("a foreign statusLine: nudges to ASK before replacing", () => {
  const box = sandbox();
  writeSettings(box.configDir, { statusLine: { type: "command", command: "starship prompt" } });
  const c = run("SessionStart", box).hookSpecificOutput.additionalContext;
  assert.match(c, /ask/i);
  assert.match(c, /starship prompt/);
});

test("every non-SessionStart event is a silent no-op", () => {
  const box = sandbox();
  for (const event of ["UserPromptSubmit", "PreToolUse", "Stop"]) {
    assert.deepEqual(run(event, box), {}, event);
  }
});

test("malformed stdin fails open — the install nudge still fires", () => {
  const box = sandbox();
  const c = run("SessionStart", box, undefined, "not json{").hookSpecificOutput.additionalContext;
  assert.match(c, /statusLine/);
});

test("settings.json present but unparsable: stays silent (never nudges over a broken config)", () => {
  const box = sandbox();
  writeFileSync(join(box.configDir, "settings.json"), "{ this is not valid json ");
  // A real user config almost certainly exists and is only transiently broken:
  // do NOT re-nudge (which would encourage a blind overwrite of a file we can't read).
  assert.deepEqual(run("SessionStart", box), {});
  // ...but the renderer still syncs — that is independent of settings.json.
  assert.ok(existsSync(box.dataRender), "renderer must sync even when settings can't be parsed");
});

test("empty / whitespace-only settings.json is a fresh install, not a broken config: still nudges", () => {
  const box = sandbox();
  // An empty file is `JSON.parse`-unparsable but carries no real config to protect,
  // so it must be treated as absent (nudge to install), not silenced.
  writeFileSync(join(box.configDir, "settings.json"), "   \n\t");
  const c = run("SessionStart", box).hookSpecificOutput.additionalContext;
  assert.match(c, /statusLine/);
});

test("no data dir (dev/--plugin-dir fallback): still nudges, pointing at the shipped renderer", () => {
  const box = sandbox();
  const r = spawnSync(process.execPath, [HOOK, "SessionStart"], {
    input: JSON.stringify({ session_id: "s" }),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CONFIG_DIR: box.configDir },
  });
  assert.equal(r.status, 0, r.stderr);
  const c = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.ok(c.includes(JSON.stringify({ type: "command", command: renderCommand(SHIPPED_RENDER) })));
});

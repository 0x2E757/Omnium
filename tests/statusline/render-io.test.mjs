import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// End-to-end checks of the renderer's IO shell: it resolves the account shown on
// line 1 from .claude.json, which Claude Code keeps in CLAUDE_CONFIG_DIR when
// that is set and in the home directory otherwise. A second profile (a separate
// config dir with its own login) must show its own account, not the default
// one. The home directory is redirected (HOME / USERPROFILE) so these tests
// never read the real ~/.claude.json.

const RENDER = join(
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugins", "statusline"),
  "statusline",
  "render.mjs",
);

const ESC = String.fromCharCode(27);
/** @param {string} s */
const strip = (s) => s.replace(new RegExp(ESC + "\\[[0-9;]*m", "g"), "");

/** @param {string} dir @param {string} email */
function writeAccount(dir, email) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: email } }));
}

/** Fresh fake home (with a default-profile login) and a separate config dir. */
function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "statusline-render-"));
  const home = join(base, "home");
  writeAccount(home, "personal@example.com");
  return { home, configDir: join(base, "work-config") };
}

/** @param {{home:string}} box @param {string|undefined} configDir @returns {string} line 1 */
function renderUserLine(box, configDir) {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, HOME: box.home, USERPROFILE: box.home };
  delete env.CLAUDE_CONFIG_DIR;
  if (configDir !== undefined) env.CLAUDE_CONFIG_DIR = configDir;
  const r = spawnSync(process.execPath, [RENDER], {
    input: JSON.stringify({ workspace: { project_dir: "/projects/App" }, model: { display_name: "Opus" } }),
    encoding: "utf8",
    env,
  });
  assert.equal(r.status, 0, r.stderr);
  return strip(r.stdout).split("\n")[0];
}

test("without CLAUDE_CONFIG_DIR the account comes from ~/.claude.json", () => {
  const box = sandbox();
  assert.equal(renderUserLine(box, undefined), "personal@example.com @ App :: Opus");
});

test("with CLAUDE_CONFIG_DIR the account comes from that dir's .claude.json, not the home one", () => {
  const box = sandbox();
  writeAccount(box.configDir, "work@example.com");
  assert.equal(renderUserLine(box, box.configDir), "work@example.com @ App :: Opus");
});

test("with CLAUDE_CONFIG_DIR but no login there yet the account is unknown, never the home one", () => {
  const box = sandbox();
  mkdirSync(box.configDir, { recursive: true });
  assert.equal(renderUserLine(box, box.configDir), "? @ App :: Opus");
});

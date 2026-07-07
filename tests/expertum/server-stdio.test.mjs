import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TOOL_NAME } from "../../plugins/expertum/common/server-lib.mjs";

const SERVER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "plugins", "expertum", "server.mjs",
);

// Drive the real stdio JSON-RPC server end-to-end: feed it a batch of request
// lines, close stdin, and collect the newline-delimited JSON responses.
/**
 * @param {object[]} lines
 * @param {string} projectDir
 * @returns {Promise<any[]>}
 */
function runServer(lines, projectDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, EXPERTUM_PROJECT_DIR: projectDir },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("error", reject);
    child.on("close", () => {
      const frames = out
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      resolve(frames);
    });
    child.stdin.write(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    // A deliberately malformed line must be skipped, not crash the server.
    child.stdin.write("{ not valid json\n");
    child.stdin.end();
  });
}

test("end-to-end: initialize, tools/list, tools/call, and error codes", async (t) => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "expertum-stdio-"));
  // Remove the per-run project dir so repeated runs do not litter the OS temp dir.
  t.after(() => fs.rmSync(proj, { recursive: true, force: true }));

  const frames = await runServer(
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", method: "notifications/initialized" }, // no id -> no response
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: TOOL_NAME, arguments: { filename: "x.md", content: "hi", directory: ".expertum/r" } },
      },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "bogus", arguments: {} } },
      { jsonrpc: "2.0", id: 5, method: "totally/unknown" },
    ],
    proj
  );

  const byId = new Map(frames.filter((f) => f.id !== undefined).map((f) => [f.id, f]));

  // Exactly the five requests with ids got a reply; the notification and the
  // malformed line produced nothing.
  assert.deepEqual([...byId.keys()].sort(), [1, 2, 3, 4, 5]);

  assert.equal(byId.get(1).result.serverInfo.name, "expertum");
  assert.equal(byId.get(2).result.tools[0].name, TOOL_NAME);

  assert.equal(byId.get(3).result.isError, undefined);
  assert.match(byId.get(3).result.content[0].text, /Wrote report to/);
  assert.ok(fs.existsSync(path.join(proj, ".expertum", "r", "x.md")));

  assert.equal(byId.get(4).error.code, -32602); // unknown tool
  assert.equal(byId.get(5).error.code, -32601); // method not found
});

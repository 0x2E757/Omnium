// Contract tests for Memosyne's LLM-facing prompt surface. Same rationale as
// tests/graphyne/mcp/instructions.test.mts: Claude Code silently truncates each
// server's `instructions` at ~2KB, so the text must fit with headroom and
// front-load the essentials; and no LLM-facing text may hardcode an mcp__
// prefix (install-layout dependent). The constant lives in an import-safe
// module (plugins/memosyne/instructions.mjs) — server.mjs starts the server at
// import time, so it cannot be imported by tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { MEMOSYNE_INSTRUCTIONS } from "../../plugins/memosyne/instructions.mjs";

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugins", "memosyne");

test("instructions fit the client cap with headroom (<= 1900 chars)", () => {
  assert.ok(
    MEMOSYNE_INSTRUCTIONS.length <= 1900,
    `MEMOSYNE_INSTRUCTIONS is ${MEMOSYNE_INSTRUCTIONS.length} chars; the ~2KB/server client cap silently drops the rest`,
  );
});

test("the first 500 chars carry the load-bearing rules", () => {
  const head = MEMOSYNE_INSTRUCTIONS.slice(0, 500);
  assert.match(head, /hand-?off/i); // the primary purpose
  assert.match(head, /memosyne_list_tasks/); // session-start recovery
  assert.match(head, /ONLY through|never read or write/i); // the .memosyne/ prohibition
  assert.match(head, /TRACKING means WRITING/i); // reads recover, only writes record
});

test("every advertised tool name appears in the instructions (ToolSearch keyword discovery)", () => {
  // The 11 advertised tools (server.mjs registrations). With deferred tools an
  // agent cannot keyword-search a name it has never seen, so each must appear
  // at least once. Update this list only when the advertised surface changes.
  const TOOL_NAMES = [
    "memosyne_project",
    "memosyne_create_task",
    "memosyne_list_tasks",
    "memosyne_find_by_file",
    "memosyne_search",
    "memosyne_get_task",
    "memosyne_update_task",
    "memosyne_edit_task",
    "memosyne_link",
    "memosyne_unlink",
    "memosyne_delete_task",
  ];
  for (const name of TOOL_NAMES) {
    assert.ok(
      MEMOSYNE_INSTRUCTIONS.includes(name),
      `${name} is missing from the instructions — deferred-tool keyword search can't find it`,
    );
  }
});

test("the instructions defer scheduling to the hooks instead of duplicating it", () => {
  // The checkpoint cadence/significance rules are delivered just-in-time by the
  // hooks with live counters; the static copy was dead weight that ate the cap.
  assert.doesNotMatch(MEMOSYNE_INSTRUCTIONS, /every 3rd file edit/i);
  assert.match(MEMOSYNE_INSTRUCTIONS, /hook/i); // ...but the deferral is stated
});

test("no LLM-facing memosyne text hardcodes an mcp__ namespace prefix", () => {
  const files = [
    join(PLUGIN, "instructions.mjs"),
    join(PLUGIN, "server.mjs"),
    join(PLUGIN, "hooks", "hook.mjs"), // where the plugin-conversion regression actually happened
    ...readdirSync(join(PLUGIN, "commands"), { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => join(PLUGIN, "commands", e.name)),
  ];
  for (const f of files) {
    // Comment lines are dropped before matching: hooks/hook.mjs legitimately
    // DOCUMENTS both layout prefixes in a comment; only emitted/exported text
    // (string literals, markdown prose) must never hardcode one.
    const code = readFileSync(f, "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    assert.doesNotMatch(
      code,
      /mcp__(plugin_)?(graphyne|memosyne)/,
      `${f} references a hardcoded mcp__ namespace — use the bare tool name + a ToolSearch keyword query`,
    );
  }
});

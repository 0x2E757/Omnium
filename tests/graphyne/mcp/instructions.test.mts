// Contract tests for Graphyne's LLM-facing prompt surface.
//
// Claude Code truncates each MCP server's `instructions` at ~2KB (and the whole
// instructions block at ~4KB), SILENTLY — anything past the cap never reaches
// the model. These tests pin (a) a hard length budget with headroom under that
// cap, (b) that the first 500 characters are self-sufficient (the load-bearing
// rules survive even a harsher cut), and (c) that no LLM-facing text hardcodes
// an mcp__ tool-name prefix — the prefix depends on the install layout
// (standalone `mcp__<server>__` vs plugin `mcp__plugin_<plugin>_<server>__`),
// so guidance must use bare tool names + a ToolSearch keyword-query hint.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { GRAPHYNE_INSTRUCTIONS, TOOL_DEFINITIONS } from "../../../plugins/graphyne/tools.mjs";

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "plugins", "graphyne");

test("instructions fit the client cap with headroom (<= 1900 chars)", () => {
  assert.ok(
    GRAPHYNE_INSTRUCTIONS.length <= 1900,
    `GRAPHYNE_INSTRUCTIONS is ${GRAPHYNE_INSTRUCTIONS.length} chars; the ~2KB/server client cap silently drops the rest`,
  );
});

test("the first 500 chars carry the load-bearing rules", () => {
  const head = GRAPHYNE_INSTRUCTIONS.slice(0, 500);
  assert.match(head, /graphyne_test/); // never raw Bash — red/green must be recorded
  assert.match(head, /\bRED\b|failing/); // the red-first gate (word-bounded: "covered" must not satisfy it)
  assert.match(head, /graphyne_checklist/); // the Stop obligation
  assert.match(head, /Stop/); // the consequence, stated up front
});

test("the doc/spec direction keeps all three legs (incl. doc-edit soft-flags)", () => {
  // Editing code or a spec hard-flags; editing a DOC only soft-flags the code —
  // dropping the third leg makes agents over-treat doc-edit flags as hard.
  assert.match(GRAPHYNE_INSTRUCTIONS, /doc only soft-flags|editing a doc (only )?soft/i);
});

test("every advertised tool name appears in the instructions (ToolSearch keyword discovery)", () => {
  for (const t of TOOL_DEFINITIONS) {
    assert.ok(
      GRAPHYNE_INSTRUCTIONS.includes(t.name),
      `${t.name} is missing from the instructions — deferred-tool keyword search can't find it`,
    );
  }
});

test("no LLM-facing graphyne text hardcodes an mcp__ namespace prefix", () => {
  const files = [
    join(PLUGIN, "tools.mjs"),
    join(PLUGIN, "server.mjs"),
    join(PLUGIN, "hooks", "hook.mjs"),
    ...readdirSync(join(PLUGIN, "commands"), { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => join(PLUGIN, "commands", e.name)),
  ];
  for (const f of files) {
    // Comment lines are dropped before matching: a code comment may legitimately
    // DOCUMENT the layout-dependent prefixes; only emitted/exported text (string
    // literals, markdown prose) must never hardcode one.
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

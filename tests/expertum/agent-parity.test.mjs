import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TOOL_NAME } from "../../plugins/expertum/common/server-lib.mjs";
import { EXPERT_TOOL_NAME, OVERVIEW_TOOL_NAME } from "../../plugins/expertum/common/experts.mjs";

// Expertum registers exactly ONE sub-agent, `expertum:analyst`, and keeps its
// expert lenses as data (plugins/expertum/experts/) served by the MCP server —
// every registered agent costs a roster line in every session's context, so a
// second agent file is a regression (DESIGN.md D21). The tool names are a
// contract the server owns; the analyst must reference them in its `tools:`
// frontmatter in the fully namespaced plugin form. This test is the single
// thing enforcing that parity, so a rename in one place can't silently desync
// the others.
const PLUGIN_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "plugins", "expertum",
);
const AGENTS_DIR = path.join(PLUGIN_DIR, "agents");
const COMMANDS_DIR = path.join(PLUGIN_DIR, "commands");
const ANALYST = path.join(AGENTS_DIR, "analyst.md");

/** @param {string} tool */
const namespaced = (tool) => "mcp__plugin_expertum_expertum__" + tool;

test("expertum registers exactly one sub-agent: the analyst", () => {
  const files = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md"));
  assert.deepEqual(files, ["analyst.md"]);
});

test("the analyst grants exactly the read-only tools plus the server's namespaced tools", () => {
  const text = fs.readFileSync(ANALYST, "utf8");
  const toolsLine = text.split(/\r?\n/).find((l) => /^tools:/.test(l));
  assert.ok(toolsLine, "analyst.md: missing a 'tools:' frontmatter line");
  const tools = toolsLine.replace(/^tools:/, "").split(",").map((s) => s.trim());
  assert.deepEqual(tools.sort(), [
    "Glob",
    "Grep",
    "Read",
    "WebFetch",
    "WebSearch",
    namespaced(EXPERT_TOOL_NAME),
    namespaced(TOOL_NAME),
  ].sort());
  // Guard against a stale un-namespaced reference lingering anywhere.
  assert.ok(
    !/mcp__(plugin_expertum_)?analysis__/.test(text),
    "analyst.md: contains a stale 'analysis' MCP tool id"
  );
});

// The analyst must document the SAME four modes the commands can invoke
// (review, research, plan, scope) — an analyst spawned in a mode it never
// documents will improvise its output shape.
const MODES = ["review", "research", "plan", "scope"];

test("the analyst documents all four modes (brief bullet + output shape)", () => {
  const text = fs.readFileSync(ANALYST, "utf8");
  for (const mode of MODES) {
    assert.ok(text.includes(`- **${mode}**`), `missing the '- **${mode}**' mode bullet`);
  }
  // review/research share the default report template; plan and scope each
  // override it with their own output shape, called out explicitly.
  for (const mode of ["plan", "scope"]) {
    assert.ok(
      text.includes(`In **${mode}** mode use this shape instead`),
      `missing the '${mode}' output-shape paragraph`
    );
  }
  // Loading its lens is the analyst's first step.
  assert.ok(text.includes("`" + EXPERT_TOOL_NAME + "`"), "analyst.md never tells it to load its lens");
});

test("every command spawns the analyst and routes via the overview, never a retired agent name", () => {
  const files = fs.readdirSync(COMMANDS_DIR).filter((f) => f.endsWith(".md"));
  assert.ok(files.length >= 1, "expected at least one command");
  for (const f of files) {
    const text = fs.readFileSync(path.join(COMMANDS_DIR, f), "utf8");
    assert.ok(text.includes('subagent_type: "expertum:analyst"'), `${f}: never spawns expertum:analyst`);
    assert.ok(text.includes("`" + OVERVIEW_TOOL_NAME + "`"), `${f}: never calls the overview`);
    assert.ok(
      !/expertum:[a-z0-9-]+--[a-z]+/.test(text),
      `${f}: still names a retired per-expert agent type`
    );
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TOOL_NAME } from "../../plugins/expertum/common/server-lib.mjs";
import {
  EXPERT_BRIEF_LINE,
  EXPERT_TOOL_NAME,
  OVERVIEW_TOOL_NAME,
  loadCatalog,
} from "../../plugins/expertum/common/experts.mjs";

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

test("the analyst registers as `analyst` and advertises the brief line it keys on", () => {
  const text = fs.readFileSync(ANALYST, "utf8");
  // `name:` — not the file name — is what makes the agent `expertum:analyst`.
  assert.match(text, /^name: analyst$/m);
  const description = text.split(/\r?\n/).find((l) => /^description:/.test(l)) ?? "";
  assert.ok(description.includes(EXPERT_BRIEF_LINE), "the description must state the brief contract");
  assert.ok(text.includes("`" + EXPERT_BRIEF_LINE + "`"), "the body must state the brief line");
});

test("every command spawns only the analyst, keyed by the brief line, and handles a missing report", () => {
  const files = fs.readdirSync(COMMANDS_DIR).filter((f) => f.endsWith(".md"));
  assert.ok(files.length >= 1, "expected at least one command");
  for (const f of files) {
    const text = fs.readFileSync(path.join(COMMANDS_DIR, f), "utf8");
    const spawns = text.match(/subagent_type[^\n]*/g) ?? [];
    assert.ok(spawns.length >= 1, `${f}: never spawns an analyst`);
    for (const spawn of spawns) {
      assert.ok(spawn.includes('subagent_type: "expertum:analyst"'), `${f}: spawns something else: ${spawn}`);
    }
    assert.ok(text.includes("`" + OVERVIEW_TOOL_NAME + "`"), `${f}: never calls the overview`);
    assert.ok(text.includes("`" + EXPERT_BRIEF_LINE + "`"), `${f}: never states the brief line`);
    assert.ok(
      text.includes("returns without writing its report"),
      `${f}: does not say what to do when an analyst writes no report`
    );
  }
});

// Every shipped Expertum text an agent or user reads — the commands, the
// analyst, the lanes, the README.
const PROSE = [
  ...fs.readdirSync(COMMANDS_DIR).filter((f) => f.endsWith(".md")).map((f) => path.join(COMMANDS_DIR, f)),
  ANALYST,
  path.join(PLUGIN_DIR, "experts", "_lanes.md"),
  path.join(PLUGIN_DIR, "README.md"),
];

test("no shipped text names a retired per-expert agent type", () => {
  for (const file of PROSE) {
    const text = fs.readFileSync(file, "utf8");
    assert.ok(
      !/expertum:[a-z0-9-]+--[a-z]+/.test(text),
      `${path.basename(file)}: still names a retired per-expert agent type`
    );
  }
});

test("every expert named in shipped text exists in the catalog", () => {
  const catalog = loadCatalog(path.join(PLUGIN_DIR, "experts"));
  for (const file of PROSE) {
    const text = fs.readFileSync(file, "utf8");
    for (const [, name] of text.matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)*--[a-z]+)`/g)) {
      assert.ok(catalog.experts.has(name), `${path.basename(file)}: names unknown expert '${name}'`);
    }
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TOOL_NAME } from "../../plugins/expertum/common/server-lib.mjs";

// The tool name is a contract the server owns (server-lib TOOL_NAME) and each
// analyst sub-agent must reference in its `tools:` frontmatter as the fully
// namespaced plugin form. This test is the single thing enforcing that parity,
// so a rename in one place can't silently desync the others.
const AGENTS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "plugins", "expertum", "agents",
);
const EXPECTED = "mcp__plugin_expertum_expertum__" + TOOL_NAME;

test("every analyst agent grants exactly the server's namespaced tool", () => {
  const files = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md"));
  assert.ok(files.length >= 1, "expected at least one analyst agent");

  for (const f of files) {
    const text = fs.readFileSync(path.join(AGENTS_DIR, f), "utf8");
    const toolsLine = text.split(/\r?\n/).find((l) => /^tools:/.test(l));
    assert.ok(toolsLine, `${f}: missing a 'tools:' frontmatter line`);
    assert.ok(
      toolsLine.includes(EXPECTED),
      `${f}: 'tools:' must grant ${EXPECTED} (got: ${toolsLine})`
    );
    // Guard against a stale un-namespaced reference lingering anywhere.
    assert.ok(
      !/mcp__(plugin_expertum_)?analysis__/.test(text),
      `${f}: contains a stale 'analysis' MCP tool id`
    );
  }
});

// Every analyst body must document the SAME four modes the commands can invoke
// (review, research, plan, scope). The mode boilerplate is shared verbatim
// across the roster, so a missing block means a file drifted out of sync — an
// analyst spawned in a mode it never documents will improvise its output shape.
const MODES = ["review", "research", "plan", "scope"];

test("every analyst documents all four modes (brief bullet + output shape)", () => {
  const files = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md"));
  assert.ok(files.length >= 1, "expected at least one analyst agent");

  for (const f of files) {
    const text = fs.readFileSync(path.join(AGENTS_DIR, f), "utf8");
    // Each mode gets a labelled bullet in the "Your brief" mode list.
    for (const mode of MODES) {
      assert.ok(
        text.includes(`- **${mode}**`),
        `${f}: missing the '- **${mode}**' mode bullet`
      );
    }
    // review/research share the default report template; plan and scope each
    // override it with their own output shape, called out explicitly.
    for (const mode of ["plan", "scope"]) {
      assert.ok(
        text.includes(`In **${mode}** mode use this shape instead`),
        `${f}: missing the '${mode}' output-shape paragraph`
      );
    }
  }
});

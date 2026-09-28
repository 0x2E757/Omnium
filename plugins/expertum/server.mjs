#!/usr/bin/env node
// Expertum MCP server entry (zero-dependency, stdio, newline-delimited
// JSON-RPC 2.0). Thin boot file: the transport lives in the vendored
// ./common/mcp-core.mjs, the report-writing logic in ./common/server-lib.mjs,
// and the expert catalog in ./common/experts.mjs. This file only registers the
// `expertum_write_report`, `expertum_overview` and `expertum_expert` tools and
// starts the stdio loop; the wire behavior is pinned by the stdio end-to-end
// test tests/expertum/server-stdio.test.mjs.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMcpServer, readPluginVersion } from "./common/mcp-core.mjs";
import { TOOL_NAME, TOOL_DEFINITION, handleWriteReport } from "./common/server-lib.mjs";
import {
  OVERVIEW_TOOL_NAME,
  OVERVIEW_TOOL_DEFINITION,
  EXPERT_TOOL_NAME,
  EXPERT_TOOL_DEFINITION,
  loadCatalog,
  handleOverview,
  handleExpert,
} from "./common/experts.mjs";

const PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url));

// The expert catalog is read once, on first successful use, and kept: it ships
// with the plugin and never changes under a running server. A load failure is
// NOT cached — the throw leaves `catalog` unset, so the next catalog call
// retries the load; meanwhile each catalog tool reports the failure as a tool
// error, and the report-writing tool is unaffected.
/** @type {import("./common/experts.mjs").Catalog | undefined} */
let catalog;
function getCatalog() {
  catalog ??= loadCatalog(path.join(PLUGIN_ROOT, "experts"));
  return catalog;
}

// The project root that reports anchor under. As a plugin, EXPERTUM_PROJECT_DIR
// is set to ${CLAUDE_PROJECT_DIR}; use `||` (not `??`) so an empty string — which
// happens in CLI/test contexts where that var isn't substituted — falls back to
// the process cwd instead of resolving an empty (invalid) path. The MCP server's
// own cwd is NOT guaranteed to be the project root, so we must not rely on it.
const PROJECT_DIR = process.env.EXPERTUM_PROJECT_DIR || process.cwd();

// The advertised inputSchema is byte-frozen, so the core's pre-handler gate
// uses a separate validation schema covering ONLY the two required properties:
// filename is marked non-empty so the gate's rejection text is byte-identical
// to the handler's own frozen messages, and the optional properties
// (directory, title) are deliberately NOT gated — the handler has always
// tolerated wrong types there (title is ignored, directory is coerced) and
// that behavior must survive.
const VALIDATION_SCHEMA = {
  type: "object",
  properties: {
    filename: { type: "string", minLength: 1 },
    content: { type: "string" },
  },
  required: ["filename", "content"],
};

/** @type {Array<[string, import("./common/mcp-core.mjs").ToolSpec]>} */
const toolEntries = [
  [
    TOOL_NAME,
    {
      description: TOOL_DEFINITION.description,
      inputSchema: TOOL_DEFINITION.inputSchema,
      validationSchema: VALIDATION_SCHEMA,
      handler: async (args) => handleWriteReport(args, PROJECT_DIR),
    },
  ],
  [
    OVERVIEW_TOOL_NAME,
    {
      description: OVERVIEW_TOOL_DEFINITION.description,
      inputSchema: OVERVIEW_TOOL_DEFINITION.inputSchema,
      handler: async () => handleOverview(getCatalog),
    },
  ],
  [
    EXPERT_TOOL_NAME,
    {
      description: EXPERT_TOOL_DEFINITION.description,
      inputSchema: EXPERT_TOOL_DEFINITION.inputSchema,
      handler: async (args) => handleExpert(args, getCatalog),
    },
  ],
];

const server = createMcpServer({
  name: "expertum",
  version: readPluginVersion(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json")),
  tools: new Map(toolEntries),
});

server.start("project=" + PROJECT_DIR);

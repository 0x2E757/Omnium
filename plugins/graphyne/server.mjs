#!/usr/bin/env node
// Graphyne MCP server (stdio). Thin adapter: resolves the project + active
// session, registers the frozen tool table (./tools.mjs) on the vendored stdio
// core (./common/mcp-core.mjs, wire dialect "sdk"), and delegates every call
// to the pure handlers in ./handlers.mjs. The graph (.graphyne/meta/*.yaml)
// and the session state (.graphyne/tasks/<session>/) are mutated ONLY through
// these tools and the hook, keeping the bidirectional-link invariant and the
// on-disk schema consistent.
//
// Opt-in gate: Graphyne operates only where the user created a `.graphyne/`
// directory at the project root. Until then the server registers NO tools,
// ships no instructions, and advertises no tool capability — the agent sees
// Graphyne as if not installed (the sdk wire answers tools/list with -32601
// exactly as the dormant SDK server did). Activation is resolved once, at
// startup; adopt a project with /graphyne:setup, then restart the session.
//
// The argument gate below reproduces the prior zod pipeline's rejection text
// byte-for-byte (issue objects, key order, JSON.stringify(_, null, 2) layout,
// and the SDK's "MCP error -32602: Input validation error: …" wrapper) —
// agents have learned those strings, so mcp-schema's house wording would be a
// compat break here. This wording is frozen — never rewrite it to house style.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMcpServer, readPluginVersion } from "./common/mcp-core.mjs";
import { resolveProject, gitInfo } from "./common/project.mjs";
import { readConfig } from "./common/config.mjs";
import { storeDir, ensureStore } from "./common/storage.mjs";
import { currentSession } from "./common/session.mjs";
import { upsertProject } from "./common/registry.mjs";
import { GRAPHYNE_INSTRUCTIONS, TOOL_DEFINITIONS } from "./tools.mjs";
import * as h from "./handlers.mjs";

const PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url));

// #region Project context

// As a plugin, GRAPHYNE_PROJECT_DIR is set to ${CLAUDE_PROJECT_DIR}. Use `||` (not
// `??`) so an empty string — which happens when the var isn't substituted — falls
// back to the process cwd instead of resolving an empty (invalid) path.
const PROJECT_CWD = process.env.GRAPHYNE_PROJECT_DIR || process.cwd();
const project = resolveProject(PROJECT_CWD);

function root() {
  return project.path;
}
function config() {
  return readConfig(root()); // re-read each call so .graphyne/config.json edits take effect live
}
function session() {
  return currentSession(root()); // the hook records the active session; may change on resume
}

const activated = existsSync(storeDir(project.path));
if (activated) ensureStore(project.path);

// Record the project in the discovery registry so the web App can find it,
// refreshing its cached vcs info (git branch / folder). Called once at startup
// (so a project appears as soon as a session opens in it) and on every graph
// write (so active projects stay fresh and a lost registry re-discovers them).
// Best-effort: a registry write must never break a tool call.
function register() {
  try {
    upsertProject({ path: project.path, name: config().name ?? project.name, ...gitInfo(project.path) });
  } catch (err) {
    console.error("Graphyne registry update failed:", err instanceof Error ? err.message : err);
  }
}
if (activated) register();

// #endregion Project context

// #region Prior zod argument gate (byte-frozen rejection text)

/**
 * The wire name zod's getParsedType gave a JSON value — the `received` field
 * of an issue. JSON-RPC arguments can only be these seven shapes.
 * @param {unknown} v
 * @returns {string}
 */
function receivedName(v) {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v; // "string" | "number" | "boolean" | "object"
}

/** @typedef {Record<string, unknown>} Issue */

/**
 * One zod invalid_type issue, field order exactly as zod v3 serialized it.
 * `message` is "Required" for a missing value, else "Expected X, received Y".
 * @param {string} expected
 * @param {unknown} value
 * @param {(string | number)[]} at
 * @returns {Issue}
 */
function invalidType(expected, value, at) {
  const received = receivedName(value);
  return {
    code: "invalid_type",
    expected,
    received,
    path: at,
    message: received === "undefined" ? "Required" : `Expected ${expected}, received ${received}`,
  };
}

/**
 * One zod too_small issue for the only two bounds the schemas use:
 * minLength 1 on strings and minItems 1 on arrays.
 * @param {"string" | "array"} kind
 * @param {number} minimum
 * @param {(string | number)[]} at
 * @returns {Issue}
 */
function tooSmall(kind, minimum, at) {
  return {
    code: "too_small",
    minimum,
    type: kind,
    inclusive: true,
    exact: false,
    message:
      kind === "string"
        ? `String must contain at least ${minimum} character(s)`
        : `Array must contain at least ${minimum} element(s)`,
    path: at,
  };
}

/**
 * Collect zod-shaped issues for `value` against a (sub)schema, walking exactly
 * the way zod v3 walked our schemas: properties in declaration order, missing
 * required keys as "Required", a too-small array still visits its elements.
 * @param {any} schema a node of the advertised inputSchema (the JSON literal in tools.mjs)
 * @param {unknown} value
 * @param {(string | number)[]} at
 * @param {Issue[]} issues
 */
function collectIssues(schema, value, at, issues) {
  switch (schema.type) {
    case "object": {
      if (receivedName(value) !== "object") {
        issues.push(invalidType("object", value, at));
        return;
      }
      const obj = /** @type {Record<string, unknown>} */ (value);
      const required = Array.isArray(schema.required) ? schema.required : [];
      for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
        const v = obj[key];
        if (v === undefined) {
          if (required.includes(key)) {
            issues.push(invalidType(/** @type {any} */ (propSchema).type, v, [...at, key]));
          }
          continue; // absent optional -> no issue (zod .optional())
        }
        collectIssues(propSchema, v, [...at, key], issues);
      }
      return;
    }
    case "string": {
      if (typeof value !== "string") {
        issues.push(invalidType("string", value, at));
        return;
      }
      if (typeof schema.minLength === "number" && value.length < schema.minLength) {
        issues.push(tooSmall("string", schema.minLength, at));
      }
      return;
    }
    case "boolean": {
      if (typeof value !== "boolean") issues.push(invalidType("boolean", value, at));
      return;
    }
    case "array": {
      if (!Array.isArray(value)) {
        issues.push(invalidType("array", value, at));
        return;
      }
      // zod pushes the size issue and STILL parses the elements.
      if (typeof schema.minItems === "number" && value.length < schema.minItems) {
        issues.push(tooSmall("array", schema.minItems, at));
      }
      if (schema.items) {
        for (let i = 0; i < value.length; i++) {
          collectIssues(schema.items, value[i], [...at, i], issues);
        }
      }
      return;
    }
    default:
      return; // no other keyword appears in the frozen schemas
  }
}

/**
 * The v4-shaped gate for the EMPTY-shape tools (graphyne_project, _checklist,
 * _status). The prior MCP SDK routed a zero-property shape through zod v4
 * (`objectFromShape` returns v4 `object({})` for an empty shape), so its only
 * failure — a missing/non-object argument bag — carries the v4 issue shape:
 * `expected` leads, there is NO `received` key, and the message reads
 * "Invalid input: expected object, received undefined". Same quirk memosyne
 * reproduces in common/zod-validate.mjs; a frozen compat surface reproduced exactly, because agents have
 * learned this rejection message.
 * @param {unknown} args
 * @returns {Issue[]}
 */
function validateEmptyShape(args) {
  if (receivedName(args) === "object") return [];
  return [
    {
      expected: "object",
      code: "invalid_type",
      path: [],
      message: `Invalid input: expected object, received ${receivedName(args)}`,
    },
  ];
}

/**
 * The pre-handler argument gate for one tool: zod-era rejection text or pass.
 * Empty-shape tools take the v4 branch (see validateEmptyShape); everything
 * else walks the schema the way zod v3 did.
 * @param {string} toolName
 * @param {import("./common/mcp-core.mjs").JsonObject} inputSchema
 * @param {unknown} args
 * @returns {import("./common/mcp-schema.mjs").ValidationResult}
 */
function zodGate(toolName, inputSchema, args) {
  /** @type {Issue[]} */
  let issues;
  const properties = /** @type {Record<string, unknown> | undefined} */ (inputSchema.properties);
  if (Object.keys(properties ?? {}).length === 0) {
    issues = validateEmptyShape(args);
  } else {
    issues = [];
    collectIssues(inputSchema, args, [], issues);
  }
  if (issues.length === 0) return { ok: true, value: args };
  return {
    ok: false,
    message:
      `MCP error -32602: Input validation error: Invalid arguments for tool ${toolName}: ` +
      JSON.stringify(issues, null, 2),
  };
}

// #endregion Prior zod argument gate

// #region Tool handlers

/**
 * Wrap a text-returning prior handler as a core ToolSpec handler: success
 * becomes a text result; a throw becomes the SDK's isError result with the
 * bare error message (how ToolError has always surfaced on the wire).
 * @param {(args: any) => string} fn
 * @returns {(args: any) => import("./common/mcp-core.mjs").ToolResult}
 */
function guarded(fn) {
  return (args) => {
    try {
      return { content: [{ type: /** @type {const} */ ("text"), text: fn(args) }] };
    } catch (err) {
      return {
        content: [{ type: /** @type {const} */ ("text"), text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  };
}

// The per-tool logic, exactly the prior registerTool bodies: graph writers
// (link/unlink/forget) and test runs also refresh the discovery registry.
/** @type {Record<string, (input: any) => string>} */
const TOOL_LOGIC = {
  graphyne_project: () => h.projectInfo(config().name ?? project.name, root(), config()),
  graphyne_neighbors: (input) => h.showNeighbors(root(), input),
  graphyne_link: (input) => {
    const out = h.link(root(), input);
    register();
    return out;
  },
  graphyne_unlink: (input) => {
    const out = h.unlink(root(), input);
    register();
    return out;
  },
  graphyne_forget: (input) => {
    const out = h.forget(root(), session(), input);
    register();
    return out;
  },
  graphyne_test: (input) => {
    const out = h.runTests(root(), config(), session(), input, new Date().toISOString());
    register();
    return out;
  },
  graphyne_refactor: (input) => h.refactor(root(), config(), session(), input, new Date().toISOString()),
  graphyne_bypass: (input) => h.bypass(root(), config(), session(), input, new Date().toISOString()),
  graphyne_checklist: () => h.checklist(root(), config(), session()),
  graphyne_review: (input) => h.review(root(), session(), input),
  graphyne_meta_confirm: (input) => h.metaConfirm(root(), session(), input),
  graphyne_status: () => h.status(root(), config(), session()),
};

/** @type {Map<string, import("./common/mcp-core.mjs").ToolSpec>} */
const tools = new Map(
  TOOL_DEFINITIONS.map((def) => [
    def.name,
    {
      title: def.title,
      description: def.description,
      inputSchema: def.inputSchema,
      execution: def.execution,
      validate: (args) => zodGate(def.name, def.inputSchema, args),
      handler: guarded(TOOL_LOGIC[def.name]),
    },
  ]),
);

// #endregion Tool handlers

// #region Main

// `name` is the stable identifier — the bare tool names stay graphyne_*; the
// client-side namespace prefix around them depends on the install layout
// (standalone vs plugin), so neither code nor guidance should hardcode it.
// Instructions, tools and the tools capability ship only when the project has
// opted in; a dormant server still completes the MCP handshake (with empty
// capabilities, as the SDK advertised when nothing was registered).
const server = createMcpServer({
  name: "graphyne",
  title: "Graphyne",
  version: readPluginVersion(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json")),
  instructions: activated ? GRAPHYNE_INSTRUCTIONS : undefined,
  capabilities: activated ? { tools: { listChanged: true } } : {},
  wire: "sdk",
  tools: activated ? tools : new Map(),
});

server.start();
const mode = activated ? "active" : "dormant (no .graphyne/ — opt in to enable)";
console.error(`Graphyne MCP ready [${mode}] — project "${project.name}" at ${project.path}`);

// #endregion Main

#!/usr/bin/env node
// Memosyne MCP server (stdio). Thin adapter: resolves the git project, declares the
// frozen tool schemas, and registers tools that delegate to the pure handlers in
// handlers.mjs. All task-file reads/writes go through these tools, keeping the
// on-disk schema consistent.
//
// Tasks live flat as <repoRoot>/.memosyne/<stem>.md. Tasks can be cross-referenced
// via their <memosyne-related> section (a list of related task stems); the relation
// is undirected and maintained by the link/unlink tools, which write both sides.
//
// The transport is the vendored shared core (common/mcp-core.mjs) in its "sdk"
// wire dialect: the prior server ran on the official MCP SDK, and everything
// the agent can observe — tool names/descriptions/inputSchema JSON, the
// initialize shape, zod-shaped validation rejections (common/zod-validate.mjs),
// error channels — is a frozen compat surface (the exact wire dialect
// memosyne@0.1.64 shipped). The ONE deliberate exception is the `instructions`
// text (./instructions.mjs): the 0.1.64 text was ~9KB but Claude Code silently
// truncates it at ~2KB, so it was re-cut in Omnium to fit the cap; see the
// budget tests in tests/memosyne/instructions.test.mts.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createMcpServer, readPluginVersion } from "./common/mcp-core.mjs";
import { validateToolArguments } from "./common/zod-validate.mjs";
import {
  SECTIONS,
  STATUSES,
  DEFAULT_STATUS,
  SUMMARY_SOFT_MAX,
  DESCRIPTION_SOFT_MAX,
  MAX_TAGS,
} from "./common/task.mjs";
import { resolveProject, gitInfo } from "./common/project.mjs";
import { upsertProject } from "./common/registry.mjs";
import { storeDir, ensureConfig, ensureAgentGuides, readConfig } from "./common/storage.mjs";
import { MEMOSYNE_INSTRUCTIONS } from "./instructions.mjs";
import * as h from "./handlers.mjs";

const PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url));

// #region Project context

// A project's identity is its root path (the git repo root if any, else cwd);
// git is not required. The repo root is used so the project has a single
// .memosyne store regardless of which subdirectory the agent ran from.
// As a plugin, MEMOSYNE_PROJECT_DIR is set to ${CLAUDE_PROJECT_DIR}. Use `||` (not `??`)
// so an empty string — which happens in CLI contexts where that var isn't substituted —
// falls back to the process cwd instead of resolving an empty (invalid) path.
const PROJECT_CWD = process.env.MEMOSYNE_PROJECT_DIR || process.cwd();
const project = resolveProject(PROJECT_CWD);

function root() {
  return project.path;
}

// Register the project in the discovery registry, refreshing its cached vcs
// info (git branch / folder). Done on every task-write (so a project appears as
// soon as it has tasks and active projects stay fresh) and once at startup if a
// task store already exists (so a reset/lost registry re-discovers it).
function register() {
  const { name } = ensureConfig(project.path, project.name);
  ensureAgentGuides(project.path);
  upsertProject({ path: project.path, name: name ?? project.name, ...gitInfo(project.path) });
}

// Memosyne is OPT-IN per project: it operates only where the user has adopted it by
// creating a `.memosyne/` directory at the project root. Until then the server
// registers NO tools and ships no instructions (see below) — it connects but
// advertises nothing, so the agent sees Memosyne as if it were not installed at all.
// Adopt a project by creating the directory, then restart the session: activation
// is resolved once, here at startup.
const activated = existsSync(storeDir(project.path));
if (activated) register();

// #endregion Project context

// #region Input schemas

// The advertised inputSchema JSON objects are byte-frozen compat surfaces: they
// reproduce exactly what the prior zod pipeline emitted through the SDK's
// zod-to-JSON-Schema conversion, including key order and the trailing $schema.
const DRAFT7 = "http://json-schema.org/draft-07/schema#";

/**
 * The draft-07 wrapper the SDK emitted for every non-empty tool schema:
 * type/properties[/required]/additionalProperties/$schema in that key order,
 * with `required` omitted when no property is required.
 * @param {Record<string, object>} properties
 * @param {string[]} required
 * @returns {import("./common/zod-validate.mjs").InputSchema}
 */
function draft7(properties, required) {
  /** @type {{ [key: string]: unknown }} */
  const schema = { type: "object", properties };
  if (required.length > 0) schema.required = required;
  schema.additionalProperties = false;
  schema.$schema = DRAFT7;
  return schema;
}

// One file entry of the Files section; shared by create/update exactly as the
// prior `fileInput` zod shape was.
const FILE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string", minLength: 1, description: "Path relative to the repo root" },
    priority: {
      type: "string",
      enum: ["P0", "P1"],
      description: "P0 = must read, P1 = potentially useful",
    },
    tags: {
      type: "array",
      items: { type: "string" },
      maxItems: MAX_TAGS,
      description: "Up to 5 single-word context tags",
    },
  },
  required: ["path", "priority"],
  additionalProperties: false,
};

// The shared create-task body properties (prior `bodyShape`).
const BODY_PROPERTIES = {
  summary: {
    type: "string",
    minLength: 1,
    description:
      `A stable 1-3 sentence ABSTRACT of what this task is about and why (<=${SUMMARY_SOFT_MAX} chars, single line) — ` +
      `enough for a reader to decide whether to open the details. NOT its status, progress or results: no "DONE", ` +
      `no test counts, no step log (state goes in status, detail in description). It should read the same whether ` +
      `the task is Backlog or Done.`,
  },
  status: {
    type: "string",
    enum: [...STATUSES],
    description: `Task state (default ${DEFAULT_STATUS}); one of: ${STATUSES.join(", ")}`,
  },
  description: {
    type: "string",
    description:
      `Full details: requirements, plan, nuances. Aim to keep it under ~${DESCRIPTION_SOFT_MAX} chars — past that ` +
      `the write still succeeds but you'll be warned to split the work into separate tasks linked with ` +
      `memosyne_link rather than growing one oversized description.`,
  },
  files: { type: "array", items: FILE_INPUT_SCHEMA },
};

// #endregion Input schemas

// #region Server

/** @typedef {import("./common/mcp-core.mjs").ToolResult} ToolResult */
/** @typedef {import("./common/mcp-core.mjs").ToolSpec} ToolSpec */

/**
 * @param {string} text
 * @returns {ToolResult}
 */
function ok(text) {
  return { content: [{ type: "text", text }] };
}

// The `initialize` instructions live in ./instructions.mjs (import-safe for the
// budget tests; this file starts the server at import time).

// Opt-in gate: when the project hasn't adopted Memosyne, the tool map below stays
// empty so NO tools are advertised and the sdk-wire core answers tools/list and
// tools/call with -32601 — the agent sees Memosyne as if it did not exist. The
// server still connects (the MCP handshake succeeds); only tool registration is
// suppressed, mirroring the prior no-op registerTool stub.
/** @type {Map<string, ToolSpec>} */
const tools = new Map();

/**
 * Register one tool, replicating the prior SDK wrapper's behavior around the
 * pure handler: the zod-shaped argument gate runs first (as ToolSpec.validate),
 * and ANY error thrown by the handler — ToolError or unexpected — surfaces as
 * an in-band isError result carrying the error's message, never as a JSON-RPC
 * error (the SDK converted callback throws the same way).
 * @param {string} name
 * @param {{ title: string, description: string, inputSchema: import("./common/zod-validate.mjs").InputSchema }} definition
 * @param {(args: any) => string | Promise<string>} run
 */
function registerTool(name, definition, run) {
  if (!activated) return;
  tools.set(name, {
    title: definition.title,
    description: definition.description,
    inputSchema: /** @type {{ [key: string]: unknown }} */ (definition.inputSchema),
    // The SDK advertised task support as forbidden on every tool; frozen shape.
    execution: { taskSupport: "forbidden" },
    validate: (args) => validateToolArguments(name, definition.inputSchema, args),
    handler: async (args) => {
      try {
        return ok(await run(args));
      } catch (err) {
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      }
    },
  });
}

registerTool(
  "memosyne_project",
  {
    title: "Current Memosyne project",
    description: "Show the git project Memosyne tracks tasks for and where its .memosyne/ store lives.",
    // The one empty-shape tool: the SDK emitted this exact object (note the
    // LEADING $schema and the absence of additionalProperties).
    inputSchema: { $schema: DRAFT7, type: "object", properties: {} },
  },
  async () => h.projectInfo({ name: readConfig(project.path).name ?? project.name, path: project.path }),
);

registerTool(
  "memosyne_create_task",
  {
    title: "Create task",
    description:
      "Create a new session-independent task as .memosyne/<stem>.md. Capture everything needed to resume in a fresh session.",
    inputSchema: draft7(
      {
        name: {
          type: "string",
          minLength: 1,
          description: "Short generalized name (<=30 chars, slugified into the stem)",
        },
        ...BODY_PROPERTIES,
      },
      ["name", "summary"],
    ),
  },
  async (input) => {
    const out = h.createTask(root(), new Date(), input);
    register();
    return out;
  },
);

registerTool(
  "memosyne_list_tasks",
  {
    title: "List tasks",
    description:
      `List top-level tasks newest first — navigate without reading full files. Two tiers: the newest ` +
      `${h.DEFAULT_EXPANDED} print as full records (status, related count, summary); the next ${h.DEFAULT_COMPACT} ` +
      `print as compact \`stem — status\` one-liners so you stay aware of older work (notably lingering Active/Backlog) ` +
      `cheaply. Raise \`expanded\`/\`compact\` (or 0) and/or pass \`status\` to page deeper, e.g. the last N Done tasks ` +
      `even when newer Backlog/Active tasks sit on top.`,
    inputSchema: draft7(
      {
        expanded: {
          type: "integer",
          minimum: 0,
          description: `Newest tasks to print as full records (default ${h.DEFAULT_EXPANDED}; 0 = no cap, all full)`,
        },
        compact: {
          type: "integer",
          minimum: 0,
          description:
            `Tasks after the expanded window to print as compact \`stem — status\` lines (default ${h.DEFAULT_COMPACT}; 0 = none)`,
        },
        status: {
          type: "array",
          items: { type: "string", enum: [...STATUSES] },
          description: `Only tasks whose status is in this set (any of: ${STATUSES.join(", ")}). Default: any status.`,
        },
      },
      [],
    ),
  },
  async (input) => h.listTasks(root(), input),
);

registerTool(
  "memosyne_find_by_file",
  {
    title: "Find tasks by file",
    description:
      "Find tasks whose Files section references a given path (case-insensitive substring), optionally narrowed to a priority " +
      "(P0/P1). Returns each matching task with the file entries that matched and their tags — so you can see which tasks " +
      `touched a file and, via the tags, what was key about it there. Newest first; capped at ${h.DEFAULT_LIST_LIMIT} by default.`,
    inputSchema: draft7(
      {
        path: {
          type: "string",
          minLength: 1,
          description: "File path to look for (case-insensitive substring; e.g. 'handlers.mts' or 'src/mcp/')",
        },
        priority: {
          type: "string",
          enum: ["P0", "P1"],
          description: "Only match file entries with this priority (P0 = must read, P1 = maybe useful)",
        },
        limit: {
          type: "integer",
          minimum: 0,
          description: `Max tasks, newest first (default ${h.DEFAULT_LIST_LIMIT}; 0 = no cap)`,
        },
      },
      ["path"],
    ),
  },
  async (input) => h.findByFile(root(), input),
);

registerTool(
  "memosyne_search",
  {
    title: "Search task text",
    description:
      "Full-text search across tasks: match a regular expression (case-insensitive) against each task's summary and " +
      "description. A plain word works as a substring search; use regex for more. Returns each matching task with a " +
      `snippet around the first hit. Newest first; capped at ${h.DEFAULT_LIST_LIMIT} by default. To search by file path ` +
      "instead, use memosyne_find_by_file.",
    inputSchema: draft7(
      {
        query: {
          type: "string",
          minLength: 1,
          description: "Regular expression, matched case-insensitively (a plain word = substring search)",
        },
        limit: {
          type: "integer",
          minimum: 0,
          description: `Max tasks, newest first (default ${h.DEFAULT_LIST_LIMIT}; 0 = no cap)`,
        },
      },
      ["query"],
    ),
  },
  async (input) => h.searchText(root(), input),
);

registerTool(
  "memosyne_get_task",
  {
    title: "Get task",
    description: "Read a task. Pass `sections` to fetch only what you need (default: all).",
    inputSchema: draft7(
      {
        task: { type: "string", description: "Task stem" },
        sections: {
          type: "array",
          items: { type: "string", enum: [...SECTIONS] },
          description: "Subset of: " + SECTIONS.join(", "),
        },
      },
      ["task"],
    ),
  },
  async (input) => h.getTask(root(), input),
);

registerTool(
  "memosyne_update_task",
  {
    title: "Update task",
    description:
      "Replace sections of a task. Omitted fields are left unchanged. Manage cross-references with memosyne_link / memosyne_unlink. Refuses to edit a task that is already Done and >2h old (unless it is among the 3 most recent tasks) — create a NEW task for follow-up work instead, or pass force: true to override.",
    inputSchema: draft7(
      {
        task: { type: "string" },
        summary: {
          type: "string",
          description:
            "Rarely changes: the stable 1-3 sentence abstract of what the task is about — NOT its progress/results " +
            "(record those in status + description). Leave it as-is unless the task's essence itself changed.",
        },
        status: { type: "string", enum: [...STATUSES] },
        description: { type: "string" },
        files: { type: "array", items: FILE_INPUT_SCHEMA },
        force: {
          type: "boolean",
          description: "Override the stale-Done-task guard (edit a completed task older than 2h anyway)",
        },
      },
      ["task"],
    ),
  },
  async (input) => h.updateTask(root(), new Date(), input),
);

registerTool(
  "memosyne_edit_task",
  {
    title: "Edit task",
    description:
      "Make a targeted edit to a plain-text section by replacing an exact snippet of its current text, instead of resending the whole section with memosyne_update_task. Read the section first with memosyne_get_task, copy the snippet you want to change VERBATIM into old_text (byte-for-byte — same whitespace, indentation and punctuation), and put the replacement in new_text. old_text is matched against the CURRENT body of the section (the text under its '# <memosyne-…>' header, as returned by memosyne_get_task) — do NOT include the header line, and this is literal text, NOT a diff (no @@ hunks, no +/- line prefixes). old_text must occur EXACTLY ONCE or the edit is refused and nothing is written — add surrounding context to make it unique, or set replace_all: true to change every occurrence. An empty new_text (\"\") deletes the matched text. Sections: description (default), summary, status. Use memosyne_update_task for a full-section replace, the file fields for the Files section, and memosyne_link / memosyne_unlink for the Related section. Refuses to edit a task that is already Done and >2h old (unless among the 3 most recent) — create a NEW task instead, or pass force: true to override.",
    inputSchema: draft7(
      {
        task: { type: "string", description: "Task stem" },
        section: {
          type: "string",
          enum: ["description", "summary", "status"],
          description: "Which plain-text section to edit (default: description)",
        },
        old_text: {
          type: "string",
          minLength: 1,
          description:
            "The exact snippet to find, copied VERBATIM from memosyne_get_task output — same whitespace, indentation and punctuation; do not retype from memory or normalize. Matched against the section BODY only, so omit the '# <memosyne-…>' header line. Literal text, not a diff (no @@, no +/- prefixes). Must occur exactly once unless replace_all is true.",
        },
        new_text: {
          type: "string",
          description:
            'The replacement text (literal, not a diff). Pass an empty string "" to delete the matched snippet.',
        },
        replace_all: {
          type: "boolean",
          description:
            "Replace EVERY occurrence of old_text instead of requiring a single unique match (default false). Use for rename-all style edits.",
        },
        force: {
          type: "boolean",
          description: "Override the stale-Done-task guard (edit a completed task older than 2h anyway)",
        },
      },
      ["task", "old_text", "new_text"],
    ),
  },
  async (input) => h.editTask(root(), new Date(), input),
);

registerTool(
  "memosyne_link",
  {
    title: "Link tasks",
    description:
      "Relate two tasks. The relation is UNDIRECTED — it is written into BOTH tasks' Related sections — so a future agent can hop between connected work. Idempotent; both tasks must already exist.",
    inputSchema: draft7(
      {
        task: { type: "string", description: "First task stem" },
        related: { type: "string", description: "Second task stem to relate it to" },
      },
      ["task", "related"],
    ),
  },
  async (input) => {
    const out = h.linkTasks(root(), input);
    register();
    return out;
  },
);

registerTool(
  "memosyne_unlink",
  {
    title: "Unlink tasks",
    description: "Remove the relation between two tasks, from BOTH tasks' Related sections.",
    inputSchema: draft7(
      {
        task: { type: "string", description: "First task stem" },
        related: { type: "string", description: "The related task stem to disconnect" },
      },
      ["task", "related"],
    ),
  },
  async (input) => {
    const out = h.unlinkTasks(root(), input);
    register();
    return out;
  },
);

registerTool(
  "memosyne_delete_task",
  {
    title: "Delete task",
    description:
      "Delete a task. Because relations are undirected, the task's stem is also removed from each of its neighbors' Related sections, so no dangling reference is left behind.",
    inputSchema: draft7({ task: { type: "string" } }, ["task"]),
  },
  async (input) => h.deleteTask(root(), input),
);

// `name` is the stable identifier (the tool namespace stays mcp__…__memosyne_*);
// `title` is the human-readable label spec-aware clients may display. Instructions
// and the tools capability are shipped only when the project has opted in; a
// dormant server stays silent (capabilities {} — no tool support advertised).
const server = createMcpServer({
  name: "memosyne",
  title: "Memosyne",
  version: readPluginVersion(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json")),
  wire: "sdk",
  capabilities: activated ? { tools: { listChanged: true } } : {},
  instructions: activated ? MEMOSYNE_INSTRUCTIONS : undefined,
  tools,
});

// #endregion Server

// Logs go to stderr (the core's log helper) to avoid corrupting the JSON-RPC
// stream on stdout.
const mode = activated ? "active" : "dormant (no .memosyne/ — opt in to enable)";
server.start(`[${mode}] project "${project.name}" at ${project.path}`);

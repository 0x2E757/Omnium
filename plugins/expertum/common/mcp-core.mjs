// VENDORED SHARED MODULE — canonical copy: shared/mcp-core.mjs. Do not edit any plugins/*/common/ copy; edit shared/ and run: node scripts/sync-shared.mjs
//
// Shared stdio MCP server core: zero-dependency, newline-delimited JSON-RPC
// 2.0 over stdin/stdout, with stderr reserved for logging. This is the
// parameterized generalization of expertum's battle-tested server.js
// transport — same dispatch, same error codes (-32601 unknown method, -32602
// unknown tool, -32603 handler crash), same malformed-line tolerance — grown
// to a tools MAP, optional `instructions`, and a pre-handler argument gate
// (./mcp-schema.mjs, its sibling). A consumer builds a server with
// createMcpServer({ name, version, instructions?, tools }) and calls start();
// everything tool-specific (schemas, handlers, project-dir resolution) stays
// in the consumer's entry file.
//
// Non-obvious decision: response assembly is isolated in one small function
// per method (initializeResult / toolsListResult / handleToolsCall) so a
// consumer-specific wire-shape shim never has to touch the dispatch loop —
// the initialize and tools/list shapes are frozen compat surfaces, pinned
// per consumer by the tests/<plugin>/ suites and the parity harness.
//
// Two wire dialects exist because the prior servers came from two lineages.
// Expertum's hand-rolled server is `wire: "prior"` (the default). Graphyne
// and memosyne shipped on the official @modelcontextprotocol/sdk, whose
// dispatch differs in small, agent-visible ways that are frozen compat
// surfaces too; `wire: "sdk"` reproduces them: `ping` answered with {},
// bare "Method not found" -32601 text (no method name appended), tools/list
// and tools/call unregistered (-32601) while the tool map is empty (a
// dormant opt-in server advertises NO tool support at all), and an unknown
// tool reported as an in-band isError result instead of a JSON-RPC error.
//
// Failure posture: malformed input lines are logged to stderr and skipped
// (never fatal); a throwing handler yields -32603 for requests and silence
// for notifications; the process exits only when stdin closes.

import fs from "node:fs";
import readline from "node:readline";

import { validateInput } from "./mcp-schema.mjs";

// The MCP protocol revision all the prior servers speak; frozen compat
// surface — clients pin on it, so bumping it is a breaking change.
const PROTOCOL_VERSION = "2024-11-05";

/**
 * @typedef {{ [key: string]: unknown }} JsonObject
 */

/**
 * An MCP tool outcome: `{ content: [...] }` on success, plus `isError: true`
 * for tool-level failures that must NOT become JSON-RPC errors.
 * @typedef {{ content: Array<{ type: string, text: string }>, isError?: boolean }} ToolResult
 */

/**
 * One registered tool.
 * @typedef {object} ToolSpec
 * @property {string} [title] Optional human-readable name; advertised in tools/list only when present.
 * @property {string} description Advertised verbatim in tools/list — frozen compat surface for ported tools.
 * @property {JsonObject} inputSchema JSON Schema advertised verbatim in tools/list — frozen compat surface.
 * @property {JsonObject} [execution] Advertised verbatim after inputSchema when present. The official
 *   SDK the prior graphyne/memosyne servers were built on emits
 *   `execution: { taskSupport: "forbidden" }` per tool, and that shape is pinned by the parity
 *   harness — consumers ported from the SDK pass it through; expertum (never SDK-based) omits it.
 * @property {JsonObject} [validationSchema] Schema the core gates tools/call with; defaults to inputSchema.
 *   Lets a ported tool keep its advertised schema byte-frozen while matching its prior validation
 *   semantics exactly (e.g. expertum gates only its required properties, because its handler
 *   deliberately tolerates wrong-typed optional ones).
 * @property {(args: unknown) => ValidationResult} [validate] Custom argument gate replacing the
 *   mcp-schema one entirely. SDK-ported consumers use it to reproduce their prior zod pipeline's
 *   rejection text byte-for-byte (mcp-schema's house-style messages would be a compat break there);
 *   the returned failure message is emitted verbatim as an isError tool result.
 * @property {(args: any) => ToolResult | Promise<ToolResult>} handler Runs only after the gate passes;
 *   must return a ToolResult and never throw for expected rejections.
 */

/**
 * @typedef {import("./mcp-schema.mjs").ValidationResult} ValidationResult
 */

/**
 * Single source of truth for a server's version: the version stamped into the
 * plugin manifest, so the version-keyed marketplace cache and serverInfo can
 * never disagree. Best-effort: returns "0.0.0" if the manifest cannot be read.
 * @param {string} manifestPath absolute path to the plugin's .claude-plugin/plugin.json
 */
export function readPluginVersion(manifestPath) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (typeof manifest.version === "string" && manifest.version.trim() !== "") {
      return manifest.version;
    }
  } catch {
    // Fall through to the static default: a missing manifest must never
    // prevent the server from starting.
  }
  return "0.0.0";
}

/**
 * The message text for a thrown value, preferring a truthy `.message` and
 * falling back to String() — the exact semantics of the prior servers'
 * `err && err.message ? err.message : String(err)`.
 * @param {unknown} err
 */
function errorText(err) {
  if (err && typeof err === "object" && "message" in err && err.message) {
    return String(err.message);
  }
  return String(err);
}

/**
 * Build a stdio MCP server around a set of tools. Returns
 * `{ start, handleMessage }`: start() wires the stdin loop; handleMessage is
 * exposed so unit tests can drive the dispatch without a child process.
 *
 * @param {object} options
 * @param {string} options.name serverInfo.name — also the stderr log prefix ("[<name>-mcp]").
 * @param {string} [options.title] serverInfo.title, emitted between name and version ONLY when
 *   provided — the official SDK advertised one for graphyne/memosyne ("Graphyne"/...), while
 *   expertum's hand-rolled server never did and its initialize shape is byte-frozen without it.
 * @param {string} options.version serverInfo.version (see readPluginVersion).
 * @param {string} [options.instructions] Emitted in the initialize result ONLY when provided:
 *   expertum historically emits none and its initialize shape is byte-frozen, while
 *   graphyne/memosyne pass the instructions their clients have always seen.
 * @param {JsonObject} [options.capabilities] Overrides the advertised capabilities object.
 *   Default is `{ tools: {} }` (expertum's frozen shape); SDK-ported consumers pass
 *   `{ tools: { listChanged: true } }` because that is what their clients have always seen.
 * @param {"prior" | "sdk"} [options.wire] Wire dialect (see header). Defaults to "prior",
 *   the expertum-lineage dispatch; "sdk" reproduces the official-SDK dispatch the
 *   graphyne/memosyne clients have always seen.
 * @param {Map<string, ToolSpec> | Record<string, ToolSpec>} options.tools tools keyed by wire name;
 *   tools/list advertises them in registration order.
 */
export function createMcpServer(options) {
  const { name, title, version, instructions, capabilities, tools } = options;
  const toolMap = tools instanceof Map ? tools : new Map(Object.entries(tools));
  const sdkWire = options.wire === "sdk";

  /** @param {...string} args */
  function log(...args) {
    // Logs go to stderr only; stdout is reserved for JSON-RPC frames.
    process.stderr.write("[" + name + "-mcp] " + args.join(" ") + "\n");
  }

  /** @param {JsonObject} message */
  function send(message) {
    process.stdout.write(JSON.stringify(message) + "\n");
  }

  /** @param {unknown} id @param {unknown} result */
  function sendResult(id, result) {
    send({ jsonrpc: "2.0", id, result });
  }

  /** @param {unknown} id @param {number} code @param {string} message */
  function sendError(id, code, message) {
    send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  // --- Response assembly, one small function per method (see header). -------

  function initializeResult() {
    /** @type {JsonObject} */
    const serverInfo = { name };
    if (title !== undefined) serverInfo.title = title;
    serverInfo.version = version;
    /** @type {JsonObject} */
    const result = {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: capabilities !== undefined ? capabilities : { tools: {} },
      serverInfo,
    };
    // `instructions` comes last, matching the field order the official SDK
    // emitted for the servers that historically had one.
    if (instructions !== undefined) result.instructions = instructions;
    return result;
  }

  function toolsListResult() {
    const list = [];
    for (const [toolName, spec] of toolMap) {
      /** @type {JsonObject} */
      const definition = { name: toolName };
      if (spec.title !== undefined) definition.title = spec.title;
      definition.description = spec.description;
      definition.inputSchema = spec.inputSchema;
      if (spec.execution !== undefined) definition.execution = spec.execution;
      list.push(definition);
    }
    return { tools: list };
  }

  /** @param {unknown} id @param {any} params */
  async function handleToolsCall(id, params) {
    const tool = toolMap.get(params.name);
    if (!tool) {
      if (sdkWire) {
        // The SDK reported an unknown tool in-band, as an isError tool result
        // whose text is the McpError message — pinned by the parity harness.
        sendResult(id, {
          content: [{ type: "text", text: "MCP error -32602: Tool " + String(params.name) + " not found" }],
          isError: true,
        });
      } else {
        sendError(id, -32602, "Unknown tool: " + String(params.name));
      }
      return;
    }
    const checked = tool.validate
      ? tool.validate(params.arguments)
      : validateInput(tool.validationSchema || tool.inputSchema, params.arguments);
    if (!checked.ok) {
      // Argument rejections are TOOL results (isError), not JSON-RPC errors —
      // exactly what the prior in-handler validation produced on the wire.
      sendResult(id, { isError: true, content: [{ type: "text", text: checked.message }] });
      return;
    }
    const result = await tool.handler(checked.value);
    if (result === undefined || result === null) {
      // The ToolSpec contract requires every handler to return a ToolResult;
      // serializing undefined would emit a result-less frame that is not
      // valid JSON-RPC, so a broken handler is surfaced as -32603 instead.
      sendError(id, -32603, "Tool \"" + String(params.name) + "\" returned no result; fix the tool handler to return a ToolResult.");
      return;
    }
    sendResult(id, result);
  }

  /** @param {unknown} id @param {string} method */
  function sendMethodNotFound(id, method) {
    // The SDK never echoed the method name; expertum's prior text does.
    // Both texts are frozen per lineage.
    sendError(id, -32601, sdkWire ? "Method not found" : "Method not found: " + String(method));
  }

  /**
   * Dispatch one parsed JSON-RPC message. Notifications (no id) and requests
   * (with id) both arrive here; unknown methods are only answered for requests.
   * @param {any} msg
   */
  async function handleMessage(msg) {
    const id = msg.id;
    // The SDK registers the tools/* handlers only when at least one tool
    // exists, so a dormant (empty-map) sdk-wire server answers them -32601 —
    // to the client it looks as if tool support were never implemented.
    const toolMethodsRegistered = !sdkWire || toolMap.size > 0;
    switch (msg.method) {
      case "initialize":
        sendResult(id, initializeResult());
        return;
      case "notifications/initialized":
        // No response for notifications.
        return;
      case "ping":
        // Only the SDK lineage implements ping; expertum's frozen wire
        // answers it -32601 like any other unknown method.
        if (sdkWire) {
          sendResult(id, {});
          return;
        }
        break;
      case "tools/list":
        if (toolMethodsRegistered) {
          sendResult(id, toolsListResult());
          return;
        }
        break;
      case "tools/call":
        if (toolMethodsRegistered) {
          await handleToolsCall(id, msg.params || {});
          return;
        }
        break;
    }
    if (id !== undefined && id !== null) {
      sendMethodNotFound(id, msg.method);
    }
  }

  /**
   * Handle one raw stdin line: skip blanks, log-and-skip unparseable JSON,
   * and convert a throwing handler into -32603 for requests. Never rejects,
   * so the serial queue in start() can never wedge.
   * @param {string} line
   */
  async function handleLine(line) {
    const trimmed = line.trim();
    if (trimmed === "") return;

    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (err) {
      // Cannot recover an id from unparseable input; log and move on.
      log("Failed to parse line as JSON:", errorText(err));
      return;
    }

    try {
      await handleMessage(msg);
    } catch (err) {
      log("Handler error:", errorText(err));
      if (msg && msg.id !== undefined && msg.id !== null) {
        sendError(msg.id, -32603, "Internal error.");
      }
    }
  }

  /**
   * Start the stdio loop. Lines are processed strictly in arrival order via a
   * serial promise chain, so async handlers can never interleave or reorder
   * responses. The optional `note` is appended to the startup log line, e.g.
   * "project=/x" -> "<name> MCP server started (project=/x)."
   * @param {string} [note]
   */
  function start(note) {
    const rl = readline.createInterface({ input: process.stdin });
    let queue = Promise.resolve();

    rl.on("line", (line) => {
      queue = queue.then(() => handleLine(line));
    });

    rl.on("close", () => {
      // Exit only after every queued line has been answered.
      queue.then(() => process.exit(0));
    });

    log(name + " MCP server started" + (note ? " (" + note + ")" : "") + ".");
  }

  return { start, handleMessage };
}

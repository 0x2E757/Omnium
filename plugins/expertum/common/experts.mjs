/*
 * The Expertum expert catalog: the lenses the analyst sub-agent can take on,
 * kept as DATA under ../experts/ instead of as one registered sub-agent each.
 * Every registered agent costs a roster line in every session's context
 * whether or not Expertum is used, so the plugin registers a single
 * `expertum:analyst` and serves the lenses through two MCP tools
 * (DESIGN.md D21):
 *
 *  - `expertum_overview` — the roster the orchestrating command picks from:
 *    each expert's name and one-line domain, grouped, plus the ownership
 *    boundaries between lanes (../experts/_lanes.md).
 *  - `expertum_expert` — one expert's lens (role line, Focus, Method), which
 *    the analyst loads as its first step.
 *
 * An expert file is `<name>.md`: a front-matter block of `key: value` lines
 * (`name`, `group`, `domain`) and a Markdown body. Files starting with `_` are
 * not experts. Lookups go through the loaded map only — no path is ever built
 * from a tool argument. Pure logic: nothing here touches stdin/stdout.
 */

import fs from "node:fs";
import path from "node:path";

import { toolError } from "./server-lib.mjs";

export const OVERVIEW_TOOL_NAME = "expertum_overview";
export const EXPERT_TOOL_NAME = "expertum_expert";

// The spawn protocol, owned here: every analyst runs as this sub-agent type,
// and the first line of its brief names its expert. The overview states both;
// agents/analyst.md and the five commands restate them, and
// tests/expertum/agent-parity.test.mjs pins every restatement to these values.
export const ANALYST_AGENT = "expertum:analyst";
export const EXPERT_BRIEF_LINE = "Expert: <name>";

/** Group headings, in the order the overview lists them. */
export const GROUPS = [
  "Design & architecture",
  "Platform",
  "Security",
  "Performance",
  "Operations & infrastructure",
  "Quality, testing & docs",
  "Diagnostics",
];

const LANES_FILE = "_lanes.md";
const REQUIRED_KEYS = ["name", "group", "domain"];

/** The tool definitions advertised in tools/list. */
export const OVERVIEW_TOOL_DEFINITION = {
  name: OVERVIEW_TOOL_NAME,
  description:
    "List every Expertum expert lens — name and one-line domain, grouped — plus the " +
    "ownership boundaries between them. Call this to pick which experts to consult. " +
    "Each expert runs as sub-agent type '" + ANALYST_AGENT + "' whose brief starts with '" +
    EXPERT_BRIEF_LINE + "'.",
  inputSchema: { type: "object", properties: {} },
};

export const EXPERT_TOOL_DEFINITION = {
  name: EXPERT_TOOL_NAME,
  description:
    "Load one Expertum expert's lens — its role, Focus and Method — by name, as listed " +
    "by expertum_overview. The " + ANALYST_AGENT + " sub-agent calls this first, to become " +
    "the expert its brief names.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "The expert's name, e.g. 'code--quality'.",
      },
    },
    required: ["name"],
  },
};

/**
 * @typedef {{ name: string, group: string, domain: string, body: string }} Expert
 * @typedef {{ experts: Map<string, Expert>, lanes: string }} Catalog
 */

/**
 * An Error naming the catalog file at fault.
 * @param {string} file
 * @param {string} message
 */
function defect(file, message) {
  return new Error("experts/" + file + ": " + message);
}

/**
 * Read a catalog file as text with a UTF-8 BOM stripped and newlines
 * normalized to `\n` — Windows editors add both.
 * @param {string} dir
 * @param {string} file
 */
function readText(dir, file) {
  return fs.readFileSync(path.join(dir, file), "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
}

/**
 * Parse one expert file. Throws an Error naming the file on any defect, so a
 * broken catalog is reported precisely instead of silently losing a lens.
 * Front-matter lines without a `key:` are ignored, as are unknown keys.
 * @param {string} file the file's basename, e.g. `code--quality.md`
 * @param {string} text normalized by readText
 * @returns {Expert}
 */
function parseExpert(file, text) {
  const lines = text.split("\n");
  const close = lines.indexOf("---", 1);
  if (lines[0] !== "---" || close === -1) {
    throw defect(file, "missing the '---' front-matter block.");
  }
  /** @type {Record<string, string>} */
  const fields = Object.create(null);
  for (const line of lines.slice(1, close)) {
    const separator = line.indexOf(":");
    if (separator > 0) {
      fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
  }
  for (const key of REQUIRED_KEYS) {
    if (!fields[key]) {
      throw defect(file, "missing '" + key + "'.");
    }
  }
  if (fields.name + ".md" !== file) {
    throw defect(file, "'name' is '" + fields.name + "', which does not match the file.");
  }
  if (!GROUPS.includes(fields.group)) {
    throw defect(file, "unknown group '" + fields.group + "'.");
  }
  const body = lines.slice(close + 1).join("\n").trim();
  if (body === "") {
    throw defect(file, "has no body (role line, Focus, Method).");
  }
  return { name: fields.name, group: fields.group, domain: fields.domain, body };
}

/**
 * Load the catalog from an experts directory: every `*.md` not starting with
 * `_` is an expert; `_lanes.md` holds the ownership boundaries. An empty
 * catalog or a missing lanes file is a defect, not an empty answer.
 * @param {string} dir
 * @returns {Catalog}
 */
export function loadCatalog(dir) {
  /** @type {Map<string, Expert>} */
  const experts = new Map();
  let lanes;
  for (const file of fs.readdirSync(dir).sort()) {
    if (file === LANES_FILE) {
      lanes = readText(dir, file).trim();
    } else if (file.endsWith(".md") && !file.startsWith("_")) {
      const expert = parseExpert(file, readText(dir, file));
      experts.set(expert.name, expert);
    }
  }
  if (experts.size === 0) {
    throw new Error("the experts directory holds no experts: " + dir);
  }
  if (!lanes) {
    throw defect(LANES_FILE, "missing or empty — the ownership boundaries are part of the catalog.");
  }
  return { experts, lanes };
}

/**
 * Render the roster the orchestrating command picks from.
 * @param {Catalog} catalog
 */
export function renderOverview(catalog) {
  const lines = [
    "# Expertum experts (" + catalog.experts.size + ")",
    "",
    "Spawn every analyst as sub-agent type `" + ANALYST_AGENT + "` and start its brief with",
    "`" + EXPERT_BRIEF_LINE + "`; the analyst loads that expert's lens itself. The report",
    "stem is the expert's name (e.g. `review--code--quality.md`).",
  ];
  for (const group of GROUPS) {
    const members = [...catalog.experts.values()].filter((e) => e.group === group);
    if (members.length === 0) continue;
    lines.push("", "## " + group, "");
    for (const expert of members) {
      lines.push("- `" + expert.name + "` — " + expert.domain);
    }
  }
  lines.push("", "## Ownership boundaries", "", catalog.lanes);
  return lines.join("\n") + "\n";
}

/**
 * Run a catalog-backed tool body, turning a catalog load failure into a tool
 * error so the report-writing tool on the same server keeps working.
 * @param {() => Catalog} getCatalog
 * @param {(catalog: Catalog) => import("./mcp-core.mjs").ToolResult} body
 */
function withCatalog(getCatalog, body) {
  let catalog;
  try {
    catalog = getCatalog();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return toolError("The Expertum expert catalog failed to load: " + detail);
  }
  return body(catalog);
}

/**
 * `expertum_overview` handler.
 * @param {() => Catalog} getCatalog
 */
export function handleOverview(getCatalog) {
  return withCatalog(getCatalog, (catalog) => ({
    content: [{ type: "text", text: renderOverview(catalog) }],
  }));
}

/**
 * `expertum_expert` handler.
 * @param {any} args
 * @param {() => Catalog} getCatalog
 */
export function handleExpert(args, getCatalog) {
  return withCatalog(getCatalog, (catalog) => {
    const name = args && typeof args.name === "string" ? args.name : "";
    const expert = catalog.experts.get(name);
    // The caller is the analyst, which cannot browse the roster: the error
    // tells it to stop and hand the bad name back to whoever spawned it.
    if (!expert) {
      return toolError(
        "Unknown expert " + JSON.stringify(args && args.name) + " — it is not in the Expertum " +
          "catalog. Do not analyze without a lens: stop and report this name back to whoever " +
          "spawned you (the orchestrator picks names from expertum_overview)."
      );
    }
    return {
      content: [
        {
          type: "text",
          text: "# Expert: " + expert.name + " (" + expert.group + ")\n\n" + expert.body + "\n",
        },
      ],
    };
  });
}

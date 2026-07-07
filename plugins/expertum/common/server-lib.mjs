/*
 * Pure logic for the Expertum MCP server, deliberately separated from the
 * stdio transport (../server.mjs, which boots the vendored mcp-core.mjs) so it
 * can be unit-tested by importing this module — nothing here touches
 * stdin/stdout or other process state. ESM port of the original server-lib.js;
 * every message, sanitization rule, and limit is transplanted byte-for-byte
 * (they are frozen compat surface).
 *
 * The single tool writes a Markdown report under the project-root `.expertum/`
 * directory and NEVER outside it: the filename is reduced to a sanitized
 * basename, and the optional `directory` must be a relative path whose first
 * segment is `.expertum` with no `..` segments. The resolved path is verified to
 * stay inside `<project>/.expertum/`.
 */

import fs from "node:fs";
import path from "node:path";

// The MCP tool name — single source of truth. server.mjs advertises it and
// the core validates tools/call against it; the analyst sub-agents reference
// the fully namespaced form `mcp__plugin_expertum_expertum__<TOOL_NAME>` in
// their `tools:` frontmatter. tests/expertum/agent-parity.test.mjs asserts the
// two stay in sync.
export const TOOL_NAME = "expertum_write_report";

// Reports may only ever be written under this per-project directory.
export const ROOT_DIR_NAME = ".expertum";

// Hard cap on a single report body (UTF-8 bytes). Reports are Markdown text, so
// 5 MiB is far above any legitimate report yet bounds a runaway/abusive write
// from exhausting disk.
export const MAX_CONTENT_BYTES = 5 * 1024 * 1024;

/** The tool definition advertised in tools/list — frozen compat surface. */
export const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description:
    "Write a Markdown analysis report under the project-root .expertum/ folder. " +
    "Use this as the ONLY way to persist findings. Pass the per-run 'directory' " +
    "(e.g. '.expertum/2026-06-11--14-30--my-task') given to you in your brief, " +
    "plus a 'filename' (e.g. 'review-security.md'). The file is written " +
    "(overwriting any existing file of the same name) at <directory>/<filename>. " +
    "If 'directory' is omitted the report lands directly in .expertum/.",
  inputSchema: {
    type: "object",
    properties: {
      filename: {
        type: "string",
        description:
          "Base name of the report file, e.g. 'review-security.md'. Directory parts are stripped.",
      },
      content: {
        type: "string",
        description: "The full Markdown content of the report.",
      },
      directory: {
        type: "string",
        description:
          "Optional relative target directory; its first segment must be '.expertum'. " +
          "Typically the per-run folder from your brief, e.g. " +
          "'.expertum/2026-06-11--14-30--my-task'. No '..' segments allowed.",
      },
      title: {
        type: "string",
        description:
          "Optional report title. If given and content does not already start with '# ', a '# <title>' heading is prepended.",
      },
    },
    required: ["filename", "content"],
  },
};

/**
 * Wrap a message as an MCP tool error result (isError, never a thrown error).
 * @param {string} message
 */
export function toolError(message) {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

/**
 * Collapse a single path segment to safe characters and trim leading dots/dashes
 * (so we never produce hidden or `..`-style names). Shared by sanitizeFilename
 * and resolveTargetDir so the rule lives in exactly one place.
 * @param {unknown} segment
 */
export function sanitizeSegment(segment) {
  const cleaned = String(segment)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "")
    // Windows silently strips a trailing dot (or run of dots) from a name, which
    // would mis-name or collide; drop them (mirrors the leading trim above).
    .replace(/\.+$/, "");
  // Windows reserves the device names CON, PRN, AUX, NUL, COM1-9, LPT1-9 — and the
  // reservation applies to the STEM regardless of extension (`con.md` still resolves
  // to the CON device, so the create fails / redirects). Test the pre-first-dot stem,
  // case-insensitively, and mangle a hit with a `_` prefix (which can never itself be
  // a reserved name and keeps the allowed charset). COM0/LPT0 are NOT devices. This is
  // a portable rule (no platform branch): the .expertum/ store is committed and shared.
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned.split(".")[0])) {
    return "_" + cleaned;
  }
  return cleaned;
}

/**
 * Reduce an arbitrary string to a safe `*.md` basename that can only ever land
 * inside the target directory. Strips directory parts and `..`, allows only
 * [A-Za-z0-9._-], collapses everything else to '-', and ensures a `.md` suffix.
 * @param {unknown} raw
 */
export function sanitizeFilename(raw) {
  // Take basename only (handles both / and \ separators), drop any `..`.
  let name = String(raw == null ? "" : raw);
  name = name.replace(/\\/g, "/");
  name = name.split("/").pop() || "";
  name = name.replace(/\.\./g, "");

  name = sanitizeSegment(name);

  if (name === "") {
    name = "report";
  }

  if (!/\.md$/i.test(name)) {
    name += ".md";
  }

  return name;
}

/**
 * Resolve the target directory for a report, enforcing that it stays inside
 * `<projectDir>/.expertum/`. Returns { dir, relDir } on success or { error } on
 * a rejected path.
 *
 * Rules:
 *  - No `directory` given -> defaults to `<projectDir>/.expertum`.
 *  - Must be a relative path whose first segment is exactly `.expertum`.
 *  - No `..` segments. Per-segment chars limited to [A-Za-z0-9._-].
 *  - The resolved absolute path must be the root itself or live beneath it.
 * @param {unknown} rawDir
 * @param {string} projectDir
 * @returns {{ dir: string, relDir: string, error?: undefined } | { error: string, dir?: undefined, relDir?: undefined }}
 */
export function resolveTargetDir(rawDir, projectDir) {
  const root = path.resolve(projectDir, ROOT_DIR_NAME);

  if (rawDir == null || String(rawDir).trim() === "") {
    return { dir: root, relDir: ROOT_DIR_NAME };
  }

  let d = String(rawDir).replace(/\\/g, "/").trim();
  // Strip a leading "./" if present.
  d = d.replace(/^\.\//, "");

  const segments = d.split("/").filter((s) => s !== "" && s !== ".");

  if (segments.length === 0 || segments[0] !== ROOT_DIR_NAME) {
    return {
      error:
        "'directory' must be a relative path starting with '" +
        ROOT_DIR_NAME +
        "' (got: " + JSON.stringify(rawDir) + ").",
    };
  }

  for (const seg of segments) {
    if (seg === "..") {
      return { error: "'directory' must not contain '..' segments." };
    }
  }

  // Sanitize every segment after the root to safe characters. The root segment
  // is the literal ".expertum" (kept as-is); others may not start with a dot.
  const safeSegments = [ROOT_DIR_NAME];
  for (let i = 1; i < segments.length; i++) {
    const seg = sanitizeSegment(segments[i]);
    if (seg === "") {
      return { error: "'directory' contains an empty or invalid path segment." };
    }
    safeSegments.push(seg);
  }

  const relDir = safeSegments.join("/");
  const dir = path.resolve(projectDir, relDir);

  // Final containment check: dir must be root or strictly beneath it.
  if (dir !== root && !dir.startsWith(root + path.sep)) {
    return { error: "Resolved 'directory' escapes the " + ROOT_DIR_NAME + " root." };
  }

  return { dir, relDir };
}

/**
 * Validate the tool arguments, build the report body (optional title heading),
 * and write it under `<projectDir>/.expertum/`. Returns an MCP tool result
 * (success text or, on any rejection, a toolError). Never throws for the normal
 * rejection paths; filesystem failures are caught and surfaced as a toolError.
 * @param {any} args
 * @param {string} projectDir
 */
export function handleWriteReport(args, projectDir) {
  const a = args || {};

  if (typeof a.filename !== "string" || a.filename.trim() === "") {
    return toolError("Missing or invalid 'filename' (expected a non-empty string).");
  }
  if (typeof a.content !== "string") {
    return toolError("Missing or invalid 'content' (expected a string).");
  }

  const resolved = resolveTargetDir(a.directory, projectDir);
  if (resolved.error) {
    return toolError(resolved.error);
  }
  // The early return above leaves only the success shape, but tsc cannot
  // narrow the optional-property union through a truthiness check on a
  // string, so assert it once here.
  const { dir, relDir } = /** @type {{ dir: string, relDir: string }} */ (resolved);

  const safeName = sanitizeFilename(a.filename);
  const target = path.join(dir, safeName);

  let body = a.content;
  if (typeof a.title === "string" && a.title.trim() !== "" && !/^# /.test(body)) {
    body = "# " + a.title.trim() + "\n\n" + body;
  }

  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > MAX_CONTENT_BYTES) {
    return toolError(
      "Report body is " + bytes + " bytes, over the " + MAX_CONTENT_BYTES +
        "-byte limit. Split the report or trim it."
    );
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(target, body, "utf8");
  } catch (err) {
    // Same truthiness rule as the original `err && err.message` — prefer the
    // error's own message, fall back to String() for exotic throwables.
    const detail =
      err && typeof err === "object" && "message" in err && err.message
        ? String(err.message)
        : String(err);
    return toolError("Failed to write report: " + detail);
  }

  const relPath = path.join(relDir, safeName);

  return {
    content: [
      {
        type: "text",
        text: "Wrote report to " + relPath + " (" + bytes + " bytes).",
      },
    ],
  };
}

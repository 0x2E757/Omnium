// Task model + the canonical <memosyne-*> markdown (de)serialization.
//
// A task file looks like:
//
//   # <memosyne-summary>Summary</memosyne-summary>
//   ...text...
//   # <memosyne-status>Status</memosyne-status>
//   ...text...
//   # <memosyne-related>Related</memosyne-related>
//   - 2026-06-04--16-05--other-task
//   # <memosyne-files>Files</memosyne-files>
//   - path - P0, tag, tag
//   # <memosyne-description>Description</memosyne-description>
//   ...markdown...
//
// The MCP server is the ONLY writer, so the schema here is authoritative.

// #region Types

/** @typedef {"P0" | "P1"} FilePriority */

/** @type {readonly FilePriority[]} */
export const PRIORITIES = ["P0", "P1"];

/**
 * @typedef {object} TaskFile
 * @property {string} path
 * @property {FilePriority} priority
 * @property {string[]} tags
 */

/**
 * @typedef {object} Task
 * @property {string} summary
 * @property {Status} status
 * @property {string[]} related Stems of related tasks. The relation is UNDIRECTED — the
 *   link/unlink handlers write both sides — so this list mirrors the corresponding entry
 *   in each neighbor's own Related section.
 * @property {TaskFile[]} files
 * @property {string} description
 */

/** @typedef {"summary" | "status" | "related" | "files" | "description"} Section */

/** @type {readonly Section[]} */
export const SECTIONS = ["summary", "status", "related", "files", "description"];

// Summary length has two caps. The SOFT cap is what we ASK for and advertise in
// every agent-facing place (tool schema descriptions + the MCP instructions): a
// one-line headline. The HARD cap is what validateSummary actually enforces, set
// higher so a small overshoot is forgiven instead of bouncing the agent into a
// re-do round trip for no real benefit. Agents should aim at the soft cap; the
// gap is just slack and is deliberately not advertised.
export const SUMMARY_SOFT_MAX = 300; // advertised to the agent
export const SUMMARY_HARD_MAX = 400; // actually enforced

// The description has its own two-tier cap, but with DIFFERENT semantics from the
// summary's. The summary caps both REJECT (soft is the advertised target, hard is
// silent slack before a bounce). The description's SOFT cap does NOT reject — a
// write past it succeeds and the handler returns a WARNING that the description is
// growing large and the work should likely be split into separate tasks linked with
// memosyne_link. Only the HARD cap refuses the write. So a long-but-reasonable
// description is never blocked; the agent is only nudged, then finally stopped from
// piling an unbounded dump into one record. Enforced in handlers.checkDescriptionSize;
// the SOFT cap is the one advertised to the agent (server.mjs).
export const DESCRIPTION_SOFT_MAX = 3000; // advertised; past this the handler warns
export const DESCRIPTION_HARD_MAX = 6000; // past this the write is refused

export const NAME_MAX = 30;
export const MAX_TAGS = 5;

/** @typedef {"Backlog" | "Active" | "Blocked" | "Done" | "Cancelled"} Status */

// Task status is a fixed, small vocabulary the agent picks from (not free text),
// so a task file is a self-contained state snapshot. These are *states* ("what
// is"), not ongoing actions — Active means "currently relevant, something to be
// worked on" (open / in progress / scheduled), as opposed to Backlog (not yet
// picked up) — so a session can be recreated from the file. Free-form status is
// NOT allowed: the parser coerces whatever is on disk to this vocabulary (see
// normalizeStatus), so a stray/prior/hand-edited value can never slip past the
// status filter unseen.
/** @type {readonly Status[]} */
export const STATUSES = ["Backlog", "Active", "Blocked", "Done", "Cancelled"];

/** @type {Status} */
export const DEFAULT_STATUS = "Backlog";

/**
 * Coerce a raw on-disk status to the vocabulary: trimmed, case-insensitively
 * matched to a canonical Status; anything unrecognized (incl. empty or a missing
 * section) falls back to DEFAULT_STATUS. The parser runs every status through
 * this so Task.status is always a valid Status, never free text.
 * @param {string} raw
 * @returns {Status}
 */
export function normalizeStatus(raw) {
  const t = raw.trim().toLowerCase();
  return STATUSES.find((s) => s.toLowerCase() === t) ?? DEFAULT_STATUS;
}

// #endregion Types

// #region Filename

const NAME_SLUG_RE = /[^a-z0-9-]+/g;

/**
 * Turn an arbitrary phrase into a <=30 char kebab slug for the filename.
 * @param {string} raw
 */
export function slugifyName(raw) {
  const slug = raw
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(NAME_SLUG_RE, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return (slug || "task").slice(0, NAME_MAX).replace(/-$/, "");
}

/**
 * Build the stem `YYYY-MM-DD--HH-MM--{name}` from a Date and a raw name.
 * @param {Date} date
 * @param {string} rawName
 */
export function buildStem(date, rawName) {
  /** @param {number} n */
  const p = (n) => String(n).padStart(2, "0");
  const stamp =
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `--${p(date.getHours())}-${p(date.getMinutes())}`;
  return `${stamp}--${slugifyName(rawName)}`;
}

const STEM_RE = /^\d{4}-\d{2}-\d{2}--\d{2}-\d{2}--.+$/;
const FILENAME_RE = /^\d{4}-\d{2}-\d{2}--\d{2}-\d{2}--.+\.md$/;
const STEM_PREFIX_RE = /^\d{4}-\d{2}-\d{2}--\d{2}-\d{2}--/;

/**
 * The human name portion of a stem — everything after the `YYYY-MM-DD--HH-MM--`
 * timestamp prefix (e.g. `list-tasks-paging`). Returns the stem unchanged if it
 * carries no recognizable prefix.
 * @param {string} stem
 */
export function stemName(stem) {
  return stem.replace(STEM_PREFIX_RE, "");
}

const STEM_STAMP_RE = /^(\d{4})-(\d{2})-(\d{2})--(\d{2})-(\d{2})--/;

/**
 * Parse the `YYYY-MM-DD--HH-MM` timestamp prefix of a stem into a local Date —
 * the inverse of buildStem, which formats from local-time getters, so this
 * reads it back in the same (local) frame. This is a task's creation time, the
 * one stable clock encoded in its handle. Returns null if the stem carries no
 * recognizable prefix (prior/free-form names).
 * @param {string} stem
 * @returns {Date | null}
 */
export function stemDate(stem) {
  const m = stem.match(STEM_STAMP_RE);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}

/**
 * A task stem, e.g. `2026-06-04--15-58--example`.
 * @param {string} name
 */
export function isTaskStem(name) {
  return STEM_RE.test(name) && !name.includes("/") && !name.includes("\\");
}

/**
 * A task file name, e.g. `2026-06-04--16-05--example.md` — a stem plus `.md`.
 * Each task is stored flat as `<stem>.md` directly under `.memosyne/`.
 * @param {string} name
 */
export function isTaskFilename(name) {
  return FILENAME_RE.test(name) && !name.includes("/") && !name.includes("\\");
}

/**
 * The flat file name for a task stem: `<stem>.md`.
 * @param {string} stem
 */
export function taskFilename(stem) {
  return `${stem}.md`;
}

/**
 * The stem behind a `<stem>.md` task file name, or null if it isn't one.
 * @param {string} filename
 * @returns {string | null}
 */
export function stemFromFilename(filename) {
  if (!isTaskFilename(filename)) return null;
  const stem = filename.slice(0, -".md".length);
  return isTaskStem(stem) ? stem : null;
}

// #endregion Filename

// #region Serialize

/** @param {Section} s @param {string} label */
const HEADER = (s, label) => `# <memosyne-${s}>${label}</memosyne-${s}>`;

/** @type {Record<Section, string>} */
const LABELS = {
  summary: "Summary",
  status: "Status",
  related: "Related",
  files: "Files",
  description: "Description",
};

/** @param {string} stem */
function serializeRelated(stem) {
  return `- ${stem}`;
}

/** @param {TaskFile} f */
function serializeFile(f) {
  const parts = [f.priority, ...f.tags];
  return `- ${f.path} - ${parts.join(", ")}`;
}

/**
 * The body text of one section (without its header).
 * @param {Task} task
 * @param {Section} section
 * @returns {string}
 */
function sectionBody(task, section) {
  switch (section) {
    case "summary":
      return task.summary.trim();
    case "status":
      return task.status.trim();
    case "related":
      return task.related.length > 0 ? task.related.map(serializeRelated).join("\n") : "_(none)_";
    case "files":
      return task.files.length > 0 ? task.files.map(serializeFile).join("\n") : "_(none)_";
    case "description":
      return task.description.trim();
  }
}

/**
 * One section as `# <memosyne-…>Label</memosyne-…>` + blank line + body. The single source
 * of truth for a section's on-disk shape, so a section-subset render (handlers'
 * renderSections) is built from the parsed task directly — never by re-splitting a
 * serialized doc, which a description containing an `# <memosyne-…>` line would break.
 * @param {Task} task
 * @param {Section} section
 */
export function serializeSection(task, section) {
  return `${HEADER(section, LABELS[section])}\n\n${sectionBody(task, section)}`;
}

/** @param {Task} task */
export function serializeTask(task) {
  // Sections separated by a blank line, with a trailing newline (unchanged format).
  return SECTIONS.map((s) => serializeSection(task, s)).join("\n\n") + "\n";
}

// #endregion Serialize

// #region Parse

const SECTION_RE = /^#\s*<memosyne-(summary|status|related|files|description)>.*?<\/memosyne-\1>\s*$/;

/**
 * True if `line` would be parsed as an memosyne-section header. The summary is
 * serialized as a single body line, so a summary whose text matches this would be
 * read back as the START of a new section — silently dropping the summary and
 * swallowing the sections that follow it (the description is the last section and
 * stops header-matching, so a summary mimicking `# <memosyne-description>` is the worst
 * case: it absorbs status/related/files/description). The write-time summary
 * validator (handlers.validateSummary) rejects such a summary to prevent this.
 * @param {string} line
 */
export function looksLikeSectionHeader(line) {
  return SECTION_RE.test(line.trim());
}

const RELATED_RE = /^-\s*(.+?)\s*$/;
const FILE_RE = /^-\s*(.+?)\s+-\s+(P0|P1)\b\s*(?:,\s*(.*))?$/;

/**
 * Split raw markdown into the five sections by their memosyne header lines.
 * @param {string} raw
 * @returns {Record<Section, string>}
 */
export function splitSections(raw) {
  const lines = raw.split(/\r?\n/);
  /** @type {Record<Section, string>} */
  const out = {
    summary: "",
    status: "",
    related: "",
    files: "",
    description: "",
  };

  /** @type {Section | null} */
  let current = null;
  /** @type {string[]} */
  let buf = [];

  const flush = () => {
    if (current) out[current] = buf.join("\n").trim();
    buf = [];
  };

  for (const line of lines) {
    // `description` is the last, free-form section: once inside it, stop matching
    // headers so a description that itself contains a `# <memosyne-…>` line (e.g. when
    // documenting Memosyne) is kept verbatim instead of corrupting the split.
    if (current !== "description") {
      const m = line.match(SECTION_RE);
      if (m) {
        flush();
        current = /** @type {Section} */ (m[1]);
        continue;
      }
    }
    if (current) buf.push(line);
  }
  flush();

  return out;
}

/**
 * @param {string} block
 * @returns {string[]}
 */
function parseRelated(block) {
  /** @type {string[]} */
  const out = [];
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(RELATED_RE);
    if (!m) continue;
    const stem = m[1].trim();
    if (isTaskStem(stem)) out.push(stem); // skip the "_(none)_" placeholder and any noise
  }
  return out;
}

/**
 * @param {string} block
 * @returns {TaskFile[]}
 */
function parseFiles(block) {
  /** @type {TaskFile[]} */
  const out = [];
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(FILE_RE);
    if (!m) continue;
    const tags = (m[3] ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, MAX_TAGS);
    out.push({ path: m[1].trim(), priority: /** @type {FilePriority} */ (m[2]), tags });
  }
  return out;
}

/**
 * @param {string} raw
 * @returns {Task}
 */
export function parseTask(raw) {
  const s = splitSections(raw);
  return {
    summary: s.summary,
    status: normalizeStatus(s.status),
    related: parseRelated(s.related),
    files: parseFiles(s.files),
    description: s.description,
  };
}

// #endregion Parse

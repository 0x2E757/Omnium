// Pure tool logic for the Memosyne MCP server. Every function takes the project root
// explicitly and returns the human-readable result text (or throws ToolError),
// so it can be unit-tested without the MCP transport. server.mjs is the thin
// adapter: project resolution + input schemas + tool registration.

import {
  parseTask,
  serializeTask,
  serializeSection,
  SECTIONS,
  STATUSES,
  DEFAULT_STATUS,
  SUMMARY_SOFT_MAX,
  SUMMARY_HARD_MAX,
  DESCRIPTION_SOFT_MAX,
  DESCRIPTION_HARD_MAX,
  MAX_TAGS,
  buildStem,
  stemDate,
  isTaskStem,
  looksLikeSectionHeader,
} from "./common/task.mjs";
import {
  listTaskStems,
  readTask,
  writeTask,
  taskExists,
  deleteTask as deleteTaskFile,
  withTaskLock,
} from "./common/storage.mjs";
import { join } from "node:path";
import { searchWithTimeout, searchTimeoutMs, RegexTimeout } from "./common/search-runner.mjs";
import { loadTasks } from "./common/cache.mjs";
import { toPosixSep } from "./common/path-key.mjs";

/** @typedef {import("./common/task.mjs").Section} Section */
/** @typedef {import("./common/task.mjs").Status} Status */
/** @typedef {import("./common/task.mjs").Task} Task */
/** @typedef {import("./common/task.mjs").TaskFile} TaskFile */
/** @typedef {import("./common/project.mjs").ProjectIdentity} ProjectIdentity */

export class ToolError extends Error {}

// #region Input types

/** @typedef {{ path: string, priority: "P0" | "P1", tags?: string[] }} FileInput */

/**
 * @typedef {object} Body
 * @property {string} summary
 * @property {string} [status]
 * @property {string} [description]
 * @property {FileInput[]} [files]
 */

// #endregion Input types

// #region Validation / construction

/**
 * @param {string} status
 * @returns {Status}
 */
export function validateStatus(status) {
  if (!(/** @type {readonly string[]} */ (STATUSES)).includes(status)) {
    throw new ToolError(`Invalid status "${status}". Allowed: ${STATUSES.join(", ")}.`);
  }
  return /** @type {Status} */ (status);
}

// NOTE: summary/description are NOT validated for embedded HTML. The web renderer
// (the standalone install's UI) escapes every angle-bracket sequence to a literal
// instead of interpreting it as HTML, so raw markup can no longer drop content on
// render. These fields are agent memory first, so we keep writing them frictionless.

/**
 * @param {string} summary
 * @returns {string}
 */
export function validateSummary(summary) {
  // An empty/whitespace-only summary is a broken hand-off: the summary is the
  // one-line headline by which a future reader (and every listing) decides whether
  // to open the task. Reject it rather than persist a task with no headline.
  if (summary.trim().length === 0) {
    throw new ToolError(
      "Summary must not be empty — it is the one-line headline a future reader (and every listing) " +
        "scans first. Provide a 1-3 sentence abstract of what the task is about and why.",
    );
  }
  // Enforce the HARD cap but phrase the error around the SOFT cap, so the agent
  // keeps aiming at 300 (a one-line headline) rather than discovering and pinning
  // the higher ceiling. Overshoots up to the hard cap pass silently.
  if (summary.length > SUMMARY_HARD_MAX) {
    throw new ToolError(
      `Summary is ${summary.length} characters; keep it to ${SUMMARY_SOFT_MAX} — a one-line headline. ` +
        `Move the detail into the description.`,
    );
  }
  // The summary is serialized on a single line. A newline would break the
  // line-based parser, so reject it rather than silently corrupt the file.
  if (/[\r\n]/.test(summary)) {
    throw new ToolError("Summary must be a single line (no line breaks).");
  }
  // The summary is serialized as its own body line. If that line itself matches an
  // memosyne-section header, the next parse reads it as the START of a new section —
  // silently dropping the summary and swallowing the sections that follow (see
  // looksLikeSectionHeader). Reject it so the round-trip can never corrupt the task.
  if (looksLikeSectionHeader(summary)) {
    throw new ToolError(
      'Summary must not be a line that looks like a Memosyne section header (e.g. "# <memosyne-status>…</memosyne-status>"): ' +
        "it would be parsed as a new section on the next read, silently dropping the summary and swallowing the " +
        "later sections. Rephrase it, or wrap the token in backticks (e.g. `# <memosyne-status>`).",
    );
  }
  return summary;
}

/**
 * The description is agent memory and may legitimately run long, but an UNBOUNDED
 * dump in one task defeats the hand-off: a future reader can't navigate a wall of
 * text, and the work it describes should be split into separate, linked tasks. Two
 * tiers (DESCRIPTION_SOFT_MAX / _HARD_MAX in task.mjs), with softer semantics than the
 * summary's caps: past the SOFT cap the write STILL succeeds but we return a warning
 * to APPEND to the success message (a nudge toward decomposition + memosyne_link);
 * only past the HARD cap is the write refused. Returns the warning string, or null
 * when under the soft cap; throws ToolError at the hard cap. Length basis matches
 * validateSummary (raw .length); the serializer trims on write, so this slightly
 * over-counts trailing whitespace — deliberately conservative.
 * @param {string} description
 * @returns {string | null}
 */
export function checkDescriptionSize(description) {
  const len = description.length;
  if (len > DESCRIPTION_HARD_MAX) {
    throw new ToolError(
      `Description is ${len} characters, over the ${DESCRIPTION_HARD_MAX}-char hard limit — refusing to save it. ` +
        `Trim it down, or split the work into separate tasks linked with memosyne_link instead of one oversized ` +
        `description (the cap keeps a single task from becoming an unbounded dump a future reader can't navigate).`,
    );
  }
  if (len > DESCRIPTION_SOFT_MAX) {
    return (
      `Heads up: the description is ${len} characters, past the ${DESCRIPTION_SOFT_MAX}-char soft limit. ` +
      `It saved fine, but if you expect it to keep growing, split the work into separate tasks linked with ` +
      `memosyne_link rather than piling everything into one oversized description.`
    );
  }
  return null;
}

/**
 * Append a warning (e.g. from checkDescriptionSize) to a handler's success message,
 * or return the message unchanged when there is none.
 * @param {string} message
 * @param {string | null} warning
 */
function withWarning(message, warning) {
  return warning ? `${message}\n\n${warning}` : message;
}

/**
 * A stem reaches a mutating handler straight from the agent, which may hallucinate
 * a malformed or traversal value. The mutating handlers take the per-task LOCK
 * first (withTaskLock -> assertStem), where a bad stem throws a raw storage Error
 * rather than a ToolError — an opaque message for the agent. Validate the stem up
 * front so the agent gets the same clean, actionable ToolError the read path already
 * returns. (Path traversal is blocked either way; this is about the error's shape.)
 * @param {string} stem
 */
function requireValidStem(stem) {
  if (!isTaskStem(stem)) {
    throw new ToolError(
      `Invalid task stem: "${stem}". A stem looks like "2026-06-04--15-58--name" (no path separators or "..").` +
        " Use memosyne_list_tasks to get the exact handle.",
    );
  }
}

/**
 * A name with no letters or digits slugifies to the placeholder "task" (slugifyName),
 * so distinct garbage names silently collide on the same stem. Reject it up front
 * with a clear reason instead of letting the agent puzzle over why its name vanished.
 * @param {string} name
 */
function validateName(name) {
  if (!/[a-z0-9]/i.test(name)) {
    throw new ToolError(
      `Task name "${name}" has no letters or digits, so it slugifies to the placeholder "task" ` +
        "(which collides with any other name-less task created the same minute). Use a short descriptive name.",
    );
  }
}

/**
 * @param {FileInput[]} [files]
 * @returns {TaskFile[]}
 */
export function toTaskFiles(files) {
  return (files ?? []).map((f) => {
    // An empty/whitespace path produces a "- - P0" line the file parser can't read
    // back as a real entry — a silently lost reference. Reject it; store trimmed
    // (the parser trims on read, so this keeps write and read consistent).
    const path = f.path?.trim();
    if (!path) {
      throw new ToolError("A file entry has an empty path. Provide a repo-root-relative path, or omit the entry.");
    }
    return { path, priority: f.priority, tags: (f.tags ?? []).slice(0, MAX_TAGS) };
  });
}

/**
 * @param {Body} input
 * @returns {Task}
 */
function newTask(input) {
  const summary = validateSummary(input.summary);
  const description = input.description ?? "";
  return {
    summary,
    status: input.status !== undefined ? validateStatus(input.status) : DEFAULT_STATUS,
    related: [],
    files: toTaskFiles(input.files),
    description,
  };
}

// #endregion Validation / construction

// #region Read helpers / guards

/** @param {string} root @param {string} stem */
function requireTask(root, stem) {
  if (!taskExists(root, stem)) throw new ToolError(`Task not found: ${stem}`);
}

/**
 * @param {string} root
 * @param {string} stem
 * @returns {Task}
 */
function readParsedTask(root, stem) {
  return parseTask(readTask(root, stem));
}

/**
 * Add `stem` to a task's related list (sorted, deduped). Returns whether it changed.
 * @param {Task} task
 * @param {string} stem
 */
function addRelated(task, stem) {
  if (task.related.includes(stem)) return false;
  task.related = [...task.related, stem].sort();
  return true;
}

/**
 * Remove `stem` from a task's related list. Returns whether it changed.
 * @param {Task} task
 * @param {string} stem
 */
function removeRelated(task, stem) {
  if (!task.related.includes(stem)) return false;
  task.related = task.related.filter((r) => r !== stem);
  return true;
}

// A finished task is a closed hand-off record: a future agent reconstructs intent
// more reliably when completed work stays frozen and new work becomes a NEW task,
// than when fresh changes are piled onto a stale "Done" entry. So editing a
// top-level task that is ALREADY Done and older than the grace window is refused,
// with two escape hatches:
//   - it is among the RECENT_EDITABLE most-recent tasks (an immediate fix-up of
//     work just wrapped up, not archaeology); or
//   - the caller passes `force` (a deliberate, considered edit).
// Age is measured from the stem timestamp (task creation) — the one stable,
// deterministic clock we have; last-modified would reset on every edit, and we
// never record when a task actually became Done. The link/unlink handlers are
// exempt: a relation is cross-reference metadata, not a reopening of the work.
export const DONE_EDIT_GRACE_MS = 2 * 60 * 60 * 1000; // 2h
export const RECENT_EDITABLE = 3; // the N newest tasks stay freely editable

/**
 * @param {string} root
 * @param {Date} now
 * @param {string} stem
 * @param {boolean} force
 */
function guardStaleDoneEdit(root, now, stem, force) {
  if (force) return;
  if (readParsedTask(root, stem).status !== "Done") return; // only completed records are protected
  if (listTaskStems(root).slice(0, RECENT_EDITABLE).includes(stem)) return; // immediate follow-up
  const created = stemDate(stem);
  if (!created) return; // unparseable age -> don't block what we can't reason about
  if (now.getTime() - created.getTime() <= DONE_EDIT_GRACE_MS) return; // still within grace

  const hours = DONE_EDIT_GRACE_MS / 3_600_000;
  throw new ToolError(
    `Refusing to edit "${stem}": it is Done and older than ${hours}h, and not among the ` +
      `${RECENT_EDITABLE} most recent tasks. A completed task is a closed hand-off record — create ` +
      `a NEW task for the follow-up work (memosyne_create_task) instead of reopening this one. If you ` +
      `truly must edit it (e.g. correcting a recorded mistake), pass force: true.`,
  );
}

/** @param {Task} t */
function relatedCount(t) {
  return t.related.length > 0 ? String(t.related.length) : "—";
}

/**
 * @param {Task} t
 * @param {Section[]} sections
 */
function renderSections(t, sections) {
  // Render the wanted sections directly from the parsed task, in canonical order.
  // Never re-split a serialized doc: a description may legitimately contain a line
  // like `# <memosyne-files>` (e.g. a task documenting Memosyne), which a split would treat
  // as a section boundary and drop everything after it (the "tail").
  const wanted = new Set(sections);
  return SECTIONS.filter((s) => wanted.has(s))
    .map((s) => serializeSection(t, s))
    .join("\n\n");
}

// #endregion Read helpers / guards

// #region Tool handlers

/**
 * @param {ProjectIdentity} p
 * @param {typeof join} [pathJoin] injectable path.join (default native) so the
 *   Store line's separator can be exercised under win32 rules on any host.
 */
export function projectInfo(p, pathJoin = join) {
  return (
    `Project: ${p.name}\nRoot: ${p.path}\nStore: ${pathJoin(p.path, ".memosyne")}\n` +
    `Top-level tasks: ${listTaskStems(p.path).length}`
  );
}

// Each mutating handler runs under withTaskLock keyed on the task stem, so the whole
// check-then-write / read-modify-write sequence is atomic against another writer on
// the same task — and only that task, since different tasks lock independently. The
// lock is acquired ONCE per task at the handler boundary; it is not re-entrant. The
// link/unlink handlers touch TWO tasks and so nest two locks, always acquired in a
// fixed (sorted) order to avoid deadlock. Read-only handlers (list/find/search/get)
// are not locked — the atomic writes in storage keep their reads from seeing a
// partial file.

/**
 * @param {string} root
 * @param {Date} now
 * @param {{ name: string } & Body} input
 */
export function createTask(root, now, input) {
  validateName(input.name);
  const stem = buildStem(now, input.name);
  return withTaskLock(root, stem, () => {
    if (taskExists(root, stem)) {
      // The stem is the creation minute + the slugified name, so two same-minute
      // creations whose names slugify the same collide. Surface the existing task's
      // status + summary right here so the agent can decide without another read:
      // same work -> edit it; different work -> retry with a more distinct name.
      const existing = readParsedTask(root, stem);
      throw new ToolError(
        `A task with this stem already exists: ${stem} [${existing.status}] — "${existing.summary}". ` +
          `The stem is the creation minute + the slugified name, so a same-minute create with a name that ` +
          `slugifies the same collides. If this is the SAME work, edit it with memosyne_update_task/memosyne_edit_task; ` +
          `if it is DIFFERENT work, retry with a more distinct name.`,
      );
    }
    // Refuse an over-the-hard-cap description before writing; capture the soft-cap
    // warning (if any) to append to the success message.
    const warning = checkDescriptionSize(input.description ?? "");
    writeTask(root, stem, serializeTask(newTask(input)));
    return withWarning(`Created task: ${stem}`, warning);
  });
}

/**
 * Relate two tasks. The relation is UNDIRECTED: each task's Related section lists
 * the other, so the link is written into BOTH files. Idempotent (a repeat is a
 * no-op). Both endpoints must already exist. Two locks are taken in sorted order so
 * concurrent link/unlink calls on the same pair can never deadlock.
 * @param {string} root
 * @param {{ task: string, related: string }} input
 */
export function linkTasks(root, input) {
  requireValidStem(input.task);
  requireValidStem(input.related);
  if (input.task === input.related) throw new ToolError("Cannot link a task to itself.");
  const [first, second] = [input.task, input.related].sort();
  return withTaskLock(root, first, () =>
    withTaskLock(root, second, () => {
      requireTask(root, input.task);
      requireTask(root, input.related);
      const a = readParsedTask(root, input.task);
      const b = readParsedTask(root, input.related);
      const ca = addRelated(a, input.related);
      const cb = addRelated(b, input.task);
      if (ca) writeTask(root, input.task, serializeTask(a));
      if (cb) writeTask(root, input.related, serializeTask(b));
      return ca || cb
        ? `Linked ${input.task} <-> ${input.related}.`
        : `${input.task} and ${input.related} are already linked.`;
    }),
  );
}

/**
 * Remove a relation between two tasks, from BOTH files. No-op (still a success) if
 * they weren't linked. Same sorted two-lock discipline as linkTasks.
 * @param {string} root
 * @param {{ task: string, related: string }} input
 */
export function unlinkTasks(root, input) {
  requireValidStem(input.task);
  requireValidStem(input.related);
  if (input.task === input.related) throw new ToolError("Cannot unlink a task from itself.");
  const [first, second] = [input.task, input.related].sort();
  return withTaskLock(root, first, () =>
    withTaskLock(root, second, () => {
      requireTask(root, input.task);
      requireTask(root, input.related);
      const a = readParsedTask(root, input.task);
      const b = readParsedTask(root, input.related);
      const ca = removeRelated(a, input.related);
      const cb = removeRelated(b, input.task);
      if (ca) writeTask(root, input.task, serializeTask(a));
      if (cb) writeTask(root, input.related, serializeTask(b));
      return ca || cb
        ? `Unlinked ${input.task} <-> ${input.related}.`
        : `${input.task} and ${input.related} were not linked.`;
    }),
  );
}

// Default page size for findByFile / searchText. The full history can be long,
// and dumping every task balloons the agent's context, so listings are capped by
// default — newest first, with a footer noting how many were withheld.
export const DEFAULT_LIST_LIMIT = 10;

// memosyne_list_tasks pages in two tiers. `expanded` is how many newest tasks
// print as FULL records (status, related count, summary). `compact` is how many
// MORE print, right after, as one-liners — `{stem} — {status}` only — so a future
// agent stays aware of older work (notably lingering Active/Backlog) at a fraction
// of the token cost, without paging. Tuned so the default view spans 30 tasks while
// only the freshest 10 carry their summaries.
export const DEFAULT_EXPANDED = 10;
export const DEFAULT_COMPACT = 20;

// Records in a multi-task listing are separated by a horizontal rule (not just a
// blank line), so the boundary between entries — whose summaries can run 1-3
// sentences — is unambiguous when scanned. Used by listTasks/findByFile/searchText
// to join records; NOT by renderSections, which joins the sections of ONE task.
const RECORD_SEP = "\n\n-----\n\n";

/**
 * @param {string} root
 * @param {{ expanded?: number, compact?: number, status?: string[] }} [opts]
 */
export function listTasks(root, opts = {}) {
  const rows = loadTasks(root); // newest first, cached (stat-validated)
  if (rows.length === 0) return "No tasks yet.";

  const statusFilter =
    opts.status && opts.status.length > 0 ? new Set(opts.status.map(validateStatus)) : null;

  // Parse + filter the full set so the status filter and the total count are
  // accurate (the stem alone doesn't carry status). Reads are served from the
  // stat-validated cache; the context cost lives in the OUTPUT, which the two
  // tier sizes cap.
  const matched = rows
    .map(({ stem, task }) => ({ stem, t: task }))
    .filter(({ t }) => !statusFilter || statusFilter.has(t.status));

  const scope = statusFilter ? ` with status ${[...statusFilter].join("/")}` : "";
  if (matched.length === 0) return `No tasks${scope}.`;

  // Two tiers, newest first: `expanded` full records, then `compact` one-liners.
  // expanded <= 0 means "no cap" — everything prints as a full record and the
  // compact tail is moot (nothing is left over). compact <= 0 drops the tail.
  const expanded = opts.expanded === undefined ? DEFAULT_EXPANDED : opts.expanded;
  const full = expanded > 0 ? matched.slice(0, expanded) : matched;
  const compact = opts.compact === undefined ? DEFAULT_COMPACT : opts.compact;
  const tail = compact > 0 ? matched.slice(full.length, full.length + compact) : [];

  const withheld = matched.length - full.length - tail.length;
  const note =
    withheld > 0 ? ` (raise \`expanded\`/\`compact\` or filter by \`status\` for the other ${withheld}).` : ".";
  const header =
    tail.length > 0
      ? `Showing ${full.length} expanded + ${tail.length} compact of ${matched.length} task(s)${scope}, newest first` +
        note
      : `Showing ${full.length} of ${matched.length} task(s)${scope}, newest first` + note;

  const fullBlock = full
    .map(({ stem, t }) => `• ${stem}\n    status: ${t.status} | related: ${relatedCount(t)}\n    ${t.summary}`)
    .join(RECORD_SEP);

  // The compact tail trades the summary for a bare stem + status — enough to know
  // a task exists and whether it's still open, at one line apiece.
  const tailBlock = tail.map(({ stem, t }) => `· ${stem} — ${t.status}`).join("\n");

  const body = tail.length > 0 ? `${fullBlock}${RECORD_SEP}${tailBlock}` : fullBlock;
  return `${header}\n\n${body}`;
}

/**
 * Find tasks whose Files section references a path. The search key is the path
 * (case-insensitive substring) — optionally narrowed to a priority. Tags are
 * NOT a search dimension (they are free-form, per-task labels, not a stable
 * vocabulary); they are surfaced in the OUTPUT so the agent can read what was
 * key about the file in each task it touched.
 * @param {string} root
 * @param {{ path: string, priority?: "P0" | "P1", limit?: number }} opts
 */
export function findByFile(root, opts) {
  const trimmed = opts.path?.trim().toLowerCase();
  if (!trimmed) throw new ToolError("Provide a `path` substring to search for.");
  // Normalize separators on BOTH sides: stored paths are verbatim agent input, so a
  // `\`-style needle must still match a `/`-stored path (and vice versa) — Low #7.
  const needle = toPosixSep(trimmed);

  const matches = loadTasks(root) // newest first, cached (stat-validated)
    .map(({ stem, task }) => ({
      stem,
      t: task,
      files: task.files.filter(
        (f) => toPosixSep(f.path.toLowerCase()).includes(needle) && (!opts.priority || f.priority === opts.priority),
      ),
    }))
    .filter(({ files }) => files.length > 0);

  const crit = `"${opts.path.trim()}"` + (opts.priority ? ` (${opts.priority})` : "");
  if (matches.length === 0) return `No tasks reference a file matching ${crit}.`;

  // limit <= 0 means "no cap"; default matches memosyne_list_tasks paging.
  const limit = opts.limit === undefined ? DEFAULT_LIST_LIMIT : opts.limit;
  const shown = limit > 0 ? matches.slice(0, limit) : matches;
  const withheld = matches.length - shown.length;

  const header =
    `Showing ${shown.length} of ${matches.length} task(s) referencing a file matching ${crit}, newest first` +
    (withheld > 0 ? ` (raise \`limit\` for the other ${withheld}).` : ".");

  const body = shown
    .map(({ stem, t, files }) => {
      const fileLines = files
        .map((f) => `      - ${f.path} - ${[f.priority, ...f.tags].join(", ")}`)
        .join("\n");
      return `• ${stem}\n    status: ${t.status} | ${t.summary}\n    matched files:\n${fileLines}`;
    })
    .join(RECORD_SEP);

  return `${header}\n\n${body}`;
}

/**
 * Full-text search over tasks. The query is a regular expression — a plain word
 * is itself a valid regex (a substring match), so no separate "mode" is needed —
 * matched case-insensitively against summary + description. Cross-platform comes
 * for free: JS RegExp is the same V8 engine on every OS, and parsed task text is
 * already newline-normalized (the parser strips \r), so matches and the snippet
 * offsets (snippetAround/firstHit, in common/search.mjs) are identical regardless
 * of how the file was stored on disk.
 * @param {string} root
 * @param {{ query: string, limit?: number }} opts
 * @returns {Promise<string>}
 */
export async function searchText(root, opts) {
  const query = opts.query?.trim();
  if (!query) throw new ToolError("Provide a `query` to search for.");

  // Validate the pattern up front so an invalid regex still yields a clean, fast
  // ToolError (the worker would otherwise report it second-hand).
  try {
    new RegExp(query, "i");
  } catch (err) {
    throw new ToolError(`Invalid regular expression: ${/** @type {Error} */ (err).message}`);
  }

  const rows = loadTasks(root); // newest first, cached (stat-validated)
  const byStem = new Map(rows.map(({ stem, task }) => [stem, task]));

  // The match itself runs in a worker under a time budget: a hallucinated
  // catastrophic-backtracking pattern aborts with a readable error instead of
  // hanging the single-threaded server. Order is preserved (newest first).
  let hits;
  try {
    hits = await searchWithTimeout(
      query,
      rows.map(({ stem, task }) => ({ stem, summary: task.summary, description: task.description })),
      searchTimeoutMs(),
    );
  } catch (err) {
    if (err instanceof RegexTimeout) throw new ToolError(err.message);
    throw err;
  }

  const matches = hits.map((h) => ({ stem: h.stem, t: /** @type {Task} */ (byStem.get(h.stem)), hit: h }));

  if (matches.length === 0) return `No tasks match /${query}/i.`;

  // limit <= 0 means "no cap"; default matches memosyne_list_tasks paging.
  const limit = opts.limit === undefined ? DEFAULT_LIST_LIMIT : opts.limit;
  const shown = limit > 0 ? matches.slice(0, limit) : matches;
  const withheld = matches.length - shown.length;

  const header =
    `Showing ${shown.length} of ${matches.length} task(s) matching /${query}/i, newest first` +
    (withheld > 0 ? ` (raise \`limit\` for the other ${withheld}).` : ".");

  const body = shown
    .map(
      ({ stem, t, hit }) =>
        `• ${stem}\n    status: ${t.status} | ${t.summary}\n    ${hit.section}: ${hit.snippet}`,
    )
    .join(RECORD_SEP);

  return `${header}\n\n${body}`;
}

/**
 * @param {string} root
 * @param {{ task: string, sections?: Section[] }} input
 */
export function getTask(root, input) {
  const want = input.sections && input.sections.length > 0 ? input.sections : [...SECTIONS];
  requireTask(root, input.task);
  return renderSections(readParsedTask(root, input.task), want);
}

/**
 * @param {string} root
 * @param {Date} now
 * @param {{ task: string, summary?: string, status?: string, description?: string, files?: FileInput[], force?: boolean }} input
 */
export function updateTask(root, now, input) {
  requireValidStem(input.task);
  return withTaskLock(root, input.task, () => {
    requireTask(root, input.task);
    guardStaleDoneEdit(root, now, input.task, input.force ?? false);
    const target = readParsedTask(root, input.task);

    if (input.summary !== undefined) {
      target.summary = validateSummary(input.summary);
    }
    if (input.status !== undefined) target.status = validateStatus(input.status);
    // The size guard fires only when the description is actually being written, so an
    // unrelated update (e.g. status only) never warns about a pre-existing long body.
    /** @type {string | null} */
    let warning = null;
    if (input.description !== undefined) {
      warning = checkDescriptionSize(input.description);
      target.description = input.description;
    }
    if (input.files !== undefined) target.files = toTaskFiles(input.files);

    writeTask(root, input.task, serializeTask(target));
    return withWarning(`Updated ${input.task}.`, warning);
  });
}

/**
 * Make a targeted edit to a plain-text section by replacing an exact snippet of its
 * CURRENT text (Claude-Code-`Edit` model): `old_text` is matched literally — byte for
 * byte — against the trimmed section body the agent sees from memosyne_get_task, and
 * must occur EXACTLY ONCE (or `replace_all` must be set) or the edit is refused and
 * nothing is written. An empty `new_text` deletes the match. Same lock / stale-Done
 * guard / per-section validation as updateTask; the uniqueness gate makes a silent
 * mis-edit impossible, and every ambiguity is a loud ToolError, never a no-op success.
 * @param {string} root
 * @param {Date} now
 * @param {{ task: string, section?: "description" | "summary" | "status", old_text: string, new_text: string, replace_all?: boolean, force?: boolean }} input
 */
export function editTask(root, now, input) {
  const sec = input.section ?? "description";
  requireValidStem(input.task);
  return withTaskLock(root, input.task, () => {
    requireTask(root, input.task);
    guardStaleDoneEdit(root, now, input.task, input.force ?? false);
    const target = readParsedTask(root, input.task);

    const original = target[sec];
    const old = input.old_text;
    // The tool schema enforces minLength:1, but the handler is unit-tested WITHOUT the
    // schema gate — an empty needle would "match" everywhere, so guard it here too.
    if (old.length === 0) throw new ToolError("old_text must not be empty.");

    // Literal find/replace via split+join — NEVER String.replace/replaceAll with a
    // string argument, which interprets `$&`/`$$`/`$1`… in new_text and silently
    // mangles any agent text containing `$`. split also yields the (non-overlapping)
    // occurrence count for free and cannot hang on an empty needle.
    const parts = original.split(old);
    const count = parts.length - 1;
    if (count === 0) {
      throw new ToolError(
        `old_text was not found in the "${sec}" section, so nothing was changed. It must match the ` +
          `section's CURRENT text exactly — same whitespace, indentation and punctuation (copy it from ` +
          `below; do not retype from memory or send a diff). Here is the live "${sec}" section — take ` +
          `old_text verbatim from between the markers:\n` +
          `----- BEGIN CURRENT ${sec} -----\n${original}\n----- END CURRENT ${sec} -----`,
      );
    }
    if (count > 1 && !(input.replace_all ?? false)) {
      throw new ToolError(
        `old_text occurs ${count} times in the "${sec}" section, so the target is ambiguous and nothing ` +
          `was changed. Either extend old_text with surrounding text so it matches exactly ONE place, or ` +
          `pass replace_all: true to change all ${count}. Here is the live "${sec}" section:\n` +
          `----- BEGIN CURRENT ${sec} -----\n${original}\n----- END CURRENT ${sec} -----`,
      );
    }
    if (input.new_text === old) {
      throw new ToolError(
        `new_text is identical to old_text, so this edit would change the "${sec}" section by nothing and ` +
          `was refused. Send the replacement text you actually want, or use memosyne_update_task to ` +
          `rewrite the whole section.`,
      );
    }

    const edited = parts.join(input.new_text); // count === 1, or replace_all over every occurrence

    // Per-section validation ROUTING — identical to updateTask: status carries
    // the strict Status type (no dynamic target[sec] = string), summary/status validate,
    // description free-form with the size guard. Every throw here precedes the single
    // writeTask, so a rejected edit writes nothing (atomic under the lock).
    /** @type {string | null} */
    let warning = null;
    if (sec === "summary") target.summary = validateSummary(edited);
    else if (sec === "status") target.status = validateStatus(edited.trim());
    else {
      warning = checkDescriptionSize(edited);
      target.description = edited;
    }

    writeTask(root, input.task, serializeTask(target));
    const scope = count > 1 ? ` (${count} occurrences)` : "";
    return withWarning(`Edited ${sec} of ${input.task}${scope}.`, warning);
  });
}

/**
 * Delete a task file. Because relations are undirected, the deleted task's stem is
 * also removed from each neighbor's Related section (a "sweep"), so no dangling edge
 * is left behind. Neighbors are swept under their OWN lock, sequentially and after
 * the task's lock is released — never nested — so the multi-task delete can't deadlock
 * against a concurrent link/unlink.
 * @param {string} root
 * @param {{ task: string }} input
 */
export function deleteTask(root, input) {
  requireValidStem(input.task);
  /** @type {string[]} */
  let neighbors = [];
  const removed = withTaskLock(root, input.task, () => {
    if (!taskExists(root, input.task)) return false;
    neighbors = readParsedTask(root, input.task).related;
    return deleteTaskFile(root, input.task);
  });
  if (!removed) return `Task not found: ${input.task}`;

  for (const n of neighbors) {
    if (!isTaskStem(n)) continue;
    withTaskLock(root, n, () => {
      if (!taskExists(root, n)) return;
      const t = readParsedTask(root, n);
      if (removeRelated(t, input.task)) writeTask(root, n, serializeTask(t));
    });
  }
  return `Deleted task ${input.task}.`;
}

// #endregion Tool handlers

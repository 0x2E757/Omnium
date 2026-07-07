import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildStem,
  slugifyName,
  parseTask,
  serializeTask,
  splitSections,
  normalizeStatus,
  isTaskFilename,
  isTaskStem,
  looksLikeSectionHeader,
  DESCRIPTION_SOFT_MAX,
  DESCRIPTION_HARD_MAX,
  type Task,
} from "../../plugins/memosyne/common/task.mjs";

// The description has a two-tier cap, parallel to the summary's soft/hard pair:
// the SOFT cap is the size past which a write still succeeds but the handler warns
// (the description is growing large — consider decomposition + linking); the HARD
// cap is the size past which the write is refused outright. The handler layer
// (handlers.checkDescriptionSize) enforces both; these constants are its source of
// truth and are also what server.mts advertises (the soft cap) to the agent.
test("description soft/hard caps are exported and ordered soft < hard", () => {
  assert.equal(DESCRIPTION_SOFT_MAX, 3000);
  assert.equal(DESCRIPTION_HARD_MAX, 6000);
  assert.ok(DESCRIPTION_SOFT_MAX < DESCRIPTION_HARD_MAX);
});

test("slugifyName trims, kebabs and caps at 30 chars", () => {
  assert.equal(slugifyName("Simple Research"), "simple-research");
  assert.equal(slugifyName("  Weird__Name!!  "), "weird-name");
  assert.equal(slugifyName("a".repeat(50)).length, 30);
  assert.equal(slugifyName(""), "task");
});

test("buildStem / task filename match the spec pattern", () => {
  const stem = buildStem(new Date(2026, 5, 4, 15, 58), "example");
  assert.equal(stem, "2026-06-04--15-58--example");

  assert.ok(isTaskStem(stem));
  // A task is stored flat as `<stem>.md`; isTaskFilename recognizes that file.
  assert.ok(isTaskFilename(`${stem}.md`));
  assert.ok(!isTaskFilename("notatask.md"));
  assert.ok(!isTaskStem("../escape")); // traversal rejected
  assert.ok(!isTaskStem("plain-name"));
});

test("serialize -> parse round-trips a full task", () => {
  const task: Task = {
    summary: "Do a thing",
    status: "Active",
    related: ["2026-06-04--13-07--simple-research", "2026-06-05--10-00--other"],
    files: [
      { path: "src/foo.js", priority: "P0", tags: ["server", "http", "auth"] },
      { path: "src/baz.js", priority: "P1", tags: ["images"] },
    ],
    description: "Full description\nwith multiple lines.",
  };

  const round = parseTask(serializeTask(task));
  assert.deepEqual(round, task);
});

test("empty related/files survive the round-trip as empty arrays", () => {
  const task: Task = { summary: "s", status: "Backlog", related: [], files: [], description: "" };
  const round = parseTask(serializeTask(task));
  assert.deepEqual(round.related, []);
  assert.deepEqual(round.files, []);
});

test("the related section parses one task stem per line and ignores non-stems", () => {
  const raw = [
    "# <memosyne-summary>Summary</memosyne-summary>",
    "Just example file.",
    "# <memosyne-status>Status</memosyne-status>",
    "Active",
    "# <memosyne-related>Related</memosyne-related>",
    "- 2026-06-04--13-07--simple-research",
    "- not-a-stem", // ignored: not a valid stem
    "- 2026-06-05--10-00--other",
    "# <memosyne-files>Files</memosyne-files>",
    "- src/foo.js - P0, server, http, auth, security",
    "# <memosyne-description>Description</memosyne-description>",
    "Full description of the task...",
  ].join("\n");

  const t = parseTask(raw);
  assert.equal(t.summary, "Just example file.");
  assert.deepEqual(t.related, ["2026-06-04--13-07--simple-research", "2026-06-05--10-00--other"]);
  assert.equal(t.files[0].path, "src/foo.js");
  assert.equal(t.files[0].priority, "P0");
  assert.deepEqual(t.files[0].tags, ["server", "http", "auth", "security"]);
});

test("a description containing an memosyne-header line is kept verbatim", () => {
  const task: Task = {
    summary: "s",
    status: "Backlog",
    related: [],
    files: [],
    description: "Docs:\n# <memosyne-summary>Summary</memosyne-summary>\nmore text",
  };
  const round = parseTask(serializeTask(task));
  assert.equal(round.summary, "s"); // not clobbered by the embedded header
  assert.equal(round.description, "Docs:\n# <memosyne-summary>Summary</memosyne-summary>\nmore text");
});

test("splitSections returns all five keys even when sections are missing", () => {
  const s = splitSections("# <memosyne-summary>Summary</memosyne-summary>\nonly summary");
  assert.equal(s.summary, "only summary");
  assert.equal(s.status, "");
  assert.equal(s.related, "");
  assert.equal(s.description, "");
});

test("slugifyName drops non-ascii and never leaves a trailing hyphen after the cap", () => {
  // Accents are stripped, not transliterated (the slug charset is [a-z0-9-]).
  assert.equal(slugifyName("Café Über!"), "caf-ber");
  // The 30-char cap can land right on a separator; that trailing hyphen is trimmed.
  const slug = slugifyName("a".repeat(29) + " extra");
  assert.equal(slug, "a".repeat(29));
  assert.ok(!slug.endsWith("-"));
});

test("buildStem zero-pads single-digit month/day/hour/minute", () => {
  assert.equal(buildStem(new Date(2026, 0, 1, 3, 5), "x"), "2026-01-01--03-05--x");
});

test("stem/filename validators reject Windows backslash paths", () => {
  assert.ok(!isTaskStem("2026-06-04--15-08--a\\b"));
  assert.ok(!isTaskFilename("2026-06-04--15-08--a\\b.md"));
});

test("the parser is CRLF-tolerant (files written on Windows)", () => {
  const task: Task = {
    summary: "s",
    status: "Active",
    related: ["2026-06-04--16-05--c"],
    files: [{ path: "src/a.ts", priority: "P0", tags: ["x"] }],
    description: "line one\nline two",
  };
  const lf = serializeTask(task);
  assert.deepEqual(parseTask(lf.replace(/\n/g, "\r\n")), parseTask(lf));
});

test("parseFiles drops invalid-priority lines and caps tags at five", () => {
  const raw = [
    "# <memosyne-files>Files</memosyne-files>",
    "- src/ok.ts - P0, a, b, c, d, e, f, g", // 7 tags -> capped to 5
    "- src/bad.ts - P2, nope", // not P0/P1 -> ignored entirely
    "- src/plain.ts - P1", // no tags
  ].join("\n");
  const files = parseTask(raw).files;
  assert.equal(files.length, 2);
  assert.deepEqual(files[0].tags, ["a", "b", "c", "d", "e"]);
  assert.deepEqual(files[1], { path: "src/plain.ts", priority: "P1", tags: [] });
});

test("splitSections is order-independent and last-header-wins on duplicates", () => {
  const raw = [
    "# <memosyne-status>Status</memosyne-status>",
    "Active",
    "# <memosyne-summary>Summary</memosyne-summary>",
    "first",
    "# <memosyne-summary>Summary</memosyne-summary>",
    "second",
  ].join("\n");
  const s = splitSections(raw);
  assert.equal(s.status, "Active"); // section found regardless of position
  assert.equal(s.summary, "second"); // a repeated header: the later block wins
});

// A summary is serialized as its own body line. If that line itself matches an
// memosyne-section header, the next parse treats it as the start of a new section — the
// corruption the write-time validator (handlers.validateSummary) guards against.
// This pins the detector the guard relies on, and confirms the parser still keeps a
// header-like line verbatim INSIDE the (last) description section.
test("looksLikeSectionHeader flags lines the parser would treat as section starts (A1)", () => {
  assert.ok(looksLikeSectionHeader("# <memosyne-status>Status</memosyne-status>"));
  assert.ok(looksLikeSectionHeader("# <memosyne-description>x</memosyne-description>"));
  assert.ok(looksLikeSectionHeader("  # <memosyne-summary>Summary</memosyne-summary>  ")); // surrounding space ignored
  // Not headers: a plain markdown heading, an escaped/backticked token, ordinary prose.
  assert.ok(!looksLikeSectionHeader("# Overview of the change"));
  assert.ok(!looksLikeSectionHeader("fixing `# <memosyne-status>` parsing"));
  assert.ok(!looksLikeSectionHeader("a normal summary"));

  // The description (the last section) legitimately keeps such a line verbatim —
  // the parser stops matching headers once inside it (see the M1 regression).
  const t: Task = {
    summary: "s",
    status: "Backlog",
    related: [],
    files: [],
    description: "intro\n# <memosyne-status>Status</memosyne-status>\ntail",
  };
  assert.equal(parseTask(serializeTask(t)).description, "intro\n# <memosyne-status>Status</memosyne-status>\ntail");
});

test("parseTask coerces a free-form / miscased / missing status to the vocabulary", () => {
  const withStatus = (status: string) =>
    [
      "# <memosyne-summary>Summary</memosyne-summary>",
      "s",
      "# <memosyne-status>Status</memosyne-status>",
      status,
      "# <memosyne-description>Description</memosyne-description>",
      "d",
    ].join("\n");

  // Unknown free-form and empty/missing both fall back to the default (Backlog),
  // so the task is never invisible to a status filter.
  assert.equal(parseTask(withStatus("Ready for implementation")).status, "Backlog");
  assert.equal(parseTask("# <memosyne-summary>Summary</memosyne-summary>\nonly summary").status, "Backlog");
  // A recognized value is canonicalized regardless of case / surrounding space.
  assert.equal(parseTask(withStatus("done")).status, "Done");
  assert.equal(parseTask(withStatus("  active ")).status, "Active");

  assert.equal(normalizeStatus("BLOCKED"), "Blocked");
  assert.equal(normalizeStatus("nonsense"), "Backlog");
});

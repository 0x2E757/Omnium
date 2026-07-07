// Session-scoped state under `.graphyne/tasks/<session-id>/`, keyed by the
// Claude Code session id so a resumed session keeps its checklist and red/green.
// NOT committed (the store's .gitignore excludes tasks/). Six JSON files, each
// touched by both the MCP server and the hook, so every mutation is lock-guarded
// and written atomically:
//
//   edited.json     { files: { <rel>: EditRecord } }          — files edited this session
//   tests.json      { tests: { <testRel>: TestRecord } }      — red/green + everRed per test
//   checklist.json  { items: [ChecklistItem...] }             — related-file review items
//   grants.json     { grants: { <rel>: GrantRecord } }        — refactor/bypass windows
//   stop-block.json { blocks: { "<event>:<agent>": StopBlockRecord } } — Stop-gate loop protection
//   mute.json       { mute: MuteRecord | null }               — /graphyne:off enforcement mute
//
// JSON (not YAML) on purpose: the hook reads/writes these on every tool call and
// JSON is built in — no parser to bundle for the hot path.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { atomicWrite } from "./atomic-write.mjs";
import { tasksDir } from "./storage.mjs";
import { withFileLock } from "./lock.mjs";
import { normalizeRel } from "./paths.mjs";
import { foldPathCase, foldedKeyOf } from "./path-key.mjs";

/** @typedef {"red" | "green"} TestResult */
/** @typedef {{ lastResult: TestResult, everRed: boolean, at: string }} TestRecord */

// A refactor grant on a gated source file. Two shapes, both verified GREEN to open
// and both carrying `greenAt` (the green-verification time, against which a later
// edit is checked for the green-after guarantee) and `at` (creation time):
//
//   DeleteGrant (graphyne_refactor) — STRUCTURAL. `oracle` is the green safety net
//     ("covering" = the file's covering tests; "all" = the whole suite when it has
//     none). While open the gate admits PURE whole-line deletions only.
//
//   BypassGrant (graphyne_bypass) — SELF-ATTESTED, the WEAKEST grant. `tests` are the
//     covering tests the agent declared and that were run green to open it. While open
//     the gate admits ANY edit to the file — there is NO structural or coverage check;
//     it rests on the agent's `reason` (attestation) plus green-before/green-after.
//
// Discriminated by the presence of `tests` (see isBypassGrant) — NOT a `kind` field,
// so an old delete-grant on disk reads back unchanged (no migration).
/** @typedef {{ reason: string, oracle: "covering" | "all", greenAt: string, at: string }} DeleteGrant */
/** @typedef {{ reason: string, tests: string[], greenAt: string, at: string }} BypassGrant */
/** @typedef {DeleteGrant | BypassGrant} GrantRecord */

/**
 * Whether a grant is a self-attested bypass grant (vs a structural delete-only one).
 * @param {GrantRecord} g
 * @returns {g is BypassGrant}
 */
export function isBypassGrant(g) {
  return "tests" in g;
}

// Per edited file: a monotonic edit counter and the counter value at the last
// meta confirmation. The file is "meta-dirty" (must be re-confirmed before Stop)
// whenever it has been edited since it was last confirmed — i.e. metaConfirmed <
// edits. Confirming sets metaConfirmed = edits; a fresh edit bumps edits past it,
// re-arming the requirement. `at` is the last edit time, for display only.
// `agents` attributes the record to every agent that edited the file ("main" for
// the main loop, the harness agent_id for a subagent) — the SubagentStop gate
// slices obligations by it. Absent (a pre-upgrade record) means main's.
/** @typedef {{ edits: number, metaConfirmed: number, at: string, agents?: string[] }} EditRecord */

/**
 * The agents an edit record belongs to; a record written before attribution
 * existed belongs to the main loop.
 * @param {EditRecord} rec
 * @returns {string[]}
 */
export function recordAgents(rec) {
  return rec.agents ?? ["main"];
}

/**
 * A file edited since its meta was last confirmed (or never confirmed).
 * @param {EditRecord} rec
 * @returns {boolean}
 */
export function isMetaDirty(rec) {
  return rec.metaConfirmed < rec.edits;
}

/** @typedef {"open" | "edited" | "reviewed"} ItemState */

/**
 * @typedef {object} ChecklistItem
 * @property {string} path
 * @property {string[]} reasons
 * @property {ItemState} state
 * @property {string} at
 * @property {string[]} [tags] Union of the edge tags that flagged this file (doc, spec,
 *   consumer, ...), for display and to explain the obligation. Optional for back-compat with old JSON.
 * @property {boolean} [hard] A HARD item (a doc/spec relation) is NOT cleared by a bare review —
 *   it needs an actual edit or a review WITH a reason. Soft items clear on a bare review.
 *   Optional for back-compat: absent => soft (the pre-doc-gate behavior).
 * @property {string} [reason] The reason supplied when reviewing without editing — required to
 *   resolve a hard item ("doc needs no change because ...").
 */

/**
 * A checklist item is settled once it is resolved: an edit always resolves it; a
 * review resolves a soft item, but a HARD (doc/spec) item only when the review
 * carried a reason — the actualization guarantee.
 * @param {ChecklistItem} item
 * @returns {boolean}
 */
export function isResolved(item) {
  if (item.state === "open") return false;
  if (item.state === "edited") return true;
  // reviewed: hard items need a reason, soft items don't.
  return !(item.hard && !item.reason);
}

/**
 * @param {string} id
 * @returns {string}
 */
export function sanitizeSessionId(id) {
  return String(id || "nosession").replace(/[^\w-]/g, "_");
}

/**
 * @param {string} root
 * @param {string} sessionId
 * @returns {string}
 */
export function sessionDir(root, sessionId) {
  return join(tasksDir(root), sanitizeSessionId(sessionId));
}

// The MCP server runs in its own process and is NOT told the Claude session id —
// only the hook receives it (via stdin). So the hook records the active session
// here on every event, and the MCP server reads it to target the same session
// directory. If it's missing (no hook event yet), we fall back to the most
// recently touched session dir, then to a fixed "default".
const CURRENT_FILE = ".current";
const DEFAULT_SESSION = "default";

/**
 * Record the active session id (called by the hook on every event).
 * @param {string} root
 * @param {string} sessionId
 */
export function writeCurrentSession(root, sessionId) {
  const id = sanitizeSessionId(sessionId);
  const p = join(tasksDir(root), CURRENT_FILE);
  mkdirSync(tasksDir(root), { recursive: true });
  try {
    writeFileSync(p, id);
  } catch {
    /* best-effort pointer */
  }
}

/**
 * The session the MCP server should operate on: the hook's recorded pointer, else
 * the most-recently-modified session dir, else "default".
 * @param {string} root
 * @returns {string}
 */
export function currentSession(root) {
  const ptr = join(tasksDir(root), CURRENT_FILE);
  try {
    const id = readFileSync(ptr, "utf8").trim();
    if (id) return id;
  } catch {
    /* no pointer — fall back */
  }
  try {
    const dirs = readdirSync(tasksDir(root))
      .filter((n) => n !== CURRENT_FILE && !n.startsWith("."))
      .map((n) => ({ n, m: safeMtime(join(tasksDir(root), n)) }))
      .filter((d) => d.m > 0)
      .sort((a, b) => b.m - a.m);
    if (dirs.length > 0) return dirs[0].n;
  } catch {
    /* no tasks dir yet */
  }
  return DEFAULT_SESSION;
}

/**
 * @param {string} p
 * @returns {number}
 */
function safeMtime(p) {
  try {
    const s = statSync(p);
    return s.isDirectory() ? s.mtimeMs : 0;
  } catch {
    return 0;
  }
}

/**
 * One row per session directory, for the web App's session browser.
 * @typedef {object} SessionSummary
 * @property {string} id
 * @property {string} at Last-activity time (the dir's mtime), ISO; "" if unknown.
 * @property {boolean} current Whether this is the session the MCP server currently targets.
 * @property {number} edited Files edited in the session.
 * @property {number} open Open (unresolved) checklist items.
 */

/**
 * Summarize every persisted session under tasks/, newest first. Skips the
 * `.current` pointer and any dotfile, and anything that isn't a directory.
 * @param {string} root
 * @returns {SessionSummary[]}
 */
export function listSessions(root) {
  const dir = tasksDir(root);
  /** @type {string[]} */
  let names;
  try {
    names = readdirSync(dir).filter((n) => n !== CURRENT_FILE && !n.startsWith("."));
  } catch {
    return [];
  }
  const cur = currentSession(root);
  /** @type {(SessionSummary & { m: number })[]} */
  const rows = [];
  for (const id of names) {
    const m = safeMtime(join(dir, id));
    if (m <= 0) continue; // not a directory
    rows.push({
      id,
      m,
      at: new Date(m).toISOString(),
      current: id === cur,
      edited: readEdited(root, id).length,
      open: readChecklist(root, id).filter((i) => !isResolved(i)).length,
    });
  }
  rows.sort((a, b) => b.m - a.m);
  return rows.map(({ m: _m, ...row }) => row);
}

/**
 * @param {string} root
 * @param {string} sessionId
 * @param {string} name
 * @returns {string}
 */
function filePath(root, sessionId, name) {
  return join(sessionDir(root, sessionId), name);
}

/**
 * @template T
 * @param {string} path
 * @param {T} fallback
 * @returns {T}
 */
function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return /** @type {T} */ (JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return fallback;
  }
}

/**
 * @param {string} path
 * @param {unknown} value
 */
function writeJson(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  atomicWrite(path, JSON.stringify(value, null, 2));
}

/**
 * @template T
 * @param {string} path
 * @param {() => T} fn
 * @returns {T}
 */
function withJsonLock(path, fn) {
  return withFileLock(`${path}.lock`, fn);
}

// #region edited.json

/**
 * Read the edited-files map, tolerating the prior `{ files: string[] }` shape
 * (a resumed pre-upgrade session): each prior entry becomes an unconfirmed
 * record, so it is treated as meta-dirty until explicitly confirmed.
 * @param {string} p
 * @returns {Record<string, EditRecord>}
 */
function readEditedRaw(p) {
  const data = readJson(p, /** @type {{ files: unknown }} */ ({ files: {} })).files;
  if (Array.isArray(data)) {
    /** @type {Record<string, EditRecord>} */
    const out = {};
    for (const f of data) if (typeof f === "string") out[f] = { edits: 1, metaConfirmed: 0, at: "" };
    return out;
  }
  if (data && typeof data === "object") return /** @type {Record<string, EditRecord>} */ (data);
  return {};
}

/**
 * Full per-file edit records for the session.
 * @param {string} root
 * @param {string} sessionId
 * @returns {Record<string, EditRecord>}
 */
export function readEditedRecords(root, sessionId) {
  return readEditedRaw(filePath(root, sessionId, "edited.json"));
}

/**
 * The edited files this session, sorted (just the paths).
 * @param {string} root
 * @param {string} sessionId
 * @returns {string[]}
 */
export function readEdited(root, sessionId) {
  return Object.keys(readEditedRecords(root, sessionId)).sort();
}

/**
 * Record an edit of `rel`: bump its edit counter (re-arming the meta-confirm
 * requirement) and stamp the edit time, preserving any prior confirmation.
 * `agent` attributes the edit ("main" = the main loop; a subagent passes its
 * agent_id) — unioned into the record's `agents`, and a prior record without
 * the field keeps its implicit main attribution.
 * @param {string} root
 * @param {string} sessionId
 * @param {string} rel
 * @param {string} at
 * @param {string} [agent]
 * @param {string} [platform] Injectable for tests; folds the record key on case-insensitive platforms so a case-variant updates the one record.
 */
export function addEdited(root, sessionId, rel, at, agent = "main", platform) {
  const path = normalizeRel(rel);
  const p = filePath(root, sessionId, "edited.json");
  withJsonLock(p, () => {
    const recs = readEditedRaw(p);
    // Dedup a case-variant into the first-seen record (never rewrite its spelling);
    // identity on Linux (exact key).
    const key = foldedKeyOf(recs, path, platform) ?? path;
    const prev = recs[key];
    recs[key] = {
      edits: (prev?.edits ?? 0) + 1,
      metaConfirmed: prev?.metaConfirmed ?? 0,
      at,
      agents: [...new Set([...(prev ? recordAgents(prev) : []), agent])],
    };
    writeJson(p, { files: recs });
  });
}

/**
 * Mark `rel`'s meta as reviewed for its current edit state: set metaConfirmed to
 * the live edit count, clearing meta-dirtiness. Returns "not-edited" when `rel`
 * wasn't edited this session (nothing to confirm).
 * @param {string} root
 * @param {string} sessionId
 * @param {string} rel
 * @param {string} [platform] Injectable for tests; folds the record key on case-insensitive platforms.
 * @returns {"confirmed" | "not-edited"}
 */
export function confirmMeta(root, sessionId, rel, platform) {
  const path = normalizeRel(rel);
  const p = filePath(root, sessionId, "edited.json");
  return withJsonLock(p, () => {
    const recs = readEditedRaw(p);
    const key = foldedKeyOf(recs, path, platform) ?? path;
    const rec = recs[key];
    if (!rec) return "not-edited";
    recs[key] = { ...rec, metaConfirmed: rec.edits };
    writeJson(p, { files: recs });
    return "confirmed";
  });
}

/**
 * Drop `rel` from the edited set entirely (e.g. after the file was deleted from disk
 * and forgotten via graphyne_forget), so it no longer contributes to any Stop gate or
 * the editability list. Returns whether it was present.
 * @param {string} root
 * @param {string} sessionId
 * @param {string} rel
 * @param {string} [platform] Injectable for tests; folds the record key on case-insensitive platforms.
 * @returns {boolean}
 */
export function removeEdited(root, sessionId, rel, platform) {
  const path = normalizeRel(rel);
  const p = filePath(root, sessionId, "edited.json");
  return withJsonLock(p, () => {
    const recs = readEditedRaw(p);
    const key = foldedKeyOf(recs, path, platform);
    if (key === undefined) return false;
    delete recs[key];
    writeJson(p, { files: recs });
    return true;
  });
}

// #endregion edited.json

// #region tests.json

/**
 * @param {string} root
 * @param {string} sessionId
 * @returns {Record<string, TestRecord>}
 */
export function readTests(root, sessionId) {
  const p = filePath(root, sessionId, "tests.json");
  return readJson(p, /** @type {{ tests: Record<string, TestRecord> }} */ ({ tests: {} })).tests ?? {};
}

/**
 * Record a test run's outcome. `everRed` latches true once the test has failed
 * at least once this session (the TDD gate's refactor signal).
 * @param {string} root
 * @param {string} sessionId
 * @param {string} testRel
 * @param {TestResult} result
 * @param {string} at
 * @param {string} [platform] Injectable for tests; folds the test key on case-insensitive platforms.
 * @returns {TestRecord}
 */
export function recordTest(root, sessionId, testRel, result, at, platform) {
  const path = normalizeRel(testRel);
  const p = filePath(root, sessionId, "tests.json");
  return withJsonLock(p, () => {
    const data = readJson(p, /** @type {{ tests: Record<string, TestRecord> }} */ ({ tests: {} }));
    const tests = data.tests ?? {};
    const key = foldedKeyOf(tests, path, platform) ?? path;
    const prev = tests[key];
    /** @type {TestRecord} */
    const record = {
      lastResult: result,
      everRed: (prev?.everRed ?? false) || result === "red",
      at,
    };
    tests[key] = record;
    writeJson(p, { tests });
    return record;
  });
}

// #endregion tests.json

// #region stop-block.json

/**
 * @typedef {{ count: number, event: string, agent: string, at: string }} StopBlockRecord
 */

/**
 * @param {string} event
 * @param {string} agent
 * @returns {string}
 */
function stopBlockKey(event, agent) {
  return `${event}:${agent}`;
}

/**
 * Read the stop-block map, tolerating the pre-map `{ block: record | null }`
 * shape (a resumed pre-upgrade session): the single record becomes the one
 * entry under its own (event, agent) key.
 * @param {string} p
 * @returns {Record<string, StopBlockRecord>}
 */
function readStopBlocksRaw(p) {
  const data = readJson(
    p,
    /** @type {{ blocks?: Record<string, StopBlockRecord>, block?: StopBlockRecord | null }} */ ({}),
  );
  if (data.blocks && typeof data.blocks === "object") return data.blocks;
  const legacy = data.block;
  if (legacy && typeof legacy === "object") {
    return { [stopBlockKey(legacy.event, legacy.agent)]: legacy };
  }
  return {};
}

/**
 * The Stop-gate loop-protection record for one gate: written when that gate
 * blocks, cleared (all gates at once) by the next user prompt (= a new stop
 * chain). Records are KEYED per (event, agent) so concurrent gates never
 * overwrite each other — a subagent's block must not disarm the main Stop
 * gate, nor another subagent's, and vice versa. `count` is the gate's
 * outstanding-blocker total at block time, so it waives only once the count
 * stops changing.
 * @param {string} root
 * @param {string} sessionId
 * @param {string} event
 * @param {string} agent
 * @returns {StopBlockRecord | null}
 */
export function readStopBlock(root, sessionId, event, agent) {
  const p = filePath(root, sessionId, "stop-block.json");
  return readStopBlocksRaw(p)[stopBlockKey(event, agent)] ?? null;
}

/**
 * Record that a Stop-family gate blocked (keyed by the record's event + agent;
 * other gates' records are preserved).
 * @param {string} root
 * @param {string} sessionId
 * @param {StopBlockRecord} record
 * @returns {StopBlockRecord}
 */
export function recordStopBlock(root, sessionId, record) {
  const p = filePath(root, sessionId, "stop-block.json");
  return withJsonLock(p, () => {
    const blocks = readStopBlocksRaw(p);
    blocks[stopBlockKey(record.event, record.agent)] = record;
    writeJson(p, { blocks });
    return record;
  });
}

/**
 * Clear every gate's record (a new user prompt starts a new stop chain).
 * Returns whether there was anything to clear; a session that never blocked
 * stays untouched.
 * @param {string} root
 * @param {string} sessionId
 * @returns {boolean}
 */
export function clearStopBlock(root, sessionId) {
  const p = filePath(root, sessionId, "stop-block.json");
  if (!existsSync(p)) return false;
  return withJsonLock(p, () => {
    writeJson(p, { blocks: {} });
    return true;
  });
}

// #endregion stop-block.json

// #region mute.json

/** @typedef {{ at: string }} MuteRecord */

/**
 * The session-wide enforcement mute (`/graphyne:off`, the recovery path when
 * the MCP server is unreachable): while set, the hook downgrades the TDD
 * PreToolUse deny and the Stop/SubagentStop blocks to warnings. Obligations
 * keep being RECORDED — never cleared — so `/graphyne:on` re-arms the gates
 * with the true outstanding set. A missing or corrupt file reads as unmuted.
 * @param {string} root
 * @param {string} sessionId
 * @returns {MuteRecord | null}
 */
export function readMute(root, sessionId) {
  const p = filePath(root, sessionId, "mute.json");
  const m = readJson(p, /** @type {{ mute: unknown }} */ ({ mute: null })).mute;
  // Shape guard: a hand-edited `{"mute": true}` / `{"mute": {}}` must not read
  // as muted with an undefined timestamp — anything without a string `at` is
  // treated as unmuted (fail toward enforcement).
  if (!m || typeof m !== "object" || typeof (/** @type {MuteRecord} */ (m).at) !== "string") return null;
  return /** @type {MuteRecord} */ (m);
}

/**
 * Mute enforcement for the session (idempotent; refreshes the timestamp).
 * @param {string} root
 * @param {string} sessionId
 * @param {string} at
 * @returns {MuteRecord}
 */
export function recordMute(root, sessionId, at) {
  const p = filePath(root, sessionId, "mute.json");
  return withJsonLock(p, () => {
    /** @type {MuteRecord} */
    const record = { at };
    writeJson(p, { mute: record });
    return record;
  });
}

/**
 * Lift the mute. Returns whether the session was actually muted.
 * @param {string} root
 * @param {string} sessionId
 * @returns {boolean}
 */
export function clearMute(root, sessionId) {
  const p = filePath(root, sessionId, "mute.json");
  if (!existsSync(p)) return false;
  return withJsonLock(p, () => {
    const was = readJson(p, /** @type {{ mute: MuteRecord | null }} */ ({ mute: null })).mute != null;
    writeJson(p, { mute: null });
    return was;
  });
}

// #endregion mute.json

// #region grants.json

/**
 * The delete-only refactor grants in effect this session, keyed by source path.
 * @param {string} root
 * @param {string} sessionId
 * @returns {Record<string, GrantRecord>}
 */
export function readGrants(root, sessionId) {
  const p = filePath(root, sessionId, "grants.json");
  return readJson(p, /** @type {{ grants: Record<string, GrantRecord> }} */ ({ grants: {} })).grants ?? {};
}

/**
 * Open (or refresh) a delete-only refactor grant for `rel`: records the green
 * oracle and the `reason`, stamping `greenAt`/`at` with the verification time. A
 * re-run overwrites the prior grant, refreshing `greenAt` (the green-after gate).
 * @param {string} root
 * @param {string} sessionId
 * @param {string} rel
 * @param {"covering" | "all"} oracle
 * @param {string} reason
 * @param {string} at
 * @param {string} [platform] Injectable for tests; folds the grant key on case-insensitive platforms.
 * @returns {DeleteGrant}
 */
export function recordGrant(root, sessionId, rel, oracle, reason, at, platform) {
  const path = normalizeRel(rel);
  const p = filePath(root, sessionId, "grants.json");
  return withJsonLock(p, () => {
    const data = readJson(p, /** @type {{ grants: Record<string, GrantRecord> }} */ ({ grants: {} }));
    const grants = data.grants ?? {};
    const key = foldedKeyOf(grants, path, platform) ?? path;
    /** @type {DeleteGrant} */
    const record = { reason, oracle, greenAt: at, at };
    grants[key] = record;
    writeJson(p, { grants });
    return record;
  });
}

/**
 * Open (or refresh) a self-attested bypass grant for `rel`: records the covering
 * `tests` the agent declared (paths normalized) and the `reason`, stamping
 * `greenAt`/`at` with the green-verification time. A re-run overwrites the prior
 * grant, refreshing `greenAt` (the green-after gate).
 * @param {string} root
 * @param {string} sessionId
 * @param {string} rel
 * @param {string[]} tests
 * @param {string} reason
 * @param {string} at
 * @param {string} [platform] Injectable for tests; folds the grant key on case-insensitive platforms.
 * @returns {BypassGrant}
 */
export function recordBypassGrant(root, sessionId, rel, tests, reason, at, platform) {
  const path = normalizeRel(rel);
  const p = filePath(root, sessionId, "grants.json");
  return withJsonLock(p, () => {
    const data = readJson(p, /** @type {{ grants: Record<string, GrantRecord> }} */ ({ grants: {} }));
    const grants = data.grants ?? {};
    const key = foldedKeyOf(grants, path, platform) ?? path;
    /** @type {BypassGrant} */
    const record = { reason, tests: tests.map(normalizeRel), greenAt: at, at };
    grants[key] = record;
    writeJson(p, { grants });
    return record;
  });
}

// #endregion grants.json

// #region checklist.json

/**
 * @param {string} root
 * @param {string} sessionId
 * @returns {ChecklistItem[]}
 */
export function readChecklist(root, sessionId) {
  const p = filePath(root, sessionId, "checklist.json");
  return readJson(p, /** @type {{ items: ChecklistItem[] }} */ ({ items: [] })).items ?? [];
}

/**
 * Options for a review flag: the edge `tags` that caused it, whether it is `hard`
 * (a doc/spec relation that a bare review can't clear), and `resolvedAsEdited`
 * (the related file was already edited this session, so start it resolved).
 * @typedef {{ tags?: string[], hard?: boolean, resolvedAsEdited?: boolean }} ReviewOpts
 */

/**
 * Add (or extend) a review item for `path`, flagged because `reason` changed.
 * If an item for `path` exists, its reasons and tags are unioned, its hardness is
 * ORed in (once hard, always hard), and its state preserved. When `resolvedAsEdited`
 * is set (the related file was already edited), a new item starts in "edited".
 * @param {string} root
 * @param {string} sessionId
 * @param {string} path
 * @param {string} reason
 * @param {string} at
 * @param {ReviewOpts} [opts]
 * @param {string} [platform] Injectable for tests; item matching folds path case on case-insensitive platforms.
 */
export function upsertReview(root, sessionId, path, reason, at, opts = {}, platform) {
  const target = normalizeRel(path);
  const targetKey = foldPathCase(target, platform);
  const why = normalizeRel(reason);
  const tags = [...new Set((opts.tags ?? []).filter(Boolean))];
  const p = filePath(root, sessionId, "checklist.json");
  withJsonLock(p, () => {
    const items = readJson(p, /** @type {{ items: ChecklistItem[] }} */ ({ items: [] })).items ?? [];
    // Match case-insensitively (Low #7) but store the first-seen real spelling.
    const existing = items.find((i) => foldPathCase(i.path, platform) === targetKey);
    if (existing) {
      if (!existing.reasons.includes(why)) existing.reasons.push(why);
      existing.tags = [...new Set([...(existing.tags ?? []), ...tags])];
      if (opts.hard) existing.hard = true;
    } else {
      items.push({
        path: target,
        reasons: [why],
        state: opts.resolvedAsEdited ? "edited" : "open",
        at,
        tags,
        hard: !!opts.hard,
      });
    }
    writeJson(p, { items });
  });
}

/**
 * Mark every item whose target is `path` as resolved-by-edit. An edit resolves any
 * not-yet-edited item — including a hard item left "reviewed" without a reason.
 * @param {string} root
 * @param {string} sessionId
 * @param {string} path
 * @param {string} [platform] Injectable for tests; item matching folds path case on case-insensitive platforms.
 */
export function markEdited(root, sessionId, path, platform) {
  const targetKey = foldPathCase(normalizeRel(path), platform);
  const p = filePath(root, sessionId, "checklist.json");
  withJsonLock(p, () => {
    const items = readJson(p, /** @type {{ items: ChecklistItem[] }} */ ({ items: [] })).items ?? [];
    let changed = false;
    for (const i of items) {
      if (foldPathCase(i.path, platform) === targetKey && i.state !== "edited") {
        i.state = "edited";
        changed = true;
      }
    }
    if (changed) writeJson(p, { items });
  });
}

/**
 * Mark the item for `path` as reviewed (the agent's manual "no change needed").
 * A `reason` is recorded when given — required to resolve a HARD (doc/spec) item.
 * Returns false if there was no item for that path.
 * @param {string} root
 * @param {string} sessionId
 * @param {string} path
 * @param {string} [reason]
 * @param {string} [platform] Injectable for tests; item matching folds path case on case-insensitive platforms.
 * @returns {boolean}
 */
export function markReviewed(root, sessionId, path, reason, platform) {
  const targetKey = foldPathCase(normalizeRel(path), platform);
  const p = filePath(root, sessionId, "checklist.json");
  return withJsonLock(p, () => {
    const items = readJson(p, /** @type {{ items: ChecklistItem[] }} */ ({ items: [] })).items ?? [];
    const item = items.find((i) => foldPathCase(i.path, platform) === targetKey);
    if (!item) return false;
    item.state = "reviewed";
    const r = reason?.trim();
    if (r) item.reason = r;
    writeJson(p, { items });
    return true;
  });
}

// #endregion checklist.json

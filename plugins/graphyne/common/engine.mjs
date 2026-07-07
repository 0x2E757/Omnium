// The shared decision logic, used by BOTH the hook (deterministic enforcement)
// and the MCP server (status reads). Keeping it here means the gate the hook
// enforces and the status the agent queries can never disagree.
//
//   gateEdit     — the TDD hard gate (PreToolUse): may this production file be edited?
//   onEdit       — after an edit (PostToolUse): record it, tick/extend the checklist.
//   stopBlockers — at Stop: what's outstanding (missing meta, unresolved reviews).

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  isGatedSource,
  isTestFile,
  isDocFile,
  isIgnored,
  needsMeta,
} from "./config.mjs";
import { edgesWithTag } from "./graph.mjs";
import { readMeta, neighbors } from "./graph-store.mjs";
import { metaExists } from "./storage.mjs";
import { normalizeRel } from "./paths.mjs";
import { foldPathCase, foldedGet, foldedKeyOf } from "./path-key.mjs";
import {
  isResolved,
  isMetaDirty,
  addEdited,
  readEdited,
  readEditedRecords,
  recordAgents,
  markEdited,
  upsertReview,
  readChecklist,
  readTests,
  readGrants,
  isBypassGrant,
} from "./session.mjs";

/** @typedef {import("./config.mjs").Config} Config */
/** @typedef {import("./session.mjs").ChecklistItem} ChecklistItem */
/** @typedef {import("./session.mjs").TestRecord} TestRecord */

/**
 * Test files covering `rel`: its `test`-tagged edges that point at a test file.
 * @param {string} root
 * @param {Config} config
 * @param {string} rel
 * @returns {string[]}
 */
export function coveringTests(root, config, rel) {
  return edgesWithTag(readMeta(root, rel), "test")
    .map((e) => e.path)
    .filter((p) => isTestFile(config, p));
}

/** @typedef {{ allowed: boolean, reason?: string }} GateResult */

/**
 * Per-edit context the hook supplies to the gate. `pureDeletion` is true when the
 * pending edit only removes whole lines (computed from the tool input) — the signal
 * that admits a delete-only refactor grant.
 * @typedef {{ pureDeletion?: boolean }} GateOpts
 */

/**
 * The TDD gate. A production edit to `rel` is allowed when: it isn't gated
 * source; or it's a test file (that's how you go red); or it's a PURE DELETION
 * covered by an open delete-only refactor grant; or a covering test is currently
 * red (make-it-pass); or a covering test went red->green this session (refactor).
 * Otherwise it's blocked with an actionable reason.
 * @param {string} root
 * @param {Config} config
 * @param {string} sessionId
 * @param {string} rel
 * @param {GateOpts} [opts]
 * @param {string} [platform] Injectable for tests; folds grant/test lookups on case-insensitive platforms.
 * @returns {GateResult}
 */
export function gateEdit(root, config, sessionId, rel, opts = {}, platform) {
  const path = normalizeRel(rel);
  if (!isGatedSource(config, path)) return { allowed: true };
  if (isTestFile(config, path)) return { allowed: true };

  // Refactor grants open a window past the red-first gate. A SELF-ATTESTED bypass
  // grant (graphyne_bypass) admits ANY edit to the file — the weakest grant, resting
  // on the agent's attestation plus green-before/green-after (enforced at Stop via
  // unverifiedBypass). A DELETE-ONLY grant (graphyne_refactor) admits only a pure
  // deletion (no line added/modified), so a behavior change can't sneak through; its
  // green-after is enforced at Stop (a covering grant via redTests, an all-suite grant
  // via staleGrants).
  const grant = foldedGet(readGrants(root, sessionId), path, platform);
  if (grant) {
    if (isBypassGrant(grant)) return { allowed: true };
    if (opts.pureDeletion) return { allowed: true };
  }

  // Red-first / refactor allowance: a covering test currently red, or one that went
  // red->green this session. Checked BEFORE the grant-aware deny messages so an open
  // grant never masks a legitimate red-first edit.
  const covering = coveringTests(root, config, path);
  const tests = readTests(root, sessionId);
  for (const t of covering) {
    const rec = foldedGet(tests, t, platform);
    if (!rec) continue;
    if (rec.lastResult === "red") return { allowed: true };
    if (rec.lastResult === "green" && rec.everRed) return { allowed: true }; // refactor window
  }

  // Blocked. Pick the most informative reason. Grant-awareness comes first: the
  // historically identical-to-no-grant message hid the real failure (it cost the
  // reporter two restarts to diagnose). If a grant IS open, a pure deletion would
  // already have been admitted above, so the only way we reach here is a non-deletion
  // edit — say exactly that. Conversely, when the hook flagged a pure deletion but no
  // grant is open, point at graphyne_refactor instead of only demanding a failing test.
  if (grant) {
    return {
      allowed: false,
      reason:
        `TDD gate: a delete-only refactor grant is open for "${path}", but this edit is not a pure ` +
        `deletion (it adds or modifies a line). Only whole-line removals are admitted under the grant; ` +
        `any add/modify still needs a failing test first — write one, run graphyne_test (see it RED), ` +
        `then edit "${path}".`,
    };
  }
  if (opts.pureDeletion) {
    return {
      allowed: false,
      reason:
        `TDD gate: this is a pure deletion, but no delete-only refactor grant is open for "${path}". ` +
        `If it is behavior-preserving dead-code removal, open one with graphyne_refactor (path: ` +
        `"${path}", reason: "..."), then re-try the deletion; otherwise write a FAILING test, run it ` +
        `via graphyne_test, then edit "${path}".`,
    };
  }
  if (covering.length === 0) {
    return {
      allowed: false,
      reason:
        `TDD gate: "${path}" is gated source with no covering test declared. Declare one with ` +
        `graphyne_link (path: "${path}", related: "<test file>", tags: ["test"]), write a FAILING ` +
        `test, run it via graphyne_test, then edit "${path}".`,
    };
  }
  return {
    allowed: false,
    reason:
      `TDD gate: no covering test for "${path}" is currently failing (and none went red->green ` +
      `this session). Write/adjust a test that fails, run it with graphyne_test (see it RED), then ` +
      `edit "${path}". Covering test(s): ${covering.join(", ")}.`,
  };
}

/**
 * @typedef {object} EditOutcome
 * @property {string} rel
 * @property {string[]} addedReviews Related files newly flagged for review (still open, not yet edited).
 * @property {boolean} missingMeta The edited file is required to have meta but has none yet.
 * @property {boolean} needsConfirm The edited file participates in the meta graph, so its relations
 *   must be (re-)confirmed via graphyne_meta_confirm before Stop.
 */

/**
 * Whether flagging a neighbor reached via an edge with `tags` is HARD — a bare
 * graphyne_review can't clear it; it needs an actual edit or a review WITH a reason.
 * A `spec` relation is always hard: the spec is the source of truth, so editing
 * either side demands a conformance check. A `doc` relation is hard only when the
 * CODE was edited (the doc may now be stale); editing the doc itself flags the code
 * softly, since prose changes rarely force a code change. Everything else is soft.
 * @param {string[]} tags
 * @param {boolean} editedFileIsDoc
 * @returns {boolean}
 */
function isHardFlag(tags, editedFileIsDoc) {
  if (tags.includes("spec")) return true;
  if (tags.includes("doc")) return !editedFileIsDoc;
  return false;
}

/**
 * Apply an edit's bookkeeping: record it, resolve any open review item for it,
 * and flag its related files for review. Returns what changed, for the nudge.
 * `agent` attributes the edit ("main" = the main loop; a subagent's agent_id
 * otherwise) so SubagentStop can gate each subagent on its own slice.
 * @param {string} root
 * @param {Config} config
 * @param {string} sessionId
 * @param {string} rel
 * @param {string} now
 * @param {string} [agent]
 * @param {string} [platform] Injectable for tests; the already-edited check folds path case on case-insensitive platforms.
 * @returns {EditOutcome}
 */
export function onEdit(root, config, sessionId, rel, now, agent = "main", platform) {
  const path = normalizeRel(rel);
  // Ignored files are invisible to Graphyne: don't record the edit and don't flag
  // anything (mirrors needsMeta/isGatedSource, which also exempt them).
  if (isIgnored(config, path)) {
    return { rel: path, addedReviews: [], missingMeta: false, needsConfirm: false };
  }
  addEdited(root, sessionId, path, now, agent, platform);
  markEdited(root, sessionId, path, platform); // editing a flagged file resolves its item (case-folded)

  // Fold the edited set and each neighbor's path to a case key so that, on a
  // case-insensitive FS, an already-edited file spelled with different casing
  // still counts as edited (Low #7) — the neighbor-review gate must not re-flag it.
  const edited = new Set(readEdited(root, sessionId).map((p) => foldPathCase(p, platform)));
  const editedIsDoc = isDocFile(config, path);
  /** @type {string[]} */
  const addedReviews = [];
  for (const edge of neighbors(root, path)) {
    if (isIgnored(config, edge.path)) continue; // never flag an ignored neighbor
    const alreadyEdited = edited.has(foldPathCase(edge.path, platform));
    const tags = edge.tags ?? [];
    upsertReview(root, sessionId, edge.path, path, now, {
      tags,
      hard: isHardFlag(tags, editedIsDoc),
      resolvedAsEdited: alreadyEdited,
    }, platform);
    if (!alreadyEdited) addedReviews.push(edge.path);
  }

  const requiresMeta = needsMeta(config, path);
  const missingMeta = requiresMeta && !metaExists(root, path);
  return { rel: path, addedReviews, missingMeta, needsConfirm: requiresMeta };
}

/**
 * @typedef {object} StopBlockers
 * @property {string[]} missingMeta
 * @property {ChecklistItem[]} unresolved
 * @property {string[]} metaDirty Edited files that HAVE meta but were changed since last confirmed —
 *   the agent must (re-)confirm their relations via graphyne_meta_confirm. Disjoint from
 *   missingMeta (which covers the no-meta-yet case).
 * @property {string[]} redTests Test files currently RED that cover a gated source edited this
 *   session — the turn left its own work failing. Scoped to edited source (not every red test
 *   this session) so an unrelated/pre-existing failure can't trap the agent.
 * @property {string[]} staleGrants Files under an all-suite delete-only refactor grant that were
 *   edited AFTER the grant's green verification — the green-after guarantee is unproven, so the
 *   agent must re-run graphyne_refactor to re-verify the suite is still green. (Covering-oracle
 *   grants need no separate check — their green-after is the redTests guard.)
 * @property {string[]} unverifiedBypass Files under a self-attested bypass grant that were edited
 *   AFTER the grant opened and whose declared covering tests are NOT all green-and-fresh (re-run
 *   after that edit) — the green-after guarantee is unproven, so the agent must re-run those
 *   tests via graphyne_test. This is how a self-attested bypass keeps a real guard.
 * @property {string[]} deletedWithMeta Files edited this session that no longer exist on disk
 *   (deleted mid-session) yet still have a meta file — the source is gone but its meta +
 *   reciprocal neighbor edges linger as orphan graph cruft. graphyne_forget prunes them. A
 *   deleted file with NO meta is simply dropped from every gate (a throwaway needs no cleanup);
 *   this list is only the leftover-meta case that needs an explicit prune.
 */

/**
 * Whether an edited file still exists on disk. A path deleted mid-session (e.g. a
 * throwaway probe `rm`'d after use, or production code removed via Bash) is no longer
 * Graphyne's concern as a graph node, so it carries no per-file Stop obligation — the
 * hook never sees a raw `rm`, so disk state at Stop is the signal that it is gone.
 * @param {string} root
 * @param {string} rel
 * @returns {boolean}
 */
function existsOnDisk(root, rel) {
  return existsSync(join(root, rel));
}

/**
 * What blocks Stop: edited files still lacking meta, edited files whose meta
 * hasn't been (re-)confirmed since the edit, unresolved review items, and red
 * covering tests for source edited this session.
 *
 * With `agentId` set, every class is scoped to the slice that agent's OWN edits
 * incurred (SubagentStop): only files whose edit record is attributed to it, and
 * only checklist items one of those files flagged. A record without attribution
 * (pre-upgrade session) belongs to "main". Without `agentId` (undefined OR null)
 * the gate is session-wide — the main Stop gate's backstop for whatever
 * subagents left behind. NOTE: passing "main" is NARROWER than session-wide —
 * it excludes other agents' slices and any unresolved item whose flagging file
 * was dropped from the edited set (deleted + forgotten); only the unscoped call
 * catches those orphans.
 * @param {string} root
 * @param {Config} config
 * @param {string} sessionId
 * @param {string} [agentId]
 * @param {string} [platform] Injectable for tests; folds cross-store key lookups on case-insensitive platforms.
 * @returns {StopBlockers}
 */
export function stopBlockers(root, config, sessionId, agentId, platform) {
  const allRecords = readEditedRecords(root, sessionId);
  const scoped = agentId != null; // null must behave like undefined, never like an empty slice
  const records = !scoped
    ? allRecords
    : Object.fromEntries(
        Object.entries(allRecords).filter(([, rec]) => recordAgents(rec).includes(agentId)),
      );
  const edited = Object.keys(records).sort();
  // A file deleted from disk mid-session carries no per-file Stop obligation: drop it
  // from every edited-derived gate below. The only residue worth surfacing is an
  // ORPHAN META — a deleted file whose meta (and its reciprocal neighbor edges) still
  // exist — which graphyne_forget prunes (deletedWithMeta). A deleted file with no meta
  // is a clean no-op (the throwaway-probe case this gate used to trap).
  const present = edited.filter((rel) => existsOnDisk(root, rel));
  const presentSet = new Set(present);
  // For CROSS-STORE membership (a grant key probed against the edited set) fold the
  // present paths: a grant recorded under a case-variant of an edited file must still
  // count as present, or its green-after guard is skipped (fails OPEN) on a
  // case-insensitive FS. Identity on Linux. (deletedWithMeta below stays same-store —
  // edited key vs edited key — so it keeps the raw presentSet.)
  const presentKeys = new Set(present.map((rel) => foldPathCase(rel, platform)));
  const deletedWithMeta = edited.filter(
    (rel) => !presentSet.has(rel) && metaExists(root, rel),
  );

  const missingMeta = present.filter(
    (rel) => needsMeta(config, rel) && !metaExists(root, rel),
  );
  const metaDirty = present.filter(
    (rel) => needsMeta(config, rel) && metaExists(root, rel) && isMetaDirty(records[rel]),
  );
  // Checklist items record WHICH edited file flagged them (reasons), so an
  // agent's slice is the items one of ITS edited files flagged. Object.hasOwn,
  // not `in`: a reason named like an inherited property (a file literally
  // called "constructor", "toString", ...) must not match every slice.
  const unresolved = readChecklist(root, sessionId)
    .filter((i) => !isResolved(i))
    .filter((i) => !scoped || i.reasons.some((r) => foldedKeyOf(records, r, platform) !== undefined));

  const tests = readTests(root, sessionId);
  /** @type {Set<string>} */
  const red = new Set();
  for (const rel of present) {
    if (!isGatedSource(config, rel) || isTestFile(config, rel)) continue;
    for (const t of coveringTests(root, config, rel)) {
      if (foldedGet(tests, t, platform)?.lastResult === "red") red.add(t);
    }
  }
  const redTests = [...red].sort();

  // An all-suite delete-only grant proves green-after only if the file wasn't edited
  // since the grant's green verification; a later edit makes it stale until re-verified.
  const grants = readGrants(root, sessionId);
  const staleGrants = Object.keys(grants)
    .filter((rel) => {
      if (!presentKeys.has(foldPathCase(rel, platform))) return false; // deleted source -> grant is moot
      const g = grants[rel];
      if (isBypassGrant(g) || g.oracle !== "all") return false;
      const rec = foldedGet(records, rel, platform);
      return !!rec && rec.at > g.greenAt;
    })
    .sort();

  // A self-attested bypass grant proves green-after only when, for a file edited after
  // the grant opened, EVERY declared test is green AND fresh — recorded (re-run) after
  // that edit. An unedited grant is fine (it opened green); a stale or red test flags it.
  const unverifiedBypass = Object.keys(grants)
    .filter((rel) => {
      if (!presentKeys.has(foldPathCase(rel, platform))) return false; // deleted source -> grant is moot
      const g = grants[rel];
      if (!isBypassGrant(g)) return false;
      const rec = foldedGet(records, rel, platform);
      if (!rec || !(rec.at > g.greenAt)) return false; // not edited since it opened
      return !g.tests.every((t) => {
        const tr = foldedGet(tests, t, platform);
        return tr?.lastResult === "green" && tr.at > rec.at;
      });
    })
    .sort();

  return { missingMeta, unresolved, metaDirty, redTests, staleGrants, unverifiedBypass, deletedWithMeta };
}

/** @typedef {{ rel: string, editable: boolean, covering: string[], detail: string }} Editability */

/**
 * Per gated, edited file: is it currently editable and why — for graphyne_status.
 * @param {string} root
 * @param {Config} config
 * @param {string} sessionId
 * @param {string} [platform] Injectable for tests; folds grant/test lookups on case-insensitive platforms.
 * @returns {Editability[]}
 */
export function editability(root, config, sessionId, platform) {
  const tests = readTests(root, sessionId);
  const grants = readGrants(root, sessionId);
  return readEdited(root, sessionId)
    .filter((rel) => existsOnDisk(root, rel)) // a deleted file is no longer editable — omit it
    .filter((rel) => isGatedSource(config, rel) && !isTestFile(config, rel))
    .map((rel) => {
      const covering = coveringTests(root, config, rel);
      const g = gateEdit(root, config, sessionId, rel, {}, platform);
      const grant = foldedGet(grants, rel, platform);
      let detail = covering.map((t) => `${t}=${describeTest(foldedGet(tests, t, platform))}`).join(", ") || "no covering test";
      // A grant opens a delete-only window: deletions are admitted even when the
      // ordinary gate (no pureDeletion flag here) reports blocked.
      const editable = g.allowed || !!grant;
      if (grant) {
        detail += isBypassGrant(grant)
          ? ` | self-attested bypass window`
          : ` | delete-only refactor window (${grant.oracle})`;
      }
      return { rel, editable, covering, detail };
    });
}

/**
 * @param {TestRecord | undefined} rec
 * @returns {string}
 */
function describeTest(rec) {
  if (!rec) return "unrun";
  return rec.everRed ? `${rec.lastResult}(was-red)` : rec.lastResult;
}

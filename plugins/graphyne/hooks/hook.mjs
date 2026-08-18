// Graphyne adoption + enforcement hook — one Claude Code hook script, dispatched
// by event (passed as argv[2]). Unlike a pure nudge hook, this one ENFORCES:
//
//   PreToolUse(Edit|Write|MultiEdit|NotebookEdit)  -> TDD hard gate (deny edits
//       to gated source with no failing test).
//   PostToolUse(Edit|…)  -> record the edit, tick/extend the related-files
//       checklist, nudge when the edited file has no meta.
//   PostToolUse(Bash)    -> nudge to run tests via graphyne_test (so red/green is tracked).
//   Stop / SubagentStop  -> HARD BLOCK while any edited file lacks meta or any
//       related-file review is still open. SubagentStop scopes the gate to the
//       obligations the subagent's OWN edits incurred (by payload agent_id), so
//       a read-only subagent is never wedged on the parent's bookkeeping.
//   SessionStart / UserPromptSubmit -> context + reminders (SessionStart source
//       "compact" carries the post-compaction reminder — PreCompact cannot inject
//       context, Claude Code ignores additionalContext for it).
//
// It reads the meta graph (YAML) and session state through the same
// ../common/*.mjs modules the MCP server uses — no bundling anymore: the
// vendored yaml-lite/globs replacements made the whole tree zero-dependency,
// so the plugin ships this file as-is. Every emitted JSON shape, context
// string and deny reason is pinned by the hook fixture tests in
// tests/graphyne/hook/hook.test.mts (the ported shapes byte-for-byte, the
// Omnium-added stop-waive systemMessage by pattern).
//
// Opt-in gate: does nothing unless the project has a `.graphyne/` directory.
// Failure posture: hooks fail OPEN — a crash here must never block the agent,
// so stdin parsing is lenient and unknown events exit silently.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveProject } from "../common/project.mjs";
import { readConfig } from "../common/config.mjs";
import { GRAPHYNE_DIR, ensureStore } from "../common/storage.mjs";
import { toRel } from "../common/paths.mjs";
import {
  writeCurrentSession,
  readStopBlock,
  recordStopBlock,
  clearStopBlock,
  readMute,
  recordMute,
  clearMute,
} from "../common/session.mjs";
import { gateEdit, onEdit, stopBlockers } from "../common/engine.mjs";
import { isPureDeletion } from "../common/deletion.mjs";

/** @typedef {import("../common/engine.mjs").StopBlockers} StopBlockers */

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const TEST_CMD_RE = /\b(npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+test|vitest|jest|mocha|pytest|go\s+test|cargo\s+test|node\s+--test|dotnet\s+test|rspec|phpunit)\b/i;

// The hook JSON arrives on stdin (fd 0). Strip a leading UTF-8 BOM some shells
// prepend when piping, which would otherwise make JSON.parse throw.
/** @returns {Record<string, unknown>} */
function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8").replace(/^﻿/, ""));
  } catch {
    return {};
  }
}

/** @param {unknown} out */
function emit(out) {
  process.stdout.write(JSON.stringify(out));
}
/**
 * @param {string} hookEventName
 * @param {string} additionalContext
 */
function emitContext(hookEventName, additionalContext) {
  emit({ hookSpecificOutput: { hookEventName, additionalContext } });
}

// Resolve the store root: fast path is the hook's cwd (Claude runs hooks at the
// project root, where .graphyne lives), avoiding a git subprocess on the hot
// PostToolUse(*) path; fall back to the git toplevel only if cwd has no store.
/** @param {string} cwd */
function resolveRoot(cwd) {
  if (existsSync(join(cwd, GRAPHYNE_DIR))) return cwd;
  return resolveProject(cwd).path;
}

/**
 * @param {Record<string, unknown>} input
 * @returns {string | null}
 */
function filePathFromInput(input) {
  const ti = /** @type {Record<string, unknown>} */ (input.tool_input ?? {});
  const p = /** @type {string | undefined} */ (ti.file_path ?? ti.notebook_path);
  if (typeof p !== "string" || !p) return null;
  return p;
}

function now() {
  return new Date().toISOString();
}

// The harness adds agent_id to every hook payload fired inside a subagent
// (PostToolUse for its tool calls, SubagentStop when it ends); the main loop's
// payloads carry none. Null when absent/blank — callers decide the fallback.
/**
 * @param {Record<string, unknown>} input
 * @returns {string | null}
 */
function agentIdOf(input) {
  const a = input.agent_id;
  return typeof a === "string" && a !== "" ? a : null;
}

// #region Handlers

/**
 * Total Stop obligations across all seven blocker classes — the single "anything
 * outstanding?" gate shared by stopLike and the post-compaction reminder, so the
 * two can never drift apart on which classes count.
 * @param {StopBlockers} b
 * @returns {number}
 */
function countOutstanding(b) {
  return (
    b.missingMeta.length +
    b.unresolved.length +
    b.metaDirty.length +
    b.redTests.length +
    b.staleGrants.length +
    b.unverifiedBypass.length +
    b.deletedWithMeta.length
  );
}

/**
 * @param {string} root
 * @param {Record<string, unknown>} input
 */
function sessionStart(root, input) {
  const sessionId = String(input.session_id ?? "nosession");
  writeCurrentSession(root, sessionId);
  const source = String(input.source ?? "startup");
  // compact: the transcript was just summarized — remind about persistent Graphyne
  // state instead of the full onboarding text. (A PreCompact hook cannot do this:
  // Claude Code ignores additionalContext for PreCompact, and anything injected
  // before compaction would be summarized away anyway.) Gated on the same on-disk
  // blockers the Stop gate enforces: when nothing is outstanding, stay silent
  // instead of opening the freshly freed context with a housekeeping burst. The
  // wording only asks for what a lossy summary can actually answer (relations
  // VISIBLE in the summary), and the deferred tools are assumed unloaded — the
  // ToolSearch expansion lives in the transcript the compaction just rewrote.
  if (source === "compact") {
    const outstanding = countOutstanding(stopBlockers(root, readConfig(root), sessionId));
    if (outstanding === 0) return;
    // Muted: the reconcile drill prescribes MCP tools the mute presumes broken —
    // just restate the mute so the fresh context knows the gates are down.
    if (readMute(root, sessionId)) {
      emitContext(
        "SessionStart",
        `Graphyne: the context was just compacted. Enforcement is MUTED for this session ` +
          `(${outstanding} obligation(s) kept on disk); /graphyne:on re-enables.`,
      );
      return;
    }
    emitContext(
      "SessionStart",
      `Graphyne: the context was just compacted and details may have been summarized away, but ` +
        `${outstanding} Graphyne obligation(s) persisted on disk. As a silent setup step, load the ` +
        `deferred MCP tools if needed (ToolSearch keyword query "graphyne_checklist" — the exact ` +
        `namespaced name differs between installs, so don't rely on a select:), review ` +
        `graphyne_checklist for what is outstanding, and link any relations visible in the summary ` +
        `that the graph does not reflect yet (graphyne_link). Then continue in the SAME turn with ` +
        `whatever is pending — the interrupted task, or the user's newer prompt if one is present — ` +
        `without stopping to announce the reconciliation.`,
    );
    return;
  }
  if (source !== "startup" && source !== "clear" && source !== "resume") return;
  // A resumed session keeps its mute (session state survives resume) — say so,
  // or a muted resume would look like ordinary active enforcement.
  const mutedNote = readMute(root, sessionId)
    ? ` NOTE: enforcement is currently MUTED for this session (muted via /graphyne:off); /graphyne:on re-enables.`
    : ``;
  emitContext(
    "SessionStart",
    `Graphyne is active for this project. Load its deferred MCP tools (ToolSearch keyword ` +
      `query "graphyne_checklist" — the exact namespaced name differs between installs, so ` +
      `don't rely on a select:), then review graphyne_checklist to see any ` +
      `outstanding related-file reviews carried over, and use graphyne_neighbors before editing so ` +
      `you know each file's connected files. Remember: edit gated source only after a failing test ` +
      `(graphyne_test), and clear the checklist before ending each turn.` +
      mutedNote,
  );
}

// `/graphyne:off|on|status` are the gate-recovery toggles: when the MCP server
// is down or unregistered, obligations are uncleanable (only the graphyne_*
// tools clear them), so `off` MUTES enforcement for the session — PreToolUse
// stops denying, Stop/SubagentStop warn instead of blocking — while every
// obligation keeps being recorded; `on` re-arms the gates with the true set.
// Handled here (not via MCP) precisely so they work when the server does not,
// and user-only by construction: UserPromptSubmit fires only on a real user
// prompt, never on model output. Strict full-match regexes, like SETUP_CMD_RE,
// so a message merely mentioning a command is never swallowed.
const OFF_CMD_RE = /^\/graphyne:off\s*$/;
const ON_CMD_RE = /^\/graphyne:on\s*$/;
const STATUS_CMD_RE = /^\/graphyne:status\s*$/;

/**
 * @param {string} root
 * @param {string} sessionId
 * @returns {number}
 */
function outstandingCount(root, sessionId) {
  return countOutstanding(stopBlockers(root, readConfig(root), sessionId));
}

/** @param {string} reason */
function emitToggleReply(reason) {
  emit({ decision: "block", reason, systemMessage: reason });
}

/**
 * @param {string} root
 * @param {Record<string, unknown>} input
 */
function userPromptSubmit(root, input) {
  const sessionId = String(input.session_id ?? "nosession");
  writeCurrentSession(root, sessionId);
  clearStopBlock(root, sessionId); // a user prompt starts a new stop chain

  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (OFF_CMD_RE.test(prompt)) {
    const prior = readMute(root, sessionId);
    if (prior) {
      // Idempotent, and keep the original timestamp so status "since" stays true.
      emitToggleReply(
        `Graphyne: enforcement is already MUTED for this session (since ${prior.at}); ` +
          `/graphyne:on re-enables it.`,
      );
      return;
    }
    recordMute(root, sessionId, now());
    emitToggleReply(
      `Graphyne: enforcement is now MUTED for this session — the TDD gate and the Stop gate warn ` +
        `instead of blocking. Obligations are kept, not cleared; /graphyne:on re-enables them.`,
    );
    return;
  }
  if (ON_CMD_RE.test(prompt)) {
    const was = clearMute(root, sessionId);
    const n = outstandingCount(root, sessionId);
    emitToggleReply(
      was
        ? `Graphyne: enforcement re-enabled (mute lifted); ${n} obligation(s) outstanding re-arm ` +
            `the gates — see graphyne_checklist.`
        : `Graphyne: enforcement is already active (this session was not muted); ${n} obligation(s) outstanding.`,
    );
    return;
  }
  if (STATUS_CMD_RE.test(prompt)) {
    const muted = readMute(root, sessionId);
    const blockers = stopBlockers(root, readConfig(root), sessionId);
    const n = countOutstanding(blockers);
    // A per-class breakdown, usable precisely when the MCP checklist is not:
    // this command is the only class-level view that works with the server down.
    const classes = /** @type {[string, number][]} */ ([
      ["missing meta", blockers.missingMeta.length],
      ["unresolved reviews", blockers.unresolved.length],
      ["pending meta confirmations", blockers.metaDirty.length],
      ["red covering tests", blockers.redTests.length],
      ["stale refactor grants", blockers.staleGrants.length],
      ["unverified bypasses", blockers.unverifiedBypass.length],
      ["orphan metas of deleted files", blockers.deletedWithMeta.length],
    ])
      .filter(([, c]) => c > 0)
      .map(([label, c]) => `${c} ${label}`)
      .join(", ");
    const detail = n > 0 ? ` (${classes})` : ``;
    emitToggleReply(
      muted
        ? `Graphyne: enforcement is MUTED for this session (since ${muted.at}); ${n} obligation(s) ` +
            `kept on disk${detail}. /graphyne:on re-enables.`
        : `Graphyne: enforcement is active (not muted); ${n} obligation(s) outstanding${detail}.`,
    );
  }
}

// `/graphyne:setup` is the adoption command: it CREATES the `.graphyne/` store so
// the rest of Graphyne (opt-in until the store exists) wakes up. Because the store
// is absent at adoption time, this is intercepted in main() BEFORE the opt-in gate.
// Being hook-handled, it performs the action and erases the prompt
// (decision: "block") so it never produces a model turn. Strict on purpose:
// a trimmed full match only, so a message that merely mentions the command is never
// swallowed.
const SETUP_CMD_RE = /^\/graphyne:setup\s*$/;

/** @param {unknown} prompt */
function isSetupCommand(prompt) {
  return typeof prompt === "string" && SETUP_CMD_RE.test(prompt.trim());
}

/** @param {string} root */
function handleSetup(root) {
  const already = existsSync(join(root, GRAPHYNE_DIR));
  if (!already) ensureStore(root);
  const reason = already
    ? `Graphyne is already set up for this project (.graphyne/ exists) — nothing to do.`
    : `Graphyne is now set up for this project: created .graphyne/ (the committed meta graph ` +
      `store, plus .gitignore and guard notes). The TDD gate and the related-files graph are ` +
      `active from here on. Next: run /graphyne:init to populate the graph from the existing ` +
      `codebase, or just start editing — Graphyne will prompt you to declare each file's meta ` +
      `and covering tests.`;
  emit({ decision: "block", reason, systemMessage: reason });
}

/**
 * @param {string} root
 * @param {Record<string, unknown>} input
 */
function preToolUse(root, input) {
  const tool = String(input.tool_name ?? "");
  if (!EDIT_TOOLS.has(tool)) return;
  const fp = filePathFromInput(input);
  if (!fp) return;
  const rel = toRel(root, fp);
  if (!rel) return; // outside the repo — not ours to gate

  const config = readConfig(root);
  const sessionId = currentSessionId(root, input);
  // Muted session (/graphyne:off): the TDD gate stands down entirely. With the
  // MCP server unreachable there is no way to record a red test, so keeping the
  // deny would leave gated source uneditable — the mute must cover this gate,
  // not just Stop.
  if (readMute(root, sessionId)) return;
  let gate = gateEdit(root, config, sessionId, rel);
  // If the ordinary gate blocks, a delete-only refactor grant may still admit the
  // edit — but ONLY when it is a pure deletion. Compute that lazily (it reads the
  // file from disk) so the common allowed path stays cheap.
  if (!gate.allowed && pendingPureDeletion(root, rel, tool, input)) {
    gate = gateEdit(root, config, sessionId, rel, { pureDeletion: true });
  }
  if (gate.allowed) return;

  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: gate.reason ?? "Blocked by Graphyne's TDD gate.",
    },
  });
}

/**
 * Whether the pending edit to `rel` is a pure deletion: reconstruct the post-edit
 * content from the tool input against the file's current on-disk content. A missing
 * file (nothing to delete from) or an unreadable one yields false.
 * @param {string} root
 * @param {string} rel
 * @param {string} tool
 * @param {Record<string, unknown>} input
 * @returns {boolean}
 */
function pendingPureDeletion(root, rel, tool, input) {
  const abs = join(root, rel);
  if (!existsSync(abs)) return false;
  /** @type {string} */
  let current;
  try {
    current = readFileSync(abs, "utf8");
  } catch {
    return false;
  }
  const ti = /** @type {Record<string, unknown>} */ (input.tool_input ?? {});
  return isPureDeletion(current, tool, ti);
}

/**
 * @param {string} root
 * @param {Record<string, unknown>} input
 */
function postToolUse(root, input) {
  const tool = String(input.tool_name ?? "");
  const sessionId = currentSessionId(root, input);
  const config = readConfig(root);

  if (EDIT_TOOLS.has(tool)) {
    const fp = filePathFromInput(input);
    if (!fp) return;
    const rel = toRel(root, fp);
    if (!rel) return;

    const out = onEdit(root, config, sessionId, rel, now(), agentIdOf(input) ?? "main");
    // Muted: keep RECORDING (above) so /graphyne:on restores the true obligation
    // set, but hold the nudges — they prescribe MCP tools that are presumed
    // unreachable while the mute is the escape hatch.
    if (readMute(root, sessionId)) return;
    /** @type {string[]} */
    const msgs = [];
    if (out.missingMeta) {
      msgs.push(
        `"${rel}" has no meta yet. Declare its related files with graphyne_link (tag covering tests as ` +
          `"test"). Stop is blocked until every edited file has a meta entry.`,
      );
    }
    if (out.addedReviews.length > 0) {
      msgs.push(
        `"${rel}" is related to: ${out.addedReviews.join(", ")}. Review/update each (or graphyne_review ` +
          `if no change is needed) before ending the turn — they're on graphyne_checklist.`,
      );
    }
    if (out.needsConfirm) {
      msgs.push(
        `After reconciling "${rel}"'s own relations (graphyne_link/graphyne_unlink for any new or removed ` +
          `connections), run graphyne_meta_confirm on it — an empty confirm is fine if nothing changed, but ` +
          `Stop is blocked until every edited file is confirmed.`,
      );
    }
    if (msgs.length > 0) emitContext("PostToolUse", `Graphyne: ${msgs.join(" ")}`);
    return;
  }

  if (tool === "Bash") {
    if (readMute(root, sessionId)) return; // the graphyne_test nudge is moot while muted
    const cmd = String(/** @type {Record<string, unknown>} */ (input.tool_input ?? {}).command ?? "");
    if (TEST_CMD_RE.test(cmd)) {
      emitContext(
        "PostToolUse",
        `Graphyne: looks like you ran tests via Bash. Run them through graphyne_test instead so ` +
          `Graphyne records red/green and the TDD gate works (it returns the same full output).`,
      );
    }
  }
}

/**
 * @param {string} root
 * @param {Record<string, unknown>} input
 * @param {string} eventName
 */
function stopLike(root, input, eventName) {
  const config = readConfig(root);
  const sessionId = currentSessionId(root, input);
  // A SubagentStop that identifies its subagent is gated only on the slice that
  // agent's OWN edits incurred: a read-only subagent (all obligations are the
  // parent's) passes silently below with no block and no chain marker, while
  // the session-wide main Stop gate stays the backstop for whatever it leaves
  // behind. Without agent_id (legacy harness) the full-session gate applies.
  const scopedAgent = eventName === "SubagentStop" ? agentIdOf(input) : null;
  const blockers = stopBlockers(root, config, sessionId, scopedAgent ?? undefined);
  const outstanding = countOutstanding(blockers);
  if (outstanding === 0) return;

  // Muted session (/graphyne:off): warn instead of blocking, and write no chain
  // marker — the mute IS the recovery path, so it must never trap the stop.
  if (readMute(root, sessionId)) {
    emit({
      systemMessage:
        `Graphyne (${eventName}): enforcement is muted for this session — ${outstanding} ` +
        `obligation(s) kept on disk, not blocking. /graphyne:on re-enables.`,
    });
    return;
  }

  // The harness sets stop_hook_active when this stop is already a continuation
  // caused by a prior stop-hook block — by ANY stop hook, the flag is
  // turn-global — and only force-overrides after 8 no-progress blocks.
  // Re-blocking forever risks a long loop, so waive with a user-visible
  // warning instead — but only once THIS gate (same event, same agent — a
  // subagent's block must not disarm the main Stop gate) has blocked in the
  // current chain (recorded below, cleared by the next user prompt) AND the
  // outstanding count is unchanged since that block: shrinking (progress) and
  // growing (new work) both deserve a fresh block, so another gate's block
  // never disarms this one and multi-stop convergence keeps its pressure.
  // The field may arrive as a boolean or a string; absent means false.
  const flagged = input.stop_hook_active === true || input.stop_hook_active === "true";
  const agent = agentIdOf(input) ?? "main";
  // The record store is keyed per (event, agent), so this read only ever sees
  // THIS gate's own prior block — concurrent gates can't disarm each other.
  const prior = readStopBlock(root, sessionId, eventName, agent);
  if (flagged && prior !== null && outstanding === prior.count) {
    emit({
      systemMessage:
        `Graphyne (${eventName}): a previous stop was already blocked (stop_hook_active) — ` +
        `allowing this one to avoid an infinite loop. Outstanding graph bookkeeping remains; ` +
        `see graphyne_checklist.`,
    });
    return;
  }
  recordStopBlock(root, sessionId, { count: outstanding, event: eventName, agent, at: new Date().toISOString() });
  const { missingMeta, unresolved, metaDirty, redTests, staleGrants, unverifiedBypass, deletedWithMeta } = blockers;

  /** @type {string[]} */
  const parts = [];
  if (unresolved.length > 0) {
    parts.push(
      `Related files still to review (edit them, or graphyne_review if no change is needed): ` +
        unresolved.map((i) => i.path).join(", "),
    );
  }
  if (missingMeta.length > 0) {
    parts.push(`Edited files missing a meta entry (use graphyne_link): ` + missingMeta.join(", "));
  }
  if (metaDirty.length > 0) {
    parts.push(
      `Edited files awaiting meta confirmation (reconcile their relations, then graphyne_meta_confirm): ` +
        metaDirty.join(", "),
    );
  }
  if (redTests.length > 0) {
    parts.push(
      `Covering tests for edited source are still RED (fix the code or the test, then re-run graphyne_test): ` +
        redTests.join(", "),
    );
  }
  if (staleGrants.length > 0) {
    parts.push(
      `Delete-only refactor grant(s) awaiting re-verification — you deleted under an all-suite grant; ` +
        `re-run graphyne_refactor to confirm the suite is still green: ` +
        staleGrants.join(", "),
    );
  }
  if (unverifiedBypass.length > 0) {
    parts.push(
      `Self-attested bypass window(s) awaiting green-after — you edited these under a bypass grant; ` +
        `re-run their declared covering tests via graphyne_test to confirm they're still green: ` +
        unverifiedBypass.join(", "),
    );
  }
  if (deletedWithMeta.length > 0) {
    parts.push(
      `Edited file(s) deleted from disk but their meta + neighbor edges linger — prune each with ` +
        `graphyne_forget: ` +
        deletedWithMeta.join(", "),
    );
  }
  // A subagent may lack the graphyne MCP tools entirely (restricted toolset):
  // give its one blocked turn a useful fallback instead of a dead-end demand.
  const toolless =
    eventName === "SubagentStop"
      ? ` If the graphyne tools are not in your toolset, list the edited files and how they relate ` +
        `in your final message instead — the main session will finish the bookkeeping.`
      : ``;
  emit({
    decision: "block",
    reason:
      `Graphyne (${eventName}): finish the graph bookkeeping before stopping. ` +
      parts.join(" | ") +
      ` See graphyne_checklist.` +
      toolless,
  });
}

// The hook KNOWS the session id (stdin) — record it so the MCP server targets the
// same session, and use it directly here.
/**
 * @param {string} root
 * @param {Record<string, unknown>} input
 * @returns {string}
 */
function currentSessionId(root, input) {
  const id = String(input.session_id ?? "nosession");
  writeCurrentSession(root, id);
  return id;
}

// #endregion Handlers

/** @type {Record<string, (root: string, input: Record<string, unknown>) => void>} */
const handlers = {
  SessionStart: sessionStart,
  UserPromptSubmit: userPromptSubmit,
  PreToolUse: preToolUse,
  PostToolUse: postToolUse,
  Stop: (root, input) => stopLike(root, input, "Stop"),
  SubagentStop: (root, input) => stopLike(root, input, "SubagentStop"),
};

function main() {
  const event = process.argv[2] ?? "";
  const handler = handlers[event];
  if (!handler) return;
  const input = readStdin();
  const cwd = String(input.cwd ?? process.cwd());
  const root = resolveRoot(cwd);

  // Adoption runs BEFORE the opt-in gate: /graphyne:setup is the command that
  // creates the store, so .graphyne/ does not exist yet at this point.
  if (event === "UserPromptSubmit" && isSetupCommand(input.prompt)) {
    handleSetup(root);
    return;
  }

  if (!existsSync(join(root, GRAPHYNE_DIR))) return; // opt-in gate
  handler(root, input);
}

main();

// Pure tool logic for the Graphyne MCP server. Every function takes the project
// root + config + the active session id explicitly and returns human-readable
// text (or throws ToolError), so it is unit-testable without the MCP transport.
// server.mjs is the thin adapter: project/session resolution + the frozen input
// schemas + tool registration on the vendored stdio core. Every string returned
// or thrown here is a frozen compat surface — agents have learned them.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { isGatedSource, isTestFile, testFileCommand, testAllCommand } from "./common/config.mjs";
import { toRel } from "./common/paths.mjs";
import { foldPathCase } from "./common/path-key.mjs";
import { listMetaSources, metaExists } from "./common/storage.mjs";
import { linkFiles, unlinkFiles, neighbors, forgetFile } from "./common/graph-store.mjs";
import {
  recordTest,
  recordGrant,
  recordBypassGrant,
  markReviewed,
  confirmMeta,
  removeEdited,
  readChecklist,
  isResolved,
  readMute,
} from "./common/session.mjs";
import { stopBlockers, editability, coveringTests } from "./common/engine.mjs";
import { runTest } from "./common/test-runner.mjs";

/** @typedef {import("./common/config.mjs").Config} Config */
/** @typedef {import("./common/session.mjs").TestResult} TestResult */

export class ToolError extends Error {}

/**
 * Resolve an agent-supplied path to a canonical repo-relative one, or throw.
 * @param {string} root
 * @param {string} input
 * @param {string} label
 * @returns {string}
 */
function rel(root, input, label) {
  const r = toRel(root, input);
  if (!r) {
    throw new ToolError(
      `Invalid ${label}: "${input}". Pass a path inside the project (repo-root-relative, ` +
        `no "..", no absolute path outside the repo).`,
    );
  }
  return r;
}

/**
 * @param {string} name
 * @param {string} root
 * @param {Config} config
 * @param {typeof join} [pathJoin] injectable path.join (default native) so the
 *   Store line's separator can be exercised under win32 rules on any host.
 * @returns {string}
 */
export function projectInfo(name, root, config, pathJoin = join) {
  const graphSize = listMetaSources(root).length;
  const hasConfig = config.source.length > 0 || config.test.file || config.test.all;
  return (
    `Project: ${name}\n` +
    `Root: ${root}\n` +
    `Store: ${pathJoin(root, ".graphyne")}\n` +
    `Meta files (graph nodes): ${graphSize}\n` +
    `Config: ${hasConfig ? ".graphyne/config.json loaded" : "no .graphyne/config.json (TDD gate inactive)"}\n` +
    `  source: ${config.source.join(", ") || "(none)"}\n` +
    `  tests:  ${config.tests.join(", ") || "(none)"}\n` +
    `  test.file: ${config.test.file ?? "(unset)"} | test.all: ${config.test.all ?? "(unset)"}`
  );
}

/**
 * @param {string} root
 * @param {{ path: string }} input
 * @returns {string}
 */
export function showNeighbors(root, input) {
  const path = rel(root, input.path, "path");
  const edges = neighbors(root, path);
  if (edges.length === 0) return `${path} has no related files recorded yet. Add some with graphyne_link.`;
  const body = edges
    .map((e) => `  - ${e.path}${e.tags.length ? ` [${e.tags.join(", ")}]` : ""}`)
    .join("\n");
  return `${path} is related to ${edges.length} file(s):\n${body}`;
}

/**
 * @param {string} root
 * @param {{ path: string, related: string, tags?: string[] }} input
 * @returns {string}
 */
export function link(root, input) {
  const a = rel(root, input.path, "path");
  const b = rel(root, input.related, "related");
  if (a === b) throw new ToolError("A file cannot be linked to itself.");
  const edge = linkFiles(root, a, b, input.tags ?? []);
  const tagTxt = edge.tags.length ? ` [${edge.tags.join(", ")}]` : " (no tags)";
  return `Linked ${a} <-> ${b}${tagTxt}. Both meta files updated.`;
}

/**
 * @param {string} root
 * @param {{ path: string, related: string }} input
 * @returns {string}
 */
export function unlink(root, input) {
  const a = rel(root, input.path, "path");
  const b = rel(root, input.related, "related");
  const removed = unlinkFiles(root, a, b);
  return removed ? `Unlinked ${a} <-> ${b} (both sides).` : `No edge between ${a} and ${b}.`;
}

/**
 * Forget a file DELETED from disk this session: prune its (orphan) meta and the
 * reciprocal edges in its neighbors, and drop it from the session's edited set so it
 * stops blocking Stop. GUARDED — refuses if the file still EXISTS on disk: this is
 * cleanup for a real deletion, not a way to skip the missing-meta gate. Delete the
 * file first, then forget it.
 * @param {string} root
 * @param {string} sessionId
 * @param {{ path: string }} input
 * @returns {string}
 */
export function forget(root, sessionId, input) {
  const path = rel(root, input.path, "path");
  if (existsSync(join(root, path))) {
    throw new ToolError(
      `${path} still exists on disk — graphyne_forget is for files you have DELETED. ` +
        `Delete the file first, or reconcile its meta normally (graphyne_link/graphyne_meta_confirm).`,
    );
  }
  const pruned = forgetFile(root, path);
  const wasTracked = removeEdited(root, sessionId, path);
  const edgeTxt =
    pruned.length > 0
      ? ` Pruned its edge(s) from ${pruned.length} neighbor(s): ${pruned.join(", ")}.`
      : "";
  if (!wasTracked && pruned.length === 0) {
    return `Nothing to forget for ${path}: it isn't tracked this session and has no meta.`;
  }
  return `Forgot ${path}: removed its (orphan) meta and dropped it from this session's edited set.${edgeTxt} It no longer blocks Stop.`;
}

/**
 * @param {string} root
 * @param {Config} config
 * @param {string} sessionId
 * @param {{ test?: string, all?: boolean }} input
 * @param {string} now
 * @returns {string}
 */
export function runTests(root, config, sessionId, input, now) {
  if (input.all) {
    const cmd = testAllCommand(config);
    if (!cmd) throw new ToolError('No "test.all" command in .graphyne/config.json. Add one, or pass a specific `test` file.');
    const run = runTest(root, cmd, { timeoutMs: config.test.timeoutMs });
    const verdict = run.exitCode === 0 ? "GREEN (exit 0)" : `RED (exit ${run.exitCode})`;
    return (
      `$ ${run.command}\n[${verdict}] — full suite; per-file TDD state NOT recorded (run a specific ` +
      `\`test\` to drive the gate).\n\n${run.output}`
    );
  }

  if (!input.test) throw new ToolError("Provide a `test` file to run, or set `all: true` for the whole suite.");
  const test = rel(root, input.test, "test");
  if (!isTestFile(config, test)) {
    // Not fatal — the agent may have unusual layout — but flag it: the gate keys
    // off test files, so a non-test path won't unblock a source edit.
  }
  const cmd = testFileCommand(config, test);
  if (!cmd) throw new ToolError('No "test.file" command in .graphyne/config.json (e.g. "npm test -- {test}"). Add one to run a single test.');

  const run = runTest(root, cmd, { timeoutMs: config.test.timeoutMs });
  /** @type {TestResult} */
  const result = run.exitCode === 0 ? "green" : "red";
  recordTest(root, sessionId, test, result, now);
  const verdict = result === "green" ? "GREEN (exit 0)" : `RED (exit ${run.exitCode})`;
  const note =
    result === "red"
      ? "Recorded RED — you may now edit the source it covers (write code to make it pass)."
      : "Recorded GREEN — if it was previously RED this session, the covered source stays editable for refactoring.";
  return `$ ${run.command}\n[${verdict}] for ${test}. ${note}\n\n${run.output}`;
}

/**
 * Open a delete-only refactor grant for a gated source file. Verifies the green
 * safety net first (the file's covering tests, or the whole suite when it has none)
 * and only then records the grant; a red oracle is DENIED — that's a behavior signal
 * for the normal red-first loop, not a structural deletion. While the grant is open
 * the TDD gate admits PURE DELETIONS of this file; adds/modifications still need a
 * failing test. The green-after guarantee is enforced at Stop.
 * @param {string} root
 * @param {Config} config
 * @param {string} sessionId
 * @param {{ path: string, reason: string }} input
 * @param {string} now
 * @returns {string}
 */
export function refactor(root, config, sessionId, input, now) {
  const path = rel(root, input.path, "path");
  if (!isGatedSource(config, path)) {
    return `${path} is not gated source — it needs no refactor grant; edit it directly.`;
  }
  const reason = input.reason?.trim();
  if (!reason) {
    throw new ToolError(
      "Provide a `reason` for the refactor grant — what dead/structural code you're removing.",
    );
  }

  const covering = coveringTests(root, config, path);
  if (covering.length > 0) {
    /** @type {string[]} */
    const outputs = [];
    /** @type {string[]} */
    const reds = [];
    for (const t of covering) {
      const cmd = testFileCommand(config, t);
      if (!cmd) throw new ToolError('No "test.file" command in .graphyne/config.json (e.g. "node --test {test}").');
      const run = runTest(root, cmd, { timeoutMs: config.test.timeoutMs });
      /** @type {TestResult} */
      const result = run.exitCode === 0 ? "green" : "red";
      recordTest(root, sessionId, t, result, now);
      outputs.push(`$ ${run.command}\n[${result === "green" ? "GREEN" : `RED (exit ${run.exitCode})`}] ${t}`);
      if (result === "red") reds.push(t);
    }
    if (reds.length > 0) {
      return (
        `Refactor grant DENIED for ${path}: covering test(s) RED: ${reds.join(", ")}. ` +
        `A red test is a behavior signal — drive it through the normal red->green loop, not a ` +
        `delete-only grant.\n\n${outputs.join("\n")}`
      );
    }
    recordGrant(root, sessionId, path, "covering", reason, now);
    return (
      `Delete-only refactor grant OPEN for ${path} (covering tests green): "${reason}". ` +
      `Only PURE DELETIONS are admitted now — any add/modify still needs a failing test first. ` +
      `The covering tests must stay green (they guard Stop).\n\n${outputs.join("\n")}`
    );
  }

  const cmd = testAllCommand(config);
  if (!cmd) {
    throw new ToolError(
      `${path} has no covering test and .graphyne/config.json has no "test.all" command. Declare a covering ` +
        `test edge (graphyne_link tags ["test"]) or add a test.all command to verify a green suite.`,
    );
  }
  const run = runTest(root, cmd, { timeoutMs: config.test.timeoutMs });
  if (run.exitCode !== 0) {
    return (
      `Refactor grant DENIED for ${path}: the full suite is RED (exit ${run.exitCode}). A delete-only ` +
      `grant requires a green suite as the safety net — fix it first.\n\n$ ${run.command}\n\n${run.output}`
    );
  }
  recordGrant(root, sessionId, path, "all", reason, now);
  return (
    `Delete-only refactor grant OPEN for ${path} (full suite green; no covering test): "${reason}". ` +
    `Only PURE DELETIONS are admitted. After deleting, re-run graphyne_refactor to re-verify the suite ` +
    `stays green — an edit leaves the grant unverified (and blocks Stop) until you do.\n\n$ ${run.command} -> GREEN`
  );
}

/**
 * Open a SELF-ATTESTED bypass grant for one or more gated source files — the weakest
 * grant. Unlike the structural delete-only grant, it admits ANY edit to a granted file;
 * there is NO check that the edit is behavior-preserving beyond the agent's per-file
 * `reason`. Its only mechanical guards are green-before (verified here: every declared
 * covering test is run and must be green — all-or-nothing across all files) and
 * green-after (enforced at Stop via unverifiedBypass: an edited file's declared tests
 * must be re-run green). Use it only for behavior-preserving refactors a failing test
 * can't drive; for new/changed behavior, go red-first.
 * @param {string} root
 * @param {Config} config
 * @param {string} sessionId
 * @param {{ files: { path: string, tests: string[], reason: string }[] }} input
 * @param {string} now
 * @returns {string}
 */
export function bypass(root, config, sessionId, input, now) {
  if (!input.files || input.files.length === 0) {
    throw new ToolError(
      "Provide at least one file to bypass-edit — each with the covering tests that pin it and a reason.",
    );
  }

  // Resolve and validate EVERY file (gated source, a reason, ≥1 runnable covering test)
  // before running anything — a bad request opens no grant and runs no tests.
  /** @typedef {{ path: string, tests: string[], reason: string }} Entry */
  /** @type {Entry[]} */
  const entries = [];
  for (const f of input.files) {
    const path = rel(root, f.path, "path");
    if (!isGatedSource(config, path)) {
      throw new ToolError(`${path} is not gated source — it needs no bypass; edit it directly.`);
    }
    const reason = f.reason?.trim();
    if (!reason) {
      throw new ToolError(
        `Provide a \`reason\` for bypassing the gate on ${path} — why this edit is behavior-preserving ` +
          `and can't be driven red-first. Articulating it is the point: justify it, or catch yourself.`,
      );
    }
    if (!f.tests || f.tests.length === 0) {
      throw new ToolError(
        `Declare at least one covering test for ${path} — the test(s) that pin the code you're refactoring ` +
          `(they're the green-before/green-after safety net).`,
      );
    }
    const tests = f.tests.map((t) => rel(root, t, "test"));
    for (const t of tests) {
      if (!testFileCommand(config, t)) {
        throw new ToolError('No "test.file" command in .graphyne/config.json (e.g. "node --test {test}") — cannot run the declared tests.');
      }
    }
    entries.push({ path, tests, reason });
  }

  // green-before: run every declared test once (deduped across files). ALL must be green
  // — a bypass needs a green safety net before AND after; one red denies the whole batch.
  const allTests = [...new Set(entries.flatMap((e) => e.tests))];
  /** @type {string[]} */
  const outputs = [];
  /** @type {string[]} */
  const reds = [];
  for (const t of allTests) {
    const cmd = /** @type {string} */ (testFileCommand(config, t));
    const run = runTest(root, cmd, { timeoutMs: config.test.timeoutMs });
    /** @type {TestResult} */
    const result = run.exitCode === 0 ? "green" : "red";
    recordTest(root, sessionId, t, result, now);
    outputs.push(`$ ${run.command}\n[${result === "green" ? "GREEN" : `RED (exit ${run.exitCode})`}] ${t}`);
    if (result === "red") reds.push(t);
  }
  if (reds.length > 0) {
    return (
      `Bypass DENIED (opens nothing): declared test(s) RED: ${reds.join(", ")}. A self-attested bypass ` +
      `requires a GREEN safety net before and after — fix these first, or drive the change red-first.\n\n` +
      outputs.join("\n")
    );
  }

  // All green -> open a per-file bypass grant.
  for (const e of entries) recordBypassGrant(root, sessionId, e.path, e.tests, e.reason, now);
  const list = entries.map((e) => `  - ${e.path}  (tests: ${e.tests.join(", ")})  — "${e.reason}"`).join("\n");
  return (
    `Self-attested BYPASS window OPEN for ${entries.length} file(s) (declared tests green):\n${list}\n\n` +
    `This is the WEAKEST grant — weaker than red-first AND than delete-only. The gate now admits ANY edit ` +
    `to these files; NOTHING checks your edit is safe beyond your own attestation, so keep it to ` +
    `behavior-preserving refactors (no new/changed behavior — that needs a failing test). After editing, ` +
    `re-run each file's declared tests via graphyne_test: they must be green again or Stop is blocked.\n\n` +
    outputs.join("\n")
  );
}

/**
 * @param {string} root
 * @param {Config} config
 * @param {string} sessionId
 * @returns {string}
 */
export function checklist(root, config, sessionId) {
  const { missingMeta, unresolved, metaDirty, redTests, staleGrants, unverifiedBypass, deletedWithMeta } = stopBlockers(root, config, sessionId);
  const all = readChecklist(root, sessionId);
  const resolved = all.filter(isResolved).length;

  /** @type {string[]} */
  const lines = [];
  // The mute banner is the cheapest cross-check that /graphyne:off round-trips
  // between the hook and this server: without it the checklist would imply a
  // gate that will not actually fire.
  if (readMute(root, sessionId)) {
    lines.push(
      `NOTE: Graphyne enforcement is MUTED for this session (/graphyne:on re-enables); ` +
        `items below are informational — nothing blocks while muted.\n`,
    );
  }
  lines.push(`Checklist: ${unresolved.length} open, ${resolved} resolved.`);
  if (unresolved.length > 0) {
    lines.push("\nOPEN — edit each, or mark reviewed (graphyne_review) if no change is needed:");
    for (const i of unresolved) {
      const tags = i.tags ?? [];
      const tagTxt = tags.length ? ` [${tags.join(", ")}]` : "";
      lines.push(`  - ${i.path}${tagTxt}  (related to: ${i.reasons.join(", ")})`);
      if (i.hard) {
        const kind = tags.includes("spec") ? "spec" : "doc";
        lines.push(
          `      ${kind.toUpperCase()}: a bare review won't clear this — edit ${i.path} to actualize it, ` +
            `or graphyne_review it WITH a reason explaining why no change is needed.`,
        );
      }
    }
  }
  if (missingMeta.length > 0) {
    lines.push("\nEDITED FILES MISSING META — declare their links with graphyne_link (or graphyne_link to nothing if truly standalone):");
    for (const m of missingMeta) lines.push(`  - ${m}`);
  }
  if (metaDirty.length > 0) {
    lines.push("\nEDITED FILES PENDING META CONFIRMATION — review each file's relations (graphyne_link any new/changed edges), then graphyne_meta_confirm (an empty confirm is fine if nothing changed):");
    for (const m of metaDirty) lines.push(`  - ${m}`);
  }
  if (redTests.length > 0) {
    lines.push("\nCOVERING TESTS STILL RED — for source you edited this session; fix the code or the test, then re-run graphyne_test to go green:");
    for (const t of redTests) lines.push(`  - ${t}`);
  }
  if (staleGrants.length > 0) {
    lines.push("\nDELETE-ONLY REFACTOR GRANTS AWAITING RE-VERIFICATION — you deleted under an all-suite grant; re-run graphyne_refactor to confirm the suite is still green:");
    for (const g of staleGrants) lines.push(`  - ${g}`);
  }
  if (unverifiedBypass.length > 0) {
    lines.push("\nSELF-ATTESTED BYPASS WINDOWS AWAITING GREEN-AFTER — you edited these under a bypass grant; re-run their declared covering tests via graphyne_test to confirm they're still green:");
    for (const g of unverifiedBypass) lines.push(`  - ${g}`);
  }
  if (deletedWithMeta.length > 0) {
    lines.push("\nEDITED FILES DELETED FROM DISK BUT META LINGERS — the source is gone yet its meta + neighbor edges remain as orphan graph cruft; prune each with graphyne_forget:");
    for (const m of deletedWithMeta) lines.push(`  - ${m}`);
  }
  if (
    unresolved.length === 0 &&
    missingMeta.length === 0 &&
    metaDirty.length === 0 &&
    redTests.length === 0 &&
    staleGrants.length === 0 &&
    unverifiedBypass.length === 0 &&
    deletedWithMeta.length === 0
  ) {
    lines.push("\nNothing outstanding — Stop will not be blocked.");
  }
  return lines.join("\n");
}

/**
 * @param {string} root
 * @param {string} sessionId
 * @param {{ path: string, reason?: string }} input
 * @param {string} [platform] Injectable for tests; folds the checklist path case on case-insensitive platforms.
 * @returns {string}
 */
export function review(root, sessionId, input, platform) {
  const path = rel(root, input.path, "path");
  const ok = markReviewed(root, sessionId, path, input.reason, platform);
  if (!ok) return `No checklist item for ${path}. Nothing to review.`;
  // Re-find case-folded to match markReviewed's own fold: on a case-insensitive FS
  // a HARD item reviewed under a variant spelling must still be found here, or it
  // falls through to a false "resolved" and the corrective nudge is suppressed.
  const item = readChecklist(root, sessionId).find(
    (i) => foldPathCase(i.path, platform) === foldPathCase(path, platform),
  );
  if (item && !isResolved(item)) {
    // A HARD (doc/spec) relation: a bare review can't clear it.
    const kind = (item.tags ?? []).includes("spec") ? "spec" : "doc";
    const fix =
      kind === "spec"
        ? "bring the code into conformance (or update the spec)"
        : "update the doc to reflect the change";
    return (
      `${path} is a ${kind} relation — a bare review does NOT clear it (the ${kind} must stay in sync). ` +
      `Either edit ${path} to ${fix}, or call graphyne_review again with a \`reason\` explaining why no change is needed.`
    );
  }
  const note = input.reason?.trim() ? ` (reason: ${input.reason.trim()})` : "";
  return `Marked ${path} as reviewed (no change needed)${note}. Checklist item resolved.`;
}

/**
 * @param {string} root
 * @param {string} sessionId
 * @param {{ path: string }} input
 * @returns {string}
 */
export function metaConfirm(root, sessionId, input) {
  const path = rel(root, input.path, "path");
  const result = confirmMeta(root, sessionId, path);
  if (result === "not-edited") {
    return `${path} was not edited this session — nothing to confirm.`;
  }
  const tail = metaExists(root, path)
    ? "It no longer blocks Stop."
    : "Note: it still has no meta file — declare its links with graphyne_link, or it will block Stop.";
  return `Confirmed: relations for ${path} reviewed for its latest edit. ${tail}`;
}

/**
 * @param {string} root
 * @param {Config} config
 * @param {string} sessionId
 * @returns {string}
 */
export function status(root, config, sessionId) {
  const banner = readMute(root, sessionId)
    ? `NOTE: Graphyne enforcement is MUTED for this session (/graphyne:on re-enables) — ` +
      `the TDD gate is not denying edits.\n`
    : ``;
  const rows = editability(root, config, sessionId);
  if (rows.length === 0) return `${banner}No gated source files have been edited this session.`;
  const body = rows
    .map((r) => `  ${r.editable ? "editable " : "BLOCKED  "} ${r.rel}  — ${r.detail}`)
    .join("\n");
  return `${banner}TDD status (gated, edited files this session):\n${body}`;
}

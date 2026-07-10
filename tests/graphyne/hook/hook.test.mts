// End-to-end hook tests: spawn the real hook process with a JSON event on stdin
// (exactly as Claude Code invokes it) and assert its stdout decision.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { recordTest, confirmMeta, markReviewed, recordGrant, recordBypassGrant, readStopBlock } from "../../../plugins/graphyne/common/session.mjs";
import { linkFiles } from "../../../plugins/graphyne/common/graph-store.mjs";

/** Create `rel` on disk under `root` (parents included). The Stop gate drops files
 *  absent from disk, so a session-edited source must actually exist to carry its
 *  per-file obligations — mirror that in these end-to-end hook tests. */
function writeSrc(root: string, rel: string, content = ""): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

// The shipped hook entry point (the .mjs the plugin runs), not a dev-tree .mts.
const HOOK = fileURLToPath(new URL("../../../plugins/graphyne/hooks/hook.mjs", import.meta.url));

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "graphyne-hook-"));
  mkdirSync(join(root, ".graphyne"), { recursive: true });
  writeFileSync(
    join(root, ".graphyne", "config.json"),
    JSON.stringify({
      source: ["src/**/*.ts"],
      exclude: ["**/*.test.ts"],
      tests: ["**/*.test.ts"],
      metaExclude: ["**/*.md"],
      test: { file: "node --test {test}", all: "node --test" },
    }),
  );
  return root;
}

function runHook(event: string, root: string, payload: object): { out: string; code: number } {
  const input = JSON.stringify({ cwd: root, session_id: "hooktest", ...payload });
  const res = spawnSync("node", [HOOK, event], { input, encoding: "utf8", cwd: root });
  return { out: (res.stdout ?? "") + (res.stderr ?? ""), code: res.status ?? 0 };
}

function editPayload(root: string, relPath: string) {
  return { tool_name: "Edit", tool_input: { file_path: join(root, relPath) } };
}

test("PreToolUse denies a gated edit with no covering test", () => {
  const root = makeProject();
  try {
    const { out } = runHook("PreToolUse", root, editPayload(root, "src/foo.ts"));
    assert.match(out, /"permissionDecision":"deny"/);
    assert.match(out, /TDD gate/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PreToolUse allows a gated edit once its covering test is red", () => {
  const root = makeProject();
  try {
    linkFiles(root, "src/foo.ts", "test/foo.test.ts", ["test"]);
    recordTest(root, "hooktest", "test/foo.test.ts", "red", new Date().toISOString());
    const { out } = runHook("PreToolUse", root, editPayload(root, "src/foo.ts"));
    assert.doesNotMatch(out, /deny/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PreToolUse never gates a test file", () => {
  const root = makeProject();
  try {
    const { out } = runHook("PreToolUse", root, editPayload(root, "test/foo.test.ts"));
    assert.doesNotMatch(out, /deny/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const EARLY = "2020-01-01T00:00:00.000Z"; // a green verification well before any edit

test("PreToolUse admits a pure deletion under an open refactor grant", () => {
  const root = makeProject();
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/foo.ts"), "a\nb\nc\n");
    recordGrant(root, "hooktest", "src/foo.ts", "all", "remove dead line", EARLY);
    const { out } = runHook("PreToolUse", root, {
      tool_name: "Edit",
      tool_input: { file_path: join(root, "src/foo.ts"), old_string: "b\n", new_string: "" },
    });
    assert.doesNotMatch(out, /deny/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PreToolUse still denies a non-deletion edit under a refactor grant", () => {
  const root = makeProject();
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/foo.ts"), "a\nb\n");
    recordGrant(root, "hooktest", "src/foo.ts", "all", "dead", EARLY);
    const { out } = runHook("PreToolUse", root, {
      tool_name: "Edit",
      tool_input: { file_path: join(root, "src/foo.ts"), old_string: "a\n", new_string: "a\nNEW\n" },
    });
    assert.match(out, /"permissionDecision":"deny"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Stop blocks while an all-suite grant awaits re-verification after an edit", () => {
  const root = makeProject();
  try {
    recordGrant(root, "hooktest", "src/bar.ts", "all", "dead", EARLY);
    writeSrc(root, "src/bar.ts");
    runHook("PostToolUse", root, editPayload(root, "src/bar.ts")); // edited after the green verification
    const { out } = runHook("Stop", root, {});
    assert.match(out, /"decision":"block"/);
    assert.match(out, /re-verif|refactor grant/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PreToolUse admits a non-deletion edit under an open self-attested bypass grant", () => {
  const root = makeProject();
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/foo.ts"), "a\nb\n");
    recordBypassGrant(root, "hooktest", "src/foo.ts", ["test/foo.test.ts"], "behavior-preserving rename", EARLY);
    const { out } = runHook("PreToolUse", root, {
      tool_name: "Edit",
      tool_input: { file_path: join(root, "src/foo.ts"), old_string: "a\n", new_string: "a\nNEW\n" },
    });
    assert.doesNotMatch(out, /deny/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Stop blocks while a self-attested bypass window awaits green-after", () => {
  const root = makeProject();
  try {
    recordBypassGrant(root, "hooktest", "src/bar.ts", ["test/bar.test.ts"], "refactor", EARLY);
    writeSrc(root, "src/bar.ts");
    runHook("PostToolUse", root, editPayload(root, "src/bar.ts")); // edited after the grant opened
    const { out } = runHook("Stop", root, {});
    assert.match(out, /"decision":"block"/);
    assert.match(out, /bypass|green-after/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PostToolUse nudges when the edited file has no meta", () => {
  const root = makeProject();
  try {
    const { out } = runHook("PostToolUse", root, editPayload(root, "src/foo.ts"));
    assert.match(out, /no meta yet/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Stop blocks while an edited file lacks meta", () => {
  const root = makeProject();
  try {
    writeSrc(root, "src/foo.ts");
    runHook("PostToolUse", root, editPayload(root, "src/foo.ts")); // records edit, no meta
    const { out } = runHook("Stop", root, {});
    assert.match(out, /"decision":"block"/);
    assert.match(out, /missing a meta entry/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PostToolUse reminds to confirm meta after an edit", () => {
  const root = makeProject();
  try {
    const { out } = runHook("PostToolUse", root, editPayload(root, "src/foo.ts"));
    assert.match(out, /graphyne_meta_confirm/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Stop blocks an edited file until its meta is confirmed", () => {
  const root = makeProject();
  try {
    linkFiles(root, "src/foo.ts", "test/foo.test.ts", ["test"]); // foo gets a meta file
    writeSrc(root, "src/foo.ts");
    runHook("PostToolUse", root, editPayload(root, "src/foo.ts")); // edited; meta exists -> meta-dirty
    let out = runHook("Stop", root, {}).out;
    assert.match(out, /"decision":"block"/);
    assert.match(out, /confirm/i);

    confirmMeta(root, "hooktest", "src/foo.ts");
    markReviewed(root, "hooktest", "test/foo.test.ts"); // also clear the flagged neighbor
    out = runHook("Stop", root, {}).out;
    assert.equal(out.trim(), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Stop blocks while a covering test for an edited file is red", () => {
  const root = makeProject();
  try {
    linkFiles(root, "src/foo.ts", "test/foo.test.ts", ["test"]); // foo gets meta + test edge
    recordTest(root, "hooktest", "test/foo.test.ts", "red", new Date().toISOString());
    writeSrc(root, "src/foo.ts");
    runHook("PostToolUse", root, editPayload(root, "src/foo.ts")); // record the edit
    // Clear the unrelated blockers so only the red covering test remains.
    confirmMeta(root, "hooktest", "src/foo.ts");
    markReviewed(root, "hooktest", "test/foo.test.ts");

    let out = runHook("Stop", root, {}).out;
    assert.match(out, /"decision":"block"/);
    assert.match(out, /red/i);
    assert.match(out, /test\/foo\.test\.ts/);

    // Going green clears it.
    recordTest(root, "hooktest", "test/foo.test.ts", "green", new Date().toISOString());
    out = runHook("Stop", root, {}).out;
    assert.equal(out.trim(), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Stop does NOT block a throwaway file created then deleted (no meta)", () => {
  const root = makeProject();
  try {
    writeSrc(root, "src/probe.ts");
    runHook("PostToolUse", root, editPayload(root, "src/probe.ts")); // records the edit; no meta
    rmSync(join(root, "src/probe.ts"), { force: true }); // rm'd after use
    const { out } = runHook("Stop", root, {});
    assert.equal(out.trim(), ""); // gone from disk + no meta -> nothing to clean up
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Stop blocks a deleted file whose meta lingers, pointing at graphyne_forget", () => {
  const root = makeProject();
  try {
    linkFiles(root, "src/foo.ts", "src/bar.ts", ["consumer"]); // foo gets a meta + edge
    writeSrc(root, "src/foo.ts");
    runHook("PostToolUse", root, editPayload(root, "src/foo.ts")); // record the edit
    rmSync(join(root, "src/foo.ts"), { force: true }); // deleted, but its meta lingers
    const { out } = runHook("Stop", root, {});
    assert.match(out, /"decision":"block"/);
    assert.match(out, /graphyne_forget/);
    assert.match(out, /src\/foo\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Stop does not block a clean session", () => {
  const root = makeProject();
  try {
    const { out } = runHook("Stop", root, {});
    assert.equal(out.trim(), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// #region stop_hook_active — loop protection (new suite, Omnium-only)
// The harness sets stop_hook_active when the stop is already a continuation
// caused by a prior stop-hook block — by ANY stop hook, the flag is
// turn-global. Blocking again forever risks a long loop (the harness only
// force-overrides after 8 no-progress blocks), so the gate waives with a
// user-visible warning instead — but only once THIS gate (same event, same
// agent) has blocked in the current stop chain (its own recorded block,
// cleared by the next user prompt) AND the outstanding count is unchanged
// since that block: shrinking (progress) and growing (new work) both
// re-block, so another gate's block never disarms this one and multi-stop
// convergence keeps its pressure.

/** Arm the cheapest Stop blocker: an edited source file with no meta entry. */
function armMissingMetaBlocker(root: string, rel = "src/foo.ts"): void {
  writeSrc(root, rel);
  runHook("PostToolUse", root, editPayload(root, rel));
}

test("Stop with stop_hook_active still blocks when the gate has not yet blocked this chain", () => {
  const root = makeProject();
  try {
    armMissingMetaBlocker(root);
    const { out } = runHook("Stop", root, { stop_hook_active: true });
    assert.match(out, /"decision":"block"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Stop waives with a warning on a flagged repeat with no progress", () => {
  const root = makeProject();
  try {
    armMissingMetaBlocker(root);
    assert.match(runHook("Stop", root, {}).out, /"decision":"block"/); // arms the gate's own marker
    const { out } = runHook("Stop", root, { stop_hook_active: true });
    assert.doesNotMatch(out, /"decision":"block"/);
    assert.match(out, /"systemMessage"/);
    assert.match(out, /stop_hook_active/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the string form "true" of stop_hook_active also waives after a prior block', () => {
  const root = makeProject();
  try {
    armMissingMetaBlocker(root);
    runHook("Stop", root, {});
    const { out } = runHook("Stop", root, { stop_hook_active: "true" });
    assert.doesNotMatch(out, /"decision":"block"/);
    assert.match(out, /"systemMessage"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a flagged repeat still blocks while the agent is making progress", () => {
  const root = makeProject();
  try {
    armMissingMetaBlocker(root, "src/foo.ts");
    armMissingMetaBlocker(root, "src/bar.ts");
    assert.match(runHook("Stop", root, {}).out, /"decision":"block"/); // 2 outstanding
    rmSync(join(root, "src/bar.ts"), { force: true }); // deleted + no meta -> drops from the gate
    const progress = runHook("Stop", root, { stop_hook_active: true });
    assert.match(progress.out, /"decision":"block"/); // 1 < 2: converging, keep the pressure
    const stalled = runHook("Stop", root, { stop_hook_active: true });
    assert.doesNotMatch(stalled.out, /"decision":"block"/); // 1 >= 1: no progress, waive
    assert.match(stalled.out, /"systemMessage"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("growing obligations still block on a flagged repeat", () => {
  const root = makeProject();
  try {
    armMissingMetaBlocker(root, "src/foo.ts");
    assert.match(runHook("Stop", root, {}).out, /"decision":"block"/); // 1 outstanding
    armMissingMetaBlocker(root, "src/bar.ts"); // new work -> 2 outstanding
    const grown = runHook("Stop", root, { stop_hook_active: true });
    assert.match(grown.out, /"decision":"block"/); // 2 !== 1: new edits deserve their block
    const stalled = runHook("Stop", root, { stop_hook_active: true });
    assert.doesNotMatch(stalled.out, /"decision":"block"/); // 2 === 2: stalled, waive
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a SubagentStop block does not arm the Stop gate's waiver", () => {
  const root = makeProject();
  try {
    armMissingMetaBlocker(root);
    assert.match(runHook("SubagentStop", root, {}).out, /"decision":"block"/);
    const { out } = runHook("Stop", root, { stop_hook_active: true });
    assert.match(out, /"decision":"block"/); // the Stop gate itself never blocked this chain
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a new user prompt re-arms the waived gate", () => {
  const root = makeProject();
  try {
    armMissingMetaBlocker(root);
    runHook("Stop", root, {});
    runHook("UserPromptSubmit", root, { prompt: "carry on" }); // a prompt starts a new stop chain
    const { out } = runHook("Stop", root, { stop_hook_active: true });
    assert.match(out, /"decision":"block"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unrecognized truthy flag value still blocks", () => {
  const root = makeProject();
  try {
    armMissingMetaBlocker(root);
    runHook("Stop", root, {});
    const { out } = runHook("Stop", root, { stop_hook_active: "yes" });
    assert.match(out, /"decision":"block"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Stop with stop_hook_active false still blocks", () => {
  const root = makeProject();
  try {
    armMissingMetaBlocker(root);
    runHook("Stop", root, {});
    const { out } = runHook("Stop", root, { stop_hook_active: false });
    assert.match(out, /"decision":"block"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Stop with stop_hook_active stays silent on a clean session", () => {
  const root = makeProject();
  try {
    const { out } = runHook("Stop", root, { stop_hook_active: true });
    assert.equal(out.trim(), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SubagentStop blocks outstanding obligations", () => {
  const root = makeProject();
  try {
    armMissingMetaBlocker(root);
    const { out } = runHook("SubagentStop", root, {});
    assert.match(out, /"decision":"block"/);
    assert.match(out, /SubagentStop/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SubagentStop waives on a flagged repeat after its own block", () => {
  const root = makeProject();
  try {
    armMissingMetaBlocker(root);
    runHook("SubagentStop", root, {});
    const { out } = runHook("SubagentStop", root, { stop_hook_active: true });
    assert.doesNotMatch(out, /"decision":"block"/);
    assert.match(out, /"systemMessage"/);
    assert.match(out, /SubagentStop/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// #endregion stop_hook_active

// #region SubagentStop scoping — per-agent obligation slice
// A subagent (payload carries agent_id) is gated ONLY on the obligations its own
// edits incurred: a read-only subagent passes silently (no block, no waive turn,
// no chain marker), an editing one keeps full pressure on its own footprint, and
// the main Stop gate stays session-wide as the backstop. A SubagentStop payload
// WITHOUT agent_id (legacy harness) keeps the full-session gate — pinned by the
// SubagentStop tests above.

test("SubagentStop passes silently for a subagent that edited nothing", () => {
  const root = makeProject();
  try {
    armMissingMetaBlocker(root); // main's obligation (PostToolUse without agent_id)
    const { out } = runHook("SubagentStop", root, { agent_id: "a1" });
    assert.equal(out.trim(), ""); // no block AND no wasted block+waive cycle
    assert.equal(readStopBlock(root, "hooktest", "SubagentStop", "a1"), null); // no chain marker written either
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a silent SubagentStop pass leaves the main Stop gate's chain marker intact", () => {
  const root = makeProject();
  try {
    armMissingMetaBlocker(root);
    runHook("Stop", root, {}); // main blocks -> arms its own marker
    assert.equal(runHook("SubagentStop", root, { agent_id: "a1" }).out.trim(), ""); // read-only subagent
    const { out } = runHook("Stop", root, { stop_hook_active: true });
    assert.doesNotMatch(out, /"decision":"block"/); // main's waive still fires: its marker survived
    assert.match(out, /"systemMessage"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a SubagentStop block with agent_id does not arm the Stop gate's waiver", () => {
  const root = makeProject();
  try {
    writeSrc(root, "src/foo.ts");
    runHook("PostToolUse", root, { ...editPayload(root, "src/foo.ts"), agent_id: "a1" });
    assert.match(runHook("SubagentStop", root, { agent_id: "a1" }).out, /"decision":"block"/);
    const { out } = runHook("Stop", root, { stop_hook_active: true });
    assert.match(out, /"decision":"block"/); // the Stop gate itself never blocked this chain
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two editing subagents waive independently (no marker ping-pong)", () => {
  const root = makeProject();
  try {
    writeSrc(root, "src/one.ts");
    writeSrc(root, "src/two.ts");
    runHook("PostToolUse", root, { ...editPayload(root, "src/one.ts"), agent_id: "a1" });
    runHook("PostToolUse", root, { ...editPayload(root, "src/two.ts"), agent_id: "a2" });
    assert.match(runHook("SubagentStop", root, { agent_id: "a1" }).out, /"decision":"block"/);
    assert.match(runHook("SubagentStop", root, { agent_id: "a2" }).out, /"decision":"block"/); // a2's own first block
    // Each agent's flagged retry finds ITS OWN marker despite the other's block in between.
    const w1 = runHook("SubagentStop", root, { agent_id: "a1", stop_hook_active: true });
    assert.doesNotMatch(w1.out, /"decision":"block"/);
    assert.match(w1.out, /"systemMessage"/);
    const w2 = runHook("SubagentStop", root, { agent_id: "a2", stop_hook_active: true });
    assert.doesNotMatch(w2.out, /"decision":"block"/);
    assert.match(w2.out, /"systemMessage"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a SubagentStop block tells a tool-less subagent to hand the files off instead", () => {
  const root = makeProject();
  try {
    writeSrc(root, "src/foo.ts");
    runHook("PostToolUse", root, { ...editPayload(root, "src/foo.ts"), agent_id: "a1" });
    const { out } = runHook("SubagentStop", root, { agent_id: "a1" });
    assert.match(out, /"decision":"block"/);
    assert.match(out, /final (report|message)|hand.*off|caller/i); // MCP-less fallback path
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SubagentStop gates a subagent on its own edits", () => {
  const root = makeProject();
  try {
    writeSrc(root, "src/foo.ts");
    runHook("PostToolUse", root, { ...editPayload(root, "src/foo.ts"), agent_id: "a1" });
    assert.match(runHook("SubagentStop", root, { agent_id: "a1" }).out, /"decision":"block"/);
    assert.equal(runHook("SubagentStop", root, { agent_id: "a2" }).out.trim(), ""); // not a2's problem
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the main Stop gate still backstops a subagent's obligations", () => {
  const root = makeProject();
  try {
    writeSrc(root, "src/foo.ts");
    runHook("PostToolUse", root, { ...editPayload(root, "src/foo.ts"), agent_id: "a1" });
    const { out } = runHook("Stop", root, {}); // session-wide: the parent inherits the cleanup
    assert.match(out, /"decision":"block"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an editing subagent keeps the per-agent stop_hook_active waive", () => {
  const root = makeProject();
  try {
    writeSrc(root, "src/foo.ts");
    runHook("PostToolUse", root, { ...editPayload(root, "src/foo.ts"), agent_id: "a1" });
    assert.match(runHook("SubagentStop", root, { agent_id: "a1" }).out, /"decision":"block"/);
    const { out } = runHook("SubagentStop", root, { agent_id: "a1", stop_hook_active: true });
    assert.doesNotMatch(out, /"decision":"block"/);
    assert.match(out, /"systemMessage"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// #endregion SubagentStop scoping

// #region /graphyne:off|on|status — session mute (gate recovery)
// The recovery path for a dead/unregistered MCP server: hook-handled toggles
// (UserPromptSubmit fires only on a real user prompt, so the model cannot
// fabricate them) that MUTE — not clear — enforcement for the session. While
// muted: PreToolUse stops denying, Stop/SubagentStop warn instead of blocking
// (and write no chain marker), edits keep being recorded so /graphyne:on
// restores the true obligation set.

function mute(root: string) {
  return runHook("UserPromptSubmit", root, { prompt: "/graphyne:off" });
}

test("/graphyne:off mutes enforcement and erases the prompt", () => {
  const root = makeProject();
  try {
    armMissingMetaBlocker(root);
    const off = mute(root);
    assert.match(off.out, /"decision":"block"/);
    assert.match(off.out, /muted/i);
    const stop = runHook("Stop", root, {});
    assert.doesNotMatch(stop.out, /"decision":"block"/);
    assert.match(stop.out, /"systemMessage"/);
    assert.match(stop.out, /muted/i);
    assert.equal(readStopBlock(root, "hooktest", "Stop", "main"), null); // no chain marker while muted
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("/graphyne:on unmutes: the Stop gate blocks again", () => {
  const root = makeProject();
  try {
    armMissingMetaBlocker(root);
    mute(root);
    const on = runHook("UserPromptSubmit", root, { prompt: "/graphyne:on" });
    assert.match(on.out, /"decision":"block"/);
    assert.match(on.out, /re-?enabled|active/i);
    assert.match(runHook("Stop", root, {}).out, /"decision":"block"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("/graphyne:status reports the mute without changing it", () => {
  const root = makeProject();
  try {
    armMissingMetaBlocker(root);
    mute(root);
    const st = runHook("UserPromptSubmit", root, { prompt: "/graphyne:status" });
    assert.match(st.out, /"decision":"block"/);
    assert.match(st.out, /muted/i);
    const stop = runHook("Stop", root, {}); // still muted afterwards
    assert.doesNotMatch(stop.out, /"decision":"block"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("/graphyne:status reports active enforcement when not muted", () => {
  const root = makeProject();
  try {
    const st = runHook("UserPromptSubmit", root, { prompt: "/graphyne:status" });
    assert.match(st.out, /"decision":"block"/);
    assert.match(st.out, /active/i);
    assert.doesNotMatch(st.out, /is MUTED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("muted PreToolUse does not deny a gated edit", () => {
  const root = makeProject();
  try {
    mute(root);
    const { out } = runHook("PreToolUse", root, editPayload(root, "src/foo.ts"));
    assert.doesNotMatch(out, /deny/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("muted SubagentStop warns instead of blocking", () => {
  const root = makeProject();
  try {
    writeSrc(root, "src/foo.ts");
    runHook("PostToolUse", root, { ...editPayload(root, "src/foo.ts"), agent_id: "a1" });
    mute(root);
    const { out } = runHook("SubagentStop", root, { agent_id: "a1" });
    assert.doesNotMatch(out, /"decision":"block"/);
    assert.match(out, /"systemMessage"/);
    assert.match(out, /muted/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a muted session keeps recording edits (nudges suppressed, obligations kept)", () => {
  const root = makeProject();
  try {
    mute(root);
    writeSrc(root, "src/foo.ts");
    const post = runHook("PostToolUse", root, editPayload(root, "src/foo.ts"));
    assert.equal(post.out.trim(), ""); // no nudge while muted
    runHook("UserPromptSubmit", root, { prompt: "/graphyne:on" });
    assert.match(runHook("Stop", root, {}).out, /"decision":"block"/); // the edit WAS recorded
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("/graphyne:off twice reports already muted and keeps the original timestamp", () => {
  const root = makeProject();
  try {
    mute(root);
    const again = mute(root);
    assert.match(again.out, /"decision":"block"/);
    assert.match(again.out, /already muted/i);
    const stop = runHook("Stop", root, {}); // still muted, of course
    assert.doesNotMatch(stop.out, /"decision":"block"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("/graphyne:on when not muted reports enforcement is already active", () => {
  const root = makeProject();
  try {
    const on = runHook("UserPromptSubmit", root, { prompt: "/graphyne:on" });
    assert.match(on.out, /"decision":"block"/);
    assert.match(on.out, /already active/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("muted Bash test-run nudge is suppressed", () => {
  const root = makeProject();
  try {
    mute(root);
    const { out } = runHook("PostToolUse", root, {
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });
    assert.equal(out.trim(), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("/graphyne:status shows the mute start time and a per-class breakdown", () => {
  const root = makeProject();
  try {
    armMissingMetaBlocker(root);
    mute(root);
    const st = runHook("UserPromptSubmit", root, { prompt: "/graphyne:status" });
    assert.match(st.out, /since \d{4}-/); // the mute.at timestamp
    assert.match(st.out, /missing meta/i); // class-level view, usable with MCP down
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a sentence merely mentioning /graphyne:off is not swallowed and does not mute", () => {
  const root = makeProject();
  try {
    armMissingMetaBlocker(root);
    const { out } = runHook("UserPromptSubmit", root, { prompt: "explain what /graphyne:off does" });
    assert.equal(out.trim(), "");
    assert.match(runHook("Stop", root, {}).out, /"decision":"block"/); // still enforcing
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the mute toggles stay dormant on an unadopted project", () => {
  const bare = mkdtempSync(join(tmpdir(), "graphyne-bare-mute-"));
  try {
    const { out } = runHook("UserPromptSubmit", bare, { prompt: "/graphyne:off" });
    assert.equal(out.trim(), "");
    assert.ok(!existsSync(join(bare, ".graphyne")));
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test("SessionStart(resume) reminds about an active mute", () => {
  const root = makeProject();
  try {
    mute(root);
    const { out } = runHook("SessionStart", root, { source: "resume" });
    assert.match(out, /muted/i);
    assert.match(out, /graphyne:on/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SessionStart(compact) while muted mentions the mute instead of the reconcile drill", () => {
  const root = makeProject();
  try {
    armMissingMetaBlocker(root);
    mute(root);
    const { out } = runHook("SessionStart", root, { source: "compact" });
    assert.match(out, /muted/i);
    assert.doesNotMatch(out, /same turn/i); // the reconcile drill is for an armed gate
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// #endregion /graphyne:off|on|status

test("/graphyne:setup creates the store and erases the prompt on a bare dir", () => {
  const bare = mkdtempSync(join(tmpdir(), "graphyne-setup-"));
  try {
    const { out } = runHook("UserPromptSubmit", bare, { prompt: "/graphyne:setup" });
    assert.match(out, /"decision":"block"/);
    assert.match(out, /set up/i);
    assert.ok(existsSync(join(bare, ".graphyne", "meta")), "store skeleton was created");
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test("/graphyne:setup on an already-adopted project reports it is already set up", () => {
  const root = makeProject();
  try {
    const { out } = runHook("UserPromptSubmit", root, { prompt: "/graphyne:setup" });
    assert.match(out, /"decision":"block"/);
    assert.match(out, /already set up/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a non-setup UserPromptSubmit stays dormant on a bare dir (strict match)", () => {
  const bare = mkdtempSync(join(tmpdir(), "graphyne-bare-ups-"));
  try {
    // Embedded mention must NOT trigger adoption.
    const { out } = runHook("UserPromptSubmit", bare, { prompt: "please run /graphyne:setup for me" });
    assert.equal(out.trim(), "");
    assert.ok(!existsSync(join(bare, ".graphyne")), "no store created for a non-matching prompt");
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test("dormant when no .graphyne (different cwd)", () => {
  const bare = mkdtempSync(join(tmpdir(), "graphyne-bare-"));
  try {
    const { out } = runHook("PreToolUse", bare, editPayload(bare, "src/foo.ts"));
    assert.equal(out.trim(), "");
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

// #region SessionStart — onboarding + post-compaction reconcile
// The compact branch is gated on the same on-disk blockers as the Stop gate:
// silent when nothing is outstanding, a reconcile nudge (with the deferred-tool
// reload path, scoped to what the summary shows, yielding to a newer user prompt)
// when obligations survived the summary.

test("SessionStart(startup) emits the onboarding context", () => {
  const root = makeProject();
  try {
    const { out } = runHook("SessionStart", root, { source: "startup" });
    assert.match(out, /"hookEventName":"SessionStart"/);
    assert.match(out, /Graphyne is active/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SessionStart(compact) is silent when nothing is outstanding", () => {
  const root = makeProject();
  try {
    const { out } = runHook("SessionStart", root, { source: "compact" });
    assert.equal(out.trim(), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SessionStart(compact) nudges while an edited file lacks meta, yielding to a newer prompt", () => {
  const root = makeProject();
  try {
    writeSrc(root, "src/foo.ts");
    runHook("PostToolUse", root, editPayload(root, "src/foo.ts")); // records edit, no meta -> blocker
    const { out } = runHook("SessionStart", root, { source: "compact" });
    assert.match(out, /compacted/);
    assert.match(out, /ToolSearch/); // deferred tools must be reloadable post-compact
    assert.match(out, /visible in the summary/); // asks only what a lossy summary can answer
    assert.match(out, /same turn/i);
    assert.match(out, /newer prompt/); // must not override a fresh user prompt
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SessionStart(unknown source) emits nothing even with outstanding blockers", () => {
  const root = makeProject();
  try {
    writeSrc(root, "src/foo.ts");
    runHook("PostToolUse", root, editPayload(root, "src/foo.ts")); // same state makes compact fire —
    const { out } = runHook("SessionStart", root, { source: "post-quantum" }); // silence must come from the source filter
    assert.equal(out.trim(), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// #endregion SessionStart

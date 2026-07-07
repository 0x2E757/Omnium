import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { withTempRoot, NOW } from "../helpers.mts";
import {
  addEdited,
  readEdited,
  readEditedRecords,
  removeEdited,
  confirmMeta,
  isMetaDirty,
  recordTest,
  readTests,
  upsertReview,
  markEdited,
  markReviewed,
  readChecklist,
  isResolved,
  listSessions,
  writeCurrentSession,
  recordGrant,
  recordBypassGrant,
  isBypassGrant,
  readGrants,
  readStopBlock,
  recordStopBlock,
  clearStopBlock,
  readMute,
  recordMute,
  clearMute,
} from "../../../plugins/graphyne/common/session.mjs";

const SID = "sess-1";

test("edited set is deduped and sorted", () => {
  withTempRoot((root) => {
    addEdited(root, SID, "src/b.ts", NOW);
    addEdited(root, SID, "src/a.ts", NOW);
    addEdited(root, SID, "src/b.ts", NOW);
    assert.deepEqual(readEdited(root, SID), ["src/a.ts", "src/b.ts"]);
  });
});

test("removeEdited drops a path from the edited set; returns whether it was present", () => {
  withTempRoot((root) => {
    addEdited(root, SID, "src/a.ts", NOW);
    addEdited(root, SID, "src/b.ts", NOW);
    assert.equal(removeEdited(root, SID, "src/a.ts"), true);
    assert.deepEqual(readEdited(root, SID), ["src/b.ts"]);
    assert.equal(removeEdited(root, SID, "src/a.ts"), false); // already gone
  });
});

test("a freshly edited file is meta-dirty until confirmed", () => {
  withTempRoot((root) => {
    addEdited(root, SID, "src/a.ts", NOW);
    const recs = readEditedRecords(root, SID);
    assert.equal(recs["src/a.ts"].edits, 1);
    assert.equal(recs["src/a.ts"].metaConfirmed, 0);
    assert.equal(isMetaDirty(recs["src/a.ts"]), true);
  });
});

test("confirmMeta clears dirty; a later edit re-arms it", () => {
  withTempRoot((root) => {
    addEdited(root, SID, "src/a.ts", NOW);
    assert.equal(confirmMeta(root, SID, "src/a.ts"), "confirmed");
    assert.equal(isMetaDirty(readEditedRecords(root, SID)["src/a.ts"]), false);

    addEdited(root, SID, "src/a.ts", NOW); // edited again -> must confirm anew
    assert.equal(isMetaDirty(readEditedRecords(root, SID)["src/a.ts"]), true);
    assert.equal(confirmMeta(root, SID, "src/a.ts"), "confirmed");
    assert.equal(isMetaDirty(readEditedRecords(root, SID)["src/a.ts"]), false);
  });
});

test("confirmMeta on a file not edited this session is a no-op", () => {
  withTempRoot((root) => {
    assert.equal(confirmMeta(root, SID, "src/never.ts"), "not-edited");
  });
});

test("addEdited attributes the edit to an agent, defaulting to main", () => {
  withTempRoot((root) => {
    addEdited(root, SID, "src/a.ts", NOW); // no agent -> the main loop's edit
    assert.deepEqual(readEditedRecords(root, SID)["src/a.ts"].agents, ["main"]);

    addEdited(root, SID, "src/a.ts", NOW, "a1"); // a subagent's edit unions in…
    addEdited(root, SID, "src/a.ts", NOW, "a1"); // …and never duplicates
    assert.deepEqual(readEditedRecords(root, SID)["src/a.ts"].agents, ["main", "a1"]);
  });
});

test("addEdited on a pre-upgrade record (no agents field) treats it as main's", () => {
  withTempRoot((root) => {
    addEdited(root, SID, "src/a.ts", NOW);
    // Simulate a resumed pre-upgrade session: strip the agents field in place.
    const p = join(root, ".graphyne", "tasks", SID, "edited.json");
    const data = JSON.parse(readFileSync(p, "utf8"));
    delete data.files["src/a.ts"].agents;
    writeFileSync(p, JSON.stringify(data));

    addEdited(root, SID, "src/a.ts", NOW, "a1"); // a new edit must not orphan main's claim
    assert.deepEqual(readEditedRecords(root, SID)["src/a.ts"].agents, ["main", "a1"]);
  });
});

test("recordTest latches everRed", () => {
  withTempRoot((root) => {
    let rec = recordTest(root, SID, "t.test.ts", "red", NOW);
    assert.deepEqual(rec, { lastResult: "red", everRed: true, at: NOW });
    rec = recordTest(root, SID, "t.test.ts", "green", NOW);
    assert.deepEqual(rec, { lastResult: "green", everRed: true, at: NOW });
    assert.equal(readTests(root, SID)["t.test.ts"].everRed, true);
  });
});

test("recordTest without red keeps everRed false", () => {
  withTempRoot((root) => {
    const rec = recordTest(root, SID, "t.test.ts", "green", NOW);
    assert.equal(rec.everRed, false);
  });
});

test("checklist upsert, edit-resolution, review-resolution", () => {
  withTempRoot((root) => {
    upsertReview(root, SID, "src/b.ts", "src/a.ts", NOW);
    upsertReview(root, SID, "src/b.ts", "src/c.ts", NOW); // union reasons
    let items = readChecklist(root, SID);
    assert.equal(items.length, 1);
    assert.deepEqual(items[0].reasons.sort(), ["src/a.ts", "src/c.ts"]);
    assert.equal(items[0].state, "open");
    assert.equal(isResolved(items[0]), false);

    markEdited(root, SID, "src/b.ts");
    items = readChecklist(root, SID);
    assert.equal(items[0].state, "edited");
    assert.equal(isResolved(items[0]), true);
  });
});

test("upsertReview with resolvedAsEdited starts edited", () => {
  withTempRoot((root) => {
    upsertReview(root, SID, "src/b.ts", "src/a.ts", NOW, { resolvedAsEdited: true });
    assert.equal(readChecklist(root, SID)[0].state, "edited");
  });
});

test("markReviewed resolves and reports missing", () => {
  withTempRoot((root) => {
    upsertReview(root, SID, "src/b.ts", "src/a.ts", NOW);
    assert.equal(markReviewed(root, SID, "src/b.ts"), true);
    assert.equal(readChecklist(root, SID)[0].state, "reviewed");
    assert.equal(markReviewed(root, SID, "nope.ts"), false);
  });
});

// Audit Low #7: a checklist item is keyed by the graph's stored spelling (src/B.ts);
// on a case-insensitive FS, editing/reviewing the same file spelled src/b.ts must
// resolve it, while on linux the two are distinct files.
test("markEdited folds checklist path case on win32, stays distinct on linux", () => {
  withTempRoot((root) => {
    upsertReview(root, SID, "src/B.ts", "src/a.ts", NOW); // item keyed by B.ts
    markEdited(root, SID, "src/b.ts", "win32");
    assert.equal(readChecklist(root, SID)[0].state, "edited"); // folded -> resolved
  });
});

test("markEdited keeps checklist path case-sensitive on linux", () => {
  withTempRoot((root) => {
    upsertReview(root, SID, "src/B.ts", "src/a.ts", NOW);
    markEdited(root, SID, "src/b.ts", "linux");
    assert.equal(readChecklist(root, SID)[0].state, "open"); // distinct file -> untouched
  });
});

test("markReviewed folds checklist path case on win32", () => {
  withTempRoot((root) => {
    upsertReview(root, SID, "src/B.ts", "src/a.ts", NOW);
    assert.equal(markReviewed(root, SID, "src/b.ts", undefined, "win32"), true);
    assert.equal(readChecklist(root, SID)[0].state, "reviewed");
  });
});

// Audit Low #7 (trio write-dedup): the edited/grants/tests object stores dedup a
// case-variant into the FIRST-SEEN entry on a case-insensitive FS, so one file
// touched under two spellings is ONE record (never rewriting the stored spelling);
// on linux the two are genuinely distinct files.
test("addEdited dedups a case-variant into the first-seen record on win32", () => {
  withTempRoot((root) => {
    addEdited(root, SID, "src/Foo.ts", NOW, "main", "win32");
    addEdited(root, SID, "src/foo.ts", NOW, "main", "win32");
    assert.deepEqual(readEdited(root, SID), ["src/Foo.ts"]); // one entry, first-seen spelling
    assert.equal(readEditedRecords(root, SID)["src/Foo.ts"].edits, 2); // both edits on the one record
  });
});

test("addEdited keeps case-variants distinct on linux", () => {
  withTempRoot((root) => {
    addEdited(root, SID, "src/Foo.ts", NOW, "main", "linux");
    addEdited(root, SID, "src/foo.ts", NOW, "main", "linux");
    assert.equal(readEdited(root, SID).length, 2);
  });
});

test("confirmMeta and removeEdited resolve a case-variant of the edited record on win32", () => {
  withTempRoot((root) => {
    addEdited(root, SID, "src/Foo.ts", NOW, "main", "win32");
    assert.equal(confirmMeta(root, SID, "src/foo.ts", "win32"), "confirmed"); // folded hit
    assert.equal(isMetaDirty(readEditedRecords(root, SID)["src/Foo.ts"]), false);
    assert.equal(removeEdited(root, SID, "src/foo.ts", "win32"), true); // folded delete
    assert.deepEqual(readEdited(root, SID), []);
  });
});

test("recordGrant and recordTest dedup a case-variant into the first-seen key on win32", () => {
  withTempRoot((root) => {
    recordGrant(root, SID, "src/Foo.ts", "all", "first", NOW, "win32");
    recordGrant(root, SID, "src/foo.ts", "all", "second", NOW, "win32");
    assert.deepEqual(Object.keys(readGrants(root, SID)), ["src/Foo.ts"]); // one grant, first-seen key
    recordTest(root, SID, "tests/A.test.mjs", "red", NOW, "win32");
    recordTest(root, SID, "tests/a.test.mjs", "green", NOW, "win32");
    assert.deepEqual(Object.keys(readTests(root, SID)), ["tests/A.test.mjs"]); // one record
    assert.equal(readTests(root, SID)["tests/A.test.mjs"].lastResult, "green"); // refreshed on the one key
  });
});

test("recordBypassGrant dedups a case-variant into the first-seen key on win32", () => {
  withTempRoot((root) => {
    recordBypassGrant(root, SID, "src/Foo.ts", ["test/a.test.ts"], "first", NOW, "win32");
    recordBypassGrant(root, SID, "src/foo.ts", ["test/b.test.ts"], "second", NOW, "win32");
    assert.deepEqual(Object.keys(readGrants(root, SID)), ["src/Foo.ts"]); // one grant, first-seen key
  });
});

test("upsertReview folds case so a re-flag under different casing unions into one item on win32", () => {
  withTempRoot((root) => {
    upsertReview(root, SID, "src/B.ts", "src/a.ts", NOW, undefined, "win32");
    upsertReview(root, SID, "src/b.ts", "src/c.ts", NOW, undefined, "win32");
    const items = readChecklist(root, SID);
    assert.equal(items.length, 1); // one item, not two
    assert.equal(items[0].path, "src/B.ts"); // first-seen spelling preserved
    assert.deepEqual(items[0].reasons, ["src/a.ts", "src/c.ts"]); // reasons unioned
  });
});

test("upsertReview records edge tags and hardness; unions tags, ORs hard", () => {
  withTempRoot((root) => {
    upsertReview(root, SID, "README.md", "src/a.ts", NOW, { tags: ["doc"], hard: false });
    upsertReview(root, SID, "README.md", "src/b.ts", NOW, { tags: ["spec"], hard: true });
    const item = readChecklist(root, SID)[0];
    assert.deepEqual((item.tags ?? []).slice().sort(), ["doc", "spec"]);
    assert.equal(item.hard, true);
  });
});

test("a HARD (doc/spec) item: bare review does NOT resolve; a reason does", () => {
  withTempRoot((root) => {
    upsertReview(root, SID, "README.md", "src/a.ts", NOW, { tags: ["doc"], hard: true });
    assert.equal(isResolved(readChecklist(root, SID)[0]), false);

    markReviewed(root, SID, "README.md"); // bare review
    let item = readChecklist(root, SID)[0];
    assert.equal(item.state, "reviewed");
    assert.equal(isResolved(item), false); // hard + no reason -> still open

    markReviewed(root, SID, "README.md", "documents an unaffected module");
    item = readChecklist(root, SID)[0];
    assert.equal(item.reason, "documents an unaffected module");
    assert.equal(isResolved(item), true);
  });
});

test("a SOFT item resolves with a bare review", () => {
  withTempRoot((root) => {
    upsertReview(root, SID, "src/b.ts", "src/a.ts", NOW, { tags: ["consumer"], hard: false });
    markReviewed(root, SID, "src/b.ts");
    assert.equal(isResolved(readChecklist(root, SID)[0]), true);
  });
});

test("editing a hard item resolves it even after a reasonless review", () => {
  withTempRoot((root) => {
    upsertReview(root, SID, "README.md", "src/a.ts", NOW, { tags: ["spec"], hard: true });
    markReviewed(root, SID, "README.md"); // reviewed, no reason -> unresolved
    assert.equal(isResolved(readChecklist(root, SID)[0]), false);
    markEdited(root, SID, "README.md"); // actually actualized the doc
    const item = readChecklist(root, SID)[0];
    assert.equal(item.state, "edited");
    assert.equal(isResolved(item), true);
  });
});

test("listSessions summarizes each session dir, flagging the current one", () => {
  withTempRoot((root) => {
    addEdited(root, "old", "src/a.ts", NOW);
    addEdited(root, "new", "src/b.ts", NOW);
    addEdited(root, "new", "src/c.ts", NOW);
    upsertReview(root, "new", "src/x.ts", "src/b.ts", NOW); // one open checklist item
    writeCurrentSession(root, "new");

    const sessions = listSessions(root);
    assert.equal(sessions.length, 2);
    // The .current pointer and dotfiles are not sessions.
    assert.deepEqual(sessions.map((s) => s.id).sort(), ["new", "old"]);

    const cur = sessions.find((s) => s.id === "new")!;
    assert.equal(cur.current, true);
    assert.equal(cur.edited, 2);
    assert.equal(cur.open, 1);
    assert.ok(typeof cur.at === "string" && cur.at.length > 0);

    const old = sessions.find((s) => s.id === "old")!;
    assert.equal(old.current, false);
    assert.equal(old.edited, 1);
    assert.equal(old.open, 0);
  });
});

test("listSessions is empty when there are no session dirs", () => {
  withTempRoot((root) => {
    assert.deepEqual(listSessions(root), []);
  });
});

test("recordGrant stores a delete-only refactor grant readable by readGrants", () => {
  withTempRoot((root) => {
    const rec = recordGrant(root, SID, "src/a.ts", "all", "remove dead helper", NOW);
    assert.deepEqual(rec, { reason: "remove dead helper", oracle: "all", greenAt: NOW, at: NOW });
    assert.deepEqual(readGrants(root, SID)["src/a.ts"], rec);
  });
});

test("readGrants is empty with no grants and isolates by session", () => {
  withTempRoot((root) => {
    assert.deepEqual(readGrants(root, SID), {});
    recordGrant(root, SID, "src/a.ts", "covering", "r", NOW);
    assert.deepEqual(readGrants(root, "other"), {});
  });
});

test("recordGrant overwrites a prior grant (re-verifying refreshes greenAt)", () => {
  withTempRoot((root) => {
    recordGrant(root, SID, "src/a.ts", "all", "first", "2026-06-06T12:00:00.000Z");
    const later = "2026-06-06T13:00:00.000Z";
    const rec = recordGrant(root, SID, "src/a.ts", "all", "second", later);
    assert.equal(rec.greenAt, later);
    assert.equal(readGrants(root, SID)["src/a.ts"].reason, "second");
  });
});

test("recordBypassGrant stores a self-attested bypass grant readable by readGrants", () => {
  withTempRoot((root) => {
    const rec = recordBypassGrant(root, SID, "src/a.ts", ["test/a.test.ts"], "inline a dead var", NOW);
    assert.deepEqual(rec, {
      reason: "inline a dead var",
      tests: ["test/a.test.ts"],
      greenAt: NOW,
      at: NOW,
    });
    assert.deepEqual(readGrants(root, SID)["src/a.ts"], rec);
    assert.equal(isBypassGrant(rec), true);
  });
});

test("isBypassGrant distinguishes a bypass grant from a delete-only grant", () => {
  withTempRoot((root) => {
    const del = recordGrant(root, SID, "src/a.ts", "all", "drop dead code", NOW);
    assert.equal(isBypassGrant(del), false);
    const bp = recordBypassGrant(root, SID, "src/b.ts", ["test/b.test.ts"], "reorder", NOW);
    assert.equal(isBypassGrant(bp), true);
  });
});

test("recordBypassGrant normalizes test paths and isolates by session", () => {
  withTempRoot((root) => {
    const rec = recordBypassGrant(root, SID, "src/a.ts", ["test\\a.test.ts"], "r", NOW);
    assert.deepEqual(rec.tests, ["test/a.test.ts"]);
    assert.deepEqual(readGrants(root, "other"), {});
  });
});

test("recordStopBlock round-trips through readStopBlock; clear resets it", () => {
  withTempRoot((root) => {
    assert.equal(readStopBlock(root, SID, "Stop", "main"), null);
    const rec = recordStopBlock(root, SID, { count: 3, event: "Stop", agent: "main", at: NOW });
    assert.deepEqual(rec, { count: 3, event: "Stop", agent: "main", at: NOW });
    assert.deepEqual(readStopBlock(root, SID, "Stop", "main"), { count: 3, event: "Stop", agent: "main", at: NOW });
    assert.equal(clearStopBlock(root, SID), true);
    assert.equal(readStopBlock(root, SID, "Stop", "main"), null);
  });
});

test("clearStopBlock on a session that never blocked is a no-op returning false", () => {
  withTempRoot((root) => {
    assert.equal(clearStopBlock(root, SID), false);
  });
});

test("stop-block records are isolated by session", () => {
  withTempRoot((root) => {
    recordStopBlock(root, SID, { count: 2, event: "Stop", agent: "main", at: NOW });
    assert.equal(readStopBlock(root, "other", "Stop", "main"), null);
  });
});

test("stop-block records are keyed per (event, agent): gates never overwrite each other", () => {
  withTempRoot((root) => {
    recordStopBlock(root, SID, { count: 1, event: "SubagentStop", agent: "a1", at: NOW });
    recordStopBlock(root, SID, { count: 2, event: "SubagentStop", agent: "a2", at: NOW });
    recordStopBlock(root, SID, { count: 3, event: "Stop", agent: "main", at: NOW });
    assert.equal(readStopBlock(root, SID, "SubagentStop", "a1")?.count, 1); // a2's block must not disarm a1
    assert.equal(readStopBlock(root, SID, "SubagentStop", "a2")?.count, 2);
    assert.equal(readStopBlock(root, SID, "Stop", "main")?.count, 3);
    assert.equal(readStopBlock(root, SID, "Stop", "a1"), null); // same agent, other event: distinct gate
    assert.equal(clearStopBlock(root, SID), true); // one user prompt re-arms every gate
    assert.equal(readStopBlock(root, SID, "SubagentStop", "a1"), null);
    assert.equal(readStopBlock(root, SID, "Stop", "main"), null);
  });
});

test("mute state round-trips; absent, cleared or corrupt reads unmuted", () => {
  withTempRoot((root) => {
    assert.equal(readMute(root, SID), null);
    const rec = recordMute(root, SID, NOW);
    assert.deepEqual(rec, { at: NOW });
    assert.deepEqual(readMute(root, SID), { at: NOW });
    assert.equal(readMute(root, "other"), null); // per-session
    assert.equal(clearMute(root, SID), true);
    assert.equal(readMute(root, SID), null);
    assert.equal(clearMute(root, SID), false); // nothing left to clear

    writeFileSync(join(root, ".graphyne", "tasks", SID, "mute.json"), "{not json");
    assert.equal(readMute(root, SID), null); // corrupt file fails open to unmuted
  });
});

test("readMute rejects a shapeless mute value (hand-edited file)", () => {
  withTempRoot((root) => {
    const p = join(root, ".graphyne", "tasks", SID, "mute.json");
    mkdirSync(join(root, ".graphyne", "tasks", SID), { recursive: true });
    writeFileSync(p, JSON.stringify({ mute: true })); // not an object
    assert.equal(readMute(root, SID), null);
    writeFileSync(p, JSON.stringify({ mute: {} })); // no string `at`
    assert.equal(readMute(root, SID), null);
  });
});

test("readStopBlock reads the pre-map single-record shape as its own gate's entry", () => {
  withTempRoot((root) => {
    // A session written by the previous release: { block: {...} } instead of { blocks: {...} }.
    const dir = join(root, ".graphyne", "tasks", SID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "stop-block.json"),
      JSON.stringify({ block: { count: 2, event: "Stop", agent: "main", at: NOW } }),
    );
    assert.deepEqual(readStopBlock(root, SID, "Stop", "main"), { count: 2, event: "Stop", agent: "main", at: NOW });
    assert.equal(readStopBlock(root, SID, "SubagentStop", "a1"), null); // other gates unaffected
  });
});

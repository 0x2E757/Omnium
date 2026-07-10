import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";

import { withTempRoot, NOW } from "../helpers.mts";
import { readConfig } from "../../../plugins/graphyne/common/config.mjs";
import { linkFiles } from "../../../plugins/graphyne/common/graph-store.mjs";
import { recordTest, confirmMeta, readChecklist, markReviewed, recordGrant, recordBypassGrant, upsertReview } from "../../../plugins/graphyne/common/session.mjs";
import { gateEdit, onEdit, stopBlockers, editability } from "../../../plugins/graphyne/common/engine.mjs";

const SID = "s1";

/** Create `rel` on disk (so the Stop gates see it as present), then record the edit.
 *  stopBlockers drops files absent from disk, so a session-edited source must exist
 *  on disk to carry its per-file obligations — mirror that here. */
function edit(root: string, c: ReturnType<typeof readConfig>, rel: string, at = NOW, agent?: string) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, "");
  return agent === undefined ? onEdit(root, c, SID, rel, at) : onEdit(root, c, SID, rel, at, agent);
}

/** Delete `rel` from disk (e.g. a throwaway probe `rm`'d after use). */
function unlinkOnDisk(root: string, rel: string): void {
  rmSync(join(root, rel), { force: true });
}

/** A config that also classifies docs/specs, for the doc/spec gate tests. */
function setupDocs(root: string): ReturnType<typeof readConfig> {
  mkdirSync(join(root, ".graphyne"), { recursive: true });
  writeFileSync(
    join(root, ".graphyne", "config.json"),
    JSON.stringify({
      source: ["src/**/*.ts"],
      exclude: ["**/*.test.ts"],
      tests: ["**/*.test.ts"],
      metaExclude: ["**/*.md"],
      docs: ["README.md", "docs/**/*.md"],
      specs: ["spec/**/*.md"],
      test: { file: "node --test {test}", all: "node --test" },
    }),
  );
  return readConfig(root);
}

function setup(root: string): ReturnType<typeof readConfig> {
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
  return readConfig(root);
}

test("gate: non-gated and test files are always allowed", () => {
  withTempRoot((root) => {
    const c = setup(root);
    assert.equal(gateEdit(root, c, SID, "README.md").allowed, true);
    assert.equal(gateEdit(root, c, SID, "src/a.test.ts").allowed, true);
  });
});

test("gate: gated source with no covering test is blocked", () => {
  withTempRoot((root) => {
    const c = setup(root);
    const g = gateEdit(root, c, SID, "src/a.ts");
    assert.equal(g.allowed, false);
    assert.match(g.reason!, /no covering test/i);
  });
});

test("gate: covering test unrun -> blocked; red -> allowed", () => {
  withTempRoot((root) => {
    const c = setup(root);
    linkFiles(root, "src/a.ts", "test/a.test.ts", ["test"]);
    assert.equal(gateEdit(root, c, SID, "src/a.ts").allowed, false); // unrun
    recordTest(root, SID, "test/a.test.ts", "red", NOW);
    assert.equal(gateEdit(root, c, SID, "src/a.ts").allowed, true);
  });
});

test("gate: green-without-ever-red blocked; green-after-red (refactor) allowed", () => {
  withTempRoot((root) => {
    const c = setup(root);
    linkFiles(root, "src/a.ts", "test/a.test.ts", ["test"]);
    recordTest(root, SID, "test/a.test.ts", "green", NOW); // never red
    assert.equal(gateEdit(root, c, SID, "src/a.ts").allowed, false);
    recordTest(root, SID, "test/a.test.ts", "red", NOW);
    recordTest(root, SID, "test/a.test.ts", "green", NOW); // red->green
    assert.equal(gateEdit(root, c, SID, "src/a.ts").allowed, true);
  });
});

test("gate: a delete-only grant + pure deletion unblocks an otherwise-gated edit", () => {
  withTempRoot((root) => {
    const c = setup(root);
    // No covering test, no red -> normally blocked.
    assert.equal(gateEdit(root, c, SID, "src/a.ts").allowed, false);
    recordGrant(root, SID, "src/a.ts", "all", "remove dead code", NOW);
    // A grant only helps a PURE DELETION (the hook computes the flag).
    assert.equal(gateEdit(root, c, SID, "src/a.ts", { pureDeletion: true }).allowed, true);
    // A non-deletion edit under the same grant stays blocked (no new code via the grant).
    assert.equal(gateEdit(root, c, SID, "src/a.ts", { pureDeletion: false }).allowed, false);
    // The flag alone, without a grant, does nothing.
    assert.equal(gateEdit(root, c, SID, "src/b.ts", { pureDeletion: true }).allowed, false);
  });
});

test("gate: deny message is grant-aware when a grant is open but the edit isn't a pure deletion", () => {
  withTempRoot((root) => {
    const c = setup(root);
    recordGrant(root, SID, "src/a.ts", "all", "remove dead code", NOW);
    // A non-deletion edit under an open grant: blocked, but the reason must name the
    // grant and explain it admits only pure deletions — not the no-grant red-first text.
    const g = gateEdit(root, c, SID, "src/a.ts", { pureDeletion: false });
    assert.equal(g.allowed, false);
    assert.match(g.reason!, /grant is open/i);
    assert.match(g.reason!, /pure deletion/i);
  });
});

test("gate: a self-attested bypass grant admits ANY edit (add/modify), not just deletions", () => {
  withTempRoot((root) => {
    const c = setup(root);
    // No covering test, no red -> normally blocked.
    assert.equal(gateEdit(root, c, SID, "src/a.ts").allowed, false);
    recordBypassGrant(root, SID, "src/a.ts", ["test/a.test.ts"], "behavior-preserving rename", NOW);
    // A bypass grant admits the edit with NO pureDeletion flag at all.
    assert.equal(gateEdit(root, c, SID, "src/a.ts").allowed, true);
    assert.equal(gateEdit(root, c, SID, "src/a.ts", { pureDeletion: false }).allowed, true);
    // A different file with no grant stays blocked.
    assert.equal(gateEdit(root, c, SID, "src/b.ts").allowed, false);
  });
});

test("stopBlockers flags a bypass grant edited after green until its tests are re-run green & fresh", () => {
  withTempRoot((root) => {
    const c = setup(root);
    const green = "2026-06-06T12:00:00.000Z";
    const editAt = "2026-06-06T13:00:00.000Z";
    const rerun = "2026-06-06T14:00:00.000Z";
    recordBypassGrant(root, SID, "src/a.ts", ["test/a.test.ts"], "refactor", green);
    edit(root, c, "src/a.ts", editAt); // edited after the green verification
    assert.deepEqual(stopBlockers(root, c, SID).unverifiedBypass, ["src/a.ts"]);

    // A green run BEFORE the edit isn't fresh enough.
    recordTest(root, SID, "test/a.test.ts", "green", green);
    assert.deepEqual(stopBlockers(root, c, SID).unverifiedBypass, ["src/a.ts"]);

    // Re-running the declared test green AFTER the edit clears it.
    recordTest(root, SID, "test/a.test.ts", "green", rerun);
    assert.deepEqual(stopBlockers(root, c, SID).unverifiedBypass, []);
  });
});

test("stopBlockers: a red declared test keeps a bypass grant unverified", () => {
  withTempRoot((root) => {
    const c = setup(root);
    recordBypassGrant(root, SID, "src/a.ts", ["test/a.test.ts"], "refactor", "2026-06-06T12:00:00.000Z");
    edit(root, c, "src/a.ts", "2026-06-06T13:00:00.000Z");
    recordTest(root, SID, "test/a.test.ts", "red", "2026-06-06T14:00:00.000Z");
    assert.deepEqual(stopBlockers(root, c, SID).unverifiedBypass, ["src/a.ts"]);
  });
});

test("stopBlockers: an unedited bypass grant is not flagged", () => {
  withTempRoot((root) => {
    const c = setup(root);
    recordBypassGrant(root, SID, "src/a.ts", ["test/a.test.ts"], "refactor", NOW);
    assert.deepEqual(stopBlockers(root, c, SID).unverifiedBypass, []);
  });
});

test("editability reports an open self-attested bypass window", () => {
  withTempRoot((root) => {
    const c = setup(root);
    recordBypassGrant(root, SID, "src/a.ts", ["test/a.test.ts"], "refactor", NOW);
    edit(root, c, "src/a.ts", NOW);
    const e = editability(root, c, SID).find((r) => r.rel === "src/a.ts")!;
    assert.equal(e.editable, true);
    assert.match(e.detail, /bypass/i);
  });
});

test("gate: deny message points at graphyne_refactor when a pure deletion has no grant", () => {
  withTempRoot((root) => {
    const c = setup(root);
    // The hook flagged a pure deletion, but no grant is open: blocked, and the reason
    // should tell the agent how to open one rather than only demanding a failing test.
    const g = gateEdit(root, c, SID, "src/a.ts", { pureDeletion: true });
    assert.equal(g.allowed, false);
    assert.match(g.reason!, /graphyne_refactor/i);
  });
});

test("stopBlockers flags an all-oracle grant whose file was edited after green", () => {
  withTempRoot((root) => {
    const c = setup(root);
    const green = "2026-06-06T12:00:00.000Z";
    const afterEdit = "2026-06-06T13:00:00.000Z";
    recordGrant(root, SID, "src/a.ts", "all", "dead", green);
    edit(root, c, "src/a.ts", afterEdit); // edited after the green verification
    assert.deepEqual(stopBlockers(root, c, SID).staleGrants, ["src/a.ts"]);

    // Re-verifying green AFTER the edit clears it.
    recordGrant(root, SID, "src/a.ts", "all", "re-verify", "2026-06-06T14:00:00.000Z");
    assert.deepEqual(stopBlockers(root, c, SID).staleGrants, []);
  });
});

test("stopBlockers does not stale-flag a covering-oracle grant (redTests guards it)", () => {
  withTempRoot((root) => {
    const c = setup(root);
    recordGrant(root, SID, "src/a.ts", "covering", "dead", "2026-06-06T12:00:00.000Z");
    onEdit(root, c, SID, "src/a.ts", "2026-06-06T13:00:00.000Z");
    assert.deepEqual(stopBlockers(root, c, SID).staleGrants, []);
  });
});

test("editability reports an open delete-only refactor window", () => {
  withTempRoot((root) => {
    const c = setup(root);
    recordGrant(root, SID, "src/a.ts", "all", "dead", NOW);
    edit(root, c, "src/a.ts", NOW);
    const e = editability(root, c, SID).find((r) => r.rel === "src/a.ts")!;
    assert.equal(e.editable, true);
    assert.match(e.detail, /delete-only/i);
  });
});

test("onEdit records edit, flags neighbors, detects missing meta", () => {
  withTempRoot((root) => {
    const c = setup(root);
    linkFiles(root, "src/a.ts", "src/b.ts", ["consumer"]);
    const out = onEdit(root, c, SID, "src/a.ts", NOW);
    assert.deepEqual(out.addedReviews, ["src/b.ts"]);
    assert.equal(out.missingMeta, false); // a has meta from the link

    // editing a brand-new gated file with no meta
    const out2 = onEdit(root, c, SID, "src/new.ts", NOW);
    assert.equal(out2.missingMeta, true);
  });
});

test("onEdit reports needsConfirm only for meta-required files", () => {
  withTempRoot((root) => {
    const c = setup(root);
    assert.equal(onEdit(root, c, SID, "src/a.ts", NOW).needsConfirm, true);
    assert.equal(onEdit(root, c, SID, "docs/readme.md", NOW).needsConfirm, false);
  });
});

test("stopBlockers flags edited-but-unconfirmed files; confirm clears, re-edit re-arms", () => {
  withTempRoot((root) => {
    const c = setup(root);
    linkFiles(root, "src/a.ts", "src/b.ts", ["consumer"]); // a has meta
    edit(root, c, "src/a.ts", NOW);
    assert.deepEqual(stopBlockers(root, c, SID).metaDirty, ["src/a.ts"]);

    confirmMeta(root, SID, "src/a.ts");
    assert.deepEqual(stopBlockers(root, c, SID).metaDirty, []);

    edit(root, c, "src/a.ts", NOW); // edited again -> must re-confirm
    assert.deepEqual(stopBlockers(root, c, SID).metaDirty, ["src/a.ts"]);
  });
});

test("a file missing meta is missingMeta, not metaDirty", () => {
  withTempRoot((root) => {
    const c = setup(root);
    edit(root, c, "src/new.ts", NOW);
    const b = stopBlockers(root, c, SID);
    assert.deepEqual(b.missingMeta, ["src/new.ts"]);
    assert.deepEqual(b.metaDirty, []);
  });
});

test("onEdit: editing the flagged neighbor resolves its checklist item", () => {
  withTempRoot((root) => {
    const c = setup(root);
    linkFiles(root, "src/a.ts", "src/b.ts", ["consumer"]);
    onEdit(root, c, SID, "src/a.ts", NOW); // flags b
    let blockers = stopBlockers(root, c, SID);
    assert.equal(blockers.unresolved.length, 1);
    assert.equal(blockers.unresolved[0].path, "src/b.ts");

    onEdit(root, c, SID, "src/b.ts", NOW); // editing b resolves it
    blockers = stopBlockers(root, c, SID);
    assert.equal(blockers.unresolved.length, 0);
  });
});

// Audit Low #7: on a case-insensitive FS the already-edited check for a flagged
// neighbor must fold case, or a genuinely-edited file is re-flagged unresolved.
test("onEdit folds case when checking whether a flagged neighbor was already edited (win32)", () => {
  withTempRoot((root) => {
    const c = setup(root);
    linkFiles(root, "src/a.ts", "src/B.ts", ["consumer"]);
    edit(root, c, "src/b.ts"); // edit the neighbor first, lowercase spelling
    onEdit(root, c, SID, "src/a.ts", NOW, "main", "win32"); // flags B.ts; fold -> already edited
    const blockers = stopBlockers(root, c, SID);
    assert.equal(blockers.unresolved.length, 0); // B.ts resolved-as-edited via the case fold
  });
});

test("onEdit keeps neighbor case distinct on linux (case-sensitive FS)", () => {
  withTempRoot((root) => {
    const c = setup(root);
    linkFiles(root, "src/a.ts", "src/B.ts", ["consumer"]);
    edit(root, c, "src/b.ts"); // b.ts != B.ts on linux
    onEdit(root, c, SID, "src/a.ts", NOW, "main", "linux");
    const blockers = stopBlockers(root, c, SID);
    assert.equal(blockers.unresolved.length, 1);
    assert.equal(blockers.unresolved[0].path, "src/B.ts");
  });
});

// The DOMINANT ordering: flag a neighbor FIRST (open item keyed by the graph's
// stored spelling src/B.ts), then edit that file spelled src/b.ts. On a
// case-insensitive FS the edit must resolve the item, or the gate hangs on a file
// the user already edited (audit Low #7, flag-then-edit).
test("onEdit resolves a flagged neighbor later edited under different casing (win32, flag-then-edit)", () => {
  withTempRoot((root) => {
    const c = setup(root);
    linkFiles(root, "src/a.ts", "src/B.ts", ["consumer"]);
    onEdit(root, c, SID, "src/a.ts", NOW, "main", "win32"); // flags B.ts
    assert.equal(stopBlockers(root, c, SID).unresolved.length, 1);
    onEdit(root, c, SID, "src/b.ts", NOW, "main", "win32"); // edit b.ts -> resolves B.ts on win32
    assert.equal(stopBlockers(root, c, SID).unresolved.length, 0);
  });
});

test("onEdit keeps a flagged neighbor unresolved under different casing on linux (flag-then-edit)", () => {
  withTempRoot((root) => {
    const c = setup(root);
    linkFiles(root, "src/a.ts", "src/B.ts", ["consumer"]);
    onEdit(root, c, SID, "src/a.ts", NOW, "main", "linux");
    onEdit(root, c, SID, "src/b.ts", NOW, "main", "linux");
    assert.equal(stopBlockers(root, c, SID).unresolved.length, 1); // B.ts != b.ts on linux
  });
});

// Audit Low #7 (trio reader-folds): the edited/grants/tests stores keep real
// first-seen keys; the engine readers fold at lookup so a foreign spelling (a
// grant vs an edit, a graph edge vs a test record) still hits. Un-folded, these
// guards silently MISS on a case-insensitive FS and a live grant, a red covering
// test, or a stale-grant / unverified-bypass Stop guard fails OPEN — invisible to
// a Linux CI. Each asserts the win32 fold AND the linux no-op.
test("gateEdit finds a delete-only grant recorded under a different casing (win32)", () => {
  withTempRoot((root) => {
    const c = setup(root);
    recordGrant(root, SID, "src/Foo.ts", "all", "drop dead code", NOW);
    assert.equal(gateEdit(root, c, SID, "src/foo.ts", { pureDeletion: true }, "win32").allowed, true);
    assert.equal(gateEdit(root, c, SID, "src/foo.ts", { pureDeletion: true }, "linux").allowed, false);
  });
});

test("gateEdit finds a red covering test recorded under a different casing than the graph edge (win32)", () => {
  withTempRoot((root) => {
    const c = setup(root);
    linkFiles(root, "src/a.ts", "test/A.test.ts", ["test"]); // edge spelled test/A.test.ts
    recordTest(root, SID, "test/a.test.ts", "red", NOW); // record spelled test/a.test.ts
    assert.equal(gateEdit(root, c, SID, "src/a.ts", {}, "win32").allowed, true); // red found via fold
    assert.equal(gateEdit(root, c, SID, "src/a.ts", {}, "linux").allowed, false);
  });
});

test("stopBlockers redTests folds the graph edge spelling against the test record (win32)", () => {
  withTempRoot((root) => {
    const c = setup(root);
    linkFiles(root, "src/a.ts", "test/A.test.ts", ["test"]);
    edit(root, c, "src/a.ts"); // gated source edited, on disk
    recordTest(root, SID, "test/a.test.ts", "red", NOW); // variant casing
    assert.deepEqual(stopBlockers(root, c, SID, undefined, "win32").redTests, ["test/A.test.ts"]);
    assert.deepEqual(stopBlockers(root, c, SID, undefined, "linux").redTests, []);
  });
});

test("stopBlockers staleGrants folds the grant key vs the edited record (win32 fail-open guard)", () => {
  withTempRoot((root) => {
    const c = setup(root);
    const greenAt = "2026-06-06T12:00:00.000Z";
    const later = "2026-06-06T13:00:00.000Z";
    recordGrant(root, SID, "src/Foo.ts", "all", "drop dead", greenAt);
    edit(root, c, "src/foo.ts", later); // edited AFTER greenAt under a different casing
    assert.deepEqual(stopBlockers(root, c, SID, undefined, "win32").staleGrants, ["src/Foo.ts"]);
    assert.deepEqual(stopBlockers(root, c, SID, undefined, "linux").staleGrants, []);
  });
});

test("stopBlockers unverifiedBypass folds grant/record/test keys (win32 fail-open guard)", () => {
  withTempRoot((root) => {
    const c = setup(root);
    const greenAt = "2026-06-06T12:00:00.000Z";
    const later = "2026-06-06T13:00:00.000Z";
    recordBypassGrant(root, SID, "src/Foo.ts", ["test/A.test.ts"], "reorder", greenAt);
    edit(root, c, "src/foo.ts", later); // edited after the grant opened, variant casing; no fresh green
    assert.deepEqual(stopBlockers(root, c, SID, undefined, "win32").unverifiedBypass, ["src/Foo.ts"]);
    assert.deepEqual(stopBlockers(root, c, SID, undefined, "linux").unverifiedBypass, []);
  });
});

test("stopBlockers scopes an item whose reason is a case-variant of the subagent's edited record (win32)", () => {
  withTempRoot((root) => {
    const c = setup(root);
    edit(root, c, "src/A.ts", NOW, "sub1"); // record keyed src/A.ts, attributed to sub1
    upsertReview(root, SID, "src/x.ts", "src/a.ts", NOW); // item flagged with reason src/a.ts (a variant)
    // The :316 Object.hasOwn(records, reason) cross-ref must fold, or the item escapes sub1's scope.
    assert.ok(stopBlockers(root, c, SID, "sub1", "win32").unresolved.some((i) => i.path === "src/x.ts"));
    assert.ok(!stopBlockers(root, c, SID, "sub1", "linux").unresolved.some((i) => i.path === "src/x.ts"));
  });
});

test("editability folds grant and test keys recorded under a different casing (win32)", () => {
  withTempRoot((root) => {
    const c = setup(root);
    linkFiles(root, "src/a.ts", "test/A.test.ts", ["test"]);
    recordBypassGrant(root, SID, "src/A.ts", ["test/A.test.ts"], "reorder", NOW); // grant under src/A.ts
    recordTest(root, SID, "test/a.test.ts", "green", NOW); // test under test/a.test.ts
    edit(root, c, "src/a.ts"); // the edited row is src/a.ts
    const row = editability(root, c, SID, "win32").find((r) => r.rel === "src/a.ts");
    assert.ok(row);
    assert.match(row.detail, /bypass window/); // grant found via the :380 fold
    assert.match(row.detail, /green/); // test found via the :381 fold (not "unrun")
  });
});

test("stopBlockers reports edited files missing meta", () => {
  withTempRoot((root) => {
    const c = setup(root);
    edit(root, c, "src/new.ts", NOW); // no meta, gated -> needs meta
    const blockers = stopBlockers(root, c, SID);
    assert.deepEqual(blockers.missingMeta, ["src/new.ts"]);
  });
});

test("stopBlockers drops a file deleted from disk from the missing-meta gate", () => {
  withTempRoot((root) => {
    const c = setup(root);
    edit(root, c, "src/probe.ts", NOW); // a throwaway, no meta -> would block
    assert.deepEqual(stopBlockers(root, c, SID).missingMeta, ["src/probe.ts"]);

    unlinkOnDisk(root, "src/probe.ts"); // rm'd after use
    const b = stopBlockers(root, c, SID);
    assert.deepEqual(b.missingMeta, []); // gone from disk -> no obligation
    assert.deepEqual(b.deletedWithMeta, []); // never had a meta -> nothing to prune
  });
});

test("stopBlockers drops a deleted file from every per-file gate", () => {
  withTempRoot((root) => {
    const c = setup(root);
    linkFiles(root, "src/a.ts", "test/a.test.ts", ["test"]);
    edit(root, c, "src/a.ts", NOW);
    recordTest(root, SID, "test/a.test.ts", "red", NOW); // red covering test
    recordGrant(root, SID, "src/a.ts", "all", "dead", "2020-01-01T00:00:00.000Z"); // stale grant
    // Present: it blocks on metaDirty, redTests and staleGrants.
    let b = stopBlockers(root, c, SID);
    assert.ok(b.metaDirty.length + b.redTests.length + b.staleGrants.length > 0);

    unlinkOnDisk(root, "src/a.ts");
    b = stopBlockers(root, c, SID);
    assert.deepEqual(b.missingMeta, []);
    assert.deepEqual(b.metaDirty, []);
    assert.deepEqual(b.redTests, []);
    assert.deepEqual(b.staleGrants, []);
    assert.deepEqual(b.unverifiedBypass, []);
  });
});

test("a deleted file that still has a meta is surfaced as deletedWithMeta", () => {
  withTempRoot((root) => {
    const c = setup(root);
    linkFiles(root, "src/a.ts", "src/b.ts", ["consumer"]); // a gets a meta + edge
    edit(root, c, "src/a.ts", NOW);
    unlinkOnDisk(root, "src/a.ts"); // deleted, but its meta file lingers

    const b = stopBlockers(root, c, SID);
    assert.deepEqual(b.deletedWithMeta, ["src/a.ts"]); // orphan meta to prune
    assert.deepEqual(b.missingMeta, []); // not "missing" — it HAS a (now orphan) meta
    assert.deepEqual(b.metaDirty, []); // gone -> no confirm obligation
  });
});

test("editability omits a file deleted from disk", () => {
  withTempRoot((root) => {
    const c = setup(root);
    linkFiles(root, "src/a.ts", "test/a.test.ts", ["test"]);
    edit(root, c, "src/a.ts", NOW);
    assert.equal(editability(root, c, SID).length, 1);
    unlinkOnDisk(root, "src/a.ts");
    assert.equal(editability(root, c, SID).length, 0);
  });
});

test("metaExclude files don't block stop for missing meta", () => {
  withTempRoot((root) => {
    const c = setup(root);
    onEdit(root, c, SID, "docs/readme.md", NOW);
    assert.deepEqual(stopBlockers(root, c, SID).missingMeta, []);
  });
});

test("stopBlockers reports red covering tests only for edited gated source", () => {
  withTempRoot((root) => {
    const c = setup(root);
    linkFiles(root, "src/a.ts", "test/a.test.ts", ["test"]);

    // A red covering test, but src/a.ts was not edited this session -> not a blocker.
    recordTest(root, SID, "test/a.test.ts", "red", NOW);
    assert.deepEqual(stopBlockers(root, c, SID).redTests, []);

    // Once src/a.ts is edited, its red covering test blocks Stop.
    edit(root, c, "src/a.ts", NOW);
    assert.deepEqual(stopBlockers(root, c, SID).redTests, ["test/a.test.ts"]);

    // Turning it green clears the blocker.
    recordTest(root, SID, "test/a.test.ts", "green", NOW);
    assert.deepEqual(stopBlockers(root, c, SID).redTests, []);
  });
});

test("editability summarizes gated edited files", () => {
  withTempRoot((root) => {
    const c = setup(root);
    linkFiles(root, "src/a.ts", "test/a.test.ts", ["test"]);
    edit(root, c, "src/a.ts", NOW);
    recordTest(root, SID, "test/a.test.ts", "red", NOW);
    const e = editability(root, c, SID);
    assert.equal(e.length, 1);
    assert.equal(e[0].rel, "src/a.ts");
    assert.equal(e[0].editable, true);
    assert.match(e[0].detail, /test\/a\.test\.ts=red/);
  });
});

test("onEdit: editing code HARD-flags its doc/spec neighbors, soft-flags the rest", () => {
  withTempRoot((root) => {
    const c = setupDocs(root);
    linkFiles(root, "src/a.ts", "README.md", ["doc"]);
    linkFiles(root, "src/a.ts", "spec/login.md", ["spec"]);
    linkFiles(root, "src/a.ts", "src/b.ts", ["consumer"]);
    onEdit(root, c, SID, "src/a.ts", NOW);
    const items = readChecklist(root, SID);
    const readme = items.find((i) => i.path === "README.md")!;
    const spec = items.find((i) => i.path === "spec/login.md")!;
    const b = items.find((i) => i.path === "src/b.ts")!;
    assert.equal(readme.hard, true);
    assert.deepEqual(readme.tags, ["doc"]);
    assert.equal(spec.hard, true);
    assert.equal(b.hard, false); // plain consumer edge stays soft
  });
});

test("onEdit: editing a DOC soft-flags the code it documents", () => {
  withTempRoot((root) => {
    const c = setupDocs(root);
    linkFiles(root, "src/a.ts", "README.md", ["doc"]);
    onEdit(root, c, SID, "README.md", NOW); // editing the doc itself
    const a = readChecklist(root, SID).find((i) => i.path === "src/a.ts")!;
    assert.equal(a.hard, false); // prose change rarely forces a code change
  });
});

test("onEdit: editing a SPEC hard-flags the code that must conform", () => {
  withTempRoot((root) => {
    const c = setupDocs(root);
    linkFiles(root, "src/a.ts", "spec/login.md", ["spec"]);
    onEdit(root, c, SID, "spec/login.md", NOW); // editing the spec
    const a = readChecklist(root, SID).find((i) => i.path === "src/a.ts")!;
    assert.equal(a.hard, true); // spec changed -> code must be brought into conformance
  });
});

test("onEdit treats ignored files as invisible: no record, no neighbor flags", () => {
  withTempRoot((root) => {
    mkdirSync(join(root, ".graphyne"), { recursive: true });
    writeFileSync(
      join(root, ".graphyne", "config.json"),
      JSON.stringify({
        source: ["src/**/*.ts"],
        tests: ["**/*.test.ts"],
        metaExclude: ["**/*.md"],
        docs: ["**/*.md"],
        ignore: ["vendor/**"],
        test: { file: "node --test {test}", all: "node --test" },
      }),
    );
    const c = readConfig(root);

    // editing an ignored file is a no-op (not recorded, nothing flagged)
    linkFiles(root, "vendor/lib.ts", "src/a.ts", ["consumer"]);
    const out = onEdit(root, c, SID, "vendor/lib.ts", NOW);
    assert.deepEqual(out.addedReviews, []);
    assert.equal(out.missingMeta, false);
    assert.equal(out.needsConfirm, false);
    assert.equal(stopBlockers(root, c, SID).unresolved.length, 0);

    // editing a tracked file does NOT flag its ignored neighbors
    linkFiles(root, "src/a.ts", "vendor/other.ts", ["consumer"]);
    onEdit(root, c, SID, "src/a.ts", NOW);
    const flagged = stopBlockers(root, c, SID).unresolved.map((i) => i.path);
    assert.ok(!flagged.includes("vendor/lib.ts"));
    assert.ok(!flagged.includes("vendor/other.ts"));
  });
});

// #region per-agent stopBlockers slice (SubagentStop scoping)
// SubagentStop must gate a subagent only on obligations ITS OWN edits incurred:
// pass the subagent's agent id to stopBlockers to get that slice. Session-wide
// behavior (no agent id) is the main Stop gate's backstop and stays pinned by
// every other stopBlockers test above. A record without an `agents` field (a
// resumed pre-upgrade session) belongs to "main".

test("stopBlockers with an agent id sees only that agent's edits", () => {
  withTempRoot((root) => {
    const c = setup(root);
    edit(root, c, "src/main.ts", NOW); // the main loop's edit (no agent)
    edit(root, c, "src/sub.ts", NOW, "a1"); // the subagent's edit
    assert.deepEqual(stopBlockers(root, c, SID).missingMeta, ["src/main.ts", "src/sub.ts"]);
    assert.deepEqual(stopBlockers(root, c, SID, "a1").missingMeta, ["src/sub.ts"]);
    assert.deepEqual(stopBlockers(root, c, SID, "a2").missingMeta, []);
  });
});

test("agent slice: checklist items count only when this agent's edit flagged them", () => {
  withTempRoot((root) => {
    const c = setup(root);
    linkFiles(root, "src/a.ts", "src/n.ts", ["consumer"]);
    linkFiles(root, "src/b.ts", "src/m.ts", ["consumer"]);
    edit(root, c, "src/a.ts", NOW, "a1"); // flags n.ts (reason: src/a.ts)
    edit(root, c, "src/b.ts", NOW); // main flags m.ts
    const slice = stopBlockers(root, c, SID, "a1");
    assert.deepEqual(slice.unresolved.map((i) => i.path), ["src/n.ts"]);
    const whole = stopBlockers(root, c, SID);
    assert.deepEqual(whole.unresolved.map((i) => i.path).sort(), ["src/m.ts", "src/n.ts"]);
  });
});

test("agent slice: a file edited by both main and the subagent gates both", () => {
  withTempRoot((root) => {
    const c = setup(root);
    edit(root, c, "src/shared.ts", NOW);
    edit(root, c, "src/shared.ts", NOW, "a1");
    assert.deepEqual(stopBlockers(root, c, SID).missingMeta, ["src/shared.ts"]);
    assert.deepEqual(stopBlockers(root, c, SID, "a1").missingMeta, ["src/shared.ts"]);
  });
});

test("agent slice: red covering tests follow the agent's edited set", () => {
  withTempRoot((root) => {
    const c = setup(root);
    linkFiles(root, "src/a.ts", "test/a.test.ts", ["test"]);
    edit(root, c, "src/a.ts", NOW, "a1");
    recordTest(root, SID, "test/a.test.ts", "red", NOW);
    assert.deepEqual(stopBlockers(root, c, SID, "a1").redTests, ["test/a.test.ts"]);
    assert.deepEqual(stopBlockers(root, c, SID, "a2").redTests, []);
  });
});

test("agent slice: grant obligations follow the agent's edited set", () => {
  withTempRoot((root) => {
    const c = setup(root);
    const green = "2026-06-06T12:00:00.000Z";
    const later = "2026-06-06T13:00:00.000Z";
    recordGrant(root, SID, "src/a.ts", "all", "dead", green);
    recordBypassGrant(root, SID, "src/b.ts", ["test/b.test.ts"], "refactor", green);
    edit(root, c, "src/a.ts", later, "a1"); // edited after green -> stale for a1
    edit(root, c, "src/b.ts", later, "a1"); // edited after green -> unverified for a1
    assert.deepEqual(stopBlockers(root, c, SID, "a1").staleGrants, ["src/a.ts"]);
    assert.deepEqual(stopBlockers(root, c, SID, "a1").unverifiedBypass, ["src/b.ts"]);
    assert.deepEqual(stopBlockers(root, c, SID, "a2").staleGrants, []);
    assert.deepEqual(stopBlockers(root, c, SID, "a2").unverifiedBypass, []);
  });
});

test("agent slice: metaDirty and deletedWithMeta follow the agent's edited set", () => {
  withTempRoot((root) => {
    const c = setup(root);
    linkFiles(root, "src/a.ts", "src/b.ts", ["consumer"]); // a has meta -> metaDirty on edit
    linkFiles(root, "src/gone.ts", "src/b.ts", ["consumer"]); // gone has meta -> orphan on delete
    edit(root, c, "src/a.ts", NOW, "a1");
    edit(root, c, "src/gone.ts", NOW, "a1");
    unlinkOnDisk(root, "src/gone.ts");
    assert.deepEqual(stopBlockers(root, c, SID, "a1").metaDirty, ["src/a.ts"]);
    assert.deepEqual(stopBlockers(root, c, SID, "a1").deletedWithMeta, ["src/gone.ts"]);
    assert.deepEqual(stopBlockers(root, c, SID, "a2").metaDirty, []);
    assert.deepEqual(stopBlockers(root, c, SID, "a2").deletedWithMeta, []);
  });
});

test("agent slice: a cleared slice passes while main's own blocker still stands", () => {
  withTempRoot((root) => {
    const c = setup(root);
    linkFiles(root, "src/sub.ts", "src/n.ts", ["consumer"]);
    edit(root, c, "src/sub.ts", NOW, "a1"); // a1: metaDirty + flags n.ts
    edit(root, c, "src/main.ts", NOW); // main: missing meta
    confirmMeta(root, SID, "src/sub.ts");
    markReviewed(root, SID, "src/n.ts");
    const slice = stopBlockers(root, c, SID, "a1");
    assert.equal(
      slice.missingMeta.length + slice.unresolved.length + slice.metaDirty.length,
      0, // a1 cleared everything its edits incurred
    );
    assert.deepEqual(stopBlockers(root, c, SID).missingMeta, ["src/main.ts"]); // main still owes
  });
});

test("agent slice: the legacy array-shape edited.json attributes to main", () => {
  withTempRoot((root) => {
    const c = setup(root);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/old.ts"), "");
    mkdirSync(join(root, ".graphyne", "tasks", SID), { recursive: true });
    // The pre-EditRecord shape: a bare list of edited paths.
    writeFileSync(
      join(root, ".graphyne", "tasks", SID, "edited.json"),
      JSON.stringify({ files: ["src/old.ts"] }),
    );
    assert.deepEqual(stopBlockers(root, c, SID, "main").missingMeta, ["src/old.ts"]);
    assert.deepEqual(stopBlockers(root, c, SID, "a1").missingMeta, []);
    assert.deepEqual(stopBlockers(root, c, SID).missingMeta, ["src/old.ts"]);
  });
});

test("agent slice: records without an agents field attribute to main (pre-upgrade session)", () => {
  withTempRoot((root) => {
    const c = setup(root);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/old.ts"), "");
    mkdirSync(join(root, ".graphyne", "tasks", SID), { recursive: true });
    writeFileSync(
      join(root, ".graphyne", "tasks", SID, "edited.json"),
      JSON.stringify({ files: { "src/old.ts": { edits: 1, metaConfirmed: 0, at: NOW } } }),
    );
    assert.deepEqual(stopBlockers(root, c, SID, "main").missingMeta, ["src/old.ts"]);
    assert.deepEqual(stopBlockers(root, c, SID, "a1").missingMeta, []);
    assert.deepEqual(stopBlockers(root, c, SID).missingMeta, ["src/old.ts"]);
  });
});

// #endregion per-agent stopBlockers slice

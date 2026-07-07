import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";

import * as h from "../../plugins/memosyne/handlers.mjs";
import { buildStem, DESCRIPTION_SOFT_MAX, DESCRIPTION_HARD_MAX } from "../../plugins/memosyne/common/task.mjs";
import { storeDir } from "../../plugins/memosyne/common/storage.mjs";

function withRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "memosyne-h-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// searchText is async (the regex match runs in a worker under a timeout), so its
// tests need an async-aware temp-root wrapper.
async function withRootAsync(fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "memosyne-h-"));
  try {
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// The "Store:" line in projectInfo must not render a mixed separator on Windows
// (C:\repo/.memosyne). It joins path + ".memosyne" through an injectable
// path.join (default native), so win32 rules are exercised on any host.
test("projectInfo Store line joins with the platform separator (no mixed slashes on Windows)", () => {
  const out = h.projectInfo({ name: "demo", path: "C:\\repo" }, win32.join);
  assert.match(out, /^Store: C:\\repo\\\.memosyne$/m);
  assert.ok(!out.includes("C:\\repo/.memosyne"), "no mixed store path separator");
});

test("projectInfo Store line defaults to the native join", () => {
  const out = h.projectInfo({ name: "demo", path: "/srv/repo" });
  assert.match(out, /^Store: \/srv\/repo\/\.memosyne$/m);
});

const D = new Date(2026, 5, 4, 15, 8); // -> 2026-06-04--15-08--<name>

test("create -> get -> update -> edit a task", () => {
  withRoot((root) => {
    const stem = buildStem(D, "demo");
    h.createTask(root, D, { name: "demo", summary: "Initial summary", description: "Body line." });
    assert.ok(h.getTask(root, { task: stem }).includes("Initial summary"));

    h.updateTask(root, D, { task: stem, status: "Active" });
    assert.ok(h.getTask(root, { task: stem, sections: ["status"] }).includes("Active"));

    h.editTask(root, D, { task: stem, section: "description", old_text: "Body line.", new_text: "Body line edited." });
    assert.ok(h.getTask(root, { task: stem, sections: ["description"] }).includes("Body line edited."));
  });
});

test("link/unlink relate two tasks bidirectionally and idempotently", () => {
  withRoot((root) => {
    const a = buildStem(new Date(2026, 5, 4, 9, 0), "a");
    const b = buildStem(new Date(2026, 5, 4, 9, 1), "b");
    h.createTask(root, new Date(2026, 5, 4, 9, 0), { name: "a", summary: "a" });
    h.createTask(root, new Date(2026, 5, 4, 9, 1), { name: "b", summary: "b" });

    h.linkTasks(root, { task: a, related: b });
    // Both sides carry the relation (the edge is undirected).
    assert.ok(h.getTask(root, { task: a, sections: ["related"] }).includes(b));
    assert.ok(h.getTask(root, { task: b, sections: ["related"] }).includes(a));

    // Linking again is a no-op: the stem appears exactly once.
    h.linkTasks(root, { task: a, related: b });
    const relA = h.getTask(root, { task: a, sections: ["related"] });
    assert.equal((relA.match(new RegExp(b, "g")) ?? []).length, 1);

    // Unlink removes the relation from both files.
    h.unlinkTasks(root, { task: a, related: b });
    assert.ok(!h.getTask(root, { task: a, sections: ["related"] }).includes(b));
    assert.ok(!h.getTask(root, { task: b, sections: ["related"] }).includes(a));
  });
});

test("link rejects a self-link, a missing endpoint and a malformed stem", () => {
  withRoot((root) => {
    const a = buildStem(D, "a");
    h.createTask(root, D, { name: "a", summary: "a" });
    assert.throws(() => h.linkTasks(root, { task: a, related: a }), h.ToolError); // self-link
    assert.throws(() => h.linkTasks(root, { task: a, related: "2026-06-04--09-00--ghost" }), h.ToolError); // missing
    assert.throws(() => h.linkTasks(root, { task: "../escape", related: a }), h.ToolError); // traversal
  });
});

test("deleting a task sweeps the inbound related refs from its neighbors", () => {
  withRoot((root) => {
    const a = buildStem(new Date(2026, 5, 4, 9, 0), "a");
    const b = buildStem(new Date(2026, 5, 4, 9, 1), "b");
    h.createTask(root, new Date(2026, 5, 4, 9, 0), { name: "a", summary: "a" });
    h.createTask(root, new Date(2026, 5, 4, 9, 1), { name: "b", summary: "b" });
    h.linkTasks(root, { task: a, related: b });

    h.deleteTask(root, { task: a });
    // The surviving neighbor no longer references the deleted task — no dangling edge.
    assert.ok(!h.getTask(root, { task: b, sections: ["related"] }).includes(a));
  });
});

test("status is constrained to the allowed set; default is Backlog", () => {
  withRoot((root) => {
    const stem = buildStem(D, "demo");
    h.createTask(root, D, { name: "demo", summary: "S" });
    assert.match(h.getTask(root, { task: stem, sections: ["status"] }), /Backlog/);

    assert.throws(() => h.updateTask(root, D, { task: stem, status: "Whatever" }), h.ToolError);
    assert.throws(() => h.createTask(root, D, { name: "x", summary: "y", status: "In Progress" }), h.ToolError);

    h.updateTask(root, D, { task: stem, status: "Done" });
    assert.match(h.getTask(root, { task: stem, sections: ["status"] }), /Done/);
  });
});

test("listTasks summarizes; empty root says none", () => {
  withRoot((root) => {
    assert.equal(h.listTasks(root), "No tasks yet.");
    h.createTask(root, D, { name: "demo", summary: "S" });
    assert.match(h.listTasks(root), /demo/);
  });
});

test("listTasks shows an expanded window then a compact tail, newest first", () => {
  withRoot((root) => {
    // 35 tasks at distinct minutes so stems sort deterministically.
    for (let i = 0; i < 35; i++) {
      h.createTask(root, new Date(2026, 5, 4, 15, i), { name: `t${i}`, summary: `task ${i}` });
    }
    const out = h.listTasks(root);
    // Default = 10 expanded full records + 20 compact one-liners = 30 of 35; 5 withheld.
    assert.match(out, new RegExp(`Showing ${h.DEFAULT_EXPANDED} expanded \\+ ${h.DEFAULT_COMPACT} compact of 35`));
    assert.match(out, /raise `expanded`.*`compact`.*other 5/);
    // Newest (t34) is a full record (• bullet) carrying its summary.
    assert.match(out, /• \S+--t34\n {4}status: Backlog.*\n {4}task 34/);
    // Expanded covers t34..t25; compact (t24..t5) carries only stem + status, no summary line.
    assert.match(out, /· \S+--t5 — Backlog/);
    assert.ok(!out.includes("task 5\n"));
    // Oldest five (t0..t4) are withheld entirely.
    assert.ok(!out.includes("--t4 —") && !out.includes("--t0 —"));
    // expanded 0 returns everything as full records (no compact tail).
    assert.match(h.listTasks(root, { expanded: 0 }), /Showing 35 of 35/);
    // compact 0 falls back to the plain "Showing N of M" header with only the expanded window.
    const noTail = h.listTasks(root, { compact: 0 });
    assert.match(noTail, new RegExp(`Showing ${h.DEFAULT_EXPANDED} of 35`));
    assert.ok(!noTail.includes(" — "));
  });
});

test("listTasks filters by status set and reaches older tasks past newer ones", () => {
  withRoot((root) => {
    // Older Done tasks, then newer Backlog ones on top of them.
    for (let i = 0; i < 3; i++) {
      const stem = buildStem(new Date(2026, 5, 4, 10, i), `done${i}`);
      h.createTask(root, new Date(2026, 5, 4, 10, i), { name: `done${i}`, summary: "d" });
      h.updateTask(root, new Date(2026, 5, 4, 10, i), { task: stem, status: "Done" });
    }
    for (let i = 0; i < 2; i++) {
      h.createTask(root, new Date(2026, 5, 4, 11, i), { name: `backlog${i}`, summary: "b" });
    }

    const done = h.listTasks(root, { status: ["Done"] });
    assert.match(done, /Showing 3 of 3 task\(s\) with status Done/);
    assert.ok(done.includes("--done2") && !done.includes("--backlog0"));

    // Multi-status set unions the matches.
    const both = h.listTasks(root, { status: ["Done", "Backlog"] });
    assert.match(both, /Showing 5 of 5/);

    // No match reports the scope, not "No tasks yet".
    assert.equal(h.listTasks(root, { status: ["Blocked"] }), "No tasks with status Blocked.");

    // Invalid status is rejected.
    assert.throws(() => h.listTasks(root, { status: ["Nope"] }), h.ToolError);
  });
});

test("findByFile matches by path substring, surfaces tags, narrows by priority", () => {
  withRoot((root) => {
    const a = buildStem(new Date(2026, 5, 4, 9, 0), "a");
    h.createTask(root, new Date(2026, 5, 4, 9, 0), {
      name: "a",
      summary: "task a",
      files: [{ path: "src/mcp/handlers.mts", priority: "P0", tags: ["listTasks", "limit"] }],
    });
    const b = buildStem(new Date(2026, 5, 4, 9, 1), "b");
    h.createTask(root, new Date(2026, 5, 4, 9, 1), {
      name: "b",
      summary: "task b",
      files: [{ path: "src/mcp/server.mts", priority: "P1", tags: ["schema"] }],
    });

    // Substring 'mcp/' matches both; newest first (b before a).
    const both = h.findByFile(root, { path: "MCP/" });
    assert.match(both, /Showing 2 of 2/);
    assert.ok(both.indexOf(b) < both.indexOf(a));
    // Tags of the matched entry are surfaced for analysis.
    assert.match(both, /listTasks, limit/);

    // Specific file substring isolates one task.
    const onlyA = h.findByFile(root, { path: "handlers.mts" });
    assert.match(onlyA, /Showing 1 of 1/);
    assert.ok(onlyA.includes(a) && !onlyA.includes(b));

    // Priority narrows: only the P0 entry (task a) qualifies.
    const p0 = h.findByFile(root, { path: "src/mcp/", priority: "P0" });
    assert.ok(p0.includes(a) && !p0.includes(b));

    // No match reports the criteria; missing path throws.
    assert.equal(h.findByFile(root, { path: "nope.ts" }), 'No tasks reference a file matching "nope.ts".');
    assert.throws(() => h.findByFile(root, { path: "  " }), h.ToolError);
  });
});

// Audit Low #7: paths are stored verbatim, so a Windows-style backslash needle
// must still match a forward-slash-stored path (separator is never a real distinction).
test("findByFile normalizes path separators: a backslash needle matches a forward-slash path", () => {
  withRoot((root) => {
    const a = buildStem(new Date(2026, 5, 4, 9, 0), "a");
    h.createTask(root, new Date(2026, 5, 4, 9, 0), {
      name: "a",
      summary: "task a",
      files: [{ path: "src/mcp/handlers.mts", priority: "P0", tags: ["x"] }],
    });
    const hit = h.findByFile(root, { path: "src\\mcp\\handlers.mts" });
    assert.match(hit, /Showing 1 of 1/);
    assert.ok(hit.includes(a));
  });
});

test("searchText: case-insensitive regex over summary+description, snippets, newest-first, errors", async () => {
  await withRootAsync(async (root) => {
    const a = buildStem(new Date(2026, 5, 4, 8, 0), "a");
    h.createTask(root, new Date(2026, 5, 4, 8, 0), {
      name: "a",
      summary: "Refactor the parser",
      description: "Handles the CSP nonce and importmap hash.",
    });
    const b = buildStem(new Date(2026, 5, 4, 8, 1), "b");
    h.createTask(root, new Date(2026, 5, 4, 8, 1), {
      name: "b",
      summary: "Add markdown rendering",
      description: "Uses marked + dompurify.",
    });

    // Case-insensitive; hit is in a's description -> snippet labeled description.
    const csp = await h.searchText(root, { query: "csp" });
    assert.match(csp, /Showing 1 of 1/);
    assert.ok(csp.includes(a) && !csp.includes(b));
    assert.match(csp, /description: .*CSP nonce/);

    // Regex alternation matches both summaries; newest (b) first.
    const both = await h.searchText(root, { query: "parser|markdown" });
    assert.match(both, /Showing 2 of 2/);
    assert.ok(both.indexOf(b) < both.indexOf(a));

    assert.equal(await h.searchText(root, { query: "nope" }), "No tasks match /nope/i.");
    await assert.rejects(() => h.searchText(root, { query: "(" }), h.ToolError); // invalid regex
    await assert.rejects(() => h.searchText(root, { query: "  " }), h.ToolError); // blank
  });
});

test("error cases throw ToolError", () => {
  withRoot((root) => {
    assert.throws(() => h.getTask(root, { task: "2026-06-04--15-08--missing" }), h.ToolError);
    assert.throws(
      () => h.linkTasks(root, { task: "2026-06-04--15-08--missing", related: "2026-06-04--15-09--other" }),
      h.ToolError,
    );
    assert.throws(() => h.createTask(root, D, { name: "big", summary: "x".repeat(401) }), h.ToolError);

    const stem = buildStem(D, "demo");
    h.createTask(root, D, { name: "demo", summary: "S", description: "real text" });
    assert.throws(
      () => h.editTask(root, D, { task: stem, section: "description", old_text: "totally different", new_text: "x" }),
      h.ToolError,
    );
  });
});

test("a stem collision error surfaces the existing task's status and summary", () => {
  withRoot((root) => {
    h.createTask(root, D, { name: "demo", summary: "First task here", status: "Active" });
    assert.throws(
      () => h.createTask(root, D, { name: "demo", summary: "different work" }),
      (err: unknown) => {
        assert.ok(err instanceof h.ToolError);
        assert.match(err.message, /Active/);
        assert.match(err.message, /First task here/);
        return true;
      },
    );
  });
});

test("summary newlines are rejected on create, update and edit; 300 chars is allowed", () => {
  withRoot((root) => {
    const stem = buildStem(D, "demo");
    assert.throws(() => h.createTask(root, D, { name: "demo", summary: "a\nb" }), h.ToolError);

    h.createTask(root, D, { name: "demo", summary: "S" });
    assert.throws(() => h.updateTask(root, D, { task: stem, summary: "a\nb" }), h.ToolError);
    assert.throws(
      () => h.editTask(root, D, { task: stem, section: "summary", old_text: "S", new_text: "multi\nline" }),
      h.ToolError,
    );

    // The soft cap (300) and overruns up to the hard cap (400) are accepted; only
    // beyond the hard cap is rejected (covered by the 401-char case above).
    h.updateTask(root, D, { task: stem, summary: "x".repeat(300) });
    h.updateTask(root, D, { task: stem, summary: "x".repeat(400) });
  });
});

test("getTask renders only the requested sections; a duplicate create is refused", () => {
  withRoot((root) => {
    const stem = buildStem(D, "demo");
    h.createTask(root, D, { name: "demo", summary: "Sum", description: "Body" });
    const two = h.getTask(root, { task: stem, sections: ["summary", "status"] });
    assert.match(two, /memosyne-summary/);
    assert.match(two, /memosyne-status/);
    assert.doesNotMatch(two, /memosyne-files/);
    assert.doesNotMatch(two, /memosyne-description/);

    assert.throws(() => h.createTask(root, D, { name: "demo", summary: "again" }), h.ToolError);
  });
});

test("stale-Done guard: blocks editing an old Done task outside the recent window; force overrides", () => {
  withRoot((root) => {
    const old = new Date(2026, 5, 4, 10, 0);
    const stem = buildStem(old, "old-done");
    h.createTask(root, old, { name: "old-done", summary: "s", description: "body" });
    h.updateTask(root, old, { task: stem, status: "Done" });
    // 3 newer tasks push the Done one out of the recent-editable window.
    for (let i = 0; i < 3; i++) h.createTask(root, new Date(2026, 5, 4, 12, i), { name: `newer${i}`, summary: "n" });

    const now = new Date(2026, 5, 4, 15, 0); // 5h after creation, well past the 2h grace
    assert.throws(() => h.updateTask(root, now, { task: stem, description: "x" }), h.ToolError);
    // The guard runs before the edit is applied, so even a clean edit is refused.
    assert.throws(
      () => h.editTask(root, now, { task: stem, section: "description", old_text: "body", new_text: "x" }),
      h.ToolError,
    );

    // force: true overrides the guard.
    h.updateTask(root, now, { task: stem, description: "forced", force: true });
    assert.match(h.getTask(root, { task: stem, sections: ["description"] }), /forced/);
  });
});

test("stale-Done guard: exempts recent tasks, non-Done tasks, and the grace window", () => {
  withRoot((root) => {
    const now = new Date(2026, 5, 4, 15, 0);
    const mk = (h_: number, m: number, name: string) => {
      const d = new Date(2026, 5, 4, h_, m);
      return { d, stem: buildStem(d, name) };
    };

    // (a) Old + Done but among the 3 newest -> editable (immediate fix-up of fresh work).
    const a = mk(10, 0, "recent-done");
    h.createTask(root, a.d, { name: "recent-done", summary: "s" });
    h.updateTask(root, a.d, { task: a.stem, status: "Done" });
    h.updateTask(root, now, { task: a.stem, description: "ok-recent" });
    assert.match(h.getTask(root, { task: a.stem, sections: ["description"] }), /ok-recent/);

    // (b) Old + outside the window but NOT Done -> editable (guard only protects Done).
    const b = mk(9, 0, "old-backlog");
    h.createTask(root, b.d, { name: "old-backlog", summary: "s" });
    for (let i = 0; i < 3; i++) h.createTask(root, new Date(2026, 5, 4, 12, i), { name: `pad${i}`, summary: "p" });
    h.updateTask(root, now, { task: b.stem, description: "ok-backlog" });
    assert.match(h.getTask(root, { task: b.stem, sections: ["description"] }), /ok-backlog/);

    // (c) Done + outside the window but still within the 2h grace -> editable.
    const c = mk(14, 30, "fresh-done");
    h.createTask(root, c.d, { name: "fresh-done", summary: "s" });
    h.updateTask(root, c.d, { task: c.stem, status: "Done" });
    for (let i = 0; i < 3; i++) h.createTask(root, new Date(2026, 5, 4, 14, 40 + i), { name: `q${i}`, summary: "q" });
    h.updateTask(root, now, { task: c.stem, description: "ok-fresh" }); // 30min old < 2h
    assert.match(h.getTask(root, { task: c.stem, sections: ["description"] }), /ok-fresh/);
  });
});

// Description size cap: a two-tier guard parallel to the summary's, but with softer
// semantics. Up to the SOFT cap a write is unaffected. Between the soft and HARD caps
// the write STILL succeeds, but the handler appends a warning nudging the agent toward
// decomposition + linking (memosyne_link). Past the hard cap the write is REFUSED
// (ToolError) on every path that sets the description.
test("description over the hard cap is refused on create/update/patch", () => {
  withRoot((root) => {
    const stem = buildStem(D, "demo");
    const over = "x".repeat(DESCRIPTION_HARD_MAX + 1);

    // create
    assert.throws(() => h.createTask(root, D, { name: "demo", summary: "s", description: over }), h.ToolError);
    // The refused create wrote nothing — the task does not exist.
    assert.throws(() => h.getTask(root, { task: stem }), h.ToolError);

    // update + patch on an existing task
    h.createTask(root, D, { name: "demo", summary: "s", description: "small" });
    assert.throws(() => h.updateTask(root, D, { task: stem, description: over }), h.ToolError);
    assert.throws(
      () => h.editTask(root, D, { task: stem, old_text: "small", new_text: over }),
      h.ToolError,
    );
    // The refused writes left the original description intact.
    assert.match(h.getTask(root, { task: stem, sections: ["description"] }), /small/);
  });
});

test("a description between the soft and hard caps saves but the result carries a warning", () => {
  withRoot((root) => {
    const stem = buildStem(D, "demo");
    const big = "x".repeat(DESCRIPTION_SOFT_MAX + 1);

    // create: succeeds AND the returned message warns (mentions the soft limit + memosyne_link).
    const created = h.createTask(root, D, { name: "demo", summary: "s", description: big });
    assert.match(created, /soft limit/i);
    assert.match(created, /memosyne_link/);
    // The task really was saved with the big description.
    assert.match(h.getTask(root, { task: stem, sections: ["description"] }), /x{3001}/);

    // update + patch into the warn band also save and warn.
    assert.match(h.updateTask(root, D, { task: stem, description: big }), /memosyne_link/);
    assert.match(
      h.editTask(root, D, { task: stem, old_text: big, new_text: big + "y" }),
      /memosyne_link/,
    );
  });
});

test("a description at the soft cap saves with no warning, and the warning only fires when the description is written", () => {
  withRoot((root) => {
    const stem = buildStem(D, "demo");
    const atCap = "x".repeat(DESCRIPTION_SOFT_MAX);

    // Exactly at the soft cap: no warning.
    const created = h.createTask(root, D, { name: "demo", summary: "s", description: atCap });
    assert.doesNotMatch(created, /memosyne_link/);

    // Grow it past the soft cap so the stored description is large…
    h.updateTask(root, D, { task: stem, description: "x".repeat(DESCRIPTION_SOFT_MAX + 1) });
    // …then an update that does NOT touch the description must not warn, even though the
    // stored description is over the soft cap (the guard fires on WRITE, not on read).
    const statusOnly = h.updateTask(root, D, { task: stem, status: "Active" });
    assert.doesNotMatch(statusOnly, /memosyne_link/);
  });
});

// Regression (M1): a description whose body contains a line that LOOKS like a
// section header (e.g. when the task documents Memosyne itself) must survive a
// section-subset read. The buggy renderSections re-serializes and splits on
// /^# <memosyne-/, so such a line spawns a phantom block that the subset filter drops
// — taking the rest of the description ("the tail") with it.
test("memosyne_get_task(sections) preserves a description containing an <memosyne-…>-like line (M1)", () => {
  withRoot((root) => {
    const stem = buildStem(D, "meta");
    const description = ["Intro line.", "# <memosyne-files>Files</memosyne-files>", "Tail after the memosyne-like line."].join("\n");
    h.createTask(root, D, { name: "meta", summary: "s", description });

    // The full read (all sections) is the unaffected path — the tail is there.
    const full = h.getTask(root, { task: stem });
    assert.ok(full.includes("Tail after the memosyne-like line."), "full read should keep the tail");

    // The subset read is the bug: the tail must NOT be dropped.
    const onlyDesc = h.getTask(root, { task: stem, sections: ["description"] });
    assert.ok(onlyDesc.includes("Intro line."), "subset read should keep the head");
    assert.ok(
      onlyDesc.includes("Tail after the memosyne-like line."),
      "subset read dropped the description tail after the <memosyne-…>-like line (M1)",
    );
  });
});

// Render-safety is now enforced by the web renderer (it escapes every angle-bracket
// sequence to a literal — see src/web/assets/js/markdown.js), NOT by a write-time
// validator. summary/description therefore accept arbitrary HTML-like text verbatim:
// it is agent memory, and the render can no longer drop content. (The renderer's
// escaping behavior is covered by tests/web/… markdown tests.)
test("render-safety: arbitrary HTML-like text in summary/description is accepted verbatim", () => {
  withRoot((root) => {
    const description = "URL .../map-objects/<id>/download and assets/<name>/<dir>.png plus <script>x</script>";
    const summary = "tokens <id> <name> <i> survive";
    h.createTask(root, D, { name: "raw", summary, description });
    const stem = buildStem(D, "raw");
    assert.ok(h.getTask(root, { task: stem, sections: ["description"] }).includes("<id>"));

    // update + patch take the same text without rejection.
    h.updateTask(root, D, { task: stem, description: "<textarea>kept" });
    h.editTask(root, D, {
      task: stem,
      section: "description",
      old_text: "<textarea>kept",
      new_text: "<script>also kept</script>",
    });
    assert.ok(h.getTask(root, { task: stem, sections: ["description"] }).includes("<script>"));
  });
});

// ---------------------------------------------------------------------------
// Non-happy paths: agent misuse (hallucinated / garbage input, ignored
// instructions). Each asserts a readable ToolError and/or that the on-disk task is
// neither corrupted nor silently mutated.
// ---------------------------------------------------------------------------

// A1: the summary is serialized as its own body line, so a summary whose text is an
// memosyne-section header is read back as the START of a new section — silently dropping
// the summary and swallowing the sections that follow (a `# <memosyne-description>` form
// absorbs status/related/files/description). The write-time validator rejects it.
test("a summary that looks like an memosyne-section header is rejected on create/update/edit (A1)", () => {
  withRoot((root) => {
    const headerish = "# <memosyne-description>x</memosyne-description>";
    assert.throws(() => h.createTask(root, D, { name: "a1", summary: headerish }), h.ToolError);
    assert.throws(
      () => h.createTask(root, D, { name: "a1b", summary: "# <memosyne-status>Active</memosyne-status>" }),
      h.ToolError,
    );

    const stem = buildStem(D, "demo");
    h.createTask(root, D, { name: "demo", summary: "S", description: "body" });
    assert.throws(() => h.updateTask(root, D, { task: stem, summary: headerish }), h.ToolError);
    assert.throws(
      () => h.editTask(root, D, { task: stem, section: "summary", old_text: "S", new_text: headerish }),
      h.ToolError,
    );
    // The escaped form (backticks / a plain markdown heading) is NOT a header line, so it passes.
    h.createTask(root, new Date(2026, 5, 4, 16, 0), { name: "a1ok", summary: "fixing `# <memosyne-status>` parsing" });
    h.createTask(root, new Date(2026, 5, 4, 16, 1), { name: "a1ok2", summary: "# Overview of the change" });
  });
});

// A2: an empty/whitespace summary is a broken hand-off — the summary is the
// headline every listing shows. Reject it everywhere a summary is set.
test("an empty or whitespace-only summary is rejected on create/update/edit (A2)", () => {
  withRoot((root) => {
    assert.throws(() => h.createTask(root, D, { name: "e", summary: "" }), h.ToolError);
    assert.throws(() => h.createTask(root, D, { name: "e2", summary: "   " }), h.ToolError);

    const stem = buildStem(D, "demo");
    h.createTask(root, D, { name: "demo", summary: "S" });
    assert.throws(() => h.updateTask(root, D, { task: stem, summary: "  " }), h.ToolError);
    assert.throws(
      () => h.editTask(root, D, { task: stem, section: "summary", old_text: "S", new_text: "   " }),
      h.ToolError,
    );
  });
});

// A3: a stem reaches a mutating handler straight from the agent. Such handlers take
// the per-task lock first, where a malformed/traversal stem used to throw a raw
// storage Error. They must surface a clean ToolError instead (the read path already
// does). Traversal stays blocked either way — this is about the error's shape.
test("mutating handlers reject a traversal/malformed stem with a ToolError, not a raw Error (A3)", () => {
  withRoot((root) => {
    const ok = buildStem(D, "ok");
    h.createTask(root, D, { name: "ok", summary: "ok" });
    for (const bad of ["../escape", "not-a-stem", "2026-06-04--15-08--a\\b"]) {
      assert.throws(() => h.updateTask(root, D, { task: bad, status: "Done" }), h.ToolError);
      assert.throws(
        () => h.editTask(root, D, { task: bad, section: "status", old_text: "x", new_text: "y" }),
        h.ToolError,
      );
      assert.throws(() => h.deleteTask(root, { task: bad }), h.ToolError);
      assert.throws(() => h.linkTasks(root, { task: bad, related: ok }), h.ToolError);
      assert.throws(() => h.unlinkTasks(root, { task: ok, related: bad }), h.ToolError);
    }
  });
});

// A4: a name with no letters/digits slugifies to the placeholder "task", so distinct
// garbage names silently collide. Reject it with a clear reason.
test("a name with no letters or digits is rejected instead of slugifying to \"task\" (A4)", () => {
  withRoot((root) => {
    assert.throws(() => h.createTask(root, D, { name: "!!!", summary: "s" }), h.ToolError);
    // A name that merely CONTAINS letters (incl. the literal word "task") is fine.
    h.createTask(root, new Date(2026, 5, 4, 16, 0), { name: "task", summary: "s" });
  });
});

// B3: editing status to a blank/empty value must be rejected by the status
// vocabulary check, not written as an invalid status.
test("editing the status section to a blank value is rejected (B3)", () => {
  withRoot((root) => {
    const stem = buildStem(D, "demo");
    h.createTask(root, D, { name: "demo", summary: "S", status: "Active" });
    assert.throws(
      () => h.editTask(root, D, { task: stem, section: "status", old_text: "Active", new_text: "   " }),
      h.ToolError,
    );
    assert.match(h.getTask(root, { task: stem, sections: ["status"] }), /Active/);
  });
});

// B4: editing the summary to empty hits the same A2 guard.
test("editing the summary section to empty is rejected (B4)", () => {
  withRoot((root) => {
    const stem = buildStem(D, "demo");
    h.createTask(root, D, { name: "demo", summary: "Some summary" });
    assert.throws(
      () => h.editTask(root, D, { task: stem, section: "summary", old_text: "Some summary", new_text: "" }),
      h.ToolError,
    );
    assert.match(h.getTask(root, { task: stem, sections: ["summary"] }), /Some summary/);
  });
});

// B5: tags are capped at MAX_TAGS on the INPUT path (not only when parsing on read).
test("file tags are capped at MAX_TAGS on input (B5)", () => {
  withRoot((root) => {
    const stem = buildStem(D, "demo");
    h.createTask(root, D, {
      name: "demo",
      summary: "s",
      files: [{ path: "src/x.ts", priority: "P0", tags: ["a", "b", "c", "d", "e", "f", "g"] }],
    });
    const files = h.getTask(root, { task: stem, sections: ["files"] });
    assert.match(files, /a, b, c, d, e/);
    assert.doesNotMatch(files, /\bf\b/);
    assert.doesNotMatch(files, /\bg\b/);
  });
});

// B7: deleting a missing task returns a not-found message, never throws.
test("deleteTask on a missing task returns a not-found message (B7)", () => {
  withRoot((root) => {
    const absent = buildStem(new Date(2026, 5, 4, 9, 0), "absent");
    assert.match(h.deleteTask(root, { task: absent }), /not found/i);
  });
});

// B8: an empty sections array means "all sections" (not "no sections").
test("getTask with an empty sections array returns all sections (B8)", () => {
  withRoot((root) => {
    const stem = buildStem(D, "demo");
    h.createTask(root, D, { name: "demo", summary: "Sum", description: "Body" });
    const out = h.getTask(root, { task: stem, sections: [] });
    for (const s of ["memosyne-summary", "memosyne-status", "memosyne-related", "memosyne-files", "memosyne-description"])
      assert.ok(out.includes(s));
  });
});

// B9: a file entry with an empty/whitespace path is rejected (it would serialize to a
// line the file parser cannot read back — a silently lost reference).
test("a file entry with an empty/whitespace path is rejected (B9)", () => {
  withRoot((root) => {
    assert.throws(
      () => h.createTask(root, D, { name: "demo", summary: "s", files: [{ path: "  ", priority: "P0" }] }),
      h.ToolError,
    );
  });
});

// B10: a negative `expanded` is treated as "no cap", consistent with 0.
test("a negative expanded is treated as no cap, like 0 (B10)", () => {
  withRoot((root) => {
    for (let i = 0; i < 12; i++)
      h.createTask(root, new Date(2026, 5, 4, 15, i), { name: `t${i}`, summary: `task ${i}` });
    assert.match(h.listTasks(root, { expanded: -1 }), /Showing 12 of 12/);
  });
});

// C1: a catastrophic-backtracking pattern (ReDoS) must abort on the time budget and
// surface a ToolError, instead of hanging the single-threaded server. The match runs
// in a worker; the timeout terminates it. Budget is lowered via env for the test.
test("a catastrophic regex is aborted by the timeout instead of hanging the server (C1)", async () => {
  await withRootAsync(async (root) => {
    // 'aaaa…aX' against /(a+)+$/ forces exponential backtracking (never matches the X).
    h.createTask(root, D, { name: "demo", summary: "s", description: "a".repeat(60) + "X" });
    const prev = process.env.MEMOSYNE_SEARCH_TIMEOUT_MS;
    process.env.MEMOSYNE_SEARCH_TIMEOUT_MS = "300";
    try {
      await assert.rejects(() => h.searchText(root, { query: "(a+)+$" }), h.ToolError);
    } finally {
      if (prev === undefined) delete process.env.MEMOSYNE_SEARCH_TIMEOUT_MS;
      else process.env.MEMOSYNE_SEARCH_TIMEOUT_MS = prev;
    }
  });
});

// C2: a regex that matches the empty string returns every task without crashing.
test("a regex that matches the empty string returns all tasks without crashing (C2)", async () => {
  await withRootAsync(async (root) => {
    h.createTask(root, new Date(2026, 5, 4, 8, 0), { name: "a", summary: "alpha" });
    h.createTask(root, new Date(2026, 5, 4, 8, 1), { name: "b", summary: "beta" });
    assert.match(await h.searchText(root, { query: ".*" }), /Showing 2 of 2/);
  });
});

// C3: when the per-task lock cannot be acquired, a mutating handler surfaces a
// readable error and never runs the critical section unlocked.
test("a mutating handler surfaces a readable error when the task lock is held (C3)", () => {
  withRoot((root) => {
    const stem = buildStem(D, "demo");
    h.createTask(root, D, { name: "demo", summary: "s" });
    const lockPath = join(storeDir(root), `${stem}.lock`);
    writeFileSync(lockPath, ""); // a fresh holder (mtime = now, not stale)

    const prev = { wait: process.env.MEMOSYNE_LOCK_WAIT_MS, stale: process.env.MEMOSYNE_LOCK_STALE_MS };
    process.env.MEMOSYNE_LOCK_WAIT_MS = "100";
    process.env.MEMOSYNE_LOCK_STALE_MS = "999999";
    try {
      assert.throws(() => h.updateTask(root, D, { task: stem, status: "Done" }), /Could not acquire the lock/);
      // The write was refused: status is still the default Backlog, not Done.
      assert.match(h.getTask(root, { task: stem, sections: ["status"] }), /Backlog/);
    } finally {
      if (prev.wait === undefined) delete process.env.MEMOSYNE_LOCK_WAIT_MS;
      else process.env.MEMOSYNE_LOCK_WAIT_MS = prev.wait;
      if (prev.stale === undefined) delete process.env.MEMOSYNE_LOCK_STALE_MS;
      else process.env.MEMOSYNE_LOCK_STALE_MS = prev.stale;
      try {
        rmSync(lockPath);
      } catch {
        /* already gone */
      }
    }
  });
});

// --- memosyne_edit_task: exact old_text/new_text, read-first, unique-or-fail ---

test("editTask replaces a unique snippet in the default (description) section, leaving the rest intact", () => {
  withRoot((root) => {
    const stem = buildStem(D, "demo");
    h.createTask(root, D, { name: "demo", summary: "S", description: "Line A\nLine B\nLine C" });
    // No section -> defaults to description (parity with patch/update).
    const msg = h.editTask(root, D, { task: stem, old_text: "Line B", new_text: "Line B edited" });
    const body = h.getTask(root, { task: stem, sections: ["description"] });
    assert.match(body, /Line B edited/);
    assert.match(body, /Line A/); // neighbours untouched — guards against a whole-section overwrite
    assert.match(body, /Line C/);
    assert.doesNotMatch(body, /Line B\n/); // the old "Line B" line is gone
    assert.match(msg, /Edited description/);
  });
});

test("editTask on an absent old_text throws, writes nothing, and quotes the live section", () => {
  withRoot((root) => {
    const stem = buildStem(D, "demo");
    h.createTask(root, D, { name: "demo", summary: "S", description: "The body text." });
    assert.throws(
      () => h.editTask(root, D, { task: stem, old_text: "nowhere", new_text: "x" }),
      (err: unknown) => {
        assert.ok(err instanceof h.ToolError);
        assert.match((err as Error).message, /The body text\./); // error hands back the live body to copy from
        return true;
      },
    );
    // Nothing was written: the original body survives verbatim.
    assert.match(h.getTask(root, { task: stem, sections: ["description"] }), /The body text\./);
  });
});

test("editTask refuses an ambiguous (non-unique) old_text unless replace_all is set", () => {
  withRoot((root) => {
    const stem = buildStem(D, "demo");
    h.createTask(root, D, { name: "demo", summary: "S", description: "foo bar foo baz foo" });

    // Ambiguous without replace_all -> refuse, name the count, change nothing.
    assert.throws(
      (): void => void h.editTask(root, D, { task: stem, old_text: "foo", new_text: "X" }),
      (err: unknown) => {
        assert.ok(err instanceof h.ToolError);
        assert.match((err as Error).message, /3/); // the ambiguous count is reported
        return true;
      },
    );
    assert.match(h.getTask(root, { task: stem, sections: ["description"] }), /foo bar foo baz foo/); // unchanged

    // replace_all: true replaces EVERY occurrence.
    h.editTask(root, D, { task: stem, old_text: "foo", new_text: "X", replace_all: true });
    const body = h.getTask(root, { task: stem, sections: ["description"] });
    assert.equal((body.match(/X/g) ?? []).length, 3); // all three, not just one
    assert.doesNotMatch(body, /foo/);
    // The interleaving text must survive in place — guards against a whole-section overwrite
    // that would also satisfy the count check.
    assert.match(body, /X bar X baz X/);
  });
});

test("editTask deletes the matched text when new_text is empty, keeping the tail", () => {
  withRoot((root) => {
    const stem = buildStem(D, "demo");
    h.createTask(root, D, { name: "demo", summary: "S", description: "Line A\nLine B" });
    h.editTask(root, D, { task: stem, old_text: "Line A\n", new_text: "" });
    const body = h.getTask(root, { task: stem, sections: ["description"] });
    assert.doesNotMatch(body, /Line A/);
    assert.match(body, /Line B/); // the deletion must not eat the tail
  });
});

test("editTask treats new_text identical to old_text as a no-op error and writes nothing", () => {
  withRoot((root) => {
    const stem = buildStem(D, "demo");
    h.createTask(root, D, { name: "demo", summary: "S", description: "unchanged body" });
    assert.throws(
      (): void => void h.editTask(root, D, { task: stem, old_text: "body", new_text: "body" }),
      h.ToolError,
    );
    assert.match(h.getTask(root, { task: stem, sections: ["description"] }), /unchanged body/);
  });
});

test("editTask preserves new_text literally, without $-substitution", () => {
  withRoot((root) => {
    const stem = buildStem(D, "demo");
    h.createTask(root, D, { name: "demo", summary: "S", description: "PLACEHOLDER here" });
    // $&, $1, $$ are special to String.replace/replaceAll — the impl must NOT go through them.
    h.editTask(root, D, { task: stem, old_text: "PLACEHOLDER", new_text: "$& $1 $$ price is $5" });
    assert.match(h.getTask(root, { task: stem, sections: ["description"] }), /\$& \$1 \$\$ price is \$5/);
  });
});

test("editTask rejects an empty old_text at the handler boundary without hanging", () => {
  withRoot((root) => {
    const stem = buildStem(D, "demo");
    h.createTask(root, D, { name: "demo", summary: "S", description: "body" });
    // The schema minLength:1 blocks this at the MCP boundary, but the handler is called
    // directly here, so it must self-guard (an empty needle would otherwise match everywhere).
    assert.throws(
      (): void => void h.editTask(root, D, { task: stem, old_text: "", new_text: "x" }),
      h.ToolError,
    );
  });
});

test("editTask routes per-section validation: summary newlines rejected, status enum enforced", () => {
  withRoot((root) => {
    const stem = buildStem(D, "demo");
    h.createTask(root, D, { name: "demo", summary: "Some summary" }); // default status Backlog

    // summary edit that introduces a newline -> validateSummary rejects.
    assert.throws(
      (): void => void h.editTask(root, D, { task: stem, section: "summary", old_text: "summary", new_text: "a\nb" }),
      h.ToolError,
    );

    // status edit to a valid enum value succeeds; to a bogus / blank value it is rejected.
    h.editTask(root, D, { task: stem, section: "status", old_text: "Backlog", new_text: "Active" });
    assert.match(h.getTask(root, { task: stem, sections: ["status"] }), /Active/);
    assert.throws(
      (): void => void h.editTask(root, D, { task: stem, section: "status", old_text: "Active", new_text: "Bogus" }),
      h.ToolError,
    );
  });
});

test("editTask honours the stale-Done guard and its force override", () => {
  withRoot((root) => {
    const old = new Date(2026, 5, 4, 10, 0);
    const stem = buildStem(old, "old-done");
    h.createTask(root, old, { name: "old-done", summary: "s", description: "body" });
    h.updateTask(root, old, { task: stem, status: "Done" });
    for (let i = 0; i < 3; i++) h.createTask(root, new Date(2026, 5, 4, 12, i), { name: `newer${i}`, summary: "n" });

    const now = new Date(2026, 5, 4, 15, 0); // 5h after creation, past the 2h grace
    assert.throws(
      (): void => void h.editTask(root, now, { task: stem, old_text: "body", new_text: "x" }),
      h.ToolError,
    );
    // force: true overrides the guard and the edit lands.
    h.editTask(root, now, { task: stem, old_text: "body", new_text: "forced", force: true });
    assert.match(h.getTask(root, { task: stem, sections: ["description"] }), /forced/);
  });
});

test("editTask enforces the description size guard: hard cap refused, soft cap warns", () => {
  withRoot((root) => {
    const stem = buildStem(D, "demo");
    h.createTask(root, D, { name: "demo", summary: "S", description: "small" });

    // Over the hard cap -> refused, original intact.
    const over = "y".repeat(DESCRIPTION_HARD_MAX + 1);
    assert.throws(
      (): void => void h.editTask(root, D, { task: stem, old_text: "small", new_text: over }),
      h.ToolError,
    );
    assert.match(h.getTask(root, { task: stem, sections: ["description"] }), /small/);

    // Between soft and hard cap -> saved, with a warning in the return message.
    const soft = "z".repeat(DESCRIPTION_SOFT_MAX + 1);
    const msg = h.editTask(root, D, { task: stem, old_text: "small", new_text: soft });
    assert.match(msg, /memosyne_link/); // the soft-cap warning is appended
  });
});

test("editTask validates the task stem", () => {
  withRoot((root) => {
    assert.throws(
      (): void => void h.editTask(root, D, { task: "../escape", old_text: "x", new_text: "y" }),
      h.ToolError,
    );
  });
});

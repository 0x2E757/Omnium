// End-to-end MCP tests: spawn the real stdio server (activated against a temp
// project) via a minimal zero-dep stdio client (mcp-client.mts — the prior
// suite used the official SDK client; only the transport plumbing changed,
// every assertion is the ported original).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { MiniMcpClient } from "./mcp-client.mts";

import { writeFileSync } from "node:fs";

import { listProjects } from "../../../plugins/graphyne/common/registry.mjs";
import { checklist, status, review, refactor, bypass, forget, runTests } from "../../../plugins/graphyne/handlers.mjs";
import { readConfig } from "../../../plugins/graphyne/common/config.mjs";
import { linkFiles, neighbors } from "../../../plugins/graphyne/common/graph-store.mjs";
import { metaExists } from "../../../plugins/graphyne/common/storage.mjs";
import { recordTest, recordGrant, recordBypassGrant, readGrants, isBypassGrant, recordMute } from "../../../plugins/graphyne/common/session.mjs";
import { onEdit } from "../../../plugins/graphyne/common/engine.mjs";

// The shipped server entry point (the .mjs the plugin runs), not a dev-tree .mts.
const SERVER = fileURLToPath(new URL("../../../plugins/graphyne/server.mjs", import.meta.url));

// A temp project (with .graphyne + graphyne.json) for direct handler unit tests.
function tempProject(): string {
  const root = mkdtempSync(join(tmpdir(), "graphyne-h-"));
  mkdirSync(join(root, ".graphyne"), { recursive: true });
  writeFileSync(
    join(root, "graphyne.json"),
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

// Like tempProject but also classifies docs/specs, for the doc/spec gate handlers.
function tempProjectDocs(): string {
  const root = mkdtempSync(join(tmpdir(), "graphyne-h-"));
  mkdirSync(join(root, ".graphyne"), { recursive: true });
  writeFileSync(
    join(root, "graphyne.json"),
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
  return root;
}

type Ctx = { projectRoot: string; regRoot: string };

// Each spawned server gets its OWN temp GRAPHYNE_ROOT so its registry writes land
// in an isolated data/registry.json — never the real repo's — and are cleaned up.
async function withClient(fn: (client: MiniMcpClient, ctx: Ctx) => Promise<void>): Promise<void> {
  const projectRoot = mkdtempSync(join(tmpdir(), "graphyne-mcp-"));
  const regRoot = mkdtempSync(join(tmpdir(), "graphyne-reg-"));
  mkdirSync(join(projectRoot, ".graphyne"), { recursive: true });
  const client = await MiniMcpClient.connect(
    "node",
    [SERVER],
    { ...process.env, GRAPHYNE_PROJECT_DIR: projectRoot, GRAPHYNE_ROOT: regRoot } as Record<string, string>,
  );
  try {
    await fn(client, { projectRoot, regRoot });
  } finally {
    await client.close();
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(regRoot, { recursive: true, force: true });
  }
}

function textOf(res: unknown): string {
  const content = (res as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map((c) => c.text ?? "").join("");
}

test("server advertises the graphyne tools", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    for (const expected of [
      "graphyne_project",
      "graphyne_neighbors",
      "graphyne_link",
      "graphyne_unlink",
      "graphyne_test",
      "graphyne_checklist",
      "graphyne_review",
      "graphyne_status",
      "graphyne_meta_confirm",
    ]) {
      assert.ok(names.includes(expected), `missing tool ${expected}`);
    }
  });
});

test("link tool advertises multi-tag edges and the 5-tag cap", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const link = tools.find((t) => t.name === "graphyne_link");
    assert.ok(link, "graphyne_link tool present");
    const tagsDesc = ((link.inputSchema as { properties?: Record<string, { description?: string }> })
      .properties?.tags?.description) ?? "";
    // multi-tag is normal: shows a 2-tag example and says an edge can carry several
    assert.match(tagsDesc, /several|more than one|one or more/i);
    assert.match(tagsDesc, /up to 5/i);
  });
});

test("meta_confirm on a file not edited this session reports nothing to confirm", async () => {
  await withClient(async (client) => {
    const res = await client.callTool({
      name: "graphyne_meta_confirm",
      arguments: { path: "src/a.ts" },
    });
    assert.match(textOf(res), /not edited this session/i);
  });
});

test("link then neighbors round-trips through the server", async () => {
  await withClient(async (client) => {
    const linked = await client.callTool({
      name: "graphyne_link",
      arguments: { path: "src/a.ts", related: "test/a.test.ts", tags: ["test"] },
    });
    assert.match(textOf(linked), /Linked src\/a\.ts <-> test\/a\.test\.ts/);

    const neighbors = await client.callTool({
      name: "graphyne_neighbors",
      arguments: { path: "src/a.ts" },
    });
    assert.match(textOf(neighbors), /test\/a\.test\.ts \[test\]/);
  });
});

test("checklist reports nothing outstanding on a fresh session", async () => {
  await withClient(async (client) => {
    const res = await client.callTool({ name: "graphyne_checklist", arguments: {} });
    assert.match(textOf(res), /Nothing outstanding/);
  });
});

test("checklist and status carry a muted banner while the session is muted", () => {
  const root = tempProject();
  try {
    const c = readConfig(root);
    recordMute(root, "s1", new Date().toISOString());
    assert.match(checklist(root, c, "s1"), /MUTED/);
    assert.match(checklist(root, c, "s1"), /graphyne:on/);
    assert.match(status(root, c, "s1"), /MUTED/);
    // unmuted sessions stay banner-free
    assert.doesNotMatch(checklist(root, c, "s2"), /MUTED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checklist surfaces red covering tests for edited source", () => {
  const root = tempProject();
  try {
    const c = readConfig(root);
    const now = new Date().toISOString();
    linkFiles(root, "src/a.ts", "test/a.test.ts", ["test"]);
    recordTest(root, "s1", "test/a.test.ts", "red", now);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/a.ts"), ""); // on disk -> a present, edited file
    onEdit(root, c, "s1", "src/a.ts", now); // edit the covered source
    const out = checklist(root, c, "s1");
    assert.match(out, /RED/);
    assert.match(out, /test\/a\.test\.ts/);
    assert.doesNotMatch(out, /Nothing outstanding/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Refactor's oracle is the project's test COMMAND (exit 0 = green). These tests drive
// it with deterministic `node -e "process.exit(N)"` commands rather than real
// node:test files: a nested `node --test` (this suite spawning the project's test
// runner) inherits NODE_TEST_CONTEXT, which zeroes a failing run's exit code — an
// artifact that would only mask the very red signal a couple of these tests assert.
function projectWithTest(testCmd: { file?: string; all?: string; timeoutMs?: number }): string {
  const root = mkdtempSync(join(tmpdir(), "graphyne-h-"));
  mkdirSync(join(root, ".graphyne"), { recursive: true });
  writeFileSync(
    join(root, "graphyne.json"),
    JSON.stringify({
      source: ["src/**/*.ts"],
      exclude: ["**/*.test.ts"],
      tests: ["**/*.test.ts"],
      metaExclude: ["**/*.md"],
      test: testCmd,
    }),
  );
  return root;
}

const PASS_CMD = 'node -e "process.exit(0)"';
const FAIL_CMD = 'node -e "process.exit(1)"';

test("graphyne_test: a shell-metacharacter test path is refused before spawn (route 1 injection)", () => {
  const root = tempProject(); // test.file = "node --test {test}"
  try {
    const c = readConfig(root);
    assert.throws(
      () => runTests(root, c, "s1", { test: "x; touch pwned" }, new Date().toISOString()),
      /inject|unsafe|metacharacter/i,
    );
    assert.equal(existsSync(join(root, "pwned")), false, "the injected command must not have run");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("graphyne_test: a timed-out run is a normal RED result with the marker, not a ToolError", () => {
  // A hang is a property of the test run (an oracle failure), not of the tool
  // call: it must go through recordTest as red, never throw.
  // The {test} path lands in the sleeper's process.argv, where node ignores it.
  const root = projectWithTest({ file: 'node -e "setTimeout(()=>{},10e3)" {test}', timeoutMs: 300 });
  try {
    const c = readConfig(root);
    const out = runTests(root, c, "s1", { test: "a.test.ts" }, new Date().toISOString());
    assert.match(out, /RED/);
    assert.match(out, /timed out/i);
    assert.match(out, /300/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refactor: a poisoned covering-test edge cannot inject a command (route 2 repo-poisoning RCE)", () => {
  const root = projectWithTest({ file: "node --test {test}" });
  try {
    const c = readConfig(root);
    // Model a committed .graphyne/meta edge whose covering-test path is a payload.
    linkFiles(root, "src/a.ts", "$(touch pwned).test.ts", ["test"]);
    assert.throws(
      () => refactor(root, c, "s1", { path: "src/a.ts", reason: "r" }, new Date().toISOString()),
      /inject|unsafe|metacharacter/i,
    );
    assert.equal(existsSync(join(root, "pwned")), false, "the poisoned edge must never reach the shell");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bypass: a shell-metacharacter declared-test path is refused before spawn (route 2 via bypass)", () => {
  const root = projectWithTest({ file: "node --test {test}" });
  try {
    const c = readConfig(root);
    assert.throws(
      () =>
        bypass(
          root,
          c,
          "s1",
          { files: [{ path: "src/a.ts", tests: ["$(touch pwned).test.ts"], reason: "r" }] },
          new Date().toISOString(),
        ),
      /inject|unsafe|metacharacter/i,
    );
    assert.equal(existsSync(join(root, "pwned")), false, "the poisoned declared test must never reach the shell");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refactor: green covering test opens a delete-only grant", () => {
  const root = projectWithTest({ file: PASS_CMD });
  try {
    const c = readConfig(root);
    linkFiles(root, "src/a.ts", "a.test.ts", ["test"]);
    const out = refactor(root, c, "s1", { path: "src/a.ts", reason: "remove dead helper" }, new Date().toISOString());
    assert.match(out, /OPEN/i);
    const grant = readGrants(root, "s1")["src/a.ts"];
    if (isBypassGrant(grant)) throw new Error("expected a delete-only grant");
    assert.equal(grant.oracle, "covering");
    assert.equal(grant.reason, "remove dead helper");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refactor: a red covering test denies the grant", () => {
  const root = projectWithTest({ file: FAIL_CMD });
  try {
    const c = readConfig(root);
    linkFiles(root, "src/b.ts", "b.test.ts", ["test"]);
    const out = refactor(root, c, "s1", { path: "src/b.ts", reason: "r" }, new Date().toISOString());
    assert.match(out, /DENIED/i);
    assert.equal(readGrants(root, "s1")["src/b.ts"], undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refactor: no covering test falls back to a green full suite (oracle 'all')", () => {
  const root = projectWithTest({ file: PASS_CMD, all: PASS_CMD });
  try {
    const c = readConfig(root);
    const out = refactor(root, c, "s1", { path: "src/c.ts", reason: "drop dead module" }, new Date().toISOString());
    assert.match(out, /OPEN/i);
    const grant = readGrants(root, "s1")["src/c.ts"];
    if (isBypassGrant(grant)) throw new Error("expected a delete-only grant");
    assert.equal(grant.oracle, "all");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refactor: a red full suite denies the grant when there's no covering test", () => {
  const root = projectWithTest({ file: PASS_CMD, all: FAIL_CMD });
  try {
    const c = readConfig(root);
    const out = refactor(root, c, "s1", { path: "src/d.ts", reason: "r" }, new Date().toISOString());
    assert.match(out, /DENIED/i);
    assert.equal(readGrants(root, "s1")["src/d.ts"], undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refactor: a missing reason is rejected", () => {
  const root = tempProject();
  try {
    const c = readConfig(root);
    assert.throws(
      () => refactor(root, c, "s1", { path: "src/a.ts", reason: "  " }, new Date().toISOString()),
      /reason/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bypass: green declared tests open a self-attested window per file", () => {
  const root = projectWithTest({ file: PASS_CMD });
  try {
    const c = readConfig(root);
    const out = bypass(
      root,
      c,
      "s1",
      { files: [{ path: "src/a.ts", tests: ["a.test.ts"], reason: "inline a dead var" }] },
      new Date().toISOString(),
    );
    assert.match(out, /OPEN/i);
    const g = readGrants(root, "s1")["src/a.ts"];
    assert.ok(g && isBypassGrant(g));
    assert.deepEqual((g as { tests: string[] }).tests, ["a.test.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bypass: a red declared test denies the whole bypass (opens nothing)", () => {
  const root = projectWithTest({ file: FAIL_CMD });
  try {
    const c = readConfig(root);
    const out = bypass(
      root,
      c,
      "s1",
      { files: [{ path: "src/b.ts", tests: ["b.test.ts"], reason: "r" }] },
      new Date().toISOString(),
    );
    assert.match(out, /DENIED/i);
    assert.equal(readGrants(root, "s1")["src/b.ts"], undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bypass: all-or-nothing — one red declared test opens NO grant for any file", () => {
  const root = projectWithTest({ file: FAIL_CMD });
  try {
    const c = readConfig(root);
    bypass(
      root,
      c,
      "s1",
      {
        files: [
          { path: "src/a.ts", tests: ["a.test.ts"], reason: "r1" },
          { path: "src/b.ts", tests: ["b.test.ts"], reason: "r2" },
        ],
      },
      new Date().toISOString(),
    );
    assert.deepEqual(readGrants(root, "s1"), {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bypass: a file with no declared tests is rejected", () => {
  const root = tempProject();
  try {
    const c = readConfig(root);
    assert.throws(
      () => bypass(root, c, "s1", { files: [{ path: "src/a.ts", tests: [], reason: "r" }] }, new Date().toISOString()),
      /test/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bypass: a missing reason is rejected", () => {
  const root = tempProject();
  try {
    const c = readConfig(root);
    assert.throws(
      () =>
        bypass(
          root,
          c,
          "s1",
          { files: [{ path: "src/a.ts", tests: ["a.test.ts"], reason: "  " }] },
          new Date().toISOString(),
        ),
      /reason/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bypass: a non-gated file is rejected", () => {
  const root = tempProject();
  try {
    const c = readConfig(root);
    assert.throws(
      () =>
        bypass(
          root,
          c,
          "s1",
          { files: [{ path: "README.md", tests: ["a.test.ts"], reason: "r" }] },
          new Date().toISOString(),
        ),
      /not gated/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checklist surfaces a bypass window awaiting green-after", () => {
  const root = tempProject();
  try {
    const c = readConfig(root);
    recordBypassGrant(root, "s1", "src/a.ts", ["test/a.test.ts"], "refactor", "2026-06-06T12:00:00.000Z");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/a.ts"), "");
    onEdit(root, c, "s1", "src/a.ts", "2026-06-06T13:00:00.000Z");
    const out = checklist(root, c, "s1");
    assert.match(out, /bypass|green-after/i);
    assert.match(out, /src\/a\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checklist surfaces an all-grant awaiting re-verification", () => {
  const root = tempProject();
  try {
    const c = readConfig(root);
    recordGrant(root, "s1", "src/a.ts", "all", "dead", "2026-06-06T12:00:00.000Z");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/a.ts"), "");
    onEdit(root, c, "s1", "src/a.ts", "2026-06-06T13:00:00.000Z");
    const out = checklist(root, c, "s1");
    assert.match(out, /re-verif|refactor grant/i);
    assert.match(out, /src\/a\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checklist surfaces a deleted file whose meta lingers (deletedWithMeta)", () => {
  const root = tempProject();
  try {
    const c = readConfig(root);
    linkFiles(root, "src/a.ts", "src/b.ts", ["consumer"]); // a gets a meta + edge
    onEdit(root, c, "s1", "src/a.ts", new Date().toISOString()); // edited; never on disk -> deleted
    const out = checklist(root, c, "s1");
    assert.match(out, /deleted/i);
    assert.match(out, /graphyne_forget/);
    assert.match(out, /src\/a\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("forget prunes a deleted file's orphan meta + neighbor edges and stops blocking", () => {
  const root = tempProject();
  try {
    const c = readConfig(root);
    linkFiles(root, "src/gone.ts", "src/keep.ts", ["consumer"]);
    onEdit(root, c, "s1", "src/gone.ts", new Date().toISOString()); // edited, then deleted (never on disk)
    assert.match(checklist(root, c, "s1"), /src\/gone\.ts/);

    const out = forget(root, "s1", { path: "src/gone.ts" });
    assert.match(out, /src\/gone\.ts/);
    assert.equal(metaExists(root, "src/gone.ts"), false); // orphan meta deleted
    assert.deepEqual(neighbors(root, "src/keep.ts"), []); // reciprocal edge pruned
    // The deletedWithMeta blocker is cleared (the lingering neighbor-review of keep.ts,
    // flagged when gone.ts was edited, is a separate, legitimate item — not asserted here).
    assert.doesNotMatch(checklist(root, c, "s1"), /DELETED FROM DISK/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("forget refuses a file that still exists on disk", () => {
  const root = tempProject();
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/here.ts"), "x");
    assert.throws(() => forget(root, "s1", { path: "src/here.ts" }), /still exists|delete/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("server advertises the graphyne_forget tool with a path param", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const f = tools.find((t) => t.name === "graphyne_forget");
    assert.ok(f, "graphyne_forget advertised");
    const props = (f.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    assert.ok(props.path, "forget exposes a path param");
  });
});

test("server advertises the graphyne_refactor tool with a reason param", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const ref = tools.find((t) => t.name === "graphyne_refactor");
    assert.ok(ref, "graphyne_refactor advertised");
    const props = (ref.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    assert.ok(props.path, "refactor exposes a path param");
    assert.ok(props.reason, "refactor exposes a reason param");
  });
});

test("server advertises the graphyne_bypass tool with a files param", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const bp = tools.find((t) => t.name === "graphyne_bypass");
    assert.ok(bp, "graphyne_bypass advertised");
    const props = (bp.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    assert.ok(props.files, "bypass exposes a files param");
  });
});

test("review: a bare review can't clear a doc/spec item; a reason can", () => {
  const root = tempProjectDocs();
  try {
    const c = readConfig(root);
    const now = new Date().toISOString();
    linkFiles(root, "src/a.ts", "README.md", ["doc"]);
    onEdit(root, c, "s1", "src/a.ts", now); // hard-flags README

    const bare = review(root, "s1", { path: "README.md" });
    assert.match(bare, /doc/i);
    assert.match(bare, /reason|edit/i); // guidance: edit it or give a reason
    assert.match(checklist(root, c, "s1"), /README\.md/); // still outstanding

    const withReason = review(root, "s1", { path: "README.md", reason: "documents an unaffected area" });
    assert.match(withReason, /resolved/i);
    assert.doesNotMatch(checklist(root, c, "s1"), /README\.md/); // cleared
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Audit Low #7 (item 6): review() re-finds the item after the now-folding
// markReviewed. On a case-insensitive FS, reviewing a HARD doc/spec item under a
// different casing than its stored spelling must still trigger the "does NOT
// clear it" nudge — a case-sensitive re-find would miss the item and fall through
// to a false "resolved", suppressing the corrective guidance.
test("review folds path case so a HARD item reviewed under variant casing is not falsely resolved (win32)", () => {
  const root = tempProjectDocs();
  try {
    const c = readConfig(root);
    const now = new Date().toISOString();
    linkFiles(root, "src/a.ts", "docs/Guide.md", ["doc"]); // item keyed by docs/Guide.md
    onEdit(root, c, "s1", "src/a.ts", now, "main", "win32"); // hard-flags docs/Guide.md
    // Review the same file spelled docs/guide.md, no reason.
    const out = review(root, "s1", { path: "docs/guide.md" }, "win32");
    assert.doesNotMatch(out, /resolved/i); // NOT a false success
    assert.match(out, /does NOT clear it|reason|edit/i); // the corrective nudge fired
    assert.match(checklist(root, c, "s1"), /Guide\.md/i); // still outstanding
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review keeps a HARD item case-distinct on linux (variant casing = different file)", () => {
  const root = tempProjectDocs();
  try {
    const c = readConfig(root);
    const now = new Date().toISOString();
    linkFiles(root, "src/a.ts", "docs/Guide.md", ["doc"]);
    onEdit(root, c, "s1", "src/a.ts", now, "main", "linux");
    // On linux docs/guide.md is a genuinely different file -> nothing to review.
    const out = review(root, "s1", { path: "docs/guide.md" }, "linux");
    assert.match(out, /No checklist item/i);
    assert.match(checklist(root, c, "s1"), /Guide\.md/i); // the real item is untouched
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checklist labels a doc/spec item with its tags and the actualization rule", () => {
  const root = tempProjectDocs();
  try {
    const c = readConfig(root);
    const now = new Date().toISOString();
    linkFiles(root, "src/a.ts", "README.md", ["doc"]);
    onEdit(root, c, "s1", "src/a.ts", now);
    const out = checklist(root, c, "s1");
    assert.match(out, /README\.md/);
    assert.match(out, /\[doc\]/);
    assert.match(out, /reason/i); // explains a bare review won't clear it
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("graphyne_review advertises an optional reason (doc/spec actualization)", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    const rev = tools.find((t) => t.name === "graphyne_review")!;
    const props = (rev.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    assert.ok(props.reason, "review exposes a reason param for clearing doc/spec items");
  });
});

test("operating in a project registers it in the discovery registry", async () => {
  await withClient(async (client, { projectRoot, regRoot }) => {
    await client.callTool({
      name: "graphyne_link",
      arguments: { path: "src/a.ts", related: "test/a.test.ts", tags: ["test"] },
    });
    // Read the same isolated registry the server wrote to.
    process.env.GRAPHYNE_ROOT = regRoot;
    try {
      assert.ok(
        listProjects().some((p) => p.path === projectRoot),
        "project recorded in the registry after a link",
      );
    } finally {
      delete process.env.GRAPHYNE_ROOT;
    }
  });
});

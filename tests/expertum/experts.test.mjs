import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXPERT_BRIEF_LINE,
  GROUPS,
  loadCatalog,
  renderOverview,
  handleOverview,
  handleExpert,
} from "../../plugins/expertum/common/experts.mjs";

const EXPERTS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "plugins", "expertum", "experts",
);

/**
 * Write a throwaway experts directory from { filename: text } and return it.
 * @param {import("node:test").TestContext} t
 * @param {Record<string, string>} files
 */
function tmpExperts(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "expertum-experts-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), text, "utf8");
  }
  return dir;
}

const GOOD =
  "---\nname: a--design\ngroup: Platform\ndomain: things\n---\n\n" +
  "You are an A ANALYST.\n\n## Focus\n\n- f\n\n## Method\n\n- m\n";

test("the shipped catalog loads every expert with a known group, a domain, and a lens", () => {
  const catalog = loadCatalog(EXPERTS_DIR);
  assert.equal(catalog.experts.size, 54);
  for (const [name, expert] of catalog.experts) {
    assert.match(name, /^[a-z0-9-]+--[a-z]+$/);
    assert.equal(expert.name, name);
    assert.ok(GROUPS.includes(expert.group), `${name}: unknown group ${expert.group}`);
    assert.ok(expert.domain.length > 0, `${name}: empty domain`);
    assert.match(expert.body, /^You are an? .+ ANALYST\./, `${name}: missing role line`);
    assert.ok(expert.body.includes("## Focus"), `${name}: missing Focus`);
    assert.ok(expert.body.includes("## Method"), `${name}: missing Method`);
  }
  assert.match(catalog.lanes, /audit--security/);
});

test("the overview lists every expert under its group, with the spawn rule and the lanes", () => {
  const catalog = loadCatalog(EXPERTS_DIR);
  const text = renderOverview(catalog);
  for (const group of GROUPS) assert.ok(text.includes(`## ${group}`), `missing group ${group}`);
  for (const [name, expert] of catalog.experts) {
    assert.ok(text.includes(`- \`${name}\` — ${expert.domain}`), `missing row for ${name}`);
  }
  assert.ok(text.includes("`expertum:analyst`"));
  assert.ok(text.includes("## Ownership boundaries"));
  // Groups appear in the declared order.
  const positions = GROUPS.map((g) => text.indexOf(`## ${g}`));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
});

test("handleOverview returns the overview as a text tool result", () => {
  const catalog = loadCatalog(EXPERTS_DIR);
  const result = handleOverview(() => catalog);
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].text, renderOverview(catalog));
});

test("handleExpert returns a known expert's lens", () => {
  const catalog = loadCatalog(EXPERTS_DIR);
  const result = handleExpert({ name: "code--quality" }, () => catalog);
  assert.equal(result.isError, undefined);
  const text = result.content[0].text;
  assert.ok(text.includes(catalog.experts.get("code--quality")?.body ?? "<none>"));
  assert.match(text, /code--quality/);
});

test("handleExpert rejects unknown, path-like, and non-string names without touching the disk", () => {
  const catalog = loadCatalog(EXPERTS_DIR);
  for (const name of ["nope--design", "../agents/analyst", "_lanes", "", 42, undefined]) {
    const result = handleExpert({ name }, () => catalog);
    assert.equal(result.isError, true, `accepted ${String(name)}`);
    // The error reaches the analyst, which cannot call the overview: it must
    // tell it to stop and hand the bad name back, not to go look elsewhere.
    assert.match(result.content[0].text, /not in the Expertum catalog/);
    assert.match(result.content[0].text, /stop and report/);
  }
});

test("a catalog that fails to load surfaces as a tool error, not a crash", () => {
  const broken = () => {
    throw new Error("experts/x.md: missing 'domain'");
  };
  for (const result of [handleOverview(broken), handleExpert({ name: "code--quality" }, broken)]) {
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /missing 'domain'/);
  }
});

test("loadCatalog skips underscore files except the lanes, and tolerates CRLF", (t) => {
  const dir = tmpExperts(t, {
    "a--design.md": GOOD.replace(/\n/g, "\r\n"),
    "_lanes.md": "lanes text\n",
    "_notes.md": "ignored\n",
    "README.txt": "ignored\n",
  });
  const catalog = loadCatalog(dir);
  assert.deepEqual([...catalog.experts.keys()], ["a--design"]);
  assert.equal(catalog.experts.get("a--design")?.domain, "things");
  assert.equal(catalog.lanes, "lanes text");
});

test("loadCatalog strips a UTF-8 BOM from experts and the lanes file", (t) => {
  const dir = tmpExperts(t, {
    "a--design.md": "﻿" + GOOD,
    "b--design.md": GOOD.replace(/a--design/g, "b--design"),
    "_lanes.md": "﻿lanes text",
  });
  const catalog = loadCatalog(dir);
  assert.deepEqual([...catalog.experts.keys()], ["a--design", "b--design"]);
  assert.equal(catalog.lanes, "lanes text");
});

test("loadCatalog names the offending file and the specific defect", (t) => {
  /** @type {Record<string, [string, RegExp]>} */
  const cases = {
    "missing domain": [GOOD.replace("domain: things\n", ""), /missing 'domain'/],
    "unknown group": [GOOD.replace("group: Platform", "group: Nowhere"), /unknown group 'Nowhere'/],
    "name/file mismatch": [GOOD.replace("name: a--design", "name: b--design"), /does not match the file/],
    "no front matter": ["You are an A ANALYST.\n", /front-matter block/],
    "unclosed front matter": ["---\nname: a--design\n", /front-matter block/],
    "empty front matter": ["---\n---\nYou are an A ANALYST.\n", /missing 'name'/],
    "empty body": [GOOD.slice(0, GOOD.indexOf("You are")), /has no body/],
  };
  for (const [label, [text, defect]] of Object.entries(cases)) {
    const dir = tmpExperts(t, { "a--design.md": text, "_lanes.md": "lanes\n" });
    assert.throws(() => loadCatalog(dir), (err) => {
      assert.ok(err instanceof Error, label);
      assert.match(err.message, /a--design\.md/, label);
      assert.match(err.message, defect, label);
      return true;
    });
  }
});

test("loadCatalog refuses an empty catalog and a missing or empty lanes file", (t) => {
  assert.throws(() => loadCatalog(tmpExperts(t, { "_lanes.md": "lanes\n" })), /no experts/);
  assert.throws(() => loadCatalog(tmpExperts(t, { "a--design.md": GOOD })), /_lanes\.md/);
  assert.throws(
    () => loadCatalog(tmpExperts(t, { "a--design.md": GOOD, "_lanes.md": " \n" })),
    /_lanes\.md/
  );
});

test("the overview states the brief line the analyst keys on", () => {
  assert.equal(EXPERT_BRIEF_LINE, "Expert: <name>");
  assert.ok(renderOverview(loadCatalog(EXPERTS_DIR)).includes("`" + EXPERT_BRIEF_LINE + "`"));
});

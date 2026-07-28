import { test } from "node:test";
import assert from "node:assert/strict";

import { renderStatusline } from "../../plugins/statusline/statusline/render.mjs";

// The renderer's PURE core: it takes already-gathered inputs (the parsed stdin
// payload, the resolved user, the clock, and the transcript text) and returns
// the multi-line status string. Keeping it pure — no fs, stdin, or clock of its
// own — is what makes it unit-testable; the IO shell in render.mjs feeds it the
// real inputs and prints. These tests strip ANSI and pin the CONTRACT.

const ESC = String.fromCharCode(27);
/** @param {string} s */
const strip = (s) => s.replace(new RegExp(ESC + "\\[[0-9;]*m", "g"), "");
const NOW = new Date(0);

test("line 1: <user> @ <folder> :: <model>", () => {
  const out = strip(
    renderStatusline({
      data: { cwd: "/home/projects/Omnium", model: { display_name: "Claude Opus 4.8" } },
      user: "eric@example.com",
      now: NOW,
      transcriptText: "",
    }),
  );
  assert.equal(out.split("\n")[0], "eric@example.com @ Omnium :: Claude Opus 4.8");
});

test("model is found by deep lookup (nested display_name)", () => {
  const out = strip(renderStatusline({ data: { model: { display_name: "Deep Model" } }, now: NOW }));
  assert.match(out, /:: Deep Model/);
});

test("line 1 appends the reasoning effort when the payload carries one", () => {
  const out = strip(
    renderStatusline({
      data: { cwd: "/home/projects/Omnium", model: { display_name: "Claude Opus 5" }, effort: { level: "xhigh" } },
      user: "eric@example.com",
      now: NOW,
    }),
  );
  assert.equal(out.split("\n")[0], "eric@example.com @ Omnium :: Claude Opus 5 (xhigh)");
});

test("effort is color-coded: red -> orange -> folder tone -> violet -> purple", () => {
  const expected = {
    low: ESC + "[0;31m",
    medium: ESC + "[0;38;5;208m",
    high: ESC + "[38;5;223m",
    xhigh: ESC + "[38;5;183m",
    max: ESC + "[38;5;135m",
  };
  for (const [level, code] of Object.entries(expected)) {
    const line1 = renderStatusline({
      data: { model: { display_name: "M" }, effort: { level } },
      now: NOW,
    }).split("\n")[0];
    assert.ok(line1.includes(`${code}(${level})${ESC}[0m`), `${level} must be painted with ${JSON.stringify(code)}`);
  }
});

test("an unknown effort level stays muted rather than mis-colored", () => {
  const line1 = renderStatusline({
    data: { model: { display_name: "M" }, effort: { level: "turbo" } },
    now: NOW,
  }).split("\n")[0];
  assert.ok(line1.includes(`${ESC}[0;90m(turbo)${ESC}[0m`));
});

test("line 1 omits the effort when the payload has none (model without effort)", () => {
  const out = strip(renderStatusline({ data: { model: { display_name: "Claude Haiku 4.5" } }, now: NOW }));
  assert.equal(out.split("\n")[0], "? @ ? :: Claude Haiku 4.5");
});

test("context percentage and bar reflect used_percentage", () => {
  const out = strip(renderStatusline({ data: { used_percentage: 42 }, now: NOW }));
  assert.match(out, /Context:\s+42%/);
});

test("token totals are summed from the transcript (input + cache-creation; output)", () => {
  const transcriptText = [
    JSON.stringify({ message: { usage: { input_tokens: 1500, cache_creation_input_tokens: 500, output_tokens: 300 } } }),
    JSON.stringify({ type: "noise" }),
    JSON.stringify({ message: { usage: { input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 200 } } }),
  ].join("\n");
  const out = strip(renderStatusline({ data: {}, now: NOW, transcriptText }));
  // totalIn = 1500+500 = 2000 -> "2k"; totalOut = 300+200 = 500 -> "500"
  assert.match(out, /↑ 2k/);
  assert.match(out, /↓ 500/);
});

test("cache line shows last-prompt read (+write)", () => {
  const out = strip(
    renderStatusline({
      data: { cache_read_input_tokens: 12000, cache_creation_input_tokens: 3000 },
      now: NOW,
    }),
  );
  assert.match(out, /Cache:\s+12k\s+\(\+3k\)/);
});

test("session percentage reflects the five-hour window", () => {
  const out = strip(renderStatusline({ data: { five_hour: { used_percentage: 73 } }, now: NOW }));
  assert.match(out, /Session:\s+73%/);
});

test("footer carries clock, reset (with tz), api time and cost", () => {
  const out = strip(
    renderStatusline({
      data: {
        total_cost_usd: 1.5,
        total_api_duration_ms: 65000,
        five_hour: { used_percentage: 10, resets_at: 3600 },
      },
      now: NOW,
    }),
  ).split("\n")[3];
  assert.match(out, /Updated at \d\d:\d\d:\d\d/);
  assert.match(out, /Reset at \d\d:\d\d/);
  assert.match(out, /(GMT|UTC)/);
  assert.match(out, /API time 1m 5s/);
  assert.match(out, /\$1\.50/);
});

test("always returns a 4-line string and never throws on empty/garbage input", () => {
  for (const inputs of [{}, { data: null }, { data: "nope", user: undefined }, { data: { model: null } }]) {
    const out = renderStatusline(inputs);
    assert.equal(typeof out, "string");
    assert.equal(out.split("\n").length, 4);
  }
});

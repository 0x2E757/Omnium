# tests/graphyne — ported prior suite + vendored-engine fixtures + parity harness

## Ported prior tests (assertions frozen)

Ported from the standalone Graphyne `tests/` tree with import-path rewrites only
(DESIGN.md D10): `../../src/common/*.mts` → `../../../plugins/graphyne/common/*.mjs`,
the spawned entry points repointed to the shipped `plugins/graphyne/server.mjs` /
`hooks/hook.mjs`, and the SDK test client replaced by the zero-dep
`mcp/mcp-client.mts` (transport plumbing only — every assertion is the original).

| Suite | Files | Tests |
|---|---|---|
| `common/` | 12 | 129 |
| `mcp/mcp.test.mts` | 1 | 29 |
| `hook/hook.test.mts` | 1 | 24 ported (+12 Omnium-only, see below) |
| **Ported total** | **14** (+ `helpers.mts`, `mcp/mcp-client.mts`) | **182** |

Excluded: the prior `tests/web/` suites — 47 tests
(`api` 10, `server` 11, `static` 5, `frontend/components` 6, `frontend/dom` 8,
`frontend/helpers` 7). The web UI is out of Omnium scope (DESIGN.md D10).
Test-count headline: **229 = 182 ported + 47 web-excluded**; nothing else was dropped.

## New suites (Omnium-only)

- `hook/hook.test.mts` `#region stop_hook_active` — 12 tests pinning the
  Stop/SubagentStop loop protection: the gate keeps one guaranteed block per
  stop chain and re-blocks while the outstanding count changes (progress or
  new work); only a flagged repeat (`stop_hook_active` boolean `true` or
  string `"true"`) with the count stalled after the gate's own block waives,
  with a `systemMessage` warning. The record is keyed per event+agent (a
  SubagentStop block never disarms the Stop gate), false/unrecognized flags
  and a fresh chain (new user prompt) still block, a clean session stays
  silent, and the `SubagentStop` blocking baseline is pinned. The ported
  assertions above are untouched.
- `yaml-lite.test.mjs` — replays `tests/parity/fixtures/yaml-stringify.json`
  (byte parity on ALL 30 rows, including the two tier2QuoteStyle rows — the
  JSON.stringify fallback reproduces eemeli's double-quote pick),
  `yaml-parse.json` (value-or-throw parity; the 8 anchors/tags/block-scalars/
  directive/nested-flow rows assert the design-accepted THROW divergence) and
  `yaml-roundtrip-real.json` (byte round-trip of 10 real store files).
- `globs.test.mjs` — replays every row of `tests/parity/fixtures/globs.json`
  against picomatch@4 `{dot:true}` verdicts, except the 5 `divergentByDesign`
  patterns, which are asserted as LITERAL matches per design §Q4 row 16.

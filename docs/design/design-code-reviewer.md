# Omnium design decisions — YAML store, glob engine, diff applier (Q3, Q4, Q5)

**Decisions**

1. **Q3 (YAML):** Vendor a **YAML-subset parser + a dedicated Meta serializer**, keeping `.yaml` as the one and only on-disk format (option (a)). Compat bar: **byte-identical to `yaml@2` `stringify({related}, {lineWidth: 0})` for the plain-safe scalar domain** (which covers 100% of both real stores), semantic round-trip parity elsewhere. No dual format, no write-through variant, `META_EXT` and `storage.mts` untouched.
2. **Q4 (globs):** Vendor a **minimal segment-based matcher** supporting exactly `**` (whole-segment), `*`, `?`, and literals, with picomatch `{dot: true}` semantics (dot files are plain characters). **Reject** `path.matchesGlob` (no `dot:true`, experimental API). Behavior table below is the normative spec; parity proven by a one-off differential fixture run against picomatch@4 in the prior repo.
3. **Q5 (diff):** _(SUPERSEDED by DESIGN.md D17, memosyne 0.4.0 — reversed: `memosyne_patch_task` retired, replaced by `memosyne_edit_task`; see the banner on §Decision Q5 below.)_ oldText/newText contract change is **confirmed off the table** (tool schema `task/section/patch/force` at `Memosyne/src/mcp/server.mts:395-411` is a learned agent contract). Vendor a **fuzz-0 port of jsdiff@9.0.0 `applyPatch`** (parse + apply + line-endings + distance-iterator, BSD-3 attribution), preserving `false`-on-fail, unchanged-on-noop, position-search offsets, `\ No newline` handling, CRLF auto-conversion, and jsdiff's exact throw messages. Handler code (`handlers.mts:578-632`) and its two ToolError texts stay byte-identical.

## Summary

All three dependencies sit behind narrow, fully enumerable contracts: `yaml` is one parse/stringify pair (`graph.mts:15`), `picomatch` is a 23-line wrapper (`globs.mts`), `diff` is one call site (`handlers.mts:596`). The real committed data is strictly canonical (both stores contain only block-style, unquoted, 2-space-indented meta files — zero flow style, zero quoting found by grep across `the upstream Graphyne source (.graphyne/meta)` and `the upstream Memosyne source (.graphyne/meta)`), and the real glob configs use only literals, `*.ext`, and whole-segment `**`. That makes vendored subsets the lowest-risk zero-dep option in every case, provided the subsets are specified against the *lenient* contracts (`parseMeta` swallows parse errors, `readConfig` swallows config errors) rather than against the full upstream feature sets.

## Scope / What was analyzed

- `Graphyne/src/common/graph.mts` (parseMeta 85-109, serializeMeta 113-119, cleanTags 35-44), `graph-store.mts` (readMeta cache 43-59), `storage.mts` (META_EXT 24, readMetaRaw 75-79, listMetaSources 95-104), `paths.mts`, `globs.mts`, `config.mts` (ALWAYS_EXEMPT 68; call sites 111/126/137/144/151/162), `DESIGN.md` (meta schema §2, glob/YAML stack rows), `src/claude/plugin/commands/init.md` (documented glob dialect).
- All committed meta YAML in both stores (67 files in Graphyne, ~40 in Memosyne) — enumerated feature inventory.
- `Graphyne/graphyne.json`, `Memosyne/graphyne.json` (the only two adopted stores under ~/projects; no other `.graphyne/` exists).
- `Memosyne/src/mcp/handlers.mts:578-632` (patchTask), `server.mts:389-414` (schema), `pnpm-lock.yaml:1014` (`diff@9.0.0` exact).
- Upstream: jsdiff v9.0.0 `libesm/patch/parse.js` + `apply.js` (unpkg), picomatch README + issue #21, eemeli yaml docs (see Sources at end).

---

## Decision Q3 — YAML strategy: vendored subset parser + dedicated Meta serializer, `.yaml` stays THE format

### Why (a) and not (b)/(c)

- (b) "dual-read/yaml-write-through" still requires a YAML reader *and* writer to exist with no dep — it is (a) plus a second format that nothing needs. Rejected.
- JSON migration is forbidden by the no-breaking-changes rule: external checkouts on plugin ≤0.1.28 must keep reading AND writing the same committed files (`.graphyne/meta/**.yaml` is committed data shared through git — design-context §Backward-compat).
- The write side does **not** need a general YAML serializer at all: `serializeMeta` (`graph.mts:113-119`) only ever emits the shape `{related: Edge[]}` post-canonicalization. A dedicated emitter is byte-exact by construction and ~40 lines. This is the key simplification that makes (a) cheap.

### Compat bar (decided)

**Two tiers:**

- **Tier 1 — byte-identical writes.** For every Meta whose `path`/`tag` scalars are *plain-safe* (rule below), output MUST be byte-identical to `yaml@2.6 stringify({related}, {lineWidth: 0})`. Every scalar in both real stores is plain-safe (verified), so mixed-version checkouts (one machine on graphyne@0.1.28, another on omnium) never produce serialization churn in committed files. "Merely parseable" is NOT enough: alternating writers would ping-pong the bytes on every link/unlink and pollute git history.
- **Tier 2 — semantic parity.** For exotic scalars that require quoting (a path that looks like a number, contains `: `, starts with an indicator char, …): output must be valid YAML that both eemeli `yaml` (old plugins) and the vendored parser re-parse to the identical Meta. Byte-identity with eemeli's quote-style choice is NOT required — such scalars cannot be produced by real repos today (they'd need pathological filenames), and today's writer already re-canonicalizes any hand-edited file it touches, so churn on this tier is pre-existing behavior.

### Serializer spec (exact)

Emit directly (no generic stringify):

```
related: []␊                      # when related is empty (matches graph.mts:117 comment)
```
otherwise:
```
related:␊
  - path: <scalar>␊
    tags:␊
      - <scalar>␊
```
(2-space indent ladder exactly as in every real file, e.g. `Graphyne/.graphyne/meta/src/mcp/handlers.mts.yaml`; edges and tags pre-sorted by the existing `serializeMeta` logic, which is retained; trailing newline; LF only; no line folding — `lineWidth: 0` today.)

**Scalar emission rule:** plain (bare) iff ALL of:
- non-empty; no leading/trailing whitespace; no TAB/control chars; no `\n`;
- first char not in `# & * ! | > ' " % @ \` [ ] { } ,` and not a `-`/`?`/`:` followed by space-or-end;
- contains no `: ` (colon+space), does not end with `:`, contains no ` #`;
- does not resolve under YAML 1.2 core schema as null (`null/Null/NULL/~`/empty), bool (`true/false` any case), int (`[-+]?\d+`, `0x…`, `0o…`), or float (incl. `.inf`/`.nan` forms). Note: `yes/no/on/off` are strings in YAML 1.2 core — do NOT quote them (eemeli default schema is core).

Otherwise emit `JSON.stringify(scalar)` (double-quoted). Tier-1 fixtures only cover plain-safe scalars, so this fallback is Tier-2 by definition.

### Parser subset grammar (the lenient `parseMeta` contract, `graph.mts:85-109`)

Generic `parseYamlLite(raw: string): unknown` (parseMeta's structure/type checks at `graph.mts:92-107` stay untouched). MUST parse:

1. LF and CRLF input (strip `\r` at EOL); UTF-8.
2. Full-line and trailing comments (`# …` after at least one space, outside quotes); blank lines anywhere.
3. Optional single leading `---` and trailing `...`; a **second** document → throw.
4. Block mappings (`key: value`, `key:` + indented block); nested mappings at deeper indent.
5. Block sequences `- item`; the dash column may be **equal to or deeper than** the parent key's column (YAML allows unindented sequences — hand-editors write this); `- path: x` starts an inline mapping continued by deeper-indented keys.
6. Flow sequences of scalars `[a, b]`, `[]`, and flow mappings of scalar values `{a: b}` — non-nested is sufficient (covers documented `tags: [test]` in DESIGN.md §2 and `related: []`); nested flow → throw.
7. Scalars: plain with **YAML 1.2 core-schema resolution** (null/bool/int/float exactly as listed above — this is compat-critical: `path: 123` parses as a *number* under eemeli, so `parseMeta` skips that edge via the `typeof rawPath === "string"` check at `graph.mts:99`; a string-only parser would silently start accepting it. `cleanTags` at `graph.mts:39` accepts numbers, so tag resolution is symmetric either way); single-quoted with `''` escape; double-quoted with JSON-style escapes + `\uXXXX` (unknown escape → throw).
8. Duplicate mapping keys → throw (eemeli default `uniqueKeys: true` also errors → parseMeta returns empty on both engines — identical behavior).
9. THROW (→ parseMeta's catch → `{related: []}`) on: anchors/aliases (`&`, `*`), tags (`!`), block scalars (`|`, `>`), directives (`%`), tab indentation, nested flow.

**Accepted bounded delta:** a hand-edited file using anchors/block scalars is *valid* YAML that old plugins read and the subset reads as empty. This can only lose edges if someone hand-writes such a file (guard files at `storage.mts:115-126` explicitly forbid hand-editing) AND then links through it. Documented, not mitigated.

### Placement, size, tests

- `plugins/graphyne/src/common/yaml-lite.mts` (parser, ≤ ~220 lines incl. narrative comments) + emitter folded into `graph.mts`'s `serializeMeta` (~40 lines). Hook and server both import it (no bundling anymore).
- Perf: parse cost is amortized by the mtime/size cache at `graph-store.mts:35-59`; a line-based recursive-descent parser is more than fast enough.
- Tests:
  1. **Real-store round-trip:** commit ~10 real meta files from both stores as fixtures; assert `serializeMeta(parseMeta(raw)) === raw` byte-for-byte (proves Tier 1 on real data).
  2. **Golden differential fixtures:** one-off script run inside `the upstream Graphyne source` (which has `yaml@2.6` installed) generating `{input Meta → yaml.stringify bytes}` pairs across the plain-safe domain (multi-tag edges, empty related, deep paths, `@`/`.`-leading segments, 5-tag cap) + `{raw YAML → yaml.parse value}` pairs for the dialect table (flow tags, quoting, comments, `---`, numbers, booleans, duplicate keys, anchors). Commit fixtures to Omnium; tests replay both directions.
  3. Lenient-path cases: garbage, tabs, block scalar, second document → `{related: []}`.
  4. Property test: for generated canonical Metas, `parse(serialize(m))` deep-equals `m`.

---

## Decision Q4 — Glob strategy: vendored minimal matcher with picomatch `{dot:true}` semantics

### Why vendored, not `path.matchesGlob`

- `compile()` passes `{dot: true}` (`globs.mts:15`). `path.matchesGlob` exposes no options; under minimatch defaults `node_modules/**` stops matching `node_modules/.bin/esbuild`, `**/*.md` stops matching `.claude/notes.md` → `isIgnored`/`needsMeta`/`isGatedSource` (`config.mts:111,137,158`) silently change verdicts for dot-dir paths → the TDD gate and Stop-blockers change behavior. A "dot-handling wrapper" cannot fix this without rewriting patterns (`**` → `{**,**/.*/**,…}` expansion is exactly the kind of cleverness the readability charter forbids), and `matchesGlob` is still marked experimental (stability 1) — an API-stability risk in a zero-dep plugin meant to outlive Node minor versions.
- Verified syntax inventory — nothing beyond `**`, `*`, literals appears in: both `graphyne.json` files, `ALWAYS_EXEMPT` (`config.mts:68` — `.graphyne/**`, `graphyne.json`), and every documented example (`init.md:40-46,77-82`: `spec/**/*.md`, `**/*_test.py`, `**/*_test.go`, `plugin/**`; DESIGN.md:98 `pnpm-lock.yaml` literal). `?` appears nowhere but costs one line — support it since picomatch did and third-party configs may exist.

### THE semantics table (normative for implementation AND tests)

Inputs: path is already `normalizeRel`'d (`globs.mts:16` — keep that call); patterns matched case-sensitively; empty pattern list matches nothing (`globs.mts:14`); list = OR.

| # | Pattern | Path | Match | Rule |
|---|---------|------|-------|------|
| 1 | `**` | `a/b`, `.claude/x`, `.md` | yes | `**` segment = zero or more whole segments; dot segments are ordinary (dot:true) |
| 2 | `**/*.md` | `README.md` | yes | leading `**/` may match zero segments |
| 3 | `**/*.md` | `.claude/notes.md` | yes | dot segment crossed by `**` |
| 4 | `**/*.md` | `docs/a/b.md` | yes | |
| 5 | `**/*.md` | `.md` | yes | `*` matches zero+ non-`/` chars; leading dot unrestricted |
| 6 | `**/*.md` | `a/b.mdx` | no | literal tail anchored |
| 7 | `node_modules/**` | `node_modules/.bin/x` | yes | dot:true |
| 8 | `tests/**` | `tests` | **yes** | picomatch quirk: trailing `/**` also matches the bare parent (picomatch issue #21, kept for back-compat upstream) |
| 9 | `tests/**` | `tests/a/b` | yes; `tests2/a` → no | anchoring |
| 10 | `src/**/*.mts` | `src/a.mts` | yes | interior `**` may match zero segments |
| 11 | `src/**/*.mts` | `src/a/b/c.mts` | yes; `x/src/a.mts` → no | |
| 12 | `*.md` | `docs/a.md` | no | `*` never crosses `/` |
| 13 | `?` in a segment | exactly one non-`/` char, incl. `.` | yes | |
| 14 | `foo**bar`, `a**` (intra-segment `**`) | — | treat as `*` | picomatch rule: `**` is globstar only as a whole segment (README: "`foo**/bar` ≡ `foo*/bar`") |
| 15 | `graphyne.json` | `graphyne.json` yes; `x/graphyne.json` no | literal, anchored |
| 16 | `{a,b}` `[abc]` `!(x)` `@(x)` `+(x)` | — | **all punctuation literal** | unsupported syntax; verified absent from all real configs and all documented examples |
| 17 | `[]` patterns list empty | anything | no | `globs.mts:14` |

### Implementation spec

- Keep the module API byte-compatible: `compile(patterns: string[]): (path: string) => boolean` and `matchesAny(path, patterns)` (`globs.mts:13-21`) — `config.mts` remains untouched except the import.
- Compile each pattern to one RegExp: split pattern on `/`; a segment equal to `**` becomes a zero-or-more-segments group; any other segment: regex-escape everything, then `*` → `[^/]*`, `?` → `[^/]`, intra-segment `**` first collapsed to `*`. Assemble so that (i) `**` between slashes contributes `(?:[^/]+/)*`-style zero-inclusive joining, and (ii) a **trailing** `/**` compiles to `(?:/.*)?$` to realize row 8. Anchor `^…$`. ~60-80 lines with comments.
- Do NOT add dot-file special-casing anywhere — `{dot:true}` means dots are ordinary characters; that absence *is* the semantics.

### Tests

1. The 17-row table above as unit cases (each row ≥1 assert), plus every pattern from both real `graphyne.json` files against representative real paths (e.g. `metaExclude: tests/**` vs `tests/common/graph.test.mts`; `ignore: .claude/**` vs `.claude/settings.json`).
2. **Differential fixture run (definition of done):** one-off script executed in `the upstream Graphyne source` (picomatch@4 installed) evaluating `picomatch(p, {dot:true})` vs the vendored matcher for: all patterns from both configs + `ALWAYS_EXEMPT` + init.md examples, × a corpus of every tracked file path in both repos plus synthesized dot-variants (`.bin/x`, `a/.b/c.md`, bare `tests`). Zero disagreements required; fixture table committed to Omnium and replayed in CI-less `node --test`.
3. Resilience (recommended, non-blocking): `readConfig` may log a one-line stderr warning when a pattern contains `{ } [ ] ( ) !` — observability for the unsupported-syntax case without any behavior change.

---

## Decision Q5 — memosyne_patch_task: vendored fuzz-0 port of jsdiff@9.0.0 applyPatch

> **SUPERSEDED by DESIGN.md D17 (memosyne 0.4.0).** This decision (keep the
> unified-diff tool, vendor a fuzz-0 jsdiff port) was later reversed by user
> directive: `memosyne_patch_task` and `common/unified-diff.mjs` are retired
> and replaced by `memosyne_edit_task`, an exact `old_text`/`new_text` editor.
> The historical analysis below is kept for provenance only.

### Contract confirmation

Changing the tool to oldText/newText is a breaking input-schema change to `memosyne_patch_task` (`server.mts:389-414`) whose description text agents have learned ("Unified diff (@@ hunks; optional ---/+++ headers)…"). **Off the table — confirmed.** The vendored applier must reproduce `applyPatch(original, patchString)` of `diff@9.0.0` exactly (locked version: `Memosyne/pnpm-lock.yaml:1014`) at default options (the call site passes none — `handlers.mts:596` — so `fuzzFactor` is 0 and `autoConvertLineEndings` is on).

### Vendoring approach

Port, don't reinvent: translate jsdiff v9's `patch/parse`, `patch/apply` (specialized to fuzz 0), `patch/line-endings`, and `util/distance-iterator` into one polished file, `plugins/memosyne/src/common/unified-diff.mts` (~300 lines incl. comments), exporting exactly `applyPatch(source: string, patch: string): string | false`. jsdiff is BSD-3-Clause: retain a header comment with the jsdiff copyright + license pointer. The fuzz>0 machinery (recursive `applyHunk` error budget) may be dropped — at `maxErrors = 0` it reduces to exact matching — but ONLY the code, never the observable behavior.

### Exact behaviors (grounded in jsdiff v9 source)

**Parsing** (`libesm/patch/parse.js`):
- Split patch on `/\n/` **preserving `\r`** at line ends.
- Silently skip unrecognized lines outside hunks (v9 explicitly tolerates prose/`Only in …` noise, per upstream comment) — so `--- a/x`/`+++ b/x` headers, `diff --git`/`index` lines, and leading commentary are all fine; a second file section (`diff --git`/`Index:`/second `---/+++` pair) yields >1 patch → **throw `applyPatch only works with a single input.`** (exact text).
- Hunk header regex: `/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/`; omitted count → 1; **count 0 quirk:** `oldLines === 0 → oldStart += 1`, `newLines === 0 → newStart += 1`.
- Hunk body loop runs while `removeCount < oldLines || addCount < newLines || line starts with '\'`. Accepted first chars: `' '`, `'+'`, `'-'`, `'\'`; an **empty line** (not last of patch) counts as a context line (`operation = ' '`) — agents' whitespace-stripped diffs rely on this.
- Throws (exact messages, agent-visible via the tool's error path today — a throw from `handlers.mts:596` propagates as an isError result):
  - `` `Hunk at line ${chunkHeaderIndex + 1} contained invalid line ${line}` ``
  - `'Added line count did not match for hunk at line ' + (chunkHeaderIndex + 1)`
  - `'Removed line count did not match for hunk at line ' + (chunkHeaderIndex + 1)`
- Bare `@@` / no `@@` at all → header never matches → zero hunks (line skipped silently).

**Line-ending auto-conversion** (`patch/line-endings`): if source has only CRLF endings and patch lines are Unix → append `\r` to hunk lines (`unixToWin`; not to `\`-marker lines); if source only-LF and patch is Windows → strip `\r` (`winToUnix`); mixed source → no conversion. Port these predicates verbatim.

**Application** (`libesm/patch/apply.js`, fuzz 0):
- `if (!hunks.length) return source;` — unchanged source, which the handler's no-op guard (`handlers.mts:608-614`) converts into the "bare @@" ToolError. Preserve exactly.
- Split source on `'\n'` (a trailing `''` element represents the trailing newline).
- Per hunk: initial position `toPos = hunk.oldStart + prevHunkOffset - 1`, then candidate positions from `distanceIterator(toPos, minLine, maxLine)` (alternating +1, −1, +2, −2, … within bounds; `maxLine = lines.length - hunk.oldLines` at fuzz 0). **Offsets ARE allowed at fuzz 0** — content must match exactly but the hunk may land away from its stated line numbers; stale-line-number diffs from agents apply today and must keep applying.
- Matching at a candidate: every `' '` and `'-'` hunk line must `===` the source line (default `compareLine` is strict equality — `\r` differences fail, hence the auto-conversion step); `'+'` lines are inserted; any mismatch → next candidate; candidates exhausted → **return `false`** (→ handler's "did not apply cleanly" ToolError at `handlers.mts:598-601`, text unchanged).
- On success: copy `lines[minLine..toPos)` to the result, append the hunk's patched lines, then `minLine = oldLineLastI + 1` (hunks stay ordered, never overlap) and `prevHunkOffset = toPos + 1 - hunk.oldStart`. After all hunks, append the remaining source lines; result = `resultLines.join('\n')`.
- **`\ No newline at end of file`:** marker after a `'+'` line sets `removeEOFNL`; after a `'-'` line sets `addEOFNL`. At the end: `removeEOFNL` → pop the trailing `''` if present, else **return `false`** (fuzz 0); `addEOFNL` → push `''` unless already present, else **return `false`**.

**Handler unchanged:** `patchTask` (`handlers.mts:578-632`) keeps its two ToolError texts byte-for-byte (lines 599-601 and 610-613), the `patched === original` no-op guard, and the per-section validation.

### Test matrix

Unit cases (each asserting result string OR `false` OR exact throw message):
1. Middle-of-text replacement, 3 context lines, correct counts.
2. Multi-hunk patch where hunk 2's position depends on `prevHunkOffset` from hunk 1.
3. **Stale line numbers:** hunk stated at line 5, content actually at line 9 → applies (distance iterator).
4. Insertion-only hunk (`@@ -5,0 +6,2 @@`, oldStart+1 quirk) and deletion-only hunk (newStart quirk).
5. Bare `@@` header → source returned unchanged → handler no-op ToolError (integration test at patchTask level, asserting the exact message text incl. the `"@@ -<start> +<start>,<count> @@"` hint).
6. Prose/garbage with no `@@` → unchanged → no-op ToolError.
7. With `---`/`+++` headers; with full `diff --git` + `index` preamble.
8. Two-file patch → `applyPatch only works with a single input.`
9. Context drift (section edited since read) → `false` → "did not apply cleanly" ToolError, exact text.
10. Count-mismatch headers → both `Added`/`Removed line count did not match…` messages, exact.
11. Invalid line inside hunk (`x foo` before counts satisfied) → `Hunk at line 1 contained invalid line x foo`.
12. Empty string as context line inside hunk → treated as `' '`, applies.
13. `\ No newline` after final `+` (result loses trailing NL), after final `-` (gains), and redundant marker → `false`.
14. CRLF source + LF patch → applies, result stays CRLF; LF source + CRLF patch → applies, result LF; mixed-endings source → no conversion (patch with `\r` fails against LF source lines).
15. Hunk at line 1 and hunk touching EOF; hunk extending past EOF → `false`.
16. Patch that applies but reproduces the original (self-replacement) → no-op ToolError.
17. **Differential fixtures (definition of done):** script run in `the upstream Memosyne source` (after `pnpm install`, `diff@9.0.0` per lockfile) executes real `applyPatch` over the whole matrix plus a set of captured agent-generated diffs (harvest from `.memosyne/` task descriptions where diffs appear, plus synthetic LLM-style diffs: no headers, stripped trailing spaces, stale offsets), dumping `{source, patch, outcome}` JSON. Committed to Omnium; the vendored applier must reproduce every outcome, including thrown-message strings, verbatim.

## Risks

- **YAML Tier-2 quoting** deviates in byte form from eemeli for pathological filenames (number-lookalike or `: `-containing paths) — semantic parity holds; a mixed-version checkout touching such a file could see one-line quote-style churn. Accepted; probability ≈ 0 in real repos.
- **Exotic hand-edited YAML** (anchors, block scalars) reads as empty under the subset where eemeli read it — bounded to explicitly-forbidden hand edits (guard files, `storage.mts:115-126`).
- **Unsupported glob punctuation** in third-party `graphyne.json` files ( `{}`, `[]`, `!` ) silently becomes literal. Verified absent in the only two adopted stores; stderr warning recommended for observability.
- **jsdiff port drift**: any deviation is caught only by the differential fixture suite — that suite is therefore a merge gate, not optional.

## Recommendations (prioritized)

1. Build the three differential-fixture generator scripts FIRST (yaml and picomatch against a Graphyne checkout, diff against a Memosyne checkout) and commit their outputs to Omnium before writing any vendored code — they are the parity oracle and the definition of done for Q3/Q4/Q5.
2. Implement `unified-diff.mts` as a structural port of jsdiff v9 (with BSD attribution header), not a rewrite; drop only the fuzz>0 branches.
3. Implement `yaml-lite.mts` parser + fold the emitter into `serializeMeta`; wire the real-store round-trip test (byte-identity over committed fixtures) into the suite.
4. Implement the glob matcher against the 17-row table; keep `globs.mts`'s public API and its `normalizeRel` call intact so `config.mts` needs zero changes.
5. Add the optional `readConfig` stderr warning for unsupported glob punctuation (behavior-neutral observability).

## Open questions

- jsdiff `parsePatch('')`/pure-garbage return-shape corner (0 file entries → possible upstream TypeError vs one empty entry): the fixture run in Memosyne settles it empirically; the vendored parser should then match the observed behavior exactly (zod `min(1)` already excludes the empty-string case at the tool boundary).
- Whether any adopting project exists outside `~/projects` (other machines/checkouts): assumed possible in principle (drives the Tier-1 byte-parity bar) but not enumerable from this host.
- eemeli yaml's exact quote-style pick (single vs double) for Tier-2 scalars was not pinned to a verbatim source line; docs indicate double-quote preference at defaults. Irrelevant under the chosen Tier-2 bar, but the yaml fixture script can capture it for free if the implementer wants to upgrade Tier 2 to byte parity.

Sources: [jsdiff v9 apply.js](https://unpkg.com/diff@9.0.0/libesm/patch/apply.js), [jsdiff v9 parse.js](https://unpkg.com/diff@9.0.0/libesm/patch/parse.js), [picomatch issue #21 (foo/** matches foo)](https://github.com/micromatch/picomatch/issues/21), [picomatch README (globstar/intra-segment rules)](https://github.com/micromatch/picomatch), [eemeli yaml toString options](https://eemeli.org/yaml/#tostring-options)

# Developing Omnium

Dev/test harness lives at the repo root and is never shipped; the installable
artifacts are the `plugins/<name>/` folders, which stay zero-dependency. The
binding decision record is `DESIGN.md`; this file is the day-to-day manual.

## The two-lane workflow (stale-cache footgun, neutralized)

The install cache is version-keyed: editing this working tree does NOTHING for
installed copies until the plugin's `plugin.json` version changes. Hence:

- **Iteration lane** — `claude --plugin-dir /path/to/Omnium/plugins/<name>`
  loads the tree in place, no cache involved. This is the only lane where
  uncommitted edits are exercised. Tool prefixes are identical to installed form.
- **Adoption lane** — `git commit` (the pre-commit hook auto-bumps any touched
  plugin's PATCH) → `/plugin marketplace update omnium` → `/reload-plugins`.
  Version provably changed whenever bytes changed, so the update always re-copies.

One rule: **commit (or `npm run stamp`) before `marketplace update`.**

One-time setup after clone: `npm install` and `git config core.hooksPath scripts/git-hooks`.

## Commands

- `npm run check` — the full gate: oxlint + version-guard check + all tests + typecheck.
  Every task must end green here; no skipped or todo-marked tests.
- `npm test` / `npm run typecheck` / `npm run lint` / `npm run stamp` / `npm run sync:shared` — the parts.

Line endings: version-guard hashes raw working-tree bytes, so `.gitattributes`
pins `* text=auto eol=lf` — every text file checks out as LF on every platform
(a Windows `core.autocrlf=true` checkout would otherwise skew every tree hash).
The CRLF test vectors in `tests/parity/fixtures/` are JSON-escaped, not raw
bytes, so no file is exempt; `tests/omnium/eol.test.mjs` guards both facts.

## Naming plugin command files

A slash-command file's basename becomes the command name (`commands/foo.md` →
`/plugin:foo`) — and the basename `skill.md` is effectively **reserved**:
Claude Code's skill discovery claims any directory containing a `SKILL.md` as
a skill bundle named after the directory, and on case-insensitive filesystems
(the Windows/macOS default) `commands/skill.md` matches it. The whole
`commands/` directory is then swallowed as one skill named "commands" and
every sibling command vanishes from the roster (observed live with distillum
0.1.0; fixed by the `to-skill.md`/`to-docs.md` rename in 0.1.1). Never use
`skill.md`, in any case variant, as a command basename.

## Vendoring contract (shared modules)

Every `shared/*.mjs` file is canonical — the MCP core (`mcp-core.mjs`,
`mcp-schema.mjs`), the file-lock factory (`lock-core.mjs`), project
resolution (`project.mjs`), and the retrying atomic file write
(`atomic-write.mjs`). Each consuming plugin carries byte-identical
copies in its `common/` (a marketplace install copies one folder and skips
out-of-tree symlinks, so physical copies are the only option). Edit ONLY under
`shared/`, then `npm run sync:shared`. Every copy carries a DO-NOT-EDIT
header; `tests/omnium/vendoring.test.mjs` byte-compares all copies and is part
of `npm run check`. Behavior that legitimately differs per plugin (env-knob
prefix, product name) ships as a factory canonical behind a per-plugin domain
shim — see `common/lock.mjs` and DESIGN.md D13.

## Versioning

Explicit semver in each `plugins/<name>/.claude-plugin/plugin.json`; marketplace
entries never carry a `version`. PATCH is bumped automatically by the pre-commit
hook via `scripts/version-guard.mjs` (content-hash comparison against
`.plugin-versions.json`); MINOR is hand-bumped for deliberate features; MAJOR is
banned (breaking changes are forbidden). Never switch to SHA versioning.

Note: version-guard hashes the WORKING TREE, not the git index — commit plugin
changes wholly, because partial staging can stamp a version against unstaged
bytes and the committed stamp then mismatches the committed tree. Editor/OS
junk files are ignored by a basename/suffix list (`.DS_Store`, `Thumbs.db`,
`.swp`/`.swo`/`~`) so they never trigger a spurious PATCH bump.

## Backward compatibility

The plugins' user-visible surfaces are FROZEN — see `DESIGN.md` and
`docs/design/design-ai-engineer.md` §(a) for the exhaustive contract. The
enforcement instruments are each server's end-to-end stdio tests (tool list,
schemas, output shapes, and rejection texts), the vendored-library
differential fixtures under `tests/parity/fixtures/` (the zero-dep ports must
reproduce `yaml`/`picomatch`/`diff` byte-for-byte), and the version guard.
When a ported oddity looks like a bug, KEEP it and document it — agents and
stores depend on today's behavior.

Accepted security trade-off (documented decision, not an unknown): the vendored
glob compiler (`plugins/graphyne/common/globs.mjs`) compiles `*` to a
backtracking `[^/]*`, so a pathological `.graphyne/config.json` glob (a long run of
`*a*a*…`) can cost polynomial regex backtracking on the hook's hot path. This
is the SAME complexity class the prior picomatch bundle had — nothing new was
introduced — and its impact is bounded: matched paths are short tool-input file
paths, and the hooks fail OPEN under their 5-10 s `hooks.json` timeouts, so the
worst case is per-tool-call latency in a hostile project, never a wedge or a
block. Deliberately not "fixed": rejecting such patterns would be an observable
behavior change to a frozen surface.

## Code-style charter (binding)

1. **Narrative file header.** Every runtime file opens with a comment block in
   full sentences: what the file is, why it exists in this shape, and the one
   non-obvious design decision. Headers name sibling files when the split matters.
2. **Shell/logic split.** IO shells (stdio loops, hook dispatchers) contain no
   policy; pure logic modules never touch `process`, stdio, or env.
3. **Comments explain WHY, never narrate WHAT.** Any looks-wrong-but-deliberate
   line gets an inline rationale at the site.
4. **JSDoc on every export** — 1-4 sentence-style lines; JSDoc types ARE the
   type system and must pass `tsc --noEmit` (`checkJs`).
5. **Naming.** kebab-case files; camelCase functions/variables; SCREAMING_SNAKE
   exported constants; real words, no non-universal abbreviations.
6. **Constants carry rationale** — every tuning constant gets a one-line why.
7. **Error messages are frozen or house-style.** Existing shipped messages are
   copied byte-for-byte (compat surface). New ones: complete sentences, quote
   the offending value, tell the caller what to do next.
8. **Failure posture is explicit per file.** Hooks fail OPEN; MCP tools return
   error results and never throw across the transport; every empty catch states
   why swallowing is safe.
9. **Module size** target ≤ ~400 lines including headers; split by
   responsibility, never so finely that one behavior spans more than ~3 files.
10. **Boring code wins.** No nested ternaries, no clever one-liners, no
    metaprogramming; early returns over deep nesting; Set/Map over object-as-dict.
11. **Imports.** `node:` prefix on builtins; shipped runtime is ESM `.mjs` only;
    zero runtime dependencies — an import that isn't `node:*` or relative is a defect.
12. **Vendored files are read-only in place** — DO-NOT-EDIT header, edited only
    under `shared/`, re-synced by script; the byte-compare test is the law.
13. **Tests.** `node:test` + `node:assert/strict`; test names are behavior
    sentences; at least one e2e per server drives the real process over stdio;
    a leading comment states what the suite pins and why.
14. **Ported code improves nothing observable.** Tool names, schemas, output
    shapes, on-disk formats, timeouts, messages are transplanted, not cleaned up.
    Polish goes into comments, structure, and naming of internals only.
15. **Language hygiene.** English everywhere; no emojis; no TODO/FIXME in
    shipped files — open items go here, to `docs/development.md`.

## Migration to omnium (per machine, after full parity sign-off)

See `docs/design/design-ai-engineer.md` §(b) for the full runbook with checks:
add the omnium marketplace, then per plugin `uninstall <p>@<p>` +
`install <p>@omnium` (never both at once), remove the four old marketplaces,
restart, run the 5-point verification. Rollback = re-add the upstream plugins.

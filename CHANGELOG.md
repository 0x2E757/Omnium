# Changelog

All notable, user-visible changes to the Omnium plugins. Each plugin is
versioned independently in its `plugin.json`; automatic PATCH bumps are not
listed here — only features (MINOR) and notable fixes. Format follows
[Keep a Changelog](https://keepachangelog.com).

## autonomity

### 0.4.4 — 2026-07-06
- Consolidated into the Omnium marketplace (baseline; supersedes the standalone 0.1.5 line).

## expertum

### 0.8.0 — 2026-07-18
- Added `/expertum:conduct-mvp`: a sibling of `/expertum:conduct` that plans and
  builds only the minimal implementation of the ask under a binding MVP
  contract — review rounds (capped at 3) block only on bugs and one-way-door
  design choices, and speculative security/performance hardening is deferred
  into a `deferred.md` backlog (recorded, not built) that a later full-rigor
  `/expertum:conduct` run can pick up.

### 0.4.14 — 2026-07-06
- Consolidated into the Omnium marketplace (baseline; supersedes the standalone 0.3.5 line).

## graphyne

### 0.8.0 — 2026-07-10
- **BREAKING:** the per-project config moved from `<repoRoot>/graphyne.json` to
  `<repoRoot>/.graphyne/config.json`, so everything Graphyne keeps for a project
  lives in one directory that can be relocated out of the tree (a symlink) as a
  single unit — mirroring `.memosyne/config.json`. A `graphyne.json` at the repo
  root is no longer read, and there is no fallback. Migration:
  `git mv graphyne.json .graphyne/config.json` (adopt the project first if
  `.graphyne/` does not exist yet). The `.graphyne/` guard notes now carve
  `config.json` out as the one hand-editable file in the store; already-adopted
  projects can delete `.graphyne/AGENTS.md` and `.graphyne/CLAUDE.md` to have the
  new text regenerated. Note that a `graphyne.json` left at the root is no longer
  exempt from classification — delete it, or cover it with a `metaExclude` glob,
  or Graphyne will ask it to carry a meta entry.

### 0.7.11 — 2026-07-06
- Consolidated into the Omnium marketplace (baseline; supersedes the standalone 0.1.28 line).

## memosyne

### 0.4.0 — 2026-07-07
- **BREAKING:** removed `memosyne_patch_task` and its vendored jsdiff fuzz-0
  unified-diff applier. Replaced by `memosyne_edit_task`, a targeted
  string-replacement editor (exact `old_text`/`new_text`, read-first,
  unique-or-fail, `replace_all`; an empty `new_text` deletes). Migration:
  rebuild unified-diff `patch` payloads as edits — re-read the section with
  `memosyne_get_task` and copy an exact snippet into `old_text` (no `@@` hunks).

### 0.3.11 — 2026-07-06
- Consolidated into the Omnium marketplace (baseline; supersedes the standalone 0.1.64 line).

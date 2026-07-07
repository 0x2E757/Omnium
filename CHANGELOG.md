# Changelog

All notable, user-visible changes to the Omnium plugins. Each plugin is
versioned independently in its `plugin.json`; automatic PATCH bumps are not
listed here — only features (MINOR) and notable fixes. Format follows
[Keep a Changelog](https://keepachangelog.com).

## autonomity

### 0.4.4 — 2026-07-06
- Consolidated into the Omnium marketplace (baseline; supersedes the standalone 0.1.5 line).

## expertum

### 0.4.14 — 2026-07-06
- Consolidated into the Omnium marketplace (baseline; supersedes the standalone 0.3.5 line).

## graphyne

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

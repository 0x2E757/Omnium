# Changelog

All notable, user-visible changes to the Omnium plugins. Each plugin is
versioned independently in its `plugin.json`; automatic PATCH bumps are not
listed here — only features (MINOR) and notable fixes. Format follows
[Keep a Changelog](https://keepachangelog.com).

## autonomity

### Removed — 2026-08-18
- **The plugin is gone from Omnium** (DESIGN.md D19); 0.4.5 was its last
  release. Claude Code drives itself well enough now (ultra code + `/loop`) that
  autonomity had become a workaround rather than a capability. If you have it
  installed, run `/plugin uninstall autonomity@omnium` — leaving it installed
  keeps a marketplace entry that no longer exists. Nothing else depended on it,
  and its only state (`${os.tmpdir()}/claude-autonomity/`) is disposable: delete
  it to be tidy, or let a reboot clear it.

### 0.4.4 — 2026-07-06
- Consolidated into the Omnium marketplace (baseline; supersedes the standalone 0.1.5 line).

## distillum

### 0.1.1 — 2026-07-22
- **Command rename:** `/distillum:skill` → `/distillum:to-skill`,
  `/distillum:docs` → `/distillum:to-docs`. The basename `skill.md` collides
  with Claude Code's `SKILL.md` skill-bundle discovery on case-insensitive
  filesystems: the whole `commands/` directory was claimed as a single skill
  named "commands" and neither command surfaced. 0.1.0 (released the same
  day) was effectively unusable; nothing else changed.

## expertum

### 0.9.1 — 2026-09-28
- A lens can no longer drop out silently. An analyst whose expert name is
  missing or unknown writes no report and replies `NO REPORT: …` (the unknown-
  expert error now tells it exactly that, instead of pointing it at a tool it
  does not have); every command re-spawns such an analyst once and otherwise
  names the missing lens, and in the conduct loops a missing review no longer
  counts as satisfied. The analyst's description now states its brief
  contract (`Expert: <name>`), and an empty `experts/_lanes.md` is a catalog
  defect.

### 0.9.0 — 2026-09-28
- **Breaking — the 54 per-expert sub-agents are gone** (DESIGN.md D21). Every
  registered sub-agent costs a line in every session's agent roster whether or
  not Expertum is used — about 5–7k tokens for the 54 analysts. The plugin now
  registers a single `expertum:analyst`; the 54 expert lenses (role, Focus,
  Method) are data under `experts/`, served by two new MCP tools:
  `expertum_overview` (the roster the commands pick from, with the ownership
  boundaries between lanes) and `expertum_expert` (one lens by name — the
  analyst's first call). All five commands route through them; their inline
  roster tables are gone.
- **Migration:** after `/plugin marketplace update omnium`, run
  `/reload-plugins` (or restart) so the roster drops the old agents. Anything
  that spawned an analyst directly as `subagent_type: "expertum:<name>"` (e.g.
  `expertum:code--quality`) must spawn `expertum:analyst` with
  `Expert: <name>` as the first line of its brief instead, and permission rules
  keyed on the old names (`Agent(expertum:code--quality)`) should move to
  `Agent(expertum:analyst)`. Expert names, report filenames, modes and report
  templates are unchanged.

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

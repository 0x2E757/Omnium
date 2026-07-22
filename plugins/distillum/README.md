# Distillum

A Claude Code plugin that distills **what a session learned** into durable
artifacts — skills and documentation — so the next session starts where this
one ended. Knowledge a session earns the hard way (a working procedure, a
decision and its rationale, a constraint discovered by breaking something)
evaporates when the session ends; Distillum's two commands turn it into
artifacts that persist.

It is **fully standalone**: no hooks, no MCP server, no state, and no
dependency on — or mention of — any other plugin. Two markdown commands and
nothing else.

## The two commands

The split is by the kind of knowledge:

- **`/distillum:skill`** — **procedural** knowledge (*how to do X again*): a
  procedure the session figured out the hard way becomes a reusable skill,
  user-level (`~/.claude/skills/`) or project-level (`.claude/skills/`). The
  command walks a quality checklist: an honesty gate (no skill unless the
  session learned something non-trivially repeatable), dedup against existing
  skills (update, don't fork the trigger surface), a portability test for
  placement, trigger-phrase discipline for the `description`, wrong turns
  embedded as warnings at the step where they bite, and a replay test — would
  the skill have fired, and would it have prevented today's wrong turns?

- **`/distillum:docs`** — **declarative** knowledge (*what is true and why*):
  decisions with rationale, constraints discovered the hard way, behavior that
  contradicted assumptions. The command finds the right home among the
  project's existing documentation surfaces (decision record, `CLAUDE.md`,
  `docs/`, README, module headers), reconciles against what is already
  written — fixing drift when the docs contradict what the session
  established — and makes the smallest timeless edit, honoring whatever
  doc-sync tooling the session has active.

When the harvest turns out to be the other kind — or a mix of both — each
command distills its own kind and **recommends the sibling command to the user
for the rest**; it never invokes the sibling itself, and both refuse to run on
an empty harvest rather than manufacture content.

Distillum is about **knowledge**, not task state: what it writes are skills
and documentation that live with the project or the user's configuration, not
a memory store of its own.

## Install

Distillum ships as part of the **Omnium** plugin collection; see the Omnium
repository's `README.md` and `docs/development.md` for marketplace setup and
install instructions.

## Develop / test

From the Omnium repo root:

```sh
npm test           # run the repo guards (manifest, EOL, zero-dep)
npm run stamp      # auto-bump PATCH when plugin bytes changed (content hash, scripts/version-guard.mjs)
```

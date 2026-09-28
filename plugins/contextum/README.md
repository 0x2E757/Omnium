# Contextum

A Claude Code plugin for **managing what is in the agent's context**. Work on
a task often needs specific context — the code at the center, its callers and
tests, why it is the way it is, the constraints written down somewhere — and
an agent handed the task cold does not always manage to gather it. You
describe the task and requirements, and the agent stalls on context it failed
to find. Meanwhile the context also fills with material nobody asked for, and
the agent quietly fills gaps with assumptions.

Contextum gives you two commands for that: one to **load** the right context
before a task, one to **audit** the context you have.

It is **fully standalone**: no hooks, no MCP server, no state, and no
dependency on — or mention of — any other plugin. Two markdown commands and
nothing else.

## `/contextum:prepare` — load context before a task

**`/contextum:prepare <topic>`** — the topic is a short description of what
to gather context about: a subsystem, a feature, a bug area, or the gist of
the coming task.

The agent reads the relevant material **itself**, so it lands in the main
conversation where the task will run: the central code, its callers and
consumers, its tests, recent history and blame, recorded decisions and
constraints (decision records, `CLAUDE.md`, `docs/`), open work, and the
configuration or gates that govern edits there. It edits nothing and does not
start the task.

The briefing (about 15–25 lines, in your language) is built to be checked,
not just read:

- **How I read the topic** — the interpretation it chose; a wrong one is
  visible in the first line.
- **Anchors** — concrete `file:line` references, each marked **✓ read** or
  **~ inferred** (from a name or search hit), so its knowledge is told apart
  from its guesses.
- **How it actually works**, **Decisions & history** — the non-obvious facts
  and the recorded reasons behind them.
- **Not found / not examined** — where it looked and found nothing, and what
  it deliberately skipped. This is where a miss shows: the thing you needed is
  far easier to spot in a list of what was skipped than to notice missing
  from a list of what was found.
- **Open questions** — what only you can answer.

## `/contextum:report` — audit the current context

**`/contextum:report [task]`** — with a task or topic, the context is judged
against that scope; without one, against the whole session. The agent reads
nothing new and fixes nothing — it describes the context as it is now:

- **Dead weight** — what entered the context but did not pay off, each item
  with its source and a rough weight (large / medium / small):
  **[environment]** material injected independently of any task (instruction
  files like `CLAUDE.md`/`AGENTS.md`, hook injections, agent/skill/tool
  rosters, MCP instructions) — recurring in every session, fixed once in
  configuration; **[agent]** material the agent loaded itself (irrelevant
  reads, oversized outputs, dead-end searches); **[user]** attachments.
- **Weak spots** — where the agent leans on assumptions instead of material it
  examined, under one rule: *if it cannot point to where in this session it
  read something, that is an assumption*. Each is classed — inferred, stale,
  compacted, from memory, second-hand, conflict, missing — ranked by how much
  the scope rests on it, and paired with the step that would firm it up.
- **Worth doing** — the one to three actions with the best payoff.

One limit is inherent: the agent sees its context as it is *now*. After a
compaction, earlier material is visible only through its summary — the report
says so (the **compacted** class) rather than pretending to see the original.

The two commands pair naturally: `report` exposes the gaps, a targeted
`prepare` closes them.

## Install

Contextum ships as part of the **Omnium** plugin collection; see the Omnium
repository's `README.md` and `docs/development.md` for marketplace setup and
install instructions.

## Develop / test

From the Omnium repo root:

```sh
npm test           # run the repo guards (manifest, EOL, zero-dep)
npm run stamp      # auto-bump PATCH when plugin bytes changed (content hash, scripts/version-guard.mjs)
```

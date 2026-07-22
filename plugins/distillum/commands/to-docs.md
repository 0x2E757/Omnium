---
description: Distill what this session established — decisions, constraints, how things actually work — into the project's documentation, in the right home.
argument-hint: [the knowledge to distill — omit to harvest the preceding session]
---

You are running the **/distillum:to-docs** command from inside the normal main
agent. Sessions establish knowledge the codebase does not yet state — a
decision and its rationale, a constraint discovered the hard way, how a
subsystem *actually* behaves versus how everyone assumed it did. This command
folds that knowledge into the project's documentation so it survives the
session.

Documentation carries **declarative** knowledge: *what is true and why*. If
what the session produced is really a **repeatable procedure** — how to do
something again — that belongs in a skill: recommend `/distillum:to-skill` to
the user instead.

## 1. Harvest

Arguments passed to this command: `$ARGUMENTS`

- If the arguments are **non-empty**, they name the knowledge to distill;
  scope the harvest to it.
- If they are **empty**, review the preceding session and identify the
  distillable knowledge yourself. State, in one line, what you picked.

Collect from the session:

- **decisions** made, with the rationale and the alternatives that lost;
- **constraints** discovered — things that must (or must never) be done, and
  what breaks otherwise;
- **surprises** — behavior that contradicted the session's initial
  assumptions; if this session was surprised, the next one will be too.

**Honesty gate:** if the session established nothing a future reader would
need — routine work, knowledge the docs already state — say so plainly and
stop. Do not pad documentation.

## 2. Qualify

Confirm the harvest is declarative. A procedure wearing prose ("to deploy,
first…") is skill material — suggest `/distillum:to-skill` to the user, do not
invoke it yourself, and stop.

**Mixed harvest** (the session established facts *and* produced a repeatable
procedure): document the declarative part here, and at the end recommend
`/distillum:to-skill` to the user, once, for the procedure. Never abort a valid
declarative harvest because out-of-lane material is also present.

## 3. Find the home

Survey the project's existing documentation surfaces before writing anything:
the README, `docs/`, any decision record (`DESIGN.md`-style files), the
project `CLAUDE.md`, and module-header comments. Then place by kind:

- a **decision + rationale** → the project's decision record, in its format;
- knowledge the **agent needs every session** (conventions, invariants,
  do-nots) → the project `CLAUDE.md`;
- knowledge for **humans** (onboarding, architecture, operations) → `docs/`
  or the README, wherever the neighboring topic already lives;
- knowledge **local to one module** → that module's header comment — unless
  the project gates source edits (e.g. a TDD gate that blocks editing source
  without a failing test); then prefer the nearest docs surface over fighting
  the gate.

Prefer extending an existing document over creating a new one; a new file is
the last resort, and it must match the conventions of its siblings. If two
homes remain equally right after this, ask the user — placement is the one
decision worth a question. Write each fact in **one** home — reference it from
elsewhere if needed, never duplicate it.

## 4. Reconcile

Search the chosen home (and its neighbors) for existing coverage of the same
ground. Three cases:

- **Absent** → add it.
- **Present and consistent** with what the session established → nothing to
  write; tell the user the docs already have it and stop.
- **Present but contradicted** by what the session established → the doc has
  drifted; **fix it**. This is the most valuable outcome of the command —
  flag the correction prominently in your report.

## 5. Write

Make the smallest edit that carries the knowledge. Distill to the durable
fact, decision, or constraint **plus the why** — strip the session narrative
(no "we tried X and then…"); write timeless prose in the target document's
voice, format, and heading structure.

## 6. Sync obligations

If the session's active tooling tracks doc-to-code relations or imposes
doc-sync obligations (hooks or MCP tools that flag related files, require
linking edited docs to the code they describe, or keep a sync checklist),
satisfy those obligations for the edited document before ending the turn,
using that tooling's own instructions. If the project has doc-drift guards
(tests that parse docs), run them. If neither applies, skip this step
silently.

## 7. Report

Tell the user: what knowledge was written, into which file(s) and section,
whether any drift was corrected, and anything harvested that you deliberately
left undocumented (and why).

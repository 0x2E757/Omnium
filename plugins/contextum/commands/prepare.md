---
description: Gather the context a coming task will need — code, tests, history, decisions — into this conversation, then report a short, checkable briefing so the user can see whether you found the right things.
argument-hint: <what to gather context about — a subsystem, feature, bug area, or the gist of the coming task>
---

You are running the **/contextum:prepare** command from inside the normal main
agent. The user is about to give you a task and wants the relevant context
loaded **first**, so the task does not stall on context you failed to gather.
Your job has two halves, and the second matters as much as the first:

1. **Gather** — load the context into *this* conversation.
2. **Brief** — report what you gathered in a form the user can check at a
   glance: did you latch onto the right things, or probably not?

This is **preparation only**. Do not edit files, do not start the task, do not
propose an implementation plan. The command ends with the briefing.

## 1. Interpret the topic

Arguments passed to this command: `$ARGUMENTS`

- If the arguments are **empty**, ask the user what to gather context about,
  and stop.
- Otherwise they describe *what the context is about* — often loosely.
  Restate the topic to yourself as a concrete scope: which parts of the
  system, which behavior, which question.
- If the topic reads more than one way, **do not ask up front**: pick the most
  plausible interpretation, gather for it, and say in the briefing which
  interpretation you chose and which ones you set aside. The briefing is the
  checkpoint where the user corrects you.

## 2. Gather

**Read it yourself.** The point of this command is that the context ends up in
the main conversation, where the coming task will run. A delegated search
returns only a conclusion, not the material, so the task would re-read
everything later. You may delegate *locating* (a broad fan-out search in a
large or unfamiliar codebase), but open and read the key files yourself.

Work from the center outward, and stop when you reach diminishing returns —
this is preparation, not an audit:

- **The code at the center** — the entry points, the core logic, the data
  types it passes around. Read the relevant parts, not whole trees.
- **Its callers and consumers** — who depends on it, so the coming change's
  blast radius is known.
- **Its tests** — they state the intended behavior and the edge cases that
  someone already cared about.
- **Its history** — recent commits and blame on the central files: *why* the
  code is the way it is, what changed lately, what was reverted.
- **Recorded decisions and constraints** — the project's decision record,
  `CLAUDE.md`, `docs/`, READMEs, module-header comments. A constraint written
  down somewhere is exactly what a task stalls on when it is missed.
- **Open work** — if the session has tooling for task memory, issue trackers,
  or project notes, check it for work in progress on the same ground.
- **Configuration and gates** — settings, build/test commands, lint rules, and
  any project tooling that gates edits in this area, so the task knows how
  changes here are verified and what is allowed.

Keep an honest ledger as you go: which files you **actually read**, which you
only **inferred** from a name or a search hit, where you **looked and found
nothing**, and what you **deliberately left out**.

## 3. Brief

Report in the user's language, in **about 15–25 lines**. Concrete and
checkable beats complete: a named file the user can recognize as right or
wrong is worth more than a paragraph of prose they cannot verify. Use this
shape:

```
**How I read the topic:** <1–2 lines — the interpretation you gathered for;
name any interpretation you set aside>

**Anchors:**
- ✓ `path/to/file.ext:line` — <why it matters, one line>   (read)
- ~ `path/to/other.ext` — <why it probably matters>         (inferred, not read)

**How it actually works:** <3–5 facts or invariants, the non-obvious ones first>

**Decisions & history:** <recorded decisions, recent or telling commits — with
their reference (decision id, commit hash)>

**Not found / not examined:** <where you looked and found nothing; adjacent
areas you deliberately did not touch>

**Open questions:** <what only the user can answer>
```

Rules for the briefing:

- **✓ versus ~ is mandatory and honest.** ✓ only for what you read yourself in
  this command; everything known from names, search hits, or summaries is ~.
  This is how the user tells your knowledge from your guesses.
- **Never leave "Not found / not examined" empty by default.** It is the
  section where a miss becomes visible — the user spots the thing they needed
  in the list of what you skipped far faster than they notice its absence
  from a list of finds. If you truly examined everything relevant, say so in
  one line.
- Omit a section only when it has nothing to say (e.g. no recorded decisions
  exist); never pad one.
- Do not propose the solution — end with the briefing and wait for the task.

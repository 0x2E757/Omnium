---
description: Distill a procedure this session figured out into a reusable skill, with quality gates for triggers, placement, and a replay test.
argument-hint: [the procedure to distill — omit to harvest the preceding session]
---

You are running the **/distillum:to-skill** command from inside the normal main
agent. Sessions routinely figure out procedures the hard way — wrong turns,
version quirks, the one flag that makes it work — and that knowledge evaporates
when the session ends. This command distills it into a **skill** so the next
session starts where this one ended.

A skill carries **procedural** knowledge: *how to do X again*. If what the
session produced is **declarative** — how something works, why a decision was
made, a constraint that holds — that belongs in documentation: recommend
`/distillum:to-docs` to the user instead.

## 1. Harvest

Arguments passed to this command: `$ARGUMENTS`

- If the arguments are **non-empty**, they name the thing to distill; scope the
  harvest to it.
- If they are **empty**, review the preceding session and identify the
  distillable procedure yourself. State, in one line, what you picked.

Collect from the session:

- the **final working sequence** — exact commands, tools, and order;
- the **wrong turns** and *why each one fails* — this is the most valuable
  part; a skill that only shows the happy path re-earns the failures;
- **discovered constants** — paths, flags, versions, environment quirks that
  took effort to find.

**Honesty gate:** if the session contains nothing non-trivially repeatable —
routine work any session would do the same way — say so plainly and stop. Do
not manufacture a skill; a skill that restates what the model already knows is
pure trigger-surface noise.

## 2. Qualify and dedup

- Confirm the harvest is procedural. If it is really declarative knowledge
  wearing a to-do list, suggest `/distillum:to-docs` to the user — do not invoke
  it yourself — and stop.
- **Mixed harvest** (the session produced both a procedure and declarative
  knowledge): distill the procedural part here, and at the end recommend
  `/distillum:to-docs` to the user, once, for the remainder. Never abort a valid
  procedural harvest because out-of-lane material is also present.
- **Search for an existing skill covering this ground** — the user-level
  skills directory (`~/.claude/skills/`), the project's (`.claude/skills/`),
  and the skills shipped by installed plugins (your available-skills list).
  If a user- or project-level skill exists, **update it** rather than creating
  a sibling: two similar skills split the trigger surface and neither fires
  reliably. A plugin-shipped skill cannot be updated in place — if the harvest
  duplicates one, report the collision to the user instead of shadowing it.

## 3. Place

Apply the portability test: *would this procedure apply, unchanged, in another
repository?*

- **Yes** → user-level: `~/.claude/skills/<name>/SKILL.md`.
- **No** (it depends on this project's layout, stack, or conventions) →
  project-level: `.claude/skills/<name>/SKILL.md`, committed with the project.
- **Both** (a general core with project-specific constants) → write the
  general procedure user-level here; for the project constants, recommend
  `/distillum:to-docs` to the user — placing them is that command's discipline.
  Do not fork the skill per project.

If placement is genuinely ambiguous after the test, ask the user — this is the
one decision worth a question.

## 4. Draft

- **Name:** a kebab-case verb phrase naming the task (`deploy-preview-env`,
  `bisect-flaky-test`), used as the directory and frontmatter `name`.
- **Frontmatter `description`:** this is the skill's *only* discovery surface —
  write it as a when-to-use statement containing the trigger phrases a user
  would actually type, plus a when-NOT-to-use clause if the skill is easily
  confused with a neighbor. Third person, one or two sentences.
- **Body:** imperative steps in execution order. Concrete commands with
  `<placeholders>` for the variable parts. Embed each harvested wrong turn as
  a warning **at the step where it bites**, with the reason it fails — not as
  a trivia section at the end. Keep the total short: only the hard-won deltas
  over what any session would already know.

## 5. Replay test

Before writing anything, replay today's session from its first message against
the draft:

1. Would the `description` have made the skill fire at the moment it was
   needed?
2. Following the steps, would the session have avoided the wrong turns it
   actually took?

If either answer is no, fix the draft — usually the description's trigger
phrases (1) or a missing warning (2) — and replay once more. One corrective
pass normally converges; do not loop further.

## 6. Write and report

Write the `SKILL.md` (creating directories as needed). Then report to the
user: the file path, the skill's name and one-line purpose, whether it was
created or an existing skill was updated (and what changed), and a reminder
that newly added skills are picked up when the next session starts.

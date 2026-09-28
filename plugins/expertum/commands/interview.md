---
description: Interrogate the user to turn a vague idea into a pinned, scoped brief, recording it into .expertum/.
argument-hint: [the rough idea to scope — omit to act on the preceding conversation]
---

You are running the **/expertum:interview** command from inside the normal main
agent. A vague ask ("I want to make an RPG") admits countless implementations
that all technically satisfy it, while the user's real, unspoken requirements
stay hidden. This command drags them into the open: experts surface the
**unspecified decisions** in their lens, you **interrogate the user** through
short adaptive questionnaires until the scope is pinned, then you write a
**brief** the user (or `/expertum:conduct` / `/expertum:conduct-mvp`) can build
against. The analysts stay READ-ONLY and only write reports; the interrogation
and the brief are yours.

## 1. Determine the subject

Arguments passed to this command: `$ARGUMENTS`

- If the arguments above are **non-empty**, treat them as the rough idea to
  scope.
- If they are **empty**, take the idea from the **preceding conversation** — the
  thing the user just said they want. State, in one line, what you are scoping.

## 2. Assemble context (lightweight)

An idea is fuzzy by nature — do not over-research it. But if a codebase or repo
is in play, note the stack, conventions, and hard constraints so the analysts
ask questions grounded in *this* project rather than generic ones. If it is
greenfield, say so; the questions will be about product and platform choices,
not existing code.

## 3. Create the per-run folder (you, the main agent, do this)

- Get a timestamp: PowerShell `Get-Date -Format 'yyyy-MM-dd--HH-mm'`
  (or `date +%Y-%m-%d--%H-%M`).
- Derive `{name}`: a kebab-case slug of the idea, **max 30 characters**.
- Create the folder: `.expertum/<timestamp>--<name>/`
  (e.g. `.expertum/2026-06-11--14-30--rpg-game/`).
- Remember this path as `<RUN_DIR>` — every analyst writes into it, and so does
  the final brief.

## 4. Pick the relevant analysts

Call the `expertum_overview` MCP tool for the roster — every expert's name and
one-line domain, grouped, followed by the **ownership boundaries** between
lanes. Select only those whose domain the idea plausibly touches — typically
3–6, never the whole roster. For a broad, greenfield idea favor the design and
platform lenses; pull in security, operations, or data only when the idea
clearly implicates them. Give each analyst its lane and tell it what it does
NOT own, so their question lists don't overlap.

## 5. Seed the question pool — spawn analysts in `scope` mode (Task tool, one message, parallel)

Spawn every analyst as `subagent_type: "expertum:analyst"`. Give each a precise
brief containing:
- **`Expert: <name>`** as its first line — the analyst loads that expert's lens
  itself.
- **Mode: scope.** The subject is a rough, under-specified idea. It is NOT
  designing or reviewing it — it surfaces the unspecified decisions in its lens
  that must be pinned before the idea can be built.
- The idea, plus any context you assembled.
- Its ownership boundary (what it questions and what it must NOT cover).
- **Output contract:** call `expertum_write_report` with `directory: "<RUN_DIR>"`
  and `filename: "scope--<stem>.md"` (`<stem>` = the expert's name). The report is a
  prioritized list of **Open decisions**, each with **Question** → **Why it
  matters** → **Options** (2–4 concrete candidates, or "open") → **Default**
  (what to assume if unanswered). No Verdict line.
- It must return to you only a short pointer (path + the top one or two
  questions), not the full report.

**Missing report:** if an analyst returns without writing its report (its reply
starts with `NO REPORT:`, or its file is absent from `<RUN_DIR>`), fix its brief
and re-spawn it once; if it fails again, name the missing lens in your result —
never drop it silently.

## 6. Interrogate the user — session loop (this is the heart of the command)

Read every `scope--<stem>.md`. Pool all the Open decisions, **dedup** ones that
different lenses raised about the same thing, and **rank by leverage** — put the
decisions that collapse the most of the solution space first (genre/platform/
target audience before, say, the color of a button).

Then run **sessions**:

- A **session** is 2–3 questionnaires. Each questionnaire is **one
  `AskUserQuestion` call** with up to 4 of the highest-leverage still-open
  decisions; turn each decision's **Options** into the choices (the tool always
  offers the user a free-form "Other" as well). Make the later questionnaires in
  a session **adaptive** — let the answers you just got prune, reshape, or unlock
  the questions you ask next.
- After each session, ask **one control questionnaire**: *"Continue narrowing the
  scope?"* with options **Yes — another round** and **No — finalize the brief**
  (the user can always steer with a custom "Other" answer). This hands the stop
  decision to the user, exactly as intended.
  - **Yes** → start another session, drilling into the decisions the last
    answers opened up. Re-consult a specific analyst in `scope` mode only if a
    genuinely new domain surfaced (e.g. the idea grew a multiplayer backend).
  - **No** → go to phase 7.
  - **Custom steer** → fold it in and let it reshape the remaining questions.
- As you go, record every answer as a **decision** (the chosen option) and every
  question the user skips or defers as an **assumption** (carry its Default) or
  an **open question**.

Keep each questionnaire tight and lead with what most narrows the idea — the goal
is to converge, not to exhaust the user.

## 7. Write the brief

Write `brief.md` into `<RUN_DIR>` via `expertum_write_report`:

```
# <Refined goal, one line>

## Decided
<each pinned decision and the option chosen>

## Assumptions
<defaults taken where the user skipped a question — mark each clearly as an
assumption to be confirmed>

## Out of scope
<directions explicitly rejected during the interrogation>

## Open questions
<deferred, non-blocking — safe to resolve later>

## Next step
<recommend /expertum:conduct — or /expertum:conduct-mvp for a deliberately
minimal build, or /expertum:research — with this brief>
```

## 8. Wrap up

Tell the user where the brief lives, the headline decisions, and the assumptions
they should sanity-check before building. Offer to run `/expertum:conduct`
(or `/expertum:conduct-mvp` when the user wants the smallest implementation
that satisfies the brief) with the brief as its input. Keep the chat summary
tight; the detail lives in `brief.md` and the per-lens `scope--<stem>.md`
reports.

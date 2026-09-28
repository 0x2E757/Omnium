---
description: Drive a task through expert planning, autonomous implementation, and an expert review loop, recording it into .expertum/.
argument-hint: [what to build/change — omit to act on the preceding conversation]
---

You are running the **/expertum:conduct** command from inside the normal main
agent. Unlike `/expertum:review` and `/expertum:research`, this command does not
just advise — it delivers a change. You orchestrate four phases: experts
**plan**, you **reconcile** their plans, you **implement**, then experts
**review** in a loop until they are satisfied. The analysts stay READ-ONLY and
only write reports; **every code change is made by you**, the main agent, using
your Edit/Write/Bash tools. For a deliberately minimal build, prefer
`/expertum:conduct-mvp` — the same loop under a strict MVP contract.

## 1. Determine the task

Arguments passed to this command: `$ARGUMENTS`

- If the arguments above are **non-empty**, treat them as the task to build or
  change (a feature, a fix, a refactor).
- If they are **empty**, take the task from the **preceding conversation** — the
  thing the user just asked to build or the fix just discussed. State, in one
  line, what you concluded you are implementing.

## 2. Assemble the context

Gather what the analysts need to plan well — do not make them guess:
- The requirement and its acceptance criteria.
- The files/areas in play and the relevant existing code.
- The constraints that bind the solution: the project's conventions, its test
  discipline, and any cross-cutting rules. If in a git repo, note the baseline
  (`git status`, the current branch).
State plainly what is being built and over which files.

## 3. Create the per-run folder (you, the main agent, do this)

- Get a timestamp: PowerShell `Get-Date -Format 'yyyy-MM-dd--HH-mm'`
  (or `date +%Y-%m-%d--%H-%M`).
- Derive `{name}`: a kebab-case slug of the task, **max 30 characters**.
- Create the folder: `.expertum/<timestamp>--<name>/`
  (e.g. `.expertum/2026-06-11--14-30--rate-limiter/`).
- Remember this path as `<RUN_DIR>` — every analyst writes into it, across both
  the plan phase and every review round.

## 4. Pick the relevant analysts

Call the `expertum_overview` MCP tool for the roster — every expert's name and
one-line domain, grouped, followed by the **ownership boundaries** between
lanes. Select only those whose domain the task touches — typically 3–6, never
the whole roster. The SAME analyst owns its lens in both phases: it drafts the
plan for its lens (phase 5) and later reviews the implementation for that lens
(phase 8). Give each analyst its lane and tell it what it does NOT own, so
plans and reviews don't overlap.

Spawn every analyst, in every phase, as `subagent_type: "expertum:analyst"`,
with **`Expert: <name>`** as the first line of its brief — the analyst loads
that expert's lens itself.

## 5. Plan phase — spawn analysts in `plan` mode (Task tool, one message, parallel)

Give each analyst a precise brief containing:
- **Mode: plan.** It is designing an implementation plan for the task through its
  lens — reading the codebase (Read/Glob/Grep) and, where useful, the internet.
- The task, the assembled context, and the files in play.
- Its ownership boundary (what it plans for and what it must NOT cover).
- **Output contract:** call `expertum_write_report` with `directory: "<RUN_DIR>"`
  and `filename: "plan--<stem>.md"` (`<stem>` = the expert's name). The report leads
  with the recommended **Approach**, then **Steps** (file-level, in apply order),
  **Risks** (with mitigations), **Validation** (how to prove it works, tests to
  add), and **Open questions**. No Verdict line.
- It must return to you only a short pointer (path + headline), not the full plan.

## 6. Reconcile into one plan (you, the main agent)

Read every `plan--<stem>.md` and fold them into a **single, sequenced
implementation plan**. Where two analysts genuinely conflict — incompatible
approaches, contradictory ordering, or a trade-off they weigh differently — do
not silently pick one:
- Run **one** re-consultation round: re-invoke only the conflicting analysts in
  `plan` mode, each given the opposing position(s), and ask for a compromise or a
  decisive argument. They write `plan--<stem>--v2.md`.
- If the conflict survives that round, **you decide**, and record the decision
  and its trade-off explicitly in the unified plan. Do not re-consult more than
  once — a second round rarely converges and burns budget.

The output of this phase is one plan you can execute, with any resolved
contradictions and their rationale written down.

## 7. Implement (you, the main agent)

Execute the unified plan with your Edit/Write/Bash tools:
- Follow the project's own conventions and **test discipline** — if the repo
  enforces a TDD or commit gate, honor it exactly (write the failing test first
  where that is the rule).
- Keep the change scoped to the plan; note any deviation you make and why.
- Get the change to a coherent, self-consistent state before asking for review.

## 8. Review loop (experts review → you fix), max **5** rounds

Starting at round `N = 1`:
1. Assemble the diff to review: `git diff` (and `git diff --staged`) if in a git
   repo, otherwise the set of changed files.
2. Spawn the relevant analysts in **`review` mode** on that diff (one message,
   parallel). Reuse the phase-4 set; add a reviewer only if the implementation
   grew into a new domain. Output contract: `expertum_write_report` with
   `directory: "<RUN_DIR>"`, `filename: "review-r<N>--<stem>.md"`, a one-line
   **Verdict** (`approve` | `approve-with-nits` | `request-changes` | `block`),
   and findings tagged with severity and a `file:line`.
3. Read the verdicts. **Satisfied** := no verdict is `request-changes` or
   `block` (`approve-with-nits` is satisfied).
   - **Satisfied** → leave the loop, go to phase 9.
   - **Not satisfied** → apply fixes for every `request-changes`/`block` finding,
     set `N = N + 1`, and repeat from step 1.
4. **Cap:** if round 5 finishes still not satisfied, **STOP** — do not keep
   looping. Five rounds without convergence means something deeper is wrong (an
   unclear requirement, analysts demanding mutually exclusive changes, or a task
   too large for one pass). Report the residual objections and what is blocking,
   and hand back to the user rather than thrash.

## 9. Wrap up

Summarize for the user:
- What was built and the files changed.
- The final verdicts per analyst (and the round count it took).
- Key decisions and trade-offs — especially any contradiction you reconciled in
  phase 6, and why you chose as you did.
- If you stopped at the cap, the residual objections and your recommendation.
Optionally write a combined `conduct--summary.md` into `<RUN_DIR>` via
`expertum_write_report`. Keep the chat summary tight; the detail lives in the
reports and the diff.

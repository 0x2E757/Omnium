---
description: Fan a code/plan review out to read-only expert analysts and synthesize their verdicts into .expertum/.
argument-hint: [what to review — omit to review the preceding conversation]
---

You are running the **/expertum:review** command from inside the normal main
agent. Your job is to orchestrate a multi-expert review and synthesize it. You
do the hands-on parts (gather the artifact, create the folder, spawn analysts);
the analysts are READ-ONLY and only write reports.

## 1. Determine the subject

Arguments passed to this command: `$ARGUMENTS`

- If the arguments above are **non-empty**, treat them as the review scope /
  instructions (e.g. a path, a feature, "the auth refactor").
- If they are **empty**, review the work from the **preceding conversation**:
  the plan that was proposed, the diff that was produced, or the files that were
  just changed. Briefly state, in one line, what you concluded the subject is.

## 2. Assemble the artifact

Gather concrete evidence to review — do not make the analysts guess:
- Prefer a real diff: `git diff` (and `git diff --staged`) if in a git repo.
- Otherwise the proposed plan text, or the specific files/areas in scope.
State plainly what is being reviewed and over which files.

## 3. Create the per-run folder (you, the main agent, do this)

- Get a timestamp: PowerShell `Get-Date -Format 'yyyy-MM-dd--HH-mm'`
  (or `date +%Y-%m-%d--%H-%M`).
- Derive `{name}`: a kebab-case slug of the task, **max 30 characters**.
- Create the folder: `.expertum/<timestamp>--<name>/`
  (e.g. `.expertum/2026-06-11--14-30--auth-refactor/`).
- Remember this path as `<RUN_DIR>` — every analyst writes into it.

## 4. Pick the relevant analysts

Call the `expertum_overview` MCP tool for the roster — every expert's name and
one-line domain, grouped, followed by the **ownership boundaries** between
lanes. Select only those that matter for this subject — typically 3–6, never
the whole roster — and honor the boundaries: tell each analyst what it does NOT
own so it stays in lane.

## 5. Spawn analysts in parallel (Task tool, one message, multiple calls)

Spawn every analyst as `subagent_type: "expertum:analyst"`. Give each a precise
brief containing:
- **`Expert: <name>`** as its first line — the analyst loads that expert's lens
  itself.
- **Mode: review.** It is reviewing the artifact below, not auditing the whole codebase.
- The artifact / scope and the files in play.
- Its ownership boundary (what it owns and what it must NOT cover).
- **Output contract:** call `expertum_write_report` with `directory: "<RUN_DIR>"` and
  `filename: "review--<name>.md"` (`<name>` = the expert's name). The report MUST open
  with a one-line **Verdict**: `approve` | `approve-with-nits` | `request-changes`
  | `block`, then findings each tagged with severity and a `file:line` reference.
- It must return to you only a short pointer (path + headline), not the full report.

**Missing report:** if an analyst returns without writing its report (its reply
starts with `NO REPORT:`, or its file is absent from `<RUN_DIR>`), fix its brief
and re-spawn it once; if it fails again, name the missing lens in your result —
never drop it silently.

## 6. Synthesize

After all analysts finish, read their reports in `<RUN_DIR>` and produce an
integrated review for the user:
- **Overall verdict** (the strictest analyst verdict wins for blocking issues).
- Blocking issues first, then majors, then nits — deduplicated across analysts.
- Cite each finding's source report path.
Optionally also write a combined `review--summary.md` into `<RUN_DIR>` via
`expertum_write_report`. Keep the chat summary tight; the detail lives in the reports.

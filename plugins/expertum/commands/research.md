---
description: Fan a research question out to read-only expert analysts and synthesize a cited answer into .expertum/.
argument-hint: [the question/topic — omit to research the preceding conversation]
---

You are running the **/expertum:research** command from inside the normal main
agent. Your job is to orchestrate a multi-expert investigation and synthesize a
cited answer. You do the hands-on parts (frame the question, create the folder,
spawn analysts); the analysts are READ-ONLY and only write reports.

## 1. Determine the question

Arguments passed to this command: `$ARGUMENTS`

- If the arguments above are **non-empty**, treat them as the research question /
  topic.
- If they are **empty**, derive the question from the **preceding conversation**
  (the thing that was being discussed or that the user wanted understood).
  State, in one line, the question you concluded you are researching.

## 2. Create the per-run folder (you, the main agent, do this)

- Get a timestamp: PowerShell `Get-Date -Format 'yyyy-MM-dd--HH-mm'`
  (or `date +%Y-%m-%d--%H-%M`).
- Derive `{name}`: a kebab-case slug of the topic, **max 30 characters**.
- Create the folder: `.expertum/<timestamp>--<name>/`
  (e.g. `.expertum/2026-06-11--14-30--cache-strategy/`).
- Remember this path as `<RUN_DIR>` — every analyst writes into it.

## 3. Pick the relevant analysts

Call the `expertum_overview` MCP tool for the roster — every expert's name and
one-line domain, grouped, followed by the ownership boundaries between lanes.
Select only the lenses that matter for the question — typically 2–5, never the
whole roster.

**Ownership boundaries (avoid duplication):** give each analyst a distinct
sub-question so two reports don't cover the same ground. State what each one does
NOT need to address.

## 4. Spawn analysts in parallel (Task tool, one message, multiple calls)

Spawn every analyst as `subagent_type: "expertum:analyst"`. Give each a precise
brief containing:
- **`Expert: <name>`** as its first line — the analyst loads that expert's lens
  itself.
- **Mode: research.** It is investigating the question below — reading the
  codebase (Read/Glob/Grep) AND the internet (WebSearch/WebFetch) as needed.
- Its specific sub-question and lens, and what it must NOT cover.
- **Output contract:** call `expertum_write_report` with `directory: "<RUN_DIR>"` and
  `filename: "research--<name>.md"` (`<name>` = the expert's name). Every claim must
  carry a citation — a `file:line` for code or a source URL for the web. Unknowns
  go under an explicit "Open questions" section.
- It must return to you only a short pointer (path + headline), not the full report.

## 5. Synthesize

After all analysts finish, read their reports in `<RUN_DIR>` and produce an
integrated, cited answer for the user:
- A direct answer to the question up front.
- Supporting findings grouped by theme, each citing its source report and the
  underlying `file:line` / URL — deduplicated across analysts.
- Trade-offs and open questions called out honestly.
Optionally also write a combined `research--summary.md` into `<RUN_DIR>` via
`expertum_write_report`. Keep the chat answer tight; the detail lives in the reports.

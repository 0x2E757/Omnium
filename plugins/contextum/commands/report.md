---
description: Audit your current context — what in it is dead weight (and where it came from), and where it is incomplete or unreliable, with you leaning on assumptions instead of material you actually examined.
argument-hint: [a task or topic to judge the context against — omit to judge it against the whole session]
---

You are running the **/contextum:report** command from inside the normal main
agent. The user wants an honest audit of your **current context** along two
axes:

1. **Dead weight** — what entered the context but did not pay off, and *how
   and why* it got there.
2. **Weak spots** — where the context is incomplete or unreliable, and you are
   relying on your own assumptions rather than material you actually
   examined.

This is **a report only**. Do not read more files, do not re-run anything, do
not fix what you find — the audit describes the context *as it is now*.
Gathering more would change the very thing being audited.

## 1. Fix the scope

Arguments passed to this command: `$ARGUMENTS`

- If the arguments are **non-empty**, they name a task or topic: judge
  everything against **that scope**. Dead weight is what does not serve it;
  weak spots are the gaps that matter for it.
- If they are **empty**, judge against **the whole session**: dead weight is
  what served nothing the session actually did; weak spots are the gaps under
  what the session concluded, built, or is about to build.

Either way, dead weight is not only what *you* loaded. Much of a context is
filled independently of any task — instruction files (`CLAUDE.md`,
`AGENTS.md`), session-start injections from hooks, rosters of available
agents, skills, and tools, MCP server instructions, system reminders. Those
belong in the audit on equal terms: they recur in every session, so they are
often the most valuable finding.

## 2. Audit dead weight

Walk the context — the injected material at the start, the tool results, the
user's attachments — and list what did not pay off within the scope. For
each item give:

- **What** it is, specifically (which file, which injection, which tool
  output).
- **Source** — how and why it got in, in one of three classes, because the
  class decides who can act on it:
  - **[environment]** — injected by the harness, instruction files, hooks,
    plugins, or MCP servers, independently of the task. Name the injector as
    precisely as the context lets you (e.g. "a SessionStart hook", "the
    agent roster", "the project CLAUDE.md"). Fixed once, in configuration,
    for every future session.
  - **[agent]** — you loaded it: a file read that proved irrelevant, an
    oversized command output, a dead-end search, a duplicate read. Fixed in
    how you work.
  - **[user]** — pasted or attached by the user.
- **Weight** — rough only: **large / medium / small**. You have no exact
  token counts; never invent numbers.

Do not list what was merely *unused so far* but plausibly needed for the
scope, and do not list something just because it is large — only what did
not, and will not, pay off. If a piece was partly useful, say which part.

## 3. Audit weak spots

The governing rule: **if you cannot point to where in this session you read
it, it is an assumption.** Go through what the scope depends on — facts about
the code, its behavior, its constraints, tools and APIs, the user's intent —
and list each one you hold without that backing. Classify:

- **[inferred]** — concluded from a name, a search hit, or a pattern, not from
  reading the thing itself.
- **[stale]** — read, but it has changed or may have changed since (your own
  edits, git operations, generated files, time-sensitive state).
- **[compacted]** — known only through a summary of earlier context; the
  original is no longer visible to you. Say so plainly instead of treating
  the summary as the source.
- **[from memory]** — behavior of a library, API, tool, or platform taken from
  your training rather than checked in this session.
- **[second-hand]** — a subagent's or a tool's conclusion whose underlying
  material you did not examine yourself.
- **[conflict]** — sources that disagree, and you have not resolved which is
  right.
- **[missing]** — something the scope needs that was never gathered at all.

Rank weak spots by **how much the scope rests on them**, highest first. For
each, name the concrete step that would firm it up ("read `path:line`", "run
the test", "ask the user whether…").

## 4. Report

Report in the user's language, compact — each item is one line. Use this
shape:

```
**Judged against:** <the scope from step 1 — the given task, or "the whole
session" plus one line on what the session did>

**Dead weight:**
- [environment] <what> — <weight> — <how it got in>; <why it did not pay off>
- [agent] <what> — <weight> — <how it got in>; <why it did not pay off>

**Weak spots** (most load-bearing first):
- [inferred] <what you are assuming> — <what it rests on> → <how to firm it up>
- [stale] …

**Worth doing:** <1–3 actions with the best payoff — e.g. a configuration
change that removes recurring noise, a targeted read, a compaction or a fresh
start — or "nothing pressing">
```

Rules for the report:

- **Be specific.** "Some files were irrelevant" is useless; name them.
- **Be honest in both directions.** Do not manufacture findings to fill a
  section — an empty section is stated in one line ("no notable dead weight")
  — and do not hide an uncomfortable one, least of all a weak spot under a
  conclusion you already gave the user.
- **Stay a report.** Recommend, do not act; end with the report and wait.

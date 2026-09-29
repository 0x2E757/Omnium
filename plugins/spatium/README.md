# Spatium

A Claude Code plugin that gives the agent a **sense of time**. A model does not
see a clock and tends to misjudge how long its work takes. Spatium tells it the
real time at the start of every prompt and after every tool call, along with
how long the current prompt has been running. Optionally it also shows how much
of a **time budget** you gave the prompt is already used.

The budget guides the agent; it does not police it. The share can pass 100%
(`112%, over by 3m30s`). Even the hard limit is enforced by the agent itself:
nothing is cut off, because an agent stopped mid-edit is worse than one that
overran.

## What the agent sees

At session start, a short primer ending in `Session started at 2026-09-29
14:05:12 +03:00 (Tue).` (`Session resumed at` or `Context compacted at` when that
is what fired it). At the start of every prompt:

```
Spatium: prompt received at 2026-09-29 14:20:06 +03:00 (Tue). Your last reply ended 1h05m ago.
Previous turn: 23m10s of a 30m guide budget (77%).
```

These lines stay in the context for the rest of the session, so each one names
the event it marks. A bare "now" would still read as the current time an hour
later.

After every tool call:

```
Spatium: 14:32:10, turn time 12m04s.                              (no budget)
Spatium: 14:32:10, 12m04s of 30m guide budget (40%).              (/spatium:budget)
Spatium: 14:51:40, 33m30s of 30m guide budget (112%, over by 3m30s).
Spatium: 14:41:00, 11m of 10m hard limit (110%). HARD LIMIT REACHED (110%): stop at the next safe point ...
```

Guidance is added once when the share first reaches **50%, 80%, 100%**, and
then at every further **50%**. The per-call line stays short. For a hard limit,
the stop order repeats on every tick once 100% is reached.

Time spent **waiting on you** is never charged to the budget: that covers
`AskUserQuestion` dialogs, and with `/spatium:continue` also the time you took
to reply. The tick line shows that time separately.

## What you see

Every turn gets two stamps from Claude Code's `systemMessage` channel. They are
shown to you but never reach the model's context, so they cost no tokens:

```
Spatium: 17:43:05                                    (under your prompt)
Spatium: 17:43:40 · turn 35s                         (after the reply)
Spatium: 17:43:05 · 30m guide budget                 (a budgeted prompt)
Spatium: 17:43:40 · 35s of 30m guide budget (2%)     (a budgeted reply)
```

No hook fires between the agent's messages inside a turn, so a stamp before
each intermediate message is not possible. Set `SPATIUM_USER_STAMPS=0` (for
example in the `env` of `settings.json`) to turn the stamps off. A budgeted
turn's closing report is still shown.

## Commands

| Command | What it does |
|---------|--------------|
| `/spatium:budget <duration> <task>` | Runs the task under a **guide** budget: a reference point, overrunning is allowed and reported. |
| `/spatium:limit <duration> <task>` | Runs the task under a **hard** limit the agent enforces on itself: wrap up at 80%, stop at the next safe point at 100% and report what is done and what remains. |
| `/spatium:continue [+duration \| duration] [instructions]` | Carries the previous prompt's budget into this one. `+15m` extends it, `45m` sets a new total. |

Durations: `90s`, `30m`, `10min`, `1h30m`, `1.5h`, or a bare number of minutes;
a day at most.

A budget belongs to **one prompt**. Any ordinary prompt clears it, so a stale
budget can never leak into the next task. To keep going under the same budget,
start the follow-up prompt with `/spatium:continue`.

Every budget declaration also tells the agent never to trade correctness for
time silently: if it skips something because of the budget, it has to say so.

## How it works

One file, `hooks/spatium.mjs`, wired in `hooks/hooks.json` for six events:

| Event | Behavior |
|-------|----------|
| `SessionStart` | A short primer explaining the `Spatium:` lines, plus the current time. After compaction or resume it restates the active budget. Also prunes state files untouched for a week. |
| `UserPromptSubmit` | Starts the turn clock and reads a `/spatium:*` command from the raw prompt. Emits the time header and, when a budget is set, the budget declaration, plus your opening stamp. A background-task notification also arrives here, often mid-turn; it only gets a tick and never restarts the clock or clears the budget. |
| `PreToolUse` (`AskUserQuestion` only) | Marks the start of a wait on the user. |
| `PostToolUse`, `PostToolUseFailure` | Emits the tick line and any newly reached guidance. |
| `Stop` | Records the turn for the next prompt's header and shows you the closing stamp (with the budget share when there is one). |

State is one small JSON file per session in the plugin's persistent data dir
(`${CLAUDE_PLUGIN_DATA}/sessions/<session_id>.json`). Under `--plugin-dir`,
where there is no data dir, it goes to `<os tmpdir>/claude-spatium/sessions/`.
Only turn boundaries, threshold announcements and user waits write it; ordinary
ticks only read it.

A subagent's tool calls tick too and show the parent prompt's budget. A
subagent never uses up an announcement meant for the main agent.

The hook **fails open**. Garbage input, a corrupt state file or an unsafe
session id each degrade to a clock-only line or to silence, never to an error.
It is pure Node built-ins and cross-platform, with no MCP server and no
dependencies.

## Cost

Every tool call spawns one short `node` process (the node startup dominates; the
script itself takes a few milliseconds) and adds about 30-40 tokens of context.
A long task with 150 tool calls therefore spends a few thousand tokens on
time-keeping. The lines are appended at the end of the context, so they never
invalidate the prompt cache.

## Install

Spatium ships as part of the **Omnium** plugin collection. See the Omnium
repository's `README.md` and `docs/development.md` for marketplace setup and
install instructions.

## Develop / test

From the Omnium repo root:

```sh
npm test           # unit, end-to-end and wiring tests (zero dependencies)
npm run stamp      # auto-bump PATCH when plugin bytes changed
```

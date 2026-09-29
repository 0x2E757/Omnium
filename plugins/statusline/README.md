# Statusline

A Claude Code plugin that ships a **custom status line** — the row at the bottom
of the session showing the model, the project directory, and whatever else you
put there.

Claude Code plugins **cannot declare a status line in their manifest**; the
`statusLine` setting lives only in your `settings.json`. This plugin bridges that
gap: a single `SessionStart` hook prepares the renderer and **nudges the agent
to install** the one-line `statusLine` command for you, once. It is pure Node
built-ins, so it is **cross-platform** (Windows/macOS/Linux), and it **fails
open** — a bug can never brick a session or the bar.

## How it works

One hook, wired in `hooks/hooks.json` and dispatched by `hooks/hook.mjs`:

| Event | Behavior |
|-------|----------|
| `SessionStart` | Copies the renderer into the plugin's persistent data dir, then — unless this plugin's status line is already installed — injects a primer asking the agent to install it (or to **ask you first** if a different `statusLine` is already configured). If your `settings.json` exists but can't be parsed, it stays silent rather than nudge over a config it can't read. |

Every other event is a silent no-op.

### Why it copies the renderer

Plugins install into a **version-stamped cache** directory (`.../<version>/…`)
that changes on every update, and `${CLAUDE_PLUGIN_ROOT}` does **not** expand
inside a `statusLine` command. So a `settings.json` command pointing straight at
the cache would break on the next version bump. Instead the hook copies the
renderer into the **persistent per-plugin data dir** (`${CLAUDE_PLUGIN_DATA}`,
stable across bumps) and the installed command points there — it keeps working,
and the hook refreshes the copy whenever the shipped renderer changes.

### Installing the status line

On first run the agent is nudged to set, in your `~/.claude/settings.json`:

```json
{
  "statusLine": { "type": "command", "command": "node \"<data-dir>/render.mjs\"", "refreshInterval": 5 }
}
```

The agent does this **with you** (it never edits `settings.json` silently), and
if you already have a status line it will **ask before replacing it**. Don't want
this status line? Just disable the plugin.

`refreshInterval` re-renders the line every 5 seconds, so the footer clock keeps
moving while the agent works. Without it the line only re-renders on events such
as a new assistant message. An install of this status line that lacks a
refresh interval gets the timer added on the next session start. An interval you
set yourself (any number ≥ 1) is kept. Every render spawns node and re-reads the
transcript, which is why the default is not 1.

## What it shows

Four lines: `<account> @ <folder> :: <model> (<effort>)` — the folder is the
session's **project directory** (`workspace.project_dir`, where Claude Code was
started), so it stays put even when the agent walks into a subdirectory; the
reasoning effort is
shown only when the payload carries one (i.e. for models where it applies) and is
color-coded up the ramp: `low` red, `medium` orange, `high` the folder tone,
`xhigh` violet, `max` purple; a **context** usage bar with
whole-session token totals (summed from the transcript); a **session** (5-hour
window) usage bar with last-prompt cache figures; and a footer with the clock,
the rate-limit reset time, API time and cost.

## Customizing the line

Everything the bar shows lives in `statusline/render.mjs`. Its pure core,
`renderStatusline({ data, user, now, transcriptText })`, takes the parsed
[status JSON](https://code.claude.com/docs/en/statusline) plus the resolved
account, clock, and transcript text and returns the multi-line string; the IO
shell at the bottom gathers those inputs (stdin, `~/.claude.json`, the transcript
file) and prints. Edit the core to change the layout, colors, or fields. Keep it
pure and self-contained (Node built-ins only, no relative imports): the file is
copied standalone into the data dir, so it must run on its own, and it **fails
open** — on any error it prints nothing rather than a stack trace.

## Install

Statusline ships as part of the **Omnium** plugin collection; see the Omnium
repository's `README.md` and `docs/development.md` for marketplace setup and
install instructions.

## Develop / test

From the Omnium repo root:

```sh
npm test           # run the unit + wiring tests (zero dependencies)
npm run stamp      # auto-bump PATCH when plugin bytes changed (content hash, scripts/version-guard.mjs)
```

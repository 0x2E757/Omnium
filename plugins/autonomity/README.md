# Autonomity

A Claude Code plugin that keeps the agent **autonomous**. It is toggled
**per session**:

- `/autonomity:on` — enable autonomous mode for the current session.
- `/autonomity:off` — disable it again.
- `/autonomity:status` — report whether it is currently on or off (no change).

The default is **off**: until you run `/autonomity:on`, the plugin does nothing
(normal permission flow, no Stop gate). The toggle is handled entirely by the
`UserPromptSubmit` hook — it flips a per-session flag and erases the prompt, so
neither command produces a model turn. State lives in a small file keyed by the
session id under the OS temp dir (`<tmp>/claude-autonomity/`).

While it is **on** it:

1. **Blocks user-facing prompts.** The `AskUserQuestion` tool is denied — the agent
   must resolve ambiguity itself from the conversation, the code, and sensible
   defaults instead of stopping to ask.
2. **Auto-approves everything else.** Every other tool call is allowed, which
   *bypasses the permission system entirely* — no permission dialogs, and plan
   approval (`ExitPlanMode`) is accepted without waiting on you. The agent never
   stalls on a prompt.
3. **Blocks pushing to a remote.** A Bash `git push` (in any form) is denied. The
   agent keeps its commits local and defers the push for you to perform.
4. **Blocks edits outside the working directory.** `Edit`/`Write`/`MultiEdit`/
   `NotebookEdit` whose target resolves outside the session `cwd` are denied, so
   the agent cannot stray beyond the project.
5. **Blocks cancelling a scheduled task.** The `CronDelete` tool is denied, so the
   agent cannot tear down a schedule you set up (e.g. a `/loop`) — it must keep
   iterating and leave cancellation to you.
6. **Gates Stop on a clean git tree.** When the agent tries to finish, Stop is
   **blocked** if there are uncommitted changes. The agent is told to commit (or
   stash) and only then may end the turn. **CRLF/LF-only churn is ignored** —
   a tracked file counts only when a change survives `git diff --ignore-cr-at-eol`
   (staged and worktree), so phantom line-ending differences never trap the agent;
   untracked files always count. **Secret-shaped paths are never pushed toward a
   commit**: dirty files whose names look like credentials (`.env*`, key files,
   `id_rsa*`, `.npmrc`/`.netrc`-style auth configs, dumps — `.env.example`-style
   committed-on-purpose variants exempted) are split into their own section of
   the block reason with the opposite instruction — gitignore (untracked) or
   `git stash push` (tracked), never `git add`, and report them in the final
   summary for the user to decide. The classification is done by the hook, not
   the agent, and the message explicitly forbids gitignoring anything else to
   escape the gate.

For guards 3, 4 and 5 the deny reason tells the agent **not to work around** the
block but to **defer** the task for you to do when you take control.

It is **pure hooks** — no MCP server, no build step, zero dependencies (Node
built-ins only).

## How it works

Four hooks, wired in `hooks/hooks.json`, all dispatched by `hooks/hook.mjs`.
**Every enforcement below is gated on the per-session flag** — when the session
is off, `PreToolUse`/`SessionStart`/`Stop` are no-ops:

| Event | Behavior |
|-------|----------|
| `UserPromptSubmit` | `/autonomity:on` / `/autonomity:off` → write the session flag and `block` (erase) the prompt; `/autonomity:status` → `block` reporting the current state without changing it. Any other prompt, while on, carries the autonomy primer as `additionalContext` (so the agent stays primed even though it was toggled on mid-session). |
| `PreToolUse` (matcher `*`) | `AskUserQuestion` → `deny`; `CronDelete` → `deny`; a Bash `git push` → `deny`; an edit tool targeting a path outside `cwd` → `deny`; every other tool → `allow`. |
| `SessionStart` | Injects an `additionalContext` primer so the agent knows it is autonomous, what the guards are, and that it must commit before stopping. (Only fires for a session already toggled on — e.g. a resumed session.) |
| `Stop` | Runs git in the session's `cwd`; emits `{"decision":"block"}` listing the dirty files when the tree is not clean. Loop protection: when the payload carries `stop_hook_active` (boolean `true` or string `"true"` — the stop is already a continuation caused by a prior stop-hook block) **and this gate itself already blocked in the current stop chain** (own marker, cleared by the next user prompt), it is **waived** with a `systemMessage` warning instead of re-blocking. The gate keeps one guaranteed block per chain — another plugin's block never disarms it — and the harness's own 8-no-progress-block cap remains the backstop. |

The `git push` guard parses each shell segment and only fires on `push` as a real
git **subcommand**, so `git commit -m "push fix"` is unaffected; Windows spellings
(`git.exe`, `GIT`) fold to `git` before the check. The cwd-containment guard
compares paths case-insensitively on Windows and macOS (case-insensitive default
filesystems) and case-sensitively on Linux. These guards do not try to
catch pushes hidden behind aliases/eval, nor arbitrary out-of-tree writes done
through Bash (only the edit tools). The autonomity guards are best-effort
guardrails, reinforced by the SessionStart primer, not a sandbox.

`SubagentStop` is intentionally **not** gated — subagents don't own the commit.

### Safety and escape hatches

- **Fail-open.** Any error in the hook emits nothing, so a bug can never brick a
  session: `PreToolUse` falls back to the normal permission flow and `Stop` is
  allowed.
- **Explicit user rules still win.** A hook `allow` does not override a user's
  *explicit* `deny`/`ask` permission rules in settings — those keep their
  precedence, so you retain a hard block for anything you've forbidden.
- **No git, no gate.** If the project is not a git repository (or git isn't
  installed), the Stop gate is skipped — the agent is never trapped.
- **Off by default.** A freshly started session is off; the plugin enforces
  nothing until you run `/autonomity:on`, and `/autonomity:off` stands it back
  down at any time. (To remove it entirely, use Claude Code's own
  enable/disable, or scope where you install it.)

## Install

Autonomity ships as part of the **Omnium** plugin collection; see the Omnium
repository's `README.md` and `docs/development.md` for marketplace setup and
install instructions.

## Develop / test

From the Omnium repo root:

```sh
npm test           # run the unit + wiring tests (zero dependencies)
npm run stamp      # auto-bump PATCH when plugin bytes changed (content hash, scripts/version-guard.mjs)
```

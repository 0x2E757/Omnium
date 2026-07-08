# Omnium

One local Claude Code plugin marketplace housing its plugins as committed,
zero-dependency, human-readable source. No build step: `plugins/<name>/` is
byte-for-byte what installs.

<!-- Plugin roster: keep in sync with .claude-plugin/marketplace.json —
     enforced by tests/omnium/manifest.test.mjs. Add a plugin = one row here. -->
| Plugin | What it does |
|--------|--------------|
| autonomity | Per-session autonomous mode: blocks user-facing prompts, auto-approves plan/permission prompts, clean-git Stop gate (`/autonomity:on\|off\|status`) |
| cautium | Always-on security conscience: a `SessionStart` hook injects a universal secure-engineering primer into every session; zero-config, no commands, no state |
| expertum | `/expertum:review`, `/expertum:research`, `/expertum:interview`, `/expertum:conduct` — fan work out to 54 read-only expert analysts; reports land in `.expertum/` via a zero-dep MCP server |
| graphyne | TDD gate + bidirectional related-files graph (MCP) with adoption hooks, per git project (`/graphyne:setup`) |
| memosyne | Session-independent task memory (MCP) + adoption hooks (`/memosyne:setup`) |
| sessio | Always-on scratch-file router: a `SessionStart` hook keeps temporary/generated files in a per-task dated subdir of a scratch root (`CLAUDE_SESSIONS_DIR`); onboards you to set it when unset |
| statusline | Custom Claude Code status line: a `SessionStart` hook copies a self-contained renderer into the persistent data dir and nudges the agent to install a one-line `statusLine` command pointing at it (asks first if a foreign one exists); pure Node, fails open |

## Install

In a Claude Code session, add the marketplace:

```
/plugin marketplace add 0x2E757/Omnium
```

Then install the plugins — either interactively by browsing the marketplace
with `/plugin`, or directly:

<!-- Install roster: keep in sync with .claude-plugin/marketplace.json —
     enforced by tests/omnium/manifest.test.mjs. -->
```
/plugin install autonomity@omnium
/plugin install cautium@omnium
/plugin install expertum@omnium
/plugin install graphyne@omnium
/plugin install memosyne@omnium
/plugin install sessio@omnium
/plugin install statusline@omnium
```

## Developing

One-time: `npm install` and `git config core.hooksPath scripts/git-hooks`.
Read `docs/development.md` (workflow, style charter) and `DESIGN.md`
(binding decisions, backward-compatibility contract).

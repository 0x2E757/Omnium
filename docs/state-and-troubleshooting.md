# State, recovery & uninstall

What each Omnium plugin writes to disk, how to recover from the handful of
realistic failure modes, and how to remove everything cleanly. `<repoRoot>` is
the git toplevel of your working directory (or the directory itself if it is not
a git repo); one store is kept per repo regardless of subdirectory.

## State map

| Plugin | What | Path | Format | Lifetime | Git | Safe to delete |
|--------|------|------|--------|----------|-----|----------------|
| graphyne | Config | `<repoRoot>/.graphyne/config.json` | JSON | project | project’s call | no — it is the config |
| graphyne | Related-files graph | `<repoRoot>/.graphyne/meta/<src>.yaml` | YAML | project | commit | no — it is the graph |
| graphyne | Store gitignore + guard notes | `<repoRoot>/.graphyne/{.gitignore,AGENTS.md,CLAUDE.md}` | text | project | commit | regenerated |
| graphyne | Session state | `<repoRoot>/.graphyne/tasks/<session>/*.json` | JSON | per session | gitignored | yes — loses this session's TDD/checklist |
| memosyne | Tasks (hand-off memory) | `<repoRoot>/.memosyne/<stem>.md` | Markdown | project | commit (intended) | no — it is the memory |
| memosyne | Project config + guard notes | `<repoRoot>/.memosyne/{config.json,AGENTS.md,CLAUDE.md}` | JSON/text | project | commit | config regenerated |
| memosyne | Nudge counters | `${CLAUDE_PLUGIN_DATA}/nudge-state/nudge-<session>-<repo>.json` | JSON | ephemeral | n/a | yes — cosmetic |
| autonomity | On/off + stop markers | `${os.tmpdir()}/claude-autonomity/<session>.{state,stop-blocked}` | text | per session | n/a | yes — resets to "off" |
| expertum | Analyst reports | `<projectDir>/.expertum/<run>/*.md` | Markdown | until deleted | gitignore recommended | yes |
| graphyne, memosyne | Discovery registry | `<installRoot>/data/registry.json` | JSON | machine | gitignored | yes — rebuilt on next run |
| all | Advisory locks | `*.lock` beside the file/registry | text | transient | n/a | yes if stale |

Two things worth knowing up front:

- **memosyne ships no `.gitignore` in `.memosyne/`**, so its transient
  `<stem>.lock` files can be committed by accident — add `.memosyne/*.lock` to
  your repo's `.gitignore`. (graphyne ships one that already ignores `tasks/`.)
- **`<installRoot>`** is `GRAPHYNE_ROOT` / `MEMOSYNE_ROOT` when set, otherwise it
  resolves from the plugin's install location to a marketplace-level directory
  in the plugin cache — so its `data/registry.json` is shared across plugin
  versions, not per-version. If that cache is rebuilt the registry is lost, but
  it self-heals; see troubleshooting #5. Set the env var for a location that
  survives any reinstall.

## Shared mechanics

Project identity is the git toplevel of your cwd, so tools running from any
subdirectory share one store per repo. Locks are advisory exclusive-create
`.lock` files; a crashed holder's lock is auto-reclaimed after
`*_LOCK_STALE_MS` (default 5s), and acquisition waits up to `*_LOCK_WAIT_MS`
(default 7s) before throwing. Hooks fail open: memosyne stays fully dormant
until `.memosyne/` exists, and autonomity defaults to off and swallows write
errors — so a broken store degrades to "no gate", never to a crash.

## Troubleshooting

1. **`Could not acquire the lock … within 7000ms`.** Only happens behind a
   wedged holder (stale locks self-heal in ~5s). Confirm no live MCP/App process
   is using the store, then delete the `.lock` file named in the error.
2. **`Registry … is corrupt (not valid JSON)`.** A hand-edit broke
   `data/registry.json`. Fix or delete it — it is rebuilt as the MCP servers
   re-run.
3. **graphyne blocks every edit / its MCP is unreachable.** Run `/graphyne:off`
   to mute the TDD and Stop gates (obligations keep recording); `/graphyne:on`
   re-arms them. This is not a data problem — do not delete state.
4. **memosyne nudges fire every turn, or never.** Every turn = the counters
   can't see writes (a `CLAUDE_PLUGIN_DATA` namespace issue). Never = the
   project was never activated (no `.memosyne/`, so the hook is dormant). Run
   `/memosyne:setup`; the counter files are disposable, delete them to reset.
5. **The desktop app lost all projects.** The discovery registry lives in the
   plugin cache and is lost if that cache is rebuilt (e.g. re-adding the
   marketplace). It rebuilds automatically as the MCP runs — re-open each
   affected project once and it is re-added. To keep it across any reinstall,
   set a stable `GRAPHYNE_ROOT` / `MEMOSYNE_ROOT` before installing.
6. **autonomity does nothing.** It is off by default every session and its state
   in `os.tmpdir()` is wiped on reboot. Run `/autonomity:on` each session; there
   is no persistent config to repair.

## Uninstall

1. **Remove each plugin:** `/plugin uninstall <name>@omnium` for each plugin you
   installed.
2. **Remove the marketplace:** `/plugin marketplace remove omnium`.
3. **Cache + registry (optional):** delete `~/.claude/plugins/cache/omnium/`;
   this also removes the machine-level `data/registry.json`.
4. **Per-project state (optional):** `.graphyne/` (config + graph) and
   `.memosyne/*.md` are committed *content* — delete only to abandon the graph or
   the hand-off memory. `.graphyne/tasks/`, `.expertum/`, every `*.lock`, and the
   nudge counters are pure runtime and always safe to delete.
5. **Ephemeral:** `${os.tmpdir()}/claude-autonomity/` clears itself on reboot;
   delete it manually to be tidy.

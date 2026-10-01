# Cautium

A Claude Code plugin that gives the agent an **always-on security conscience**.
A single `SessionStart` hook injects a compact, universal secure-engineering
primer as `additionalContext` at the start of every session, so the agent holds
a security-first posture in everything it designs, writes, and runs — without
being asked, and without you copying the same rules into every project's
`CLAUDE.md`.

It is **zero-config and passive**: no commands, no toggle, no state, no MCP
server. Install it and it applies **everywhere**; there is nothing to turn on.
The hook is pure Node built-ins with no shell or filesystem assumptions, so it
is **cross-platform** (Windows/macOS/Linux) — and it goes further than one flat
text: the concrete risk assessment is **tailored to the host OS**.

## The primer

The injected briefing has three layers.

**1. Universal security duties** — the same on every platform:

1. **Secrets** — never hardcode, log, print, or commit credentials, API keys,
   tokens, private keys, or connection strings; read them from the environment
   or a secret store, and keep secret-bearing files out of version control.
2. **Untrusted input** — treat every external input as hostile: validate and
   encode it, use parameterized queries and safe APIs, and never build SQL,
   shell commands, file paths, or HTML by string concatenation.
3. **AuthN/AuthZ** — never weaken authentication or authorization to make
   something work; enforce checks server-side, fail closed, and grant least
   privilege.
4. **Dependencies & supply chain** — do not add or execute untrusted
   third-party code casually; pin versions and prefer vetted libraries.
5. **Cryptography & transport** — use established, well-reviewed libraries;
   never roll your own crypto, and never disable or downgrade TLS/certificate
   verification.
6. **Security controls** — never disable one just to unblock a task; fix the
   underlying cause or flag it.

**2. A universal change-impact rubric** — gauge every system-changing action on
a 0–10 blast-radius scale and act by tier: 0–2 (read-only / trivially
reversible) proceed autonomously; 3–6 (moderate, recoverable) confirm each step;
7–10 (hard to reverse, outward-facing, system-level) require explicit approval
with a risk assessment. Plus process-management hygiene (kill by PID, never
broad `pkill`/`killall`).

**Scope: the machine, not the project.** The rubric protects the machine you
work on, physical or virtual: its OS and system configuration, installed
software, services, network exposure, accounts, and files outside the project.
Work *inside* the project is not scored by it: code, tests, builds, data and
databases (test or otherwise), environments, and deploys follow the project's
own rules and your instructions. The one exception is the git operations in
the platform mappings (`git push`, `git reset --hard`), which apply everywhere.
"The project" is defined in the primer as the working directory the session
started in (plus any directories added to the session), everything under it,
and the resources its work uses (databases, environments, deploy targets). In
an empty folder, that folder is the project. A home directory, a drive or
filesystem root, or a system directory is never a project, so launching the
agent in `~` or `C:\` cannot turn the whole machine into "project files".
The boundary is stated in the primer itself. While it was implicit, the
rubric bled into project work: an agent would avoid a shared test database as
"outward-facing" and ship unverified code to production instead. "Round up
when unsure" means asking the user, never skipping the check.

**3. An OS-dependent risk mapping** — *which* concrete actions land in the 7–10
tier, keyed on `process.platform`. Every named mapping starts with deleting
files outside the project and `git push`. Linux calls out `/etc`, `systemd`,
firewall/port exposure, `/etc/fstab`, GRUB, `rm -rf` on system paths, severing
SSH access, and broad `pkill`/`killall`. Windows calls out the registry,
`PATH`/environment variables, OS settings, scheduled tasks and services,
elevation (UAC / Run as Administrator), and broad `taskkill /IM … /F`. macOS
calls out `launchd`/`launchctl`, System Integrity Protection (SIP), Gatekeeper,
Keychain, Homebrew, `sudo`/elevation, and broad `killall`. A platform without a
dedicated mapping receives an OS-neutral one. Host-specific *policy* still belongs in your own
`CLAUDE.md`; this layer only tailors the risk *taxonomy* to the platform.

If a request conflicts with these duties or exceeds the agent's authority for
its risk tier, it is told to surface the risk plainly instead of silently
complying.

## How it works

One hook, wired in `hooks/hooks.json` and dispatched by `hooks/hook.mjs`:

| Event | Behavior |
|-------|----------|
| `SessionStart` | Emits the security primer for the host `process.platform` as `additionalContext`. |

Every other event is a silent no-op — Cautium never gates a tool call, never
blocks Stop, and never asks anything. The dispatcher **fails open**: any error
emits nothing, so a bug can never brick a session. The primer text and its
accessors (`securityContext(platform)` / `sessionStartOutput(platform)`) live in
`hooks/hook-lib.mjs`, kept separate from the IO shell so both are unit-testable
per platform without spawning a process.

It is **pure hooks** — no MCP server, no build step, zero dependencies (Node
built-ins only).

## Install

Cautium ships as part of the **Omnium** plugin collection; see the Omnium
repository's `README.md` and `docs/development.md` for marketplace setup and
install instructions.

## Develop / test

From the Omnium repo root:

```sh
npm test           # run the unit + wiring tests (zero dependencies)
npm run stamp      # auto-bump PATCH when plugin bytes changed (content hash, scripts/version-guard.mjs)
```

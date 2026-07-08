# Security Policy

Security policy for the Omnium plugin marketplace and the plugins it ships.
These are local Claude Code plugins that run on your own machine, inside your
own Claude Code session.

## Reporting a vulnerability

Please report privately — **do not open a public issue** for anything
security-sensitive.

Report via GitHub private vulnerability reporting —
[open a draft advisory](https://github.com/0x2E757/Omnium/security/advisories/new).
Include the affected plugin and version, reproduction steps, and the impact.

This is a single-maintainer project: expect a best-effort acknowledgement,
coordinated private disclosure before any public write-up, and no bug bounty.

## Supported versions

Pre-1.0; each plugin is versioned independently in its `plugin.json`. Only the
**latest released version of each plugin is supported** — fixes ship forward as
a new release (update with `/plugin marketplace update omnium`). There are no
backports or maintenance branches.

| Plugin | Supported |
|--------|-----------|
| All plugins | latest only |

## Security model

The plugins run **in-process, with your own privileges** — they are not a
sandbox and grant nothing you could not already do. Be aware:

- They read and write files under your git projects (reports in `.expertum/`,
  stores in `.graphyne/` and `.memosyne/`), path-contained to project subtrees.
- Child processes they spawn: `git` (argv form, no shell) and a Node worker for
  memosyne search. **graphyne additionally runs the test command from a repo's
  own `graphyne.json`**, at the same trust level as `npm test` — only enable
  graphyne in repositories you trust.
- **autonomity** is opt-in and off by default; its guardrails are best-effort,
  not a containment boundary.
- **Supply-chain posture:** zero third-party runtime dependencies (`node:*`
  only), no build step, committed lockfile — a deliberately small attack surface.

Input crossing these trust boundaries is validated.

## Scope

In scope: the shipped plugin code under `plugins/`. Out of scope: Claude Code
itself, Node.js, your own repository contents, and misuse of the documented
not-a-sandbox behavior.

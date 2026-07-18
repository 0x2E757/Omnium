# Expertum

Slash commands that fan a task out to read-only expert sub-agents. `review` and
`research` synthesize findings; `interview` interrogates you to turn a vague
idea into a pinned brief; `conduct` drives the change to completion under
expert supervision, and `conduct-mvp` does the same for the smallest
implementation that satisfies the ask. The main agent stays a **stock
Claude Code agent** — this plugin installs no default-agent override and changes
nothing about how the main agent normally behaves. The expert machinery only
runs when you invoke a command.

## Commands

- **`/expertum:review [what to review]`** — multi-expert review of a plan or
  diff. Each relevant analyst returns a verdict (`approve` /
  `approve-with-nits` / `request-changes` / `block`) plus findings.
- **`/expertum:research [question]`** — multi-expert investigation of a question,
  reading the codebase and the internet, producing a cited answer.
- **`/expertum:interview [rough idea]`** — interrogates you through short adaptive
  questionnaires (experts first surface the unspecified decisions in their lens)
  and writes a pinned `brief.md` you can hand to `conduct`.
- **`/expertum:conduct [what to build]`** — experts draft an implementation plan,
  the main agent reconciles it and implements, then experts review the diff in a
  loop (up to 5 rounds) until none demand changes. The main agent does all the
  coding; the analysts only plan and review.
- **`/expertum:conduct-mvp [what to build]`** — like `conduct`, but under a
  binding MVP contract: the experts plan the **minimal** implementation of the
  ask, review rounds (up to 3) block only on bugs and one-way-door design
  choices, and speculative security/performance hardening is deferred into a
  `deferred.md` backlog (recorded, not built).

Every command follows the same rule for its argument:

- **With an argument** → that text is the subject (scope to review / question to
  research).
- **Without an argument** → the command acts on the **preceding conversation**
  (the plan/diff just produced, or the topic just discussed).

## How it works

1. The command runs inside the main agent and figures out the subject.
2. The main agent creates a per-run folder:
   `.expertum/YYYY-MM-DD--HH-MM--<name>/` (`<name>` = kebab-case task slug, ≤30
   chars).
3. It spawns the relevant analysts in parallel (Task tool). Each is given a
   mode, the subject, an ownership boundary (to avoid overlap), and the exact
   output `directory` + `filename`.
4. Each analyst is **read-only** (Read/Glob/Grep + WebSearch/WebFetch) and
   persists exactly one report via the bundled MCP server's `expertum_write_report` tool.
5. The main agent reads the reports and synthesizes an integrated answer,
   citing each report path.

## Analysts & report files

54 read-only analysts, adapted from [wshobson/agents](https://github.com/wshobson/agents)
into Expertum's analyst skeleton. Report files are `review--<slug>.md`,
`research--<slug>.md`, `plan--<slug>.md`, or `scope--<slug>.md` inside the per-run folder (`/expertum:interview` also writes a `brief.md`). Each analyst is named `<domain>--<lens>` (lens ∈ design, platform, security, performance, operations, quality, diagnostics), which is also its report `<slug>`; a report path is `<phase>--<name>.md` (e.g. `review--backend--design.md`).

| Category                    | Analysts |
|-----------------------------|-----------|
| Design & architecture       | backend--design, frontend--design, mobile--design, ui-ux--design, database--design, event-sourcing--design, monorepo--design, cloud--design, kubernetes--design, service-mesh--design, graphql--design, ai--design, prompt--design, data--design, ml--design, vector-search--design, unity--design, legacy--design |
| Security                    | audit--security, backend--security, frontend--security, mobile--security, threat-model--security |
| Performance                 | app--performance, database--performance |
| Operations & infrastructure | database--operations, deployment--operations, network--operations, terraform--operations, observability--operations, incident--operations, ml--operations |
| Quality, testing & docs     | code--quality, architecture--quality, testing--quality, docs--quality, api-docs--quality, accessibility--quality, analytics--quality, typescript--quality, python--quality, golang--quality, rust--quality, sql--quality |
| Diagnostics                 | debug--diagnostics, logs--diagnostics, production--diagnostics |

The commands pick only the analysts relevant to the subject (typically 3–6) and
give each an ownership boundary so reports don't overlap; the exact per-analyst
focus and report filenames live in the command files under `commands/`.

## MCP server (`server.mjs`)

Zero-dependency Node stdio JSON-RPC server exposing one tool, `expertum_write_report`.
It writes only under the project-root `.expertum/` directory: the `filename` is
reduced to a sanitized basename, and the optional `directory` must be a relative
path whose first segment is `.expertum` with no `..` segments. Any path that
would escape `.expertum/` is rejected.

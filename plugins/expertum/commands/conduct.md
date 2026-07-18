---
description: Drive a task through expert planning, autonomous implementation, and an expert review loop, recording it into .expertum/.
argument-hint: [what to build/change — omit to act on the preceding conversation]
---

You are running the **/expertum:conduct** command from inside the normal main
agent. Unlike `/expertum:review` and `/expertum:research`, this command does not
just advise — it delivers a change. You orchestrate four phases: experts
**plan**, you **reconcile** their plans, you **implement**, then experts
**review** in a loop until they are satisfied. The analysts stay READ-ONLY and
only write reports; **every code change is made by you**, the main agent, using
your Edit/Write/Bash tools. For a deliberately minimal build, prefer
`/expertum:conduct-mvp` — the same loop under a strict MVP contract.

## 1. Determine the task

Arguments passed to this command: `$ARGUMENTS`

- If the arguments above are **non-empty**, treat them as the task to build or
  change (a feature, a fix, a refactor).
- If they are **empty**, take the task from the **preceding conversation** — the
  thing the user just asked to build or the fix just discussed. State, in one
  line, what you concluded you are implementing.

## 2. Assemble the context

Gather what the analysts need to plan well — do not make them guess:
- The requirement and its acceptance criteria.
- The files/areas in play and the relevant existing code.
- The constraints that bind the solution: the project's conventions, its test
  discipline, and any cross-cutting rules. If in a git repo, note the baseline
  (`git status`, the current branch).
State plainly what is being built and over which files.

## 3. Create the per-run folder (you, the main agent, do this)

- Get a timestamp: PowerShell `Get-Date -Format 'yyyy-MM-dd--HH-mm'`
  (or `date +%Y-%m-%d--%H-%M`).
- Derive `{name}`: a kebab-case slug of the task, **max 30 characters**.
- Create the folder: `.expertum/<timestamp>--<name>/`
  (e.g. `.expertum/2026-06-11--14-30--rate-limiter/`).
- Remember this path as `<RUN_DIR>` — every analyst writes into it, across both
  the plan phase and every review round.

## 4. Pick the relevant analysts

Select only those whose domain the task touches — typically 3–6, never the whole
roster. The SAME analyst owns its lens in both phases: it drafts the plan for its
lens (phase 5) and later reviews the implementation for that lens (phase 8). Map:

**Design & architecture**

| Analyst (`subagent_type`)         | Domain                                                   | Report stem              |
|-----------------------------------|----------------------------------------------------------|--------------------------|
| `expertum:backend--design`        | API design, service boundaries, data flows, resilience   | `backend--design`        |
| `expertum:frontend--design`       | component architecture, state, rendering, accessibility  | `frontend--design`       |
| `expertum:mobile--design`         | app architecture, navigation, battery, offline sync      | `mobile--design`         |
| `expertum:ui-ux--design`          | interaction design, design tokens, usability, states     | `ui-ux--design`          |
| `expertum:database--design`       | schema design, normalization, technology fit             | `database--design`       |
| `expertum:event-sourcing--design` | events, CQRS, sagas, replay/projection safety            | `event-sourcing--design` |
| `expertum:monorepo--design`       | workspace boundaries, build caching, dependency graph    | `monorepo--design`       |
| `expertum:cloud--design`          | cloud infrastructure, IaC, cost, multi-region            | `cloud--design`          |
| `expertum:kubernetes--design`     | K8s workloads, scaling, GitOps, resource governance      | `kubernetes--design`     |
| `expertum:service-mesh--design`   | mesh configuration, mTLS, traffic policy                 | `service-mesh--design`   |
| `expertum:graphql--design`        | schema design, resolver N+1, federation, cost limits     | `graphql--design`        |
| `expertum:ai--design`             | LLM app architecture, RAG, agent orchestration, evals    | `ai--design`             |
| `expertum:prompt--design`         | prompt structure, output contracts, injection robustness | `prompt--design`         |
| `expertum:data--design`           | ETL/ELT, batch/streaming, warehouse modeling, quality    | `data--design`           |
| `expertum:ml--design`             | training/inference pipeline, features, serving, eval     | `ml--design`             |
| `expertum:vector-search--design`  | embeddings, ANN index, chunking, hybrid retrieval        | `vector-search--design`  |
| `expertum:unity--design`          | Unity architecture, frame budget, asset pipeline         | `unity--design`          |
| `expertum:legacy--design`         | strangler migration, compatibility, seams, sequencing    | `legacy--design`         |
| `expertum:mobile-ux--design`      | touch/gesture UX, HIG/Material, navigation, states       | `mobile-ux--design`      |
| `expertum:desktop-ux--design`     | UI density, windows/menus, shortcuts, multi-monitor      | `desktop-ux--design`     |
| `expertum:desktop--design`        | desktop framework fit, IPC, auto-update, packaging       | `desktop--design`        |
| `expertum:gamedev--design`        | game loop, ECS, determinism, netcode/tick-rate           | `gamedev--design`        |

**Platform**

| Analyst (`subagent_type`)         | Domain                                                   | Report stem              |
|-----------------------------------|----------------------------------------------------------|--------------------------|
| `expertum:windows--platform`      | Win32/WinRT, MSIX, registry, services, signing           | `windows--platform`      |
| `expertum:linux--platform`        | POSIX, systemd, packaging, FHS, capabilities             | `linux--platform`        |
| `expertum:macos--platform`        | Cocoa, sandbox, notarization, launchd, Keychain          | `macos--platform`        |

**Security**

| Analyst (`subagent_type`)         | Domain                                                | Report stem              |
|-----------------------------------|-------------------------------------------------------|--------------------------|
| `expertum:audit--security`        | threat model, OWASP, authn/z, secrets, compliance     | `audit--security`        |
| `expertum:backend--security`      | injection, API security, SSRF, deserialization        | `backend--security`      |
| `expertum:frontend--security`     | XSS, CSP, CORS, client-side data exposure             | `frontend--security`     |
| `expertum:mobile--security`       | WebView, secure storage, pinning, deep links          | `mobile--security`       |
| `expertum:threat-model--security` | trust boundaries, STRIDE, attack surface, abuse cases | `threat-model--security` |

**Performance**

| Analyst (`subagent_type`)        | Domain                                      | Report stem             |
|----------------------------------|---------------------------------------------|-------------------------|
| `expertum:app--performance`      | hot paths, complexity, allocations, caching | `app--performance`      |
| `expertum:database--performance` | queries, indexes, N+1, migration safety     | `database--performance` |

**Operations & infrastructure**

| Analyst (`subagent_type`)            | Domain                                                  | Report stem                 |
|--------------------------------------|---------------------------------------------------------|-----------------------------|
| `expertum:database--operations`      | backup/DR, replication, HA, capacity, DB monitoring     | `database--operations`      |
| `expertum:deployment--operations`    | CI/CD pipelines, containerization, progressive delivery | `deployment--operations`    |
| `expertum:network--operations`       | routing, DNS, load balancing, TLS, firewalling          | `network--operations`       |
| `expertum:terraform--operations`     | Terraform modules, state, provider pinning, drift       | `terraform--operations`     |
| `expertum:observability--operations` | logging/metrics/tracing coverage, SLOs, alert quality   | `observability--operations` |
| `expertum:incident--operations`      | detectability, blast radius, containment, recovery      | `incident--operations`      |
| `expertum:ml--operations`            | tracking, registry, model CI/CD, drift monitoring       | `ml--operations`            |

**Quality, testing & docs**

| Analyst (`subagent_type`)         | Domain                                                   | Report stem              |
|-----------------------------------|----------------------------------------------------------|--------------------------|
| `expertum:code--quality`          | correctness, readability, error handling, production fit | `code--quality`          |
| `expertum:architecture--quality`  | pattern consistency, SOLID, layering discipline          | `architecture--quality`  |
| `expertum:testing--quality`       | pyramid coverage, edge cases, flakiness, CI health       | `testing--quality`       |
| `expertum:docs--quality`          | doc structure, accuracy/sync, completeness, onboarding   | `docs--quality`          |
| `expertum:api-docs--quality`      | OpenAPI accuracy, examples, error/versioning docs        | `api-docs--quality`      |
| `expertum:accessibility--quality` | WCAG, semantics/ARIA, keyboard, assistive tech           | `accessibility--quality` |
| `expertum:analytics--quality`     | analytical correctness, statistics, A/B design, metrics  | `analytics--quality`     |
| `expertum:typescript--quality`    | type soundness, generics, strictness, runtime edges      | `typescript--quality`    |
| `expertum:python--quality`        | Pythonic design, typing, async, perf, packaging          | `python--quality`        |
| `expertum:golang--quality`        | idiomatic Go, goroutine safety, errors, allocation       | `golang--quality`        |
| `expertum:rust--quality`          | ownership, unsafe soundness, errors, concurrency         | `rust--quality`          |
| `expertum:sql--quality`           | set semantics, joins, indexing, transactions             | `sql--quality`           |

**Diagnostics**

| Analyst (`subagent_type`)          | Domain                                                    | Report stem               |
|------------------------------------|-----------------------------------------------------------|---------------------------|
| `expertum:debug--diagnostics`      | root-cause tracing when the task fixes a concrete failure | `debug--diagnostics`      |
| `expertum:logs--diagnostics`       | log/error patterns, swallowed exceptions, correlation     | `logs--diagnostics`       |
| `expertum:production--diagnostics` | prod failure modes, config drift, ops readiness           | `production--diagnostics` |

**Ownership boundaries (avoid duplication):** the same lanes as `/expertum:review`
apply — `audit--security` owns the threat model, the tier analysts own
code-level practice in their tier; `app--performance` owns application hot
paths, `database--performance` owns query/schema cost; `architecture--quality` owns
pattern consistency, `backend--design` owns API/service design. Give each
analyst its lane and tell it what it does NOT own, so plans and reviews don't
overlap.

## 5. Plan phase — spawn analysts in `plan` mode (Task tool, one message, parallel)

Give each analyst a precise brief containing:
- **Mode: plan.** It is designing an implementation plan for the task through its
  lens — reading the codebase (Read/Glob/Grep) and, where useful, the internet.
- The task, the assembled context, and the files in play.
- Its ownership boundary (what it plans for and what it must NOT cover).
- **Output contract:** call `expertum_write_report` with `directory: "<RUN_DIR>"`
  and `filename: "plan--<stem>.md"` (the stem from the table). The report leads
  with the recommended **Approach**, then **Steps** (file-level, in apply order),
  **Risks** (with mitigations), **Validation** (how to prove it works, tests to
  add), and **Open questions**. No Verdict line.
- It must return to you only a short pointer (path + headline), not the full plan.

## 6. Reconcile into one plan (you, the main agent)

Read every `plan--<stem>.md` and fold them into a **single, sequenced
implementation plan**. Where two analysts genuinely conflict — incompatible
approaches, contradictory ordering, or a trade-off they weigh differently — do
not silently pick one:
- Run **one** re-consultation round: re-invoke only the conflicting analysts in
  `plan` mode, each given the opposing position(s), and ask for a compromise or a
  decisive argument. They write `plan--<stem>--v2.md`.
- If the conflict survives that round, **you decide**, and record the decision
  and its trade-off explicitly in the unified plan. Do not re-consult more than
  once — a second round rarely converges and burns budget.

The output of this phase is one plan you can execute, with any resolved
contradictions and their rationale written down.

## 7. Implement (you, the main agent)

Execute the unified plan with your Edit/Write/Bash tools:
- Follow the project's own conventions and **test discipline** — if the repo
  enforces a TDD or commit gate, honor it exactly (write the failing test first
  where that is the rule).
- Keep the change scoped to the plan; note any deviation you make and why.
- Get the change to a coherent, self-consistent state before asking for review.

## 8. Review loop (experts review → you fix), max **5** rounds

Starting at round `N = 1`:
1. Assemble the diff to review: `git diff` (and `git diff --staged`) if in a git
   repo, otherwise the set of changed files.
2. Spawn the relevant analysts in **`review` mode** on that diff (one message,
   parallel). Reuse the phase-4 set; add a reviewer only if the implementation
   grew into a new domain. Output contract: `expertum_write_report` with
   `directory: "<RUN_DIR>"`, `filename: "review-r<N>--<stem>.md"`, a one-line
   **Verdict** (`approve` | `approve-with-nits` | `request-changes` | `block`),
   and findings tagged with severity and a `file:line`.
3. Read the verdicts. **Satisfied** := no verdict is `request-changes` or
   `block` (`approve-with-nits` is satisfied).
   - **Satisfied** → leave the loop, go to phase 9.
   - **Not satisfied** → apply fixes for every `request-changes`/`block` finding,
     set `N = N + 1`, and repeat from step 1.
4. **Cap:** if round 5 finishes still not satisfied, **STOP** — do not keep
   looping. Five rounds without convergence means something deeper is wrong (an
   unclear requirement, analysts demanding mutually exclusive changes, or a task
   too large for one pass). Report the residual objections and what is blocking,
   and hand back to the user rather than thrash.

## 9. Wrap up

Summarize for the user:
- What was built and the files changed.
- The final verdicts per analyst (and the round count it took).
- Key decisions and trade-offs — especially any contradiction you reconciled in
  phase 6, and why you chose as you did.
- If you stopped at the cap, the residual objections and your recommendation.
Optionally write a combined `conduct--summary.md` into `<RUN_DIR>` via
`expertum_write_report`. Keep the chat summary tight; the detail lives in the
reports and the diff.

---
description: Fan a code/plan review out to read-only expert analysts and synthesize their verdicts into .expertum/.
argument-hint: [what to review — omit to review the preceding conversation]
---

You are running the **/expertum:review** command from inside the normal main
agent. Your job is to orchestrate a multi-expert review and synthesize it. You
do the hands-on parts (gather the artifact, create the folder, spawn analysts);
the analysts are READ-ONLY and only write reports.

## 1. Determine the subject

Arguments passed to this command: `$ARGUMENTS`

- If the arguments above are **non-empty**, treat them as the review scope /
  instructions (e.g. a path, a feature, "the auth refactor").
- If they are **empty**, review the work from the **preceding conversation**:
  the plan that was proposed, the diff that was produced, or the files that were
  just changed. Briefly state, in one line, what you concluded the subject is.

## 2. Assemble the artifact

Gather concrete evidence to review — do not make the analysts guess:
- Prefer a real diff: `git diff` (and `git diff --staged`) if in a git repo.
- Otherwise the proposed plan text, or the specific files/areas in scope.
State plainly what is being reviewed and over which files.

## 3. Create the per-run folder (you, the main agent, do this)

- Get a timestamp: PowerShell `Get-Date -Format 'yyyy-MM-dd--HH-mm'`
  (or `date +%Y-%m-%d--%H-%M`).
- Derive `{name}`: a kebab-case slug of the task, **max 30 characters**.
- Create the folder: `.expertum/<timestamp>--<name>/`
  (e.g. `.expertum/2026-06-11--14-30--auth-refactor/`).
- Remember this path as `<RUN_DIR>` — every analyst writes into it.

## 4. Pick the relevant analysts

Select only those that matter for this subject — typically 3–6, never the whole
roster. Map:

**Design & architecture**

| Analyst (`subagent_type`)         | Owns (review focus)                                           | Report file                         |
|-----------------------------------|---------------------------------------------------------------|-------------------------------------|
| `expertum:backend--design`        | API design, service boundaries, data flows, resilience        | `review--backend--design.md`        |
| `expertum:frontend--design`       | component architecture, state, rendering, accessibility       | `review--frontend--design.md`       |
| `expertum:mobile--design`         | mobile app architecture, navigation/state, perf, offline      | `review--mobile--design.md`         |
| `expertum:ui-ux--design`          | interaction/IA, design-system consistency, usability          | `review--ui-ux--design.md`          |
| `expertum:database--design`       | schema design, normalization, technology fit                  | `review--database--design.md`       |
| `expertum:event-sourcing--design` | events, CQRS, sagas, replay/projection safety                 | `review--event-sourcing--design.md` |
| `expertum:monorepo--design`       | workspace boundaries, build caching, dependency graph         | `review--monorepo--design.md`       |
| `expertum:cloud--design`          | cloud infrastructure, IaC, cost, multi-region                 | `review--cloud--design.md`          |
| `expertum:kubernetes--design`     | workload/cluster design, autoscaling, GitOps, resource limits | `review--kubernetes--design.md`     |
| `expertum:service-mesh--design`   | mesh configuration, mTLS, traffic policy                      | `review--service-mesh--design.md`   |
| `expertum:graphql--design`        | schema design, resolver N+1, federation, query cost           | `review--graphql--design.md`        |
| `expertum:ai--design`             | LLM app architecture, RAG, agent orchestration, evals, cost   | `review--ai--design.md`             |
| `expertum:prompt--design`         | prompt structure, output contracts, injection robustness      | `review--prompt--design.md`         |
| `expertum:data--design`           | ETL/ELT design, streaming, data modeling, data quality        | `review--data--design.md`           |
| `expertum:ml--design`             | training/serving pipeline, feature parity, eval rigor         | `review--ml--design.md`             |
| `expertum:vector-search--design`  | embeddings, ANN index config, retrieval quality               | `review--vector-search--design.md`  |
| `expertum:unity--design`          | Unity architecture, frame budget, asset pipeline              | `review--unity--design.md`          |
| `expertum:legacy--design`         | incremental migration, backward compat, seams, rollback       | `review--legacy--design.md`         |
| `expertum:mobile-ux--design`      | touch/gesture UX, HIG/Material, screen states                 | `review--mobile-ux--design.md`      |
| `expertum:desktop-ux--design`     | UI density, windows/menus, keyboard-first UX                  | `review--desktop-ux--design.md`     |
| `expertum:desktop--design`        | desktop app arch: Electron/Tauri, IPC, updates                | `review--desktop--design.md`        |
| `expertum:gamedev--design`        | engine-neutral game loop, ECS, netcode                        | `review--gamedev--design.md`        |

**Platform**

| Analyst (`subagent_type`)         | Owns (review focus)                                           | Report file                         |
|-----------------------------------|---------------------------------------------------------------|-------------------------------------|
| `expertum:windows--platform`      | Win32/WinRT, packaging, registry, UAC, signing                | `review--windows--platform.md`      |
| `expertum:linux--platform`        | syscalls, systemd, packaging, FHS, perms/caps                 | `review--linux--platform.md`        |
| `expertum:macos--platform`        | Cocoa, sandbox, notarization, launchd, signing                | `review--macos--platform.md`        |

**Security**

| Analyst (`subagent_type`)         | Owns (review focus)                                           | Report file                         |
|-----------------------------------|---------------------------------------------------------------|-------------------------------------|
| `expertum:audit--security`        | threat model, OWASP, authn/z design, secrets, compliance      | `review--audit--security.md`        |
| `expertum:backend--security`      | injection, API security, SSRF, deserialization                | `review--backend--security.md`      |
| `expertum:frontend--security`     | XSS, CSP, CORS, client-side data exposure                     | `review--frontend--security.md`     |
| `expertum:mobile--security`       | WebView, secure storage, pinning, deep links                  | `review--mobile--security.md`       |
| `expertum:threat-model--security` | trust boundaries, STRIDE threats, attack surface, abuse cases | `review--threat-model--security.md` |

**Performance**

| Analyst (`subagent_type`)        | Owns (review focus)                         | Report file                        |
|----------------------------------|---------------------------------------------|------------------------------------|
| `expertum:app--performance`      | hot paths, complexity, allocations, caching | `review--app--performance.md`      |
| `expertum:database--performance` | queries, indexes, N+1, migration safety     | `review--database--performance.md` |

**Operations & infrastructure**

| Analyst (`subagent_type`)            | Owns (review focus)                                      | Report file                            |
|--------------------------------------|----------------------------------------------------------|----------------------------------------|
| `expertum:database--operations`      | backup/restore, replication, failover, DB monitoring     | `review--database--operations.md`      |
| `expertum:deployment--operations`    | CI/CD pipeline, image hygiene, release/rollback safety   | `review--deployment--operations.md`    |
| `expertum:network--operations`       | connectivity, DNS, load balancing, TLS, segmentation     | `review--network--operations.md`       |
| `expertum:terraform--operations`     | IaC module design, state, drift, plan safety             | `review--terraform--operations.md`     |
| `expertum:observability--operations` | logging/metrics/tracing coverage, SLOs, alert quality    | `review--observability--operations.md` |
| `expertum:incident--operations`      | detectability, blast radius, rollback, runbook readiness | `review--incident--operations.md`      |
| `expertum:ml--operations`            | experiment tracking, model registry, model CI/CD, drift  | `review--ml--operations.md`            |

**Quality, testing & docs**

| Analyst (`subagent_type`)         | Owns (review focus)                                              | Report file                         |
|-----------------------------------|------------------------------------------------------------------|-------------------------------------|
| `expertum:code--quality`          | correctness, readability, error handling, production readiness   | `review--code--quality.md`          |
| `expertum:architecture--quality`  | pattern consistency, SOLID, layering discipline                  | `review--architecture--quality.md`  |
| `expertum:testing--quality`       | coverage adequacy, test design, determinism, CI health           | `review--testing--quality.md`       |
| `expertum:docs--quality`          | doc structure, code-doc sync, completeness, examples             | `review--docs--quality.md`          |
| `expertum:api-docs--quality`      | spec-vs-code accuracy, example/error coverage, versioning docs   | `review--api-docs--quality.md`      |
| `expertum:accessibility--quality` | WCAG conformance, semantics/ARIA, keyboard/focus                 | `review--accessibility--quality.md` |
| `expertum:analytics--quality`     | query/metric correctness, statistical method, experiment design  | `review--analytics--quality.md`     |
| `expertum:typescript--quality`    | type soundness, generics, strictness, boundary typing            | `review--typescript--quality.md`    |
| `expertum:python--quality`        | Pythonic design, typing, async, perf, packaging                  | `review--python--quality.md`        |
| `expertum:golang--quality`        | idiomatic Go, concurrency/races, error handling, allocation      | `review--golang--quality.md`        |
| `expertum:rust--quality`          | ownership/lifetimes, unsafe soundness, error handling, Send/Sync | `review--rust--quality.md`          |
| `expertum:sql--quality`           | query correctness, joins/aggregation, indexing, transactions     | `review--sql--quality.md`           |

**Diagnostics**

| Analyst (`subagent_type`)          | Owns (review focus)                                     | Report file                          |
|------------------------------------|---------------------------------------------------------|--------------------------------------|
| `expertum:debug--diagnostics`      | root-cause tracing of a concrete failure                | `review--debug--diagnostics.md`      |
| `expertum:logs--diagnostics`       | log/error patterns, swallowed exceptions, correlation   | `review--logs--diagnostics.md`       |
| `expertum:production--diagnostics` | prod failure modes, config drift, operational readiness | `review--production--diagnostics.md` |

**Ownership boundaries (avoid duplication):** `audit--security` owns the overall
threat model and authn/z design; the tier-specific security analysts
(backend/frontend/mobile) own code-level practices in their tier — add only the
tier(s) the artifact touches. `app--performance` owns application hot paths;
`database--performance` owns query/schema-level cost; `observability--operations` owns
telemetry, not performance itself. `architecture--quality` owns pattern consistency;
`backend--design` owns API/service design; `database--design` owns schema
design (query tuning belongs to `database--performance`). `code--quality` owns
line-level quality of the change; `debug--diagnostics` and `logs--diagnostics` are relevant
only when the subject includes a concrete failure or its logs. Tell each analyst
what it does NOT own so it stays in lane.

## 5. Spawn analysts in parallel (Task tool, one message, multiple calls)

Give each analyst a precise brief containing:
- **Mode: review.** It is reviewing the artifact below, not auditing the whole codebase.
- The artifact / scope and the files in play.
- Its ownership boundary (what it owns and what it must NOT cover).
- **Output contract:** call `expertum_write_report` with `directory: "<RUN_DIR>"` and
  `filename: "review--<name>.md"` (the file from the table). The report MUST open
  with a one-line **Verdict**: `approve` | `approve-with-nits` | `request-changes`
  | `block`, then findings each tagged with severity and a `file:line` reference.
- It must return to you only a short pointer (path + headline), not the full report.

## 6. Synthesize

After all analysts finish, read their reports in `<RUN_DIR>` and produce an
integrated review for the user:
- **Overall verdict** (the strictest analyst verdict wins for blocking issues).
- Blocking issues first, then majors, then nits — deduplicated across analysts.
- Cite each finding's source report path.
Optionally also write a combined `review--summary.md` into `<RUN_DIR>` via
`expertum_write_report`. Keep the chat summary tight; the detail lives in the reports.

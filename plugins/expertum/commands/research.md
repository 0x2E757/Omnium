---
description: Fan a research question out to read-only expert analysts and synthesize a cited answer into .expertum/.
argument-hint: [the question/topic — omit to research the preceding conversation]
---

You are running the **/expertum:research** command from inside the normal main
agent. Your job is to orchestrate a multi-expert investigation and synthesize a
cited answer. You do the hands-on parts (frame the question, create the folder,
spawn analysts); the analysts are READ-ONLY and only write reports.

## 1. Determine the question

Arguments passed to this command: `$ARGUMENTS`

- If the arguments above are **non-empty**, treat them as the research question /
  topic.
- If they are **empty**, derive the question from the **preceding conversation**
  (the thing that was being discussed or that the user wanted understood).
  State, in one line, the question you concluded you are researching.

## 2. Create the per-run folder (you, the main agent, do this)

- Get a timestamp: PowerShell `Get-Date -Format 'yyyy-MM-dd--HH-mm'`
  (or `date +%Y-%m-%d--%H-%M`).
- Derive `{name}`: a kebab-case slug of the topic, **max 30 characters**.
- Create the folder: `.expertum/<timestamp>--<name>/`
  (e.g. `.expertum/2026-06-11--14-30--cache-strategy/`).
- Remember this path as `<RUN_DIR>` — every analyst writes into it.

## 3. Pick the relevant analysts

Select only the lenses that matter for the question — typically 2–5, never the
whole roster. Map:

**Design & architecture**

| Analyst (`subagent_type`)         | Research lens                                  | Report file                           |
|-----------------------------------|------------------------------------------------|---------------------------------------|
| `expertum:backend--design`        | API/service design and data-flow angle         | `research--backend--design.md`        |
| `expertum:frontend--design`       | UI architecture/state/accessibility angle      | `research--frontend--design.md`       |
| `expertum:mobile--design`         | mobile-architecture/offline/performance angle  | `research--mobile--design.md`         |
| `expertum:ui-ux--design`          | UX/design-system/usability angle               | `research--ui-ux--design.md`          |
| `expertum:database--design`       | data-modeling and storage-technology angle     | `research--database--design.md`       |
| `expertum:event-sourcing--design` | event-driven/CQRS/consistency angle            | `research--event-sourcing--design.md` |
| `expertum:monorepo--design`       | workspace/build-tooling/dependency-graph angle | `research--monorepo--design.md`       |
| `expertum:cloud--design`          | cloud-infrastructure/cost/resilience angle     | `research--cloud--design.md`          |
| `expertum:kubernetes--design`     | Kubernetes/cloud-native architecture angle     | `research--kubernetes--design.md`     |
| `expertum:service-mesh--design`   | service-mesh/traffic-management angle          | `research--service-mesh--design.md`   |
| `expertum:graphql--design`        | GraphQL schema/resolver/federation angle       | `research--graphql--design.md`        |
| `expertum:ai--design`             | LLM-application/RAG/agent-design angle         | `research--ai--design.md`             |
| `expertum:prompt--design`         | prompt-design/robustness/eval angle            | `research--prompt--design.md`         |
| `expertum:data--design`           | data-pipeline/warehouse-modeling angle         | `research--data--design.md`           |
| `expertum:ml--design`             | ML pipeline/serving/eval angle                 | `research--ml--design.md`             |
| `expertum:vector-search--design`  | vector-search/retrieval-quality angle          | `research--vector-search--design.md`  |
| `expertum:unity--design`          | Unity/game-architecture/frame-budget angle     | `research--unity--design.md`          |
| `expertum:legacy--design`         | modernization/migration-strategy angle         | `research--legacy--design.md`         |
| `expertum:mobile-ux--design`      | mobile UX/touch/platform-guideline angle       | `research--mobile-ux--design.md`      |
| `expertum:desktop-ux--design`     | desktop UX/density/keyboard-interaction angle  | `research--desktop-ux--design.md`     |
| `expertum:desktop--design`        | desktop-app framework/IPC/packaging angle      | `research--desktop--design.md`        |
| `expertum:gamedev--design`        | engine-neutral game-architecture/netcode angle | `research--gamedev--design.md`        |

**Platform**

| Analyst (`subagent_type`)         | Research lens                                  | Report file                           |
|-----------------------------------|------------------------------------------------|---------------------------------------|
| `expertum:windows--platform`      | Windows platform/packaging/API angle           | `research--windows--platform.md`      |
| `expertum:linux--platform`        | Linux platform/packaging/systemd angle         | `research--linux--platform.md`        |
| `expertum:macos--platform`        | macOS platform/sandbox/signing angle           | `research--macos--platform.md`        |

**Security**

| Analyst (`subagent_type`)         | Research lens                            | Report file                           |
|-----------------------------------|------------------------------------------|---------------------------------------|
| `expertum:audit--security`        | threat-model/compliance/authn-z angle    | `research--audit--security.md`        |
| `expertum:backend--security`      | backend secure-coding angle              | `research--backend--security.md`      |
| `expertum:frontend--security`     | client-side security angle               | `research--frontend--security.md`     |
| `expertum:mobile--security`       | mobile-platform security angle           | `research--mobile--security.md`       |
| `expertum:threat-model--security` | threat-model/STRIDE/attack-surface angle | `research--threat-model--security.md` |

**Performance**

| Analyst (`subagent_type`)        | Research lens                        | Report file                          |
|----------------------------------|--------------------------------------|--------------------------------------|
| `expertum:app--performance`      | performance/scaling/complexity angle | `research--app--performance.md`      |
| `expertum:database--performance` | query/index/data-access-cost angle   | `research--database--performance.md` |

**Operations & infrastructure**

| Analyst (`subagent_type`)            | Research lens                          | Report file                              |
|--------------------------------------|----------------------------------------|------------------------------------------|
| `expertum:database--operations`      | database-operations/HA/backup angle    | `research--database--operations.md`      |
| `expertum:deployment--operations`    | CI/CD and release-strategy angle       | `research--deployment--operations.md`    |
| `expertum:network--operations`       | networking/connectivity/latency angle  | `research--network--operations.md`       |
| `expertum:terraform--operations`     | infrastructure-as-code/Terraform angle | `research--terraform--operations.md`     |
| `expertum:observability--operations` | telemetry/SLO/diagnosability angle     | `research--observability--operations.md` |
| `expertum:incident--operations`      | incident-response/reliability angle    | `research--incident--operations.md`      |
| `expertum:ml--operations`            | MLOps infrastructure/lifecycle angle   | `research--ml--operations.md`            |

**Quality, testing & docs**

| Analyst (`subagent_type`)         | Research lens                                | Report file                           |
|-----------------------------------|----------------------------------------------|---------------------------------------|
| `expertum:code--quality`          | maintainability/readability/idiom angle      | `research--code--quality.md`          |
| `expertum:architecture--quality`  | pattern/idiom-consistency and layering angle | `research--architecture--quality.md`  |
| `expertum:testing--quality`       | test-strategy/coverage/flakiness angle       | `research--testing--quality.md`       |
| `expertum:docs--quality`          | technical-documentation/structure angle      | `research--docs--quality.md`          |
| `expertum:api-docs--quality`      | API-documentation/contract-accuracy angle    | `research--api-docs--quality.md`      |
| `expertum:accessibility--quality` | accessibility/WCAG-conformance angle         | `research--accessibility--quality.md` |
| `expertum:analytics--quality`     | data-analysis/statistics/experiment angle    | `research--analytics--quality.md`     |
| `expertum:typescript--quality`    | TypeScript type-system angle                 | `research--typescript--quality.md`    |
| `expertum:python--quality`        | Python idiom/typing/async angle              | `research--python--quality.md`        |
| `expertum:golang--quality`        | Go concurrency/idiom angle                   | `research--golang--quality.md`        |
| `expertum:rust--quality`          | Rust ownership/unsafe/concurrency angle      | `research--rust--quality.md`          |
| `expertum:sql--quality`           | SQL correctness/set-semantics angle          | `research--sql--quality.md`           |

**Diagnostics**

| Analyst (`subagent_type`)          | Research lens                               | Report file                            |
|------------------------------------|---------------------------------------------|----------------------------------------|
| `expertum:debug--diagnostics`      | root-cause/failure-mechanism angle          | `research--debug--diagnostics.md`      |
| `expertum:logs--diagnostics`       | error-pattern/log-forensics angle           | `research--logs--diagnostics.md`       |
| `expertum:production--diagnostics` | production-operations/troubleshooting angle | `research--production--diagnostics.md` |

**Ownership boundaries (avoid duplication):** give each analyst a distinct
sub-question so two reports don't cover the same ground. State what each one does
NOT need to address.

## 4. Spawn analysts in parallel (Task tool, one message, multiple calls)

Give each analyst a precise brief containing:
- **Mode: research.** It is investigating the question below — reading the
  codebase (Read/Glob/Grep) AND the internet (WebSearch/WebFetch) as needed.
- Its specific sub-question and lens, and what it must NOT cover.
- **Output contract:** call `expertum_write_report` with `directory: "<RUN_DIR>"` and
  `filename: "research--<name>.md"` (the file from the table). Every claim must
  carry a citation — a `file:line` for code or a source URL for the web. Unknowns
  go under an explicit "Open questions" section.
- It must return to you only a short pointer (path + headline), not the full report.

## 5. Synthesize

After all analysts finish, read their reports in `<RUN_DIR>` and produce an
integrated, cited answer for the user:
- A direct answer to the question up front.
- Supporting findings grouped by theme, each citing its source report and the
  underlying `file:line` / URL — deduplicated across analysts.
- Trade-offs and open questions called out honestly.
Optionally also write a combined `research--summary.md` into `<RUN_DIR>` via
`expertum_write_report`. Keep the chat answer tight; the detail lives in the reports.

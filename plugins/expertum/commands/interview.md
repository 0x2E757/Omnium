---
description: Interrogate the user to turn a vague idea into a pinned, scoped brief, recording it into .expertum/.
argument-hint: [the rough idea to scope — omit to act on the preceding conversation]
---

You are running the **/expertum:interview** command from inside the normal main
agent. A vague ask ("I want to make an RPG") admits countless implementations
that all technically satisfy it, while the user's real, unspoken requirements
stay hidden. This command drags them into the open: experts surface the
**unspecified decisions** in their lens, you **interrogate the user** through
short adaptive questionnaires until the scope is pinned, then you write a
**brief** the user (or `/expertum:conduct` / `/expertum:conduct-mvp`) can build
against. The analysts stay READ-ONLY and only write reports; the interrogation
and the brief are yours.

## 1. Determine the subject

Arguments passed to this command: `$ARGUMENTS`

- If the arguments above are **non-empty**, treat them as the rough idea to
  scope.
- If they are **empty**, take the idea from the **preceding conversation** — the
  thing the user just said they want. State, in one line, what you are scoping.

## 2. Assemble context (lightweight)

An idea is fuzzy by nature — do not over-research it. But if a codebase or repo
is in play, note the stack, conventions, and hard constraints so the analysts
ask questions grounded in *this* project rather than generic ones. If it is
greenfield, say so; the questions will be about product and platform choices,
not existing code.

## 3. Create the per-run folder (you, the main agent, do this)

- Get a timestamp: PowerShell `Get-Date -Format 'yyyy-MM-dd--HH-mm'`
  (or `date +%Y-%m-%d--%H-%M`).
- Derive `{name}`: a kebab-case slug of the idea, **max 30 characters**.
- Create the folder: `.expertum/<timestamp>--<name>/`
  (e.g. `.expertum/2026-06-11--14-30--rpg-game/`).
- Remember this path as `<RUN_DIR>` — every analyst writes into it, and so does
  the final brief.

## 4. Pick the relevant analysts

Select only those whose domain the idea plausibly touches — typically 3–6, never
the whole roster. For a broad, greenfield idea favor the design and platform
lenses; pull in security, operations, or data only when the idea clearly
implicates them. Map:

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

**Ownership boundaries (avoid duplication):** the same lanes as
`/expertum:review` and `/expertum:conduct` apply. Give each analyst its lane and
tell it what it does NOT own, so their question lists don't overlap.

## 5. Seed the question pool — spawn analysts in `scope` mode (Task tool, one message, parallel)

Give each analyst a precise brief containing:
- **Mode: scope.** The subject is a rough, under-specified idea. It is NOT
  designing or reviewing it — it surfaces the unspecified decisions in its lens
  that must be pinned before the idea can be built.
- The idea, plus any context you assembled.
- Its ownership boundary (what it questions and what it must NOT cover).
- **Output contract:** call `expertum_write_report` with `directory: "<RUN_DIR>"`
  and `filename: "scope--<stem>.md"` (the stem from the table). The report is a
  prioritized list of **Open decisions**, each with **Question** → **Why it
  matters** → **Options** (2–4 concrete candidates, or "open") → **Default**
  (what to assume if unanswered). No Verdict line.
- It must return to you only a short pointer (path + the top one or two
  questions), not the full report.

## 6. Interrogate the user — session loop (this is the heart of the command)

Read every `scope--<stem>.md`. Pool all the Open decisions, **dedup** ones that
different lenses raised about the same thing, and **rank by leverage** — put the
decisions that collapse the most of the solution space first (genre/platform/
target audience before, say, the color of a button).

Then run **sessions**:

- A **session** is 2–3 questionnaires. Each questionnaire is **one
  `AskUserQuestion` call** with up to 4 of the highest-leverage still-open
  decisions; turn each decision's **Options** into the choices (the tool always
  offers the user a free-form "Other" as well). Make the later questionnaires in
  a session **adaptive** — let the answers you just got prune, reshape, or unlock
  the questions you ask next.
- After each session, ask **one control questionnaire**: *"Continue narrowing the
  scope?"* with options **Yes — another round** and **No — finalize the brief**
  (the user can always steer with a custom "Other" answer). This hands the stop
  decision to the user, exactly as intended.
  - **Yes** → start another session, drilling into the decisions the last
    answers opened up. Re-consult a specific analyst in `scope` mode only if a
    genuinely new domain surfaced (e.g. the idea grew a multiplayer backend).
  - **No** → go to phase 7.
  - **Custom steer** → fold it in and let it reshape the remaining questions.
- As you go, record every answer as a **decision** (the chosen option) and every
  question the user skips or defers as an **assumption** (carry its Default) or
  an **open question**.

Keep each questionnaire tight and lead with what most narrows the idea — the goal
is to converge, not to exhaust the user.

## 7. Write the brief

Write `brief.md` into `<RUN_DIR>` via `expertum_write_report`:

```
# <Refined goal, one line>

## Decided
<each pinned decision and the option chosen>

## Assumptions
<defaults taken where the user skipped a question — mark each clearly as an
assumption to be confirmed>

## Out of scope
<directions explicitly rejected during the interrogation>

## Open questions
<deferred, non-blocking — safe to resolve later>

## Next step
<recommend /expertum:conduct — or /expertum:conduct-mvp for a deliberately
minimal build, or /expertum:research — with this brief>
```

## 8. Wrap up

Tell the user where the brief lives, the headline decisions, and the assumptions
they should sanity-check before building. Offer to run `/expertum:conduct`
(or `/expertum:conduct-mvp` when the user wants the smallest implementation
that satisfies the brief) with the brief as its input. Keep the chat summary
tight; the detail lives in `brief.md` and the per-lens `scope--<stem>.md`
reports.

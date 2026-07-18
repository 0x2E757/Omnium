---
description: Drive the minimal (MVP) version of a task through expert planning, autonomous implementation, and a bug-focused expert review loop, recording it into .expertum/.
argument-hint: [what to build minimally — omit to act on the preceding conversation]
---

You are running the **/expertum:conduct-mvp** command from inside the normal
main agent. It is the minimal-scope sibling of `/expertum:conduct`: the same
plan → reconcile → implement → review orchestration, but governed by an **MVP
contract** — experts plan the smallest implementation of exactly what was
asked, correctness scrutiny goes *up*, and hardening beyond the ask is
*captured as deferred, never built*. The analysts stay READ-ONLY and only write
reports; **every code change is made by you**, the main agent, using your
Edit/Write/Bash tools. The governing asymmetry of the whole run: **scope goes
down, correctness rigor goes up** — MVP narrows WHAT is built, not HOW WELL it
must work.

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
If the task came from an `/expertum:interview` `brief.md`, its "Out of scope"
section pre-seeds the scope contract in phase 4.
State plainly what is being built and over which files. If the task itself IS
security-sensitive (an auth feature, a payment flow), stop here and recommend
`/expertum:conduct` instead — full rigor is the right tool, and stopping now
leaves no dead run folder behind.

## 3. Create the per-run folder (you, the main agent, do this)

- Get a timestamp: PowerShell `Get-Date -Format 'yyyy-MM-dd--HH-mm'`
  (or `date +%Y-%m-%d--%H-%M`).
- Derive `{name}`: a kebab-case slug of the task, **max 30 characters**.
- Create the folder: `.expertum/<timestamp>--<name>/`
  (e.g. `.expertum/2026-06-11--14-30--rate-limiter/`).
- Remember this path as `<RUN_DIR>` — every analyst writes into it, across both
  the plan phase and every review round.

## 4. Pin the scope contract (you, the main agent, BEFORE any analyst runs)

Two artifacts govern this run. Writing them first — before any analyst is
spawned — is the point: they constrain the plans rather than ratify them.

**First, the universal yardstick.** Paste the following block **VERBATIM** into
every analyst brief in phases 6, 7, and 9. Do not paraphrase, shorten, or merge
it into prose — paraphrase drift is how scope creep returns:

```
### MVP CONTRACT (binding for this run)

The user asked for a deliberately minimal implementation.

- **In scope** := the smallest change that makes the requested behavior
  work correctly for the stated use case. Deletion test: if removing a
  proposed element would not break the requested behavior today, it is
  OUT of scope. Two standing exemptions always survive the test: tests
  that prove the requested behavior (they are part of "work correctly"),
  and elements required by the clean-seams clause of scope-contract.md.
- **Priority order:** correct behavior > simple, readable code >
  everything else. Be STRICTER than usual about bugs, main-path edge
  cases, and data loss/corruption. MVP narrows WHAT is built, not HOW
  WELL it must work.
- **Do not propose or require** (unless the user's request itself needs
  it): config or feature flags, abstraction layers or interfaces with a
  single implementation, caching, retry/backoff, rate limiting,
  generalized error taxonomies, plugin/extension points, or any
  security/performance/ops hardening motivated only by "later",
  "scale", "other callers", or "attackers" without a concrete stated
  requirement.
- **Still in scope (cheap correctness, not hardening):** input
  validation the requested behavior needs, parameterized queries and
  escaped output, not leaking secrets, handling the failure modes the
  main path will actually hit.
- **One-way doors:** design so hardening can be layered on later
  WITHOUT a rewrite, but do NOT build it now. If a choice would close
  that door, keep it open with a seam (a boundary or naming choice,
  not an abstraction layer) and record it under Deferred.
- **Deferred, not planned:** every good idea outside this yardstick
  goes in your report's Deferred section — captured, never implemented.
```

**Second, the task-specific scope.** Write `scope-contract.md` into `<RUN_DIR>`
via `expertum_write_report`, with three parts:

- **IN** — the exact deliverables and acceptance criteria, restated narrowly.
- **OUT (deferred, not built)** — named explicitly: hardening beyond what the
  delivered scope needs, performance work beyond obvious correctness,
  abstractions/config/extension points for unrequested futures, resilience
  machinery (retries, circuit breakers, rate limits) unless the task IS that
  machinery.
- **Clean seams** — the few design properties the minimal code must still honor
  so hardening can be layered on later (e.g. external input crosses one
  identifiable boundary; secrets/config not inlined; no decision that actively
  forecloses later hardening). This is the ONLY future-proofing the run
  permits, and it constrains shape, not features.

Echo the contract into chat (visible and contestable) but do not block on user
confirmation — the command stays autonomous. Every brief you compose from here
on carries both artifacts verbatim.

## 5. Pick the relevant analysts

Select **2–4** analysts, never the whole roster. The floor: `code--quality`
(always), plus the one design analyst of the primary domain — it owns the
clean-seams clause. Add `testing--quality` when the repo has real test
discipline, the language `--quality` analyst when idiom risk is real, and
`debug--diagnostics` when the task fixes a concrete failure. The SAME analyst
owns its lens in both phases: it drafts the plan for its lens (phase 6) and
later reviews the implementation for that lens (phase 9).

**Security and performance analysts are NOT consulted in the plan phase** — in
a plan they structurally produce hardening steps, which is exactly the
speculative work this command exists to avoid. Instead, one security analyst
joins **the review loop at round 1** only if the delivered scope touches a
trust boundary (network input, auth, secrets, user-controlled paths), briefed
to report ONLY issues exploitable in the delivered scope as it will actually
run — everything else goes to its Deferred section. If it returns a blocking
finding, it re-joins each subsequent round until that finding clears; it never
joins the plan phase. If the conditional adds above would push the set past 4,
prefer `testing--quality`, then the language analyst, then
`debug--diagnostics` — unless the task is a bug fix, where
`debug--diagnostics` outranks both.

Map:

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

## 6. Plan phase — spawn analysts in `plan` mode (Task tool, one message, parallel)

Give each analyst a precise brief containing:
- **Mode: plan.** It is designing an implementation plan for the task through its
  lens — reading the codebase (Read/Glob/Grep) and, where useful, the internet.
- The task, then **immediately after it** the MVP CONTRACT block and the
  `scope-contract.md` content, both verbatim — before the longer context, so
  they are not diluted.
- The assembled context and the files in play.
- Its ownership boundary (what it plans for and what it must NOT cover).
- **Output contract:** call `expertum_write_report` with `directory: "<RUN_DIR>"`
  and `filename: "plan--<stem>.md"` (the stem from the table). The report leads
  with the recommended **Approach**, then **Steps** (file-level, in apply order),
  **Risks** (with mitigations), **Validation** (how to prove it works, tests to
  add), and **Open questions**. No Verdict line. After Open questions, a
  mandatory **`## Deferred (not now)`** section: each item = what / why it is
  outside the MVP yardstick / the seam (if any) that keeps it layerable later.
  A plan report without this section is incomplete; write `- none` if genuinely
  empty.
- A minimality tie-breaker: when two approaches both satisfy the contract,
  recommend the one with less code and fewer new abstractions.
- The closing line of the brief, verbatim: *"Steps must survive the deletion
  test; anything that does not goes under Deferred."*
- It must return to you only a short pointer (path + headline), not the full plan.

## 7. Reconcile into one plan (you, the main agent)

Read every `plan--<stem>.md` and fold them into a **single, sequenced
implementation plan**. The scope contract is the arbiter — the union of N
expert plans must not silently become the scope:
- **Apply the deletion test yourself** when folding: strip any step that fails
  it (the contract's standing exemptions — tests and clean-seams elements —
  survive), even if an analyst proposed it, and move it to the deferred list.
  Analysts advise; the contract binds.
- **Roll all analysts' `Deferred (not now)` sections** into one deduplicated
  **DEFERRED list** inside the unified plan. If a plan lacks the section,
  derive its deferred items yourself from the steps you stripped. This list is
  the shared yardstick for phase 9 — reviewers receive it verbatim.
- Where two analysts genuinely conflict **within IN** — incompatible
  approaches, contradictory ordering — run **one** re-consultation round:
  re-invoke only the conflicting analysts in `plan` mode, each given the
  opposing position(s) AND the MVP CONTRACT + scope contract again (otherwise
  round 2 is where hardening sneaks back in). They write `plan--<stem>--v2.md`.
- If the conflict survives that round, **you decide** — tie-break by
  minimality — and record the decision and its trade-off explicitly in the
  unified plan. Do not re-consult more than once.

The output of this phase is one plan you can execute, with the DEFERRED list
and any resolved contradictions and their rationale written down. Persist it:
write the unified plan, DEFERRED list included, to `<RUN_DIR>` as
`plan--unified.md` via `expertum_write_report` — phases 9 and 10 read the
DEFERRED list from there, so it cannot silently shrink over a long run.

## 8. Implement (you, the main agent)

Execute the unified plan with your Edit/Write/Bash tools:
- Follow the project's own conventions and **test discipline** — if the repo
  enforces a TDD or commit gate, honor it exactly (write the failing test first
  where that is the rule).
- Keep the change scoped to the plan; note any deviation you make and why.
- **Hold yourself to the contract too** — no speculative parameters,
  interfaces, or "while I'm here" robustness. Main-agent gold-plating is a real
  failure mode independent of the analysts.
- Get the change to a coherent, self-consistent state before asking for review.

## 9. Review loop (experts review → you fix), max **3** rounds

The scope is deliberately small; if it does not converge in 3 rounds, the
contract itself is ambiguous. Starting at round `N = 1`:
1. Assemble the diff to review: `git diff` (and `git diff --staged`) if in a git
   repo, otherwise the set of changed files.
2. Spawn the relevant analysts in **`review` mode** on that diff (one message,
   parallel). Reuse the phase-5 set (plus the security screen if a trust
   boundary is touched — round 1, then again while it has an uncleared
   blocking finding); add a reviewer only if the implementation grew into a
   new domain. Each review brief carries, verbatim and immediately after the
   diff pointer (before any longer context, so it is not diluted): the MVP
   CONTRACT block, the `scope-contract.md` content, the run's DEFERRED list
   (from `plan--unified.md`), and these two rules:
   - **Classification gate:** *"Before assigning severity, classify each
     candidate finding: `bug` (behavior wrong vs the ask, data
     loss/corruption, crash or unhandled failure on the main path, a security
     issue exploitable in the delivered scope as it will run, or any
     violation of the contract's 'Still in scope' carve-out reachable in the
     delivered scope), `one-way-door` (this code shape makes later hardening
     impossible without a rewrite), `missing-hardening`
     (security/performance/ops work outside the ask), or `style`. If no class
     fits (e.g. a missing test for the delivered behavior), class by whether
     the finding concerns the correctness of the delivered behavior: yes →
     `bug`, no → `missing-hardening`. Tag every finding `[Class: ...]`
     alongside its severity."*
   - **Verdict rules:** *"Only `bug` and `one-way-door` findings may drive
     `request-changes` or `block`. `missing-hardening` and `style` findings —
     including anything on the DEFERRED list — go under a
     `## Deferred observations` section and cap the verdict at
     `approve-with-nits`. Issuing `request-changes` for a DEFERRED-list item
     violates this brief. Be harder on correctness than a normal review, not
     softer."*
   Close every review brief with that last sentence repeated verbatim as its
   final line: *"Be harder on correctness than a normal review, not softer."*
   Output contract: `expertum_write_report` with `directory: "<RUN_DIR>"`,
   `filename: "review-r<N>--<stem>.md"`, a one-line **Verdict**
   (`approve` | `approve-with-nits` | `request-changes` | `block`), and
   findings tagged with class, severity, and a `file:line`.
3. **Adjudicate per finding, against `scope-contract.md`** (the anti-ratchet;
   analysts anchored on maximal-rigor system prompts will occasionally block
   on out-of-contract findings despite the brief). Classify any unclassified —
   and re-classify any misclassified — finding yourself, **in either
   direction** (an in-scope exploit misfiled as `missing-hardening` becomes a
   `bug`; a hardening wish misfiled as a `bug` becomes `missing-hardening`).
   Then, in EVERY report regardless of its verdict, move
   `missing-hardening`/`style` findings to the DEFERRED list — they are never
   fixed this round and never lost. A `request-changes`/`block` left justified
   **solely** by such findings becomes `approve-with-nits`; record the
   override for the wrap-up. **Never** downgrade a verdict that still contains
   at least one `bug` or `one-way-door` finding. The gate swings both ways: if
   an upward re-classification leaves a `bug`/`one-way-door` finding in a
   report that did not block, treat that report as `request-changes` for the
   satisfaction test below. When adjudication moved anything to the DEFERRED
   list, re-write `plan--unified.md` via `expertum_write_report` so the next
   round's briefs carry the current list, not a stale one.
4. **Satisfied** := after adjudication, no verdict remains at `request-changes`
   or `block` (`approve-with-nits` is satisfied).
   - **Satisfied** → leave the loop, go to phase 10.
   - **Not satisfied and `N < 3`** → apply fixes for every remaining **`bug`
     and `one-way-door`** finding — never for the deferred ones — set
     `N = N + 1`, and repeat from step 1.
   - **Not satisfied and `N = 3`** → go to step 5.
5. **Cap:** if round 3 finishes still not satisfied, **STOP** — do not keep
   looping. Hand back with the round-3 blocking findings unfixed and reported
   (do not silently patch without re-review), say which contract clause is
   ambiguous, and let the user decide.

## 10. Wrap up

Summarize for the user:
- What was built and the files changed.
- The final verdicts per analyst (and the round count it took), including every
  adjudication override and its reasoning.
- The **hardening backlog**: aggregate the final DEFERRED list — every
  `Deferred (not now)` item, `Deferred observations` item, and adjudication
  downgrade — into **`deferred.md`** in `<RUN_DIR>` via `expertum_write_report`.
  Per item: source lens, description, affected files, severity if the scope
  expands, and a trigger condition ("before public exposure", "before
  multi-user", "if load exceeds X"). This makes the deferral visible value, not
  silent omission.
- The handoff: when a trigger fires, run `/expertum:conduct` (full rigor) with
  `deferred.md` as its input — the mirror of interview's `brief.md → conduct`
  handoff.
- Key decisions and trade-offs — especially any contradiction you reconciled in
  phase 7, and why you chose as you did.
- If you stopped at the cap, the residual objections and your recommendation.
Optionally write a combined `conduct-mvp--summary.md` into `<RUN_DIR>` via
`expertum_write_report`. Keep the chat summary tight; the detail lives in the
reports, `deferred.md`, and the diff.

---
description: Forced full pass to populate the Graphyne related-files graph — declare meta/edges for files that have none yet (especially test↔source edges).
argument-hint: "[optional path/glob to scope the pass, e.g. src/web]"
---

You are running **`/graphyne:init`** — a one-time (or periodic) pass to **populate the
Graphyne related-files graph** for this project. Normally edges accrue lazily as files
are edited; this command forces a full sweep so the graph reflects the codebase as it
already is. You add **edges only** via the `graphyne_link` MCP tool — never hand-edit
`.graphyne/meta/*.yaml`.

## 0. Preconditions

1. Ensure the Graphyne MCP tools are loaded (they are deferred): if `graphyne_project`
   isn't available, load it via ToolSearch with the keyword query `"graphyne_project"`
   (the exact namespaced name differs between standalone and plugin installs, so don't
   rely on an exact `select:`).
2. Call `graphyne_project`. If it reports the project is **not adopted** (no `.graphyne/`),
   STOP and tell the user to run `mkdir .graphyne` at the repo root and restart the
   session — Graphyne is opt-in and does nothing until then.
3. **Ensure `.graphyne/config.json` exists.** It is the per-project config that
   tells Graphyne which files the TDD gate guards, which files are tests, and how to run
   them. The expected flow is: the user makes a `.graphyne/` folder, then runs this command
   — so on a fresh adoption `.graphyne/config.json` is usually **absent** and YOU bootstrap
   it here.

   - If `.graphyne/config.json` already exists, read it and skip to step 4.
   - If it's **missing**, generate one from the reference template below:
     1. Inspect the repo to fill the fields with *real* values — don't ship the literal
        example. Look at the layout and tooling: where source lives, the test-file naming
        convention, and the test runner (read `package.json` scripts / dev-deps, or the
        `Cargo.toml` / `pyproject.toml` / `go.mod` etc. equivalent).
     2. Show the user the `.graphyne/config.json` you propose and the reasoning (which globs,
        which test command), and ask them to confirm or correct it **before** writing the file.
     3. Write the confirmed `.graphyne/config.json` with the **Write** tool. It sits inside the
        `.graphyne/` store, but `config.json` is the one hand-editable file there — the guard
        notes carve it out — so writing and editing it directly is fine. The meta graph and
        session state still go only through the MCP tools.

   **Reference `.graphyne/config.json`** (a TypeScript/Node project; adapt every value):

   ```json
   {
     "name": "My Project",
     "source": ["src/**/*.ts"],
     "exclude": ["src/**/*.test.ts", "src/**/*.d.ts"],
     "tests": ["tests/**/*.test.ts"],
     "docs": ["**/*.md"],
     "specs": ["spec/**/*.md"],
     "metaExclude": ["**/*.json", "tests/**", "scripts/**"],
     "ignore": ["plugin/**", ".memosyne/**", "dist/**"],
     "test": {
       "file": "npm test -- {test}",
       "all": "npm test"
     }
   }
   ```

   Field meanings (all globs are repo-root-relative, POSIX `/` separators):
   - **`name`** — display name, free text.
   - **`source`** − **`exclude`** → the **gated** files the TDD gate guards (editing them
     requires a failing covering test). Put production code in `source`; carve test files,
     type decls, and generated code out via `exclude`. NOTE: `exclude` also carves out
     **doc/spec** classification (below), so it doubles as the "never classify these dirs"
     list — put the plugin tree and `.memosyne/`-style stores here.
   - **`tests`** — which files ARE test files (exempt from the gate, used as test targets).
   - **`metaExclude`** — edited files NOT required to carry a meta entry before Stop
     (config, build scripts). Source you want in the graph should NOT be listed here. Keep
     `**/*.md` here so any `.md` that is *excluded* from `docs` still needs no meta.
   - **`docs`** / **`specs`** — documentation and specification `.md` files. NOT under
     the TDD gate, but (unlike plain metaExcluded `.md`) they MUST carry meta, so they
     join the graph: link them to the sources they describe so editing that source flags
     the doc/spec for actualization. Prefer a **broad** glob — `"docs": ["**/*.md"]` tracks
     EVERY source `.md` — and carve the plugin tree and `.memosyne/`-style stores out via
     `exclude` (`.graphyne/` is always exempt). Globs are repo-root-relative, so root files
     like `README.md` match natively — no directory scoping.
   - **`test.file`** — command to run ONE test; every `{test}` is replaced with the test's
     repo-relative path. **`test.all`** — command to run the whole suite. Graphyne runs
     these via `graphyne_test` to observe red/green, so they must work from the repo root.
     **`test.timeoutMs`** (optional) — cap on a single run in milliseconds, default 600000
     (10 minutes); a run past the cap is killed and reported red, so a hanging command
     can't wedge the session. Set it above your slowest full-suite time.

   Examples for other stacks (adapt, don't copy blindly):
   - **Python/pytest**: `"source": ["src/**/*.py"]`, `"tests": ["tests/**/*_test.py"]`,
     `"test": { "file": "pytest {test}", "all": "pytest" }`.
   - **Rust/cargo**: `"source": ["src/**/*.rs"]`, `"test": { "all": "cargo test" }`
     (cargo has no clean single-file form — `file` may be omitted).
   - **Go**: `"source": ["**/*.go"]`, `"exclude": ["**/*_test.go"]`,
     `"tests": ["**/*_test.go"]`, `"test": { "all": "go test ./..." }`.

4. From the now-present `.graphyne/config.json`, note the globs you'll use in this pass:
   - `source` − `exclude` → the **gated** files (the ones the TDD gate guards),
   - `tests` → which files are **test** files,
   - `docs` / `specs` → the documentation / specification `.md` files (cover these — see §2),
   - `metaExclude` → files that are *exempt* from needing meta (skip these, EXCEPT any that
     also match `docs`/`specs`, which win and must be covered).

## 1. Enumerate the files to cover

Scope: `$ARGUMENTS` if the user passed a path/glob, otherwise the whole repo.

- Use **Glob** to list candidate files under the scope. Cover, in priority order:
  1. **Gated source** files (match `source` − `exclude`) — most important, they can't be
     edited later without a `test`-tagged covering test.
  2. **Test** files (match `tests`).
  3. **Docs & specs** (match `docs` / `specs`) — link each to the code it documents/specifies.
  4. Other first-class source the project cares about.
- **Skip**: anything matching `metaExclude`, the `.graphyne/` store itself, `node_modules`,
  `dist`, and VCS/build noise — **but NOT** files matching `docs`/`specs` (they override
  `metaExclude` and must be covered, even root files like `README.md`).
- For each candidate, call `graphyne_neighbors <path>` to see what edges it ALREADY has.
  A file with the edges it needs is done — don't re-link (`graphyne_link` is idempotent and
  unions tags, but skipping saves work). Build a worklist of files lacking the edges below.

## 2. Declare the real edges (read the code — don't guess)

For each file on the worklist, OPEN it and infer its genuine relationships, then declare
each with `graphyne_link(path, related, tags)` (the edge is undirected — it's written into
both files' meta):

- **`test`** — the covering test for a source file. THIS IS THE PRIORITY: every gated
  source file should have a `test`-tagged edge to the test that exercises it, or the TDD
  gate will block editing it later. Match source↔test by convention (`src/foo.mts` ↔
  `tests/**/foo.test.mts`) and by reading the test's imports.
- **`consumer`** — a file that imports/uses this file.
- **`type`** — a file providing types this file depends on.
- **`doc`** — a `docs` `.md` linked to the code it documents. Editing that code will then
  hard-flag the doc for actualization. Link a doc to the specific source files whose behavior
  it describes (e.g. `README.md`/`DESIGN.md` ↔ the modules they explain), read both to justify it.
- **`spec`** — a `specs` `.md` linked to the code that must conform to it. Editing either side
  hard-flags the other. Link a spec to the modules that implement it.
- **`asset`**, etc. — other one-word labels as the relationship warrants.

Prefer a few accurate edges over many speculative ones. Use only relationships you can
justify from the code or docs (imports, references, test targets, what a doc actually
describes) — this is not a guessing game. For `doc`/`spec`, link the specific sources the
`.md` really covers, not every file.

Work in small batches; you may call `graphyne_link` many times.

## 3. Wrap up

- Call `graphyne_project` again and report the new graph size (meta-file count) vs. before.
- Summarize, grouped by tag: how many `test` edges were added (and any gated source files
  still **missing** a covering test — flag these explicitly so the user knows the TDD gate
  will block them), how many `doc`/`spec` edges were added (and any `docs`/`specs` `.md`
  left **unlinked** — flag these, the doc/spec gate stays dormant for them), plus other edges.
- Note any files you deliberately skipped and why.
- Run `graphyne_checklist` and make sure nothing is left outstanding before you stop.

Do NOT edit any source files during this pass — `/graphyne:init` only declares graph edges.

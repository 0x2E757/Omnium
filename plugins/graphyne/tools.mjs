// Frozen wire surface of the Graphyne MCP server: the 12 advertised tool
// definitions (names, titles, descriptions, inputSchemas — including the
// `$schema`/`additionalProperties` keys and their exact key ORDER — and the
// SDK's `execution` block), exactly as graphyne@0.1.28 emitted them. Agents
// have learned every byte of the TOOL surface, so it is DATA here, not code:
// transcribed verbatim from graphyne@0.1.28's live tools/list output. Edit
// ONLY to deliberately change the advertised contract — never as cleanup.
//
// The `instructions` text is the ONE deliberate exception to that freeze: the
// 0.1.28 text was ~5KB, but Claude Code silently truncates each server's
// instructions at ~2KB, so most of it (including the whole TDD-gate section)
// never reached the model. It was re-cut in Omnium to fit the cap
// front-loaded; the budget and the first-500-chars contract are pinned by
// tests/graphyne/mcp/instructions.test.mts. Tool names/descriptions/schemas
// below remain frozen.
//
// The array is in the prior REGISTRATION order (the order tools/list
// advertises); the schemas' zod-era artifacts (draft-07 $schema, sometimes
// first and sometimes last, additionalProperties present or absent) are
// quirks of the old zod pipeline, transplanted verbatim (charter rule 14).

export const GRAPHYNE_INSTRUCTIONS = `Graphyne enforces two disciplines in THIS project; Stop is BLOCKED until graphyne_checklist is clear.

1) TDD GATE. Files under graphyne.json's source globs are editable ONLY while a covering test is failing. Rhythm: graphyne_link(path: <src>, related: <test>, tags: ["test"]) -> write/adjust the test -> run graphyne_test, see it RED -> edit <src> -> graphyne_test GREEN (after RED->GREEN the file stays editable for refactoring). ALWAYS run tests via graphyne_test, never raw Bash — that is how red/green is recorded.

2) RELATED-FILES GRAPH. Every edited file needs a meta entry (.graphyne/meta/<path>.yaml) of UNDIRECTED edges with up to 5 one-word tags (test, consumer, type, doc, spec, ...) — graphyne_link writes both sides, graphyne_unlink removes. Editing a file flags its neighbors: edit each, or mark it graphyne_review, before the turn ends. After each edit also reconcile the file's OWN relations, then call graphyne_meta_confirm on it (empty confirm OK; MANDATORY, re-armed by every edit).

DOC/SPEC GATE (HARD flags). Edges tagged doc/spec tie code to the documentation/spec it must stay in sync with: editing code hard-flags its doc/spec neighbors, editing a spec hard-flags the code; editing a doc only soft-flags the code. A bare review will NOT clear a hard item — edit the doc/spec, or graphyne_review WITH a reason.

ESCAPE HATCHES: graphyne_refactor(path, reason) opens a delete-only window for dead code (verifies a green safety net; pure deletions only). graphyne_bypass(files) is the LAST RESORT for behavior-preserving refactors that modify lines — self-attested, weakest, green-before and green-after enforced; new/changed behavior always goes red-first. graphyne_forget prunes a deleted file.

Discovery: graphyne_project (config, graph size), graphyne_neighbors (related files), graphyne_status (TDD editability). Clear graphyne_checklist before ending each turn.`;

/** @typedef {import("./common/mcp-core.mjs").JsonObject} JsonObject */

/**
 * @type {Array<{ name: string, title: string, description: string, inputSchema: JsonObject, execution: JsonObject }>}
 */
export const TOOL_DEFINITIONS = [
  {
    "name": "graphyne_project",
    "title": "Current Graphyne project",
    "description": "Show the project Graphyne tracks, its .graphyne/ store, graph size and config.",
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {}
    },
    "execution": {
      "taskSupport": "forbidden"
    }
  },
  {
    "name": "graphyne_neighbors",
    "title": "Related files",
    "description": "List the files related to a given file (its graph edges) with their tags — the files you should consider reviewing/updating when you change it.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "minLength": 1,
          "description": "Repo-root-relative path of the file"
        }
      },
      "required": [
        "path"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "execution": {
      "taskSupport": "forbidden"
    }
  },
  {
    "name": "graphyne_link",
    "title": "Link two files",
    "description": "Create an UNDIRECTED relation between two files, written into BOTH meta files. An edge carries a SET of one-word tags (up to 5), not a single label — combine them when several apply (e.g. a file that is both a `type` source and a `consumer`). Use tag \"test\" to declare a file's covering test (required by the TDD gate); other tags are free one-word labels (consumer, type, doc, …).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "minLength": 1,
          "description": "First file (repo-root-relative)"
        },
        "related": {
          "type": "string",
          "minLength": 1,
          "description": "Second file to relate it to (repo-root-relative)"
        },
        "tags": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "One or more one-word tags for the edge (up to 5) — an edge can carry several tags, e.g. [\"test\"] or [\"type\",\"consumer\"]."
        }
      },
      "required": [
        "path",
        "related"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "execution": {
      "taskSupport": "forbidden"
    }
  },
  {
    "name": "graphyne_unlink",
    "title": "Unlink two files",
    "description": "Remove the relation between two files from both their meta files.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "minLength": 1,
          "description": "First file (repo-root-relative)"
        },
        "related": {
          "type": "string",
          "minLength": 1,
          "description": "The related file to disconnect"
        }
      },
      "required": [
        "path",
        "related"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "execution": {
      "taskSupport": "forbidden"
    }
  },
  {
    "name": "graphyne_forget",
    "title": "Forget a deleted file",
    "description": "Prune a file you DELETED from disk this session from the graph and the session: remove its (now orphan) meta file, strip the reciprocal edges from its neighbors, and drop it from the edited-files set so it stops blocking Stop. Use this when you created/edited a file and then removed it (e.g. a throwaway probe) — the gate would otherwise still demand a meta for the missing path. GUARDED: refuses if the file still EXISTS on disk (delete it first); this is cleanup for a real deletion, not a way to skip the missing-meta gate.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "minLength": 1,
          "description": "The deleted file to forget (repo-root-relative)"
        }
      },
      "required": [
        "path"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "execution": {
      "taskSupport": "forbidden"
    }
  },
  {
    "name": "graphyne_test",
    "title": "Run tests",
    "description": "Run tests via the commands in graphyne.json and record red/green (exit 0 = green). Pass `test` (a test file) to drive the TDD gate for the source it covers; or `all: true` to run the whole suite. Returns the FULL test output. ALWAYS run tests through this, not raw Bash.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "test": {
          "type": "string",
          "description": "A test file to run (repo-root-relative); drives the TDD gate"
        },
        "all": {
          "type": "boolean",
          "description": "Run the whole suite instead (does not record per-file gate state)"
        }
      },
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "execution": {
      "taskSupport": "forbidden"
    }
  },
  {
    "name": "graphyne_refactor",
    "title": "Open a delete-only refactor grant",
    "description": "Open a delete-only refactor window for a gated source file so you can DELETE dead/structural code that no failing test can drive (red-first is impossible for a behavior-preserving removal). Verifies the green safety net first — the file's covering tests, or the whole suite if it has none — and only then opens the grant. While open, the TDD gate admits PURE DELETIONS of this file (no line added/modified); any add or change still needs a failing test. A red oracle is DENIED (that's a behavior signal for the normal loop). The suite must stay green: re-run this after deleting to re-verify (an all-suite grant blocks Stop until you do).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "minLength": 1,
          "description": "The gated source file you want to delete dead code from (repo-root-relative)"
        },
        "reason": {
          "type": "string",
          "minLength": 1,
          "description": "What dead/structural code you're removing — recorded with the grant"
        }
      },
      "required": [
        "path",
        "reason"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "execution": {
      "taskSupport": "forbidden"
    }
  },
  {
    "name": "graphyne_bypass",
    "title": "Open a self-attested gate bypass",
    "description": "Open a SELF-ATTESTED bypass window for one or more gated source files so you can make a behavior-preserving change that MODIFIES lines (not just whole-line deletions) and that no failing test can drive — e.g. removing dead state woven inside a line, rename/inline/extract-variable, collapsing a dead if/else branch. This is the WEAKEST grant: weaker than red-first AND than the delete-only graphyne_refactor. While open the gate admits ANY edit to a granted file — there is NO structural or coverage check that your edit is safe; it rests entirely on your per-file `reason` (attestation) plus two real guards: green-before (every declared covering test is run here and must be green — all-or-nothing across all files) and green-after (after editing you MUST re-run those tests green via graphyne_test or Stop is blocked). Coverage proves execution, not assertion, and here not even execution is checked — so use this ONLY for behavior-preserving refactors, NEVER for new or changed behavior (that needs a failing test, red-first).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "files": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "minLength": 1,
                "description": "A gated source file you will bypass-edit (repo-root-relative)"
              },
              "tests": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1
                },
                "minItems": 1,
                "description": "The covering test file(s) that pin the code you're refactoring (at least one, repo-root-relative)"
              },
              "reason": {
                "type": "string",
                "minLength": 1,
                "description": "Why this edit is behavior-preserving and can't be driven red-first — your attestation"
              }
            },
            "required": [
              "path",
              "tests",
              "reason"
            ],
            "additionalProperties": false
          },
          "minItems": 1,
          "description": "The files you plan to bypass-edit, each with its covering tests and a reason"
        }
      },
      "required": [
        "files"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "execution": {
      "taskSupport": "forbidden"
    }
  },
  {
    "name": "graphyne_checklist",
    "title": "Session checklist",
    "description": "Show what's outstanding this session: related files still to review/update, and edited files missing a meta entry. These block Stop until cleared.",
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {}
    },
    "execution": {
      "taskSupport": "forbidden"
    }
  },
  {
    "name": "graphyne_review",
    "title": "Mark reviewed",
    "description": "Mark a related file as reviewed with no change needed — resolves its checklist item without editing it. For a doc/spec relation this is a HARD item: a bare review will NOT clear it; you must either edit the doc/spec to actualize it, or pass `reason` explaining why no change is needed.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "minLength": 1,
          "description": "The related file you reviewed (repo-root-relative)"
        },
        "reason": {
          "type": "string",
          "description": "Why no change is needed — REQUIRED to clear a doc/spec (hard) item without editing it"
        }
      },
      "required": [
        "path"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "execution": {
      "taskSupport": "forbidden"
    }
  },
  {
    "name": "graphyne_meta_confirm",
    "title": "Confirm meta",
    "description": "Confirm that an edited file's related-files meta has been reconciled with the change — review whether the edit added or removed connections (graphyne_link / graphyne_unlink) first. An empty confirm is fine when nothing changed, but the call is REQUIRED after each edit (re-armed whenever you edit the file again); Stop is blocked until every edited file is confirmed.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "minLength": 1,
          "description": "The edited file whose relations you've reconciled (repo-root-relative)"
        }
      },
      "required": [
        "path"
      ],
      "additionalProperties": false,
      "$schema": "http://json-schema.org/draft-07/schema#"
    },
    "execution": {
      "taskSupport": "forbidden"
    }
  },
  {
    "name": "graphyne_status",
    "title": "TDD status",
    "description": "For each gated source file you've edited this session, show whether it's currently editable and why.",
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {}
    },
    "execution": {
      "taskSupport": "forbidden"
    }
  }
];

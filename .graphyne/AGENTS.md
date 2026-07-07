# .graphyne/ — managed by Graphyne

This directory is the Graphyne plugin's store. `meta/` is the committed graph of
related files; `tasks/` is per-session state (gitignored).

Do NOT hand-edit these files. Work with the graph EXCLUSIVELY through the Graphyne
MCP tools (graphyne_neighbors, graphyne_meta, graphyne_link, graphyne_unlink, …)
and the session state through graphyne_checklist / graphyne_review / graphyne_test.
Hand-editing risks corrupting the on-disk schema and bypasses the bidirectional
link invariant the tools maintain.

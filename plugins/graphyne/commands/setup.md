---
description: Adopt this project for Graphyne — create the .graphyne/ store so the TDD gate and related-files graph activate.
---

Graphyne handles this command in its `UserPromptSubmit` hook: it creates the
project's `.graphyne/` store (the committed meta graph plus `.gitignore` and guard
notes) and erases the prompt, so normally no model turn happens at all. Graphyne is
opt-in and stays dormant until that directory exists; `/graphyne:setup` is what
brings it into being. Once set up, run `/graphyne:init` to populate the graph.

If you are reading this text, the hook did **not** intercept the command. Most
often that just means the command was typed with arguments or different casing —
interception requires an exact match; first tell the user to re-type it exactly
as `/graphyne:setup`, with nothing after it. Only if the exact form also reaches
you is the hook disabled or failing; then the store can be created manually with
`mkdir .graphyne` at the repo root followed by a session restart. Do nothing
else.

---
description: Report whether Graphyne enforcement is active or muted for this session, with the outstanding obligation count (works without the MCP server).
---

Graphyne handles this command in its `UserPromptSubmit` hook: it reports whether
enforcement is active or muted (`/graphyne:off`) for the current session plus the
outstanding obligation count, and erases the prompt, so normally no model turn
happens at all. It is deliberately hook-handled — unlike the `graphyne_status`
MCP tool (which reports per-file TDD editability) it must keep working precisely
when the MCP server is down.

If you are reading this text, the hook did **not** intercept the command. Most
often that just means the command was typed with arguments or different casing —
interception requires an exact match; first tell the user to re-type it exactly
as `/graphyne:status`, with nothing after it. Only if the exact form also
reaches you is the hook disabled or failing; then the session's mute state can
be inspected manually at `.graphyne/tasks/<session-id>/mute.json` (session id =
content of `.graphyne/tasks/.current`). Do nothing else.

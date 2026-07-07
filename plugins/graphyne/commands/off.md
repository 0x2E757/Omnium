---
description: Mute Graphyne enforcement for this session — the TDD gate and the Stop gate warn instead of blocking (recovery path when the MCP server is unreachable).
---

Graphyne handles this command in its `UserPromptSubmit` hook: it MUTES enforcement
for the current session (PreToolUse stops denying edits, Stop/SubagentStop warn
instead of blocking) and erases the prompt, so normally no model turn happens at
all. Obligations keep being recorded — never cleared — and `/graphyne:on` re-arms
the gates with the full outstanding set. This is the intended recovery path when
the Graphyne MCP server is down or unregistered and the obligations are therefore
uncleanable.

If you are reading this text, the hook did **not** intercept the command. The
most common reason is harmless: interception requires an EXACT match, so any
arguments or different casing (`/graphyne:off please`, `/graphyne:OFF`) fall
through to this document while the hook stays perfectly healthy — first tell
the user to re-type the command exactly as `/graphyne:off`, with nothing after
it. Only if the exact form also reaches you is the hook itself disabled or
failing; in that case the manual recovery is to delete the session's state
directory: `.graphyne/tasks/<session-id>/` (the current session id is the
content of `.graphyne/tasks/.current`), or the entire `.graphyne/tasks/`
directory. That is uncommitted session state; the committed graph under
`.graphyne/meta/` is untouched. Then do nothing else.

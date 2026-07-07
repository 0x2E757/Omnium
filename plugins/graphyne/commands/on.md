---
description: Re-enable Graphyne enforcement for this session after /graphyne:off — the gates re-arm with every obligation recorded while muted.
---

Graphyne handles this command in its `UserPromptSubmit` hook: it lifts the
session mute set by `/graphyne:off` and erases the prompt, so normally no model
turn happens at all. Enforcement resumes immediately — every obligation recorded
while muted re-arms the Stop gate, and the reply reports the outstanding count.

If you are reading this text, the hook did **not** intercept the command. Most
often that just means the command was typed with arguments or different casing —
interception requires an exact match; first tell the user to re-type it exactly
as `/graphyne:on`, with nothing after it. Only if the exact form also reaches
you is the hook disabled or failing; then the mute can be lifted manually by
deleting the file `.graphyne/tasks/<session-id>/mute.json` (session id =
content of `.graphyne/tasks/.current`). Do nothing else.

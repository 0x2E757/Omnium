---
description: Report whether Autonomity autonomous mode is on or off for this session
---

The Autonomity plugin handles this command in its `UserPromptSubmit` hook: it
reads the session flag (without changing it) and erases the prompt, surfacing the
current state, so normally no model turn happens at all.

If you are reading this text, the hook did **not** intercept the command (it may
be disabled or failing). Tell the user that Autonomity's `UserPromptSubmit` hook
did not fire, so the current mode could not be reported — and do nothing else.

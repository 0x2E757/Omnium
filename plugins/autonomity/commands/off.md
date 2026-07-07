---
description: Turn Autonomity autonomous mode OFF for this session
---

The Autonomity plugin handles this command in its `UserPromptSubmit` hook: it
flips the session flag to **off** and erases the prompt, so normally no model
turn happens at all.

If you are reading this text, the hook did **not** intercept the command (it may
be disabled or failing). Tell the user that Autonomity's `UserPromptSubmit` hook
did not fire, so autonomous mode could not be disabled — and do nothing else.

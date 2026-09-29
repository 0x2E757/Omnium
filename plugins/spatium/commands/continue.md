---
description: Carry the previous prompt's time budget into this one — the clock keeps running from where it was, the time you took to reply is not counted. Optional +15m extends it, 45m sets a new total.
argument-hint: [+duration to extend | duration as the new total] [instructions]
disable-model-invocation: true
---

The user is continuing the previous prompt under its time budget. Spatium's
`UserPromptSubmit` hook has already carried the budget over (adjusting it if a
duration was given as the first word of the arguments) and stated the time used
so far in a `Spatium:` line in your context.

Continue the previous work. If the arguments contain instructions after the
optional duration, follow them; otherwise pick up where you left off.

If no `Spatium:` line about continuing is in your context, the hook did not run
(the plugin is disabled or failing): tell the user the budget is not being
tracked, then continue anyway.

Arguments passed to this command: `$ARGUMENTS`

---
description: Run a task under a guide time budget — the agent sees the share of the budget used after every tool call (it may pass 100%).
argument-hint: <duration, e.g. 30m, 1h30m, 90s> <task>
disable-model-invocation: true
---

The user started this prompt with a **guide** time budget. Spatium's
`UserPromptSubmit` hook has already read the duration (the first word of the
arguments) and stated the budget and its rules in a `Spatium:` line in your
context; from now on every tool call is followed by a line with the time used
and the share of the budget.

Carry out the task — the arguments after the duration — as you normally would,
treating the budget as a guide, not a stop. If the task is empty, ask the user
what to do.

If no `Spatium:` line declaring this budget is in your context, the hook did not
run (the plugin is disabled or failing): tell the user the budget is not being
tracked, then do the task anyway.

Arguments passed to this command: `$ARGUMENTS`

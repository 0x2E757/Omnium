---
description: Run a task under a hard time limit the agent enforces on itself — wrap up at 80%, stop at the next safe point at 100%.
argument-hint: <duration, e.g. 30m, 1h30m, 90s> <task>
disable-model-invocation: true
---

The user started this prompt with a **hard** time limit. Spatium's
`UserPromptSubmit` hook has already read the duration (the first word of the
arguments) and stated the limit and its rules in a `Spatium:` line in your
context; from now on every tool call is followed by a line with the time used
and the share of the limit.

Nothing will stop you at the limit — enforcing it is your job. Carry out the
task (the arguments after the duration) within it: at 80% wrap up, at 100% stop
at the next safe point, leave the work consistent, and report what is done,
what is not, and what remains. If the task is empty, ask the user what to do.

If no `Spatium:` line declaring this limit is in your context, the hook did not
run (the plugin is disabled or failing): tell the user the limit is not being
tracked, then do the task anyway.

Arguments passed to this command: `$ARGUMENTS`

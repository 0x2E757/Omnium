---
description: Opt this project in to Memosyne by creating its .memosyne/ store
---

Memosyne handles this command in its `UserPromptSubmit` hook: it creates the
`.memosyne/` store at the project root (the opt-in gate the MCP server and hook
check for), seeds `config.json` and the `AGENTS.md` / `CLAUDE.md` guard files,
then erases the prompt — so normally no model turn happens at all.

If you are reading this text, the hook did **not** intercept the command (it may
be disabled or failing). Do the setup yourself:

1. Resolve the project root — the git repo top level (`git rev-parse
   --show-toplevel`), or the current working directory if this is not a repo.
2. Create `<root>/.memosyne/` if it does not already exist. If it does, tell the
   user the project is already activated and stop.
3. Write `<root>/.memosyne/config.json` as `{ "name": "<basename of root>" }`,
   and drop the `AGENTS.md` and `CLAUDE.md` guard files (the canonical text is
   `GUARD_CONTENT` in `src/common/storage.mts`) so agents leave the store alone.

Then tell the user to **restart the session** (`/reload-plugins` or reopen)
before the Memosyne MCP tools become available — the server resolves activation
once at startup — and to commit the new `.memosyne/` files.

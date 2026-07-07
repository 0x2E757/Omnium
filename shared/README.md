# shared/ — canonical shared modules

The files here are the CANONICAL copies of code shared between plugins: the
MCP server core (`mcp-core.mjs`, `mcp-schema.mjs`), the file-lock factory
(`lock-core.mjs` — graphyne's and memosyne's `common/lock.mjs` are thin shims
binding their env prefix and product name; expertum's copy is currently
unused), project resolution (`project.mjs`), the retrying atomic file
write (`atomic-write.mjs`), and case/separator path-key normalization
(`path-key.mjs` — fold a repo-relative path to a lookup key on
case-insensitive filesystems).
Each consuming plugin (expertum, graphyne, memosyne) carries byte-identical
copies in its `plugins/<name>/common/` folder, because a marketplace install
copies exactly one plugin folder and skips out-of-tree symlinks — physical
copies are the only way to share code between plugins.

Edit ONLY here, then run `node scripts/sync-shared.mjs` (`npm run sync:shared`)
to refresh every copy. `tests/omnium/vendoring.test.mjs` byte-compares all
copies against these canonicals on every `npm run check` — that guard is the
law; an edited copy cannot survive the gate.

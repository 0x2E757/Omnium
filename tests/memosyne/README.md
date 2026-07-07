<!--
Ported/excluded split for the memosyne test port (DESIGN.md D10 — the old
suites are the behavioral spec; import paths repointed, assertions frozen):

  PORTED (112 tests, all green — matches the prior non-web total):
    task.test.mts          18  from Memosyne tests/common/task.test.mts
    storage.test.mts        9  from Memosyne tests/common/storage.test.mts
    lock.test.mts           6  from Memosyne tests/common/lock.test.mts
    cache.test.mts          4  from Memosyne tests/common/cache.test.mts
    project.test.mts        3  from Memosyne tests/common/project.test.mts
    registry.test.mts       8  from Memosyne tests/common/registry.test.mts
    mcp-handlers.test.mts  38  from Memosyne tests/mcp/mcp-handlers.test.mts
    claude.test.mts        26  from Memosyne tests/hook/claude.test.mts

  EXCLUDED (56 tests — the web App is out of the plugin's scope, DESIGN.md D10):
    tests/web/backend/web-api.test.mts        9
    tests/web/backend/web-server.test.mts     5
    tests/web/frontend/components.test.js     5
    tests/web/frontend/dom.test.js           11
    tests/web/frontend/markdown.test.js       4
    tests/web/frontend/routing.test.js        5
    tests/web/frontend/view.test.js          17

  Prior total: 168 = 112 ported + 56 web-excluded.
-->

# tests/memosyne

The prior Memosyne suites (common + mcp + hook; web excluded), ported with
import-path rewrites only — assertions are frozen, per DESIGN.md D10.
(`mcp-handlers.test.mts` additionally carries the `memosyne_edit_task` suite
added when the unified-diff `memosyne_patch_task` was retired — DESIGN.md D17.)

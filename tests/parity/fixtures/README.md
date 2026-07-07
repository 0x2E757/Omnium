# Parity fixtures — differential oracles for the vendored libraries (DESIGN.md D4/D5)

Golden outputs captured from the REAL libraries running in the reference checkouts; the vendored
zero-dep replacements must reproduce every recorded outcome (values, bytes, and throw messages).
Produced by: `yaml@2.9.0` + `picomatch@4.0.4` (Graphyne pnpm-lock.yaml).

Regenerate (each generator resolves its library from the CURRENT working directory, so it must run from a checkout that has the library installed):

    cd <ref-checkout>  && node <omnium>/tests/parity/fixtures/generators/gen-yaml-stringify.mjs \
                                   && node <omnium>/tests/parity/fixtures/generators/gen-yaml-parse.mjs \
                                   && node <omnium>/tests/parity/fixtures/generators/gen-yaml-roundtrip.mjs \
                                   && node <omnium>/tests/parity/fixtures/generators/gen-globs.mjs

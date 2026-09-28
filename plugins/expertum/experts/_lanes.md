`audit--security` owns the overall threat model and authn/z design; the
tier-specific security analysts (backend/frontend/mobile) own code-level
practices in their tier — add only the tier(s) the subject touches.
`app--performance` owns application hot paths; `database--performance` owns
query/schema-level cost; `observability--operations` owns telemetry, not
performance itself. `architecture--quality` owns pattern consistency;
`backend--design` owns API/service design; `database--design` owns schema
design (query tuning belongs to `database--performance`). `code--quality` owns
line-level quality of the change; `debug--diagnostics` and `logs--diagnostics`
are relevant only when the subject includes a concrete failure or its logs.
Tell each analyst what it does NOT own so it stays in lane.

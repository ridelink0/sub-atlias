# Atlias native transaction experiment

Gev's PLAN-1013 items 10 and 11, grounded in RESEARCH-FIRST 0f. All options default off. Load this directory with `claude --plugin-dir ./mods/atlias-transaction`; enable options only in an isolated qualified profile. This experiment does not replace or remove native tools and makes no model calls.

The registered batch routes every operation through `$.tool.call`. It does not invent consent, bypass a denial, roll back partial writes, or treat tool execution as a passing test. A refusal, error, unknown result or cancellation stops later operations; inspect existing effects before retrying. Full native results remain in the batch receipt. There is an eight-operation batch bound, with no two-inference-call task cap. Native tools remain available for longer work.

Native dispatch, ordinary permission denial, transcript storage, cancellation and token cost must be qualified on the installed Claude version before a public release. Current experimental target: Claude Code 2.1.296. This is not a proven 20x improvement.

# Atlias native transaction experiment

Gev's PLAN-1013 items 10 and 11, grounded in RESEARCH-FIRST 0f. All options default off. Load this directory with `claude --plugin-dir ./mods/atlias-transaction`; enable options only in an isolated qualified profile. This experiment does not replace or remove native tools and makes no model calls.

The registered batch routes every operation through `$.tool.call`. Batch Read is text-only: image, PDF and page-based Read plans are rejected before preflight, and an unexpected or mixed native Read result halts with `require-native-read` without serializing its opaque payload; use native Read directly. Valid text results retain their exact text and line metadata; malformed fields reject the whole result. Read failures preserve the native textual diagnostic, denial and error marker while withholding opaque payload fields. Other tools retain their full native result. Worker batches return require-native-tools before preflight or effects: the installed host attributes nested native calls to the main actor, so workers must use standalone native tools through ToolSearch until actor propagation is qualified. This does not change standalone native Read or add an automatic fallback. It does not invent consent, bypass a denial, roll back partial writes, or treat tool execution as a passing test. A refusal, error, unknown result or cancellation stops later operations; inspect existing effects before retrying. There is an eight-operation batch bound, with no two-inference-call task cap. Native tools remain available for longer work.

Optional `deduplicateTextReads` is also off by default and requires the master switch.
It keeps the exact native Read text and all file metadata, replacing only verified
duplicate `file.content` with `{from:"native.text",format:"line-number-tab-v1"}` or
`format:"text-v1"`. The numbered recipe removes exactly one leading line number
and tab from each line; the plain recipe uses the identical text. CRLF, empty
lines, tabs, Unicode, trailing newlines and truncation metadata are retained.
Unknown formatting, diagnostics, future fields, malformed metadata and results
without a UTF-8 byte benefit at both JSON text and JSON-string transport layers
retain the complete original representation. The line count must also match the
verified content, including a trailing empty line. There
is no output clipping, history rewrite, auxiliary model or additional tool call.
The native text is the source to read; `restoreTextRead` reconstructs the original
envelope. The custom tool describes the representation when enabled. Its added
description costs tokens and must be counted in paired measurement. Model quality
and whole-task savings remain unqualified; byte savings alone establish neither.

Native tool deferral requires a valid tool list, successful batch registration and ToolSearch in that list. Missing discovery or registration leaves standalone native tools unchanged. Dispatch and permission API semantics require native conformance checks for the current build; the hook uses documented literal API calls and catches failures. Malformed, empty or unfamiliar result/control envelopes stop the batch as unknown before later operations; this is execution evidence only, never proof that a check passed.

Native dispatch, ordinary permission denial, transcript storage, cancellation and token cost must be qualified on the installed Claude version before a public release. Historical model benchmarks used Claude Code 2.1.296. Focused deterministic fixtures have also exercised 2.1.300; new source and new CLI versions need fresh qualification. These guards cannot guarantee compatibility with every future update. This is not a proven 20x improvement.

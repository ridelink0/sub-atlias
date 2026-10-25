# Terminal usability implementation plan

Research: [Terminal UI research update](</D:/atlias-app/reports/Terminal UI research update.md>), extending the earlier beginner report. All three source-note passes and the synthesis were read before implementation. Baseline: ad06354. Findings are source/probe evidence, not measured usability or assistive-technology conformance.

This batch applies RESEARCH-FIRST H3 (actionable errors), H4 (stopping differs from completing) and H5 (verify actual behavior). It changes interactive presentation and input handling only; no evaluator, model requests, worker approval policy, benchmark budgets or frozen source changes.

1. Block question submission when the complete question cannot fit. Keep cancellation and resize available; prove the decision handler is not called while hidden.
2. Carry unsent draft text into each queued turn. Preserve it through empty handoffs and rejected queued input. Submitted queue entries belong in input history; unsent drafts and permission answers do not.
3. Recompute slash matches on Up/Down using the current input, including coalesced controls.
4. Let settings selection inspect a boolean before an explicit value choice. Empty value preserves it; retain validation, keys and numbering.
5. Match the empty-state hint to setup state. Keep hints out of submitted input and retain the original normal prompt/header.
6. Make keyboard help describe the actual composer or line input mode. Expose implemented keys without inventing controls.
7. Add an opt-in, session-only --plain presentation using line input, plain identity text, sanitized human output and no usage-display redraw. Keep exact stored requests and normal defaults unchanged.

Verify bounded stream scenarios, CLI/fallback flows and real ConPTY with a loopback provider fixture. Exercise queue drain, rejected queued input, nested questions, resize, cancellation, hostile display controls and unchanged baseline request fingerprints. Then plant isolated regressions and run the full suite with PID-termination cases explicitly skipped. Inspect actual native screenshots; keep paid-provider and live screen-reader outcomes unverified.

Default Atlo, unchanged Atlias wordmark and original blue remain. No push or deployment. Preserve the resource-stopped benchmark and its history. New undo stacks, queue take-back, global motion preferences, broad menu reorganization and live assistive-technology certification are outside this batch until these concrete failures are closed.


## Actual verification, October 25

Functional pass: `ATLIAS_TEST_NO_PID_KILL=1 node test/run.mjs` exited 0 with 3209/3209 checks across 414 suites. Nine PID-termination cases were explicitly skipped and remain unverified. `node --test test/subagent-routing.test.mjs` exited 0 with 9/9 tests. The earlier focused regression exited 0 with 189/189 checks; the final full run includes the new 15 terminal usability checks. `node --check` exited 0 for all 11 changed JavaScript files, and `git diff --check` was clean.

Real Windows ConPTY and pipe-captured application output: `node test/native-terminal-usability-check.mjs` exited 0. Five loopback HTTP fixture calls, zero external model calls. Queued A/B retained draft C, submitting C preserved its exact text, and a rejected queued image kept draft D without another provider request. Submitted queue history excluded unsent text. Both actual app children exited 0. With token usage enabled and FORCE_COLOR=3, explicit --plain output had no terminal controls or periodic redraw; contextual keyboard help and unchanged boolean inspection worked.

Adversarial pass: read each changed file and exercised the hidden-question guard with a deliberately removed guard (the identical scenario rejected the mutant). Fixed a default-readline auto-detection regression, double-Escape submitting /rewind as a question answer, and OSC payload text with spaces surviving Node's VT stripper. Final full/native checks above ran after those fixes. Initial native queue failure was a fixture timing false alarm: coalescing Enter with subsequent text followed the existing unbracketed multiline-paste path. Sending and awaiting distinct key events proved queue recovery without altering paste behavior.

Three actual native-byte replays were captured and viewed: start, recovered C, and rejected queue with retained D. Original blue, Atlo and unchanged wordmark remain. Receipts, application stdout, replay transcript and screenshots are in D:/atlias-app/reports/terminal-usability-1025. The research report and three notes are in D:/atlias-app/reports/Terminal UI research update.md and D:/atlias-app/research_notes/Terminal UI research update; the earlier report now links the continuation.

Live screen-reader testing, paid-provider behavior and PID-termination cases remain unverified. This batch adds no input undo stack, queue withdrawal, global motion preference or measured superiority claim. The resource-stopped benchmark and frozen source remain untouched. No push or deployment.

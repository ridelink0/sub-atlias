# History search feedback, October25

The earlier terminal research recommends an explicit no-match state for Ctrl+R search (editing and feedback notes, P2). The composer now displays `No matches` instead of leaving a blank result. Search acceptance still returns to editing; Esc restores the existing draft. Search queries and this display label are not saved as submitted input. Default Atlo, wordmark, blue theme and model requests are unchanged.

Functional verification:128/128 focused checks passed, actual exit0. A real Windows ConPTY scenario passed with explicit no-match feedback,40-column resize, no submission from the first Enter, and exact restored draft editing/return. It exited0 and made zero external model calls. Initial native fixture failures came from omitted stream arguments and an inherited TERM=dumb; the fixture was corrected to use real streams and TERM=xterm-256color before the successful run. App fallback behavior was not altered.

Adversarial verification: an isolated actual-line removal of `No matches` failed the two corresponding assertions in the identical53-check composer scenario. Original source was never mutated. Separate source/test review found no new persistence, permission handling or model-request path. Actual receipts and native transcript are in reports/search-feedback-1025.

Full regression verification:3213/3213 checks across414 suites passed, actual exit0 in full-exit.json/full.log. Nine PID-dependent cases were explicitly skipped and remain unverified. The separate worker-routing suite was not rerun for this display-only change. Final source/test syntax and whitespace checks passed; the changed line affects presentation only. Preserve the live benchmark's frozen source and owned resources. No paid inference or PID termination.

# Steer, Queue, /btw and drafts - implementation receipt

Gev's delegated task from Claude owner-f1. Worktree:
`D:/harness-work/atlias-steer-1029`, branch `codex/steer-queue-drafts-1029`,
base `7677288`. No application checkout was edited; no push, merge, network
install, deployment or live model request was performed.

## Design and research

Read RESEARCH-FIRST.md top to bottom and the top WORK-PLAN block before design.
The design rests on section 0a H2/H4 and section 9's authority-preservation
contract. Read FOLLOWUPS-BTW-DRAFTS-1029.md when it arrived. Its confirmed
Codex CLI keys establish Enter=steer; the report's proposed queue default
conflicts with Gev's explicit instruction to match Codex CLI. Its per-session
draft proposal and 500 ms interval yield to Gev's per-project/250 ms request.

Steering is opt-in through a source passed to agent.turn. Calls without that
source keep their reply-string contract and model-request assembly. The source
is polled before requests, after the previous step's tool observations. Applied
steers become user messages and are preserved in asks, history and the enabled
authority ledger. Late messages and messages left after Stop are prepended to
the queue. A partially consumed batch remains recoverable on an exception.

The existing TUI/REPL queue path was extended; the Max runner was read to keep
the API compatible and was not edited. The wider research proposals for image
draft copies, cleared-draft history, multi-window locks, send-now interruption,
side-thread navigation and benchmark experiments were not added to this task.
The optional steer source is the off-by-default mechanism for embedders and
benchmarks; no additional benchmark flag or efficiency claim was introduced.

## API in three lines

`agent.turn(state, text, ask, say, { steer: { take(): string[], onApplied?(text) }, signal })`
`=> { reply, appliedSteers, unappliedSteers }; exceptions carry error.steers`
`agent.btw(state, question, { signal }) => string; no tools, session or memory writes`

See [docs/follow-ups.md](docs/follow-ups.md) for ownership, transport fixtures,
unsupported host-engine behavior and Max integration instructions.

## Keys and persistence

- `ui.followUp`: `steer` default, or `queue`. Enter uses this setting during work.
- Ctrl+Q sends the other kind; Tab remains slash-command completion.
- `/queue` lists pending entries; `/queue edit N text` and `/queue remove N`
  operate before they start. Messages execute one by one after the current turn.
- `/btw <question>` displays an ephemeral no-tool answer. Esc dismisses;
  PgUp/PgDn scroll. Claude-plan/ChatGPT defer side requests with a visible notice.
- `<ATLIAS_HOME>/drafts/<project-hash>.json` saves the prompt, queue and pending
  steers after 250 ms idle, at most two seconds during continuous typing.
  Sending flushes immediately; exit, SIGINT, SIGTERM and uncaught errors flush.
  Unique temporary files, fsync and rename protect the previous complete draft.
  New POSIX files use 0600 and directories 0700. Recognized secrets use the
  existing importer redaction rules. A dim note identifies restored input.

## Test receipts

All model requests in these checks used scripted or loopback fixture transports.
The supplemental runner is `node test/followups-receipts.mjs`, exit 0, with
machine-readable detail in the local `checks-steer/receipts.json`.

| Command | Exit | Count |
|---|---:|---|
| `node test/run.mjs followups terminal "every feature has"` | 0 | 208/208 checks, 20 suites |
| `node test/run.mjs "import: the /import command" golden followups` | 0 | 42/42 checks, 6 suites |
| `node test/install-sandbox.mjs` | 0 | 30/30 checks |
| `node --test test/*.test.mjs` (all ten files, expanded by the runner) | 0 | 87/87 tests, 0 skipped |
| `node test/evolution-search-functional.mjs` | 0 | 3/3 scenario groups |
| `node test/evolution-search-adversarial.mjs` | 0 | 3/3 scenario groups |
| `node test/evolution-controller-functional.mjs` | 0 | 1/1 scenario group |
| `node test/evolution-controller-adversarial.mjs` | 0 | 1/1 scenario group |
| `node test/codex-native-flow.mjs` | 0 | 4/4 scenarios |
| `node test/native-media-check.mjs` | 0 | 8/8 checks |
| `node test/native-media-check.mjs --plain` | 0 | 8/8 checks |
| `node test/native-terminal-usability-check.mjs` | 0 | 8/8 checks |
| `node test/terminal-default-check.mjs` | 0 | 7/7 checks |
| `node test/native-account-resume-check.mjs` | 0 | 2/2 native entry points |
| `npm test` (first run) | 1 | 3400/3402 checks, 437 suites |
| `ATLIAS_TEST_TRACE=1 npm test` (fresh final run) | PENDING | See `checks-final-full.log` and `checks-final-full.exit` |

`harness_verify` parsed all twelve then-changed JavaScript files successfully.
The thirteen final runtime/test files (including the reviewed source-pin test)
have SHA-256 receipts in `checks-source-hashes.json`; the last comparison found
zero changes. The full safe runner also runs five Node test files after its
main suite; its final exit and Node test count are pending.

The first full run loaded an earlier agent module before the later batch-error
recovery assertion was added, and failed that assertion. Its other failure was
the loop-source review gate. The reviewed loop is now pinned to implementation
commit `c54f780`; eval/h2h retain the frozen 25f0280 pin, and golden requests
continue to enforce the benchmark baseline. The fresh run began after runtime
source freeze; the review-pin test was updated before that suite was imported.

The standalone terminal-default check initially exited 1 after six checks:
its mutation fixture omitted the existing edition.mjs dependency. Adding that
fixture dependency preserves its actual assertion; rerun passes 7/7.

Pass 1 covered request order, source results, queue editing, settings, side
questions, byte-identical sessions, atomic writes, signal/error flush, and a
killed isolated typing process restored at next start. Pass 2 re-read the
changed code and caught batch recovery and small-viewport paging edges. Tests
reject planted missing late-steer recovery and missing draft redaction; the
standalone default mutation is also caught. No live model suite or benchmark
was run, as Gev prohibited model calls.

## Limits and pending verification

No live model/provider behavior or token/solve benefit was measured. POSIX
permissions and OS signal delivery were not exercised on this Windows host.
Draft persistence uses synchronous small atomic writes and the latest writer
wins if two terminals use the same project. SIGKILL recovery covers completed
debounced writes; input since the last save can be lost. No in-flight message
dispatch journal or draft attachment copies were added. Recognized secrets
restore as redacted text; unrecognized secrets remain local plaintext.

Corrupt-draft quarantine, automatic rename retries, attachment copies and
multiple-writer locking from the broader research proposal were not added.

The Max app still needs its caller to pass the steer source, consume the
structured result, and call agent.btw without its normal save/distil wrapper.
Its source and vendored harness were intentionally not changed.

## Handoff at the usage boundary

The shared window reached 89% before the fresh full suite finished. Gev's
cutoff rule takes precedence. Implementation is `c54f780`; source-pin review
is `2d3740e`. Collect the final run's exit/counts, fix any remaining failure,
replace its PENDING row above, and commit the final receipt locally. This is
not a claim that the requested full-suite verification is complete.

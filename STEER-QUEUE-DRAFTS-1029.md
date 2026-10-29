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

## Validation checkpoint

- Functional subset: `node test/run.mjs followups terminal "every feature has"`,
  exit 0, 207/207 checks across 20 suites before the final small-viewport check.
- Follow-up adversarial subset: exit 0, 29/29 before later callback-recovery
  and redaction mutation assertions. Final counts will replace these checkpoints.
- `harness_verify`: exit-equivalent success, 11 files parsed at its checkpoint.
- Supplemental suites completed: sandbox install 30/30; all Node test files
  87/87, zero skips; evolution search functional/adversarial 3/3 scenario groups
  each; controller functional/adversarial 1/1 group each; Codex native flow 4/4;
  native media normal/plain 8/8 each; native terminal usability 8/8; account
  resume 2/2 native entry-point cases. All exited 0.
- Terminal-default standalone initially exited 1 after six passing checks:
  its existing mutation fixture omitted edition.mjs. The fixture now copies
  that dependency; rerun exited 0, 7/7, including the caught default mutation.
- Full `npm test` is still running at this checkpoint. This file is not yet
  a completed full-suite receipt.

## Limits and pending verification

No live model/provider behavior or token/solve benefit was measured. POSIX
permissions and OS signal delivery were not exercised on this Windows host.
Draft persistence uses synchronous small atomic writes and the latest writer
wins if two terminals use the same project. SIGKILL recovery covers completed
debounced writes; input since the last save can be lost. No in-flight message
dispatch journal or draft attachment copies were added. Recognized secrets
restore as redacted text; unrecognized secrets remain local plaintext.

The Max app still needs its caller to pass the steer source, consume the
structured result, and call agent.btw without its normal save/distil wrapper.
Its source and vendored harness were intentionally not changed.

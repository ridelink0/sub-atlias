# OpenCode v2 runtime receipts (Claude, 2026-10-09)

Pinned upstream: anomalyco/opencode d2905b8ddae8b0353cd2166d68d59795397921db (2.0.26, bun@1.4.2).

## Run 1: functional and adversarial suites, no inference
- Command: `node test/opencode-runtime-suites.mjs` (Node v22.21.0, Windows 11)
- Exit code: 0. Result: 64 passed, 0 failed.
  - functional: ledger discovery/translation/ledger line 18; runtime profile/config/isolation/CLI events 12; orchestrated run with a stand-in CLI 6.
  - adversarial: ledger refusals/failures/unknown counters 20; runtime guards 8.
- Fake Ollama and fake CLI only: no model loaded, no GPU use, loopback only. Evolve owner 41764 untouched.

## Source hashes (sha256)
```
f1a59bafa0f62f54b2365a605c0b82c2a974f4e0721890b5eec9bb56aa67a8c4 *lib/opencode-provider-ledger.mjs
32415f089dbb4b280ba6318b0149d402785d9033501623dd3159be9438c1db39 *lib/opencode-runtime.mjs
5bf0727a433e174eb2f09a41be90e16f57755d0bbba41dc09ef1958f835b171f *test/opencode-runtime-suites.mjs
```

## Not yet proven
- No pinned OpenCode process has run: dependencies are not installed (verifySource reports it).
- No inference: real 8k/16k runs wait for EVOLVE-GPU.lock to be released.
- Independent adversarial re-read of the three files is still pending.
- No 20x token or peak-context claim exists.

## Corrections, 2026-10-09 evening (Codex adversarial findings)

Checked by `node test/opencode-runtime-suites.mjs`: 88 passed, 0 failed, exit 0, Node v22, no inference, no GPU.

- Unknown stays unknown. Every call sent to the model server without valid counters (HTTP 500 or any non-200, overflow, streamed error, malformed stream line, abort before or after headers, connection error, crash between sending and recording) is `unknown`. Only a call refused before it was sent (`dispatched: false`) is a known zero. `total`, `input` and `output` are null unless every sent call was counted; `countedTotal` is the lower bound; `unknownInputLowerBound` adds overflow-reported prompt sizes. A record that does not say `dispatched: false` is treated as sent.
- Counters must be whole non-negative numbers, checked when Ollama answers and again in `summarize()` for records read back from disk, and in `parseRunEvents()` for CLI steps. Invalid is counted apart from missing; neither is ever zero, and an invalid CLI step cannot reconcile.
- Append before dispatch: a `dispatch-intent` line is written and fsynced before the upstream request is sent; if it cannot be written the call is refused. `summarize(readLedgerFile(file))` turns an intent without its answer line into an `interrupted` call of unknown cost; malformed lines make the totals incomplete. The run's receipt uses the file summary.
- Bounded buffers: a stream line over 8 MiB or an answer over 64 Mi characters fails the call (`malformed-stream`, `response-too-large`) with the limit recorded; CLI stdout over 64 MiB sets `stdoutTruncated` and the run cannot complete.
- GPU ownership: `acquireGpuLease()` takes an exclusive O_EXCL lease (`OPENCODE-GPU.lease` at the work root, never EVOLVE-GPU.lock). A dead owner's lease is moved aside, not deleted; an unreadable fresh lease is not taken. The original owner (EVOLVE-GPU.lock and HEARTBEAT.json), the run's own lease and the RAM floor are rechecked by the ledger's `beforeDispatch` gate before every inference call, and a gate that throws refuses.
- Cancellation never uses a PID. The ledger is held and in-flight calls aborted first, then the child is ended through the handle Node opened at spawn (`ChildProcess.kill`, libuv TerminateProcess on that handle). Measured on Windows: a non-detached Node grandchild ends with its parent through libuv's kill-on-close job; whether bun's own children do is UNVERIFIED. After every run `surveyDescendants()` (read-only CIM listing, creation time after the spawn) reports anything still running; it is never ended, and the run is `left-processes-running`, not completed.
- Source identity: git HEAD must be the pinned commit, HEAD^{tree} must equal the tree the GitHub API reports for it (ec2dbc32beca9b7da380eb5105e1af6e40f64ebd, fetched independently), no tracked file may differ, and bun.lock must hash to the pinned value. A self-written PIN.json is no longer accepted. Dependency manifest versions are recorded.
- Status: process exit, output parsing, isolation, inference, accounting and leftover processes are separate `receipt.verdicts`. `completed` needs exit 0, parsed events without errors, no egress, an unchanged global profile, at least one answered call, complete accounting reconciled with the CLI and no leftover process; it still does not judge the task. `held-boot` marks a hold run.
- Not proved here: actual pinned CLI boot, real SSE from OpenCode, compaction/child/title accounting against the real CLI, installed Ollama enforcement of truncate:false/shift:false (static source support only), bun child cleanup. Those need the pinned boot with inference held, then a real run after a clean GPU boundary.

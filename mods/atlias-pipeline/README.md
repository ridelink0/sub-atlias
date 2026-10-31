# atlias-pipeline

Default-off collectors for the local planner and reporter. The mod makes no model call, opens no connection and runs no process. It records what the local pipeline needs, and every event it does not change goes on through `next(e)` untouched.

```bash
claude --plugin-dir /path/to/atlias/mods/atlias-pipeline
```

Every option is off unless it is exactly `true`. With the master switch `enabled` off, nothing is registered at all.

| Option | Needs | What it does |
|---|---|---|
| `enabled` | none | Master switch. Off registers no handler. |
| `collectAuthority` | `enabled` | Records the exact text of each of the person's own prompts (`prompt.submit`, origin `composer`, `bridge` or `sdk`). The first is the original, later ones follow-ups, in order, repeats kept. Records each selected skill's exact name and text (`skill.prompt`). Stored in `$.store` under `atlias-pipeline.session` and kept in process. |
| `collectReceipts` | `enabled` and `collectAuthority` | After a `Bash` or `PowerShell` call completes, records a check receipt. Its status is `pass` (exit 0) or `fail` (other exit) only when the native result carries a numeric `exitCode`. Otherwise it is `unknown`. Stdout text is never exit evidence. Each `Edit`, `Write`, `MultiEdit` or `NotebookEdit` that completes without a refusal advances a scope version, so an older receipt is stale. |
| `evidenceRecordStyle` | `enabled` | Adds one constant block, named `atlias-evidence-style`, to the first message's context (`prompt.context`). It asks the model to end each reply with the shortest complete evidence record and minimal narration. The text is byte-stable. Nothing else in the context is changed or removed. |

## What it stores

The packet and the receipts are built with the shared `contract.mjs` (`createPacket`, `createReceipt`), so the format is the one the local planner and reporter read. Receipts are bound to the packet's id and scope version. The packet id hashes the scope version, so after an edit an earlier receipt reads `unknown:stale_packet` when the reporter checks it (the contract's `stale_scope` reason is then never reached). A receipt from a subagent (`agentId` present on `tool.call`) reads `unknown:wrong_actor`.

A check keeps the packet and scope from its invocation. A pending-write scope makes earlier passes stale before an edit can have effects. If an edit was pending when a check started, starts while it runs, or is still pending when it finishes, its numeric result is not evidence for a pass or failure. A new check after all edits complete can count again. A refused edit restores the earlier completed scope. Native tool results, refusals and errors still pass through unchanged.

## Limits, read before turning anything on

- **Exit codes are not in the declared native results.** The type declarations this repo has (`D:/harness-work/research/claude-code-mods-types-2.1.277.d.ts`, lines 12921 to 12928 for `Bash` and 13097 to 13102 for `PowerShell`) list `stdout`, `stderr`, `interrupted` and related fields, and no `exitCode`. So on those declarations every shell receipt is `unknown:missing_exit_code`, and no pass can be recorded. The mod takes a numeric `exitCode` when a build provides one. The 2.1.300 declarations were not generated for this review, so whether 2.1.300 provides one is unverified.
- **A pass is an exit code, not a verdict.** A `pass` means the command exited 0. It does not show that the command was the right check. The reporter has to cite the command.
- **Edits are counted by completion, not by success.** Any completed edit that is not a refusal advances the scope, and so does a call that throws. An edit that failed may still have written a file, so the rule is deliberately wider than "succeeded".
- **Non-user prompts are not authority.** A `prompt.submit` with origin `task-notification`, `peer`, `scheduled-trigger`, `channel` or any other kind is not recorded. The origin field is typed (`PromptSubmitInput.origin`, types line 7259).
- **The text is as it reaches this hook.** An earlier hook may already have rewritten a prompt. This mod records what it receives.
- **Skills have no agent field.** `skill.prompt` carries only `skill` and `text`, so a skill preloaded into a subagent is recorded with the session's skills.
- **The store copy is best effort, and recovery fails closed.** The store refuses a record over 4 MiB (types line 2885). When the full record cannot be saved, the mod writes a small `{ sessionId, broken: true }` marker instead. A valid digest proves a stored record was not altered, not that every prompt reached it: the save and the marker can both fail, leaving an older complete-looking copy (Codex review 1015, finding 2). Prompt equality is not enough either: a selected skill or an edit can be observed while both writes fail, and a process can stop between an event and its save, so a transcript-confirmed record could still lack a skill or keep a check from before an edit as a pass (Codex review of 91d3e55, cases 2 and 3). So the first event of a process (a restart, or a resumed session) never extends an earlier record for its session: it marks the session broken, and the session records nothing more while every prompt still passes through. It starts a new record only when there is none and `$.session.messages()` shows no earlier prompt, with the prompt being submitted allowed. Tool-result rows are skipped. A transcript that cannot be read whole (an error, a user row without text, a page of 4096 entries, which is all a long transcript answers) fails closed: the session is marked broken and records nothing more. Any other user row, such as a task notification, a skill expansion or text the host stored differently, also fails closed until a live session shows how the host stores it. A record that cannot be verified is treated the same way. The in-process ledger is the authority while the process runs.
- **No session id, no record.** When `$.session.id()` fails or answers anything but a nonempty string, nothing is recorded, and every session the process sees later is marked broken, since it may have missed that event (Codex review 1015, finding 1). There is no fallback name.
- **The evidence style is a request, not a control.** The primary model may ignore it. The block is added once per conversation, so it stays in the cached prefix until `$.ui.invalidate("prompt.context")` or a compaction or clear recomputes the context (types line 3443 onwards).
- **Hiding output saves nothing by itself.** Native UI hiding saves zero generated tokens, and `turn.complete` cannot undo generation (handoff item 2, CLAUDE-SUBHARNESS-HANDOFF-1015.md). This mod does not use `turn.complete`. The only lever on generated output here is the instruction in `evidenceRecordStyle`, and its saving is unmeasured.
- **Writes are whole-record.** Each change rewrites the stored record, including every skill body and prompt. That is simple and correct, and it costs more for a long session with large skills.

## Calls used

Only these, each read from the type declarations or the research notes:

- events: `prompt.submit`, `skill.prompt`, `tool.call`, `prompt.context`
- `$.session.id()` (types line 2382), `$.session.messages()` (types line 2357), `$.store.get` and `$.store.set` (types lines 2879 and 2887)

No `$.model.complete`, no `$.model.fork`, no `$.http`, no dynamic `$[x]` lookup. The test in `test/pipeline-mod-suites.mjs` reads `register.mjs` and fails on any other call.

## Status

- Deterministic tests only: `node test/run.mjs "pipeline mod"`. No live Claude Code session has been run with it, so nothing here is measured in a session.
- `claude plugin validate --strict` passes on Claude Code 2.1.300 (exit 0), with advisory notes that do not change the verdict.
- Mods are an early-access surface that Anthropic says may change between releases. Re-read the generated declarations for each build before relying on a field.

Research: RESEARCH-FIRST section 9 (the claude_mods contract); `C:/Users/OWNER/research_notes/Atlias native cost replacement/local-pipeline.md` (exact authority, no `$.model.complete`, receipts from numeric exit codes); `claude300.md` findings 3 and 4 (tool events, and checking `$.tool.list()` rather than inferring from names); `D:/harness-work/research/claude-code-mods-2026-10-12.md` section 3 (a mod that throws is skipped; a changed prefix costs cache).

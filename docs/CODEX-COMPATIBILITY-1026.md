# Codex sub-atlias compatibility, October 26

The Codex desktop build tested here supplies `Bash` PostToolUse payloads with
plain stdout and no process exit code. Its native JSONL execution journal has
the missing result in a typed `event_msg` / `item_completed` /
`CommandExecution` record. The journal item id matches the hook's tool-use id.
The application package inspected was `OpenAI.Codex_26.1021.3705.0`.

The gate now correlates the exact thread, turn and execution id. An explicit
terminal exit 0 can resolve a hook's unknown result. Nonzero exits, failed
hooks, conflicting identities, missing statuses, pending processes and checks
that began before the last edit remain failures or unknowns. Printed JSON and
an outer `functions.exec` completion do not establish a subprocess result.

Native results are retained during PostToolUse and recovered at Stop. This
keeps completed evidence when a long session moves it beyond the bounded
journal tail. Native edits and later filesystem modification times establish
edit barriers, including shell writes that have no edit hook. Already recorded
failures survive a trimmed journal. Partial MCP syntax verification does not
become a pass.

Codex's typed user and final assistant messages now enter Dream's session
digest. Commentary and tool output do not become a final answer or a user
request. The compaction audit reads the actual `compacted` replacement history,
excluding function-call outputs. Existing Claude transcript handling stays in
place. PowerShell and shell stdin assertion programs are recognized as checks.

Host installation recognizes Atlias's managed hook marker or dispatcher path.
An unrelated hook stored under an Atlias project path is preserved. Repeated
installation and removal are tested for ownership and idempotence.

Automatic project-check discovery inspects explicit editor launches in the
selected scripts, npm lifecycle scripts and referenced local scripts. It does
not select a detected VS Code launch or a path that exceeds its inspection
bound. The check remains due. This is static discovery, not a sandbox for
arbitrary project code. Doctor uses headless process/file/protocol checks.

## Verification

`node test/run.mjs Codex` exercises protocol-shaped fixtures and actual hook
processes. `node test/codex-native-flow.mjs` runs real passing and failing Node
programs and checks the successful, failed, pending and edit-after-check paths.
Actual-line mutants plant broken exit-code, turn-identity, edit-ordering and
pending-command handling; the same contracts must detect every mutation.

`npm test` includes the broader regression suite and worker-routing checks.
With `ATLIAS_TEST_NO_PID_KILL=1`, PID-directed process-termination cases are
explicit skips and are never counted as passes. Local receipts under
`reports/codex-compat-1026` contain actual exit codes and real native journal
acceptance. Host configuration backups and full user transcripts remain local.

Research basis: Atlias-work RESEARCH-FIRST 0g and H3/H4/H5 require a fixed
comparison and truthful failed, stopped and unknown outcomes. The primary
evidence for this repair is the observed native hook payload and matching
execution journal, rather than assumptions about Claude's protocol.

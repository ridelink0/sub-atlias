# Atlias subharness goal checkpoint for Gev

## Current objective

Fix Atlias as a real native Claude Code subharness using mods and the two pipeline
reports, benchmark clean base Claude Code against the same client plus Atlias on
the same local model/tasks, then do base Codex against Codex plus Atlias. The target
is 20x lower total input plus output AND full native peak context, with the same
or better taskwise required outputs and capabilities. This goal is NOT complete.
Protocol/character results are not inference savings. No paid credits or pushes.

Gev is offline and authorizes necessary Atlias work, unattended Claude auto/bypass
mode and Usage Limits relays if useful. Choose recommended decisions without
questions. Give the natural-reset estimate ONLY ONCE at final completion.

## Workspace and ownership

- Isolated branch: codex/subharness-1012, D:/harness-work/atlias-subharness-1012.
- Base: main f6b6048. Live C:/Users/OWNER/atlias has other ownership changes in
  lib/logo.mjs and site JSON; do not touch them or live hashed source during runs.
- Read D:/harness-work/atlias-evolve/RESEARCH-FIRST.md fully and top WORK-PLAN.md,
  then the atlias-work skill and status.sh via D:/Git/bin/bash.exe.
- The current Ultimate gate owns LOCAL-ROLE.lock and is running HumanEvalFix
  Python. The evolution controller waits for it. No live gate or lock was changed.
  Its gate-specific STOP supports ending after the current corpus; never put STOP
  into the running evolve folder or terminate by PID. Coordinate GPU access at
  a boundary, preserve every existing receipt, and resume outstanding gate work.

## Completed research

Read both earlier reports fully: C:/Users/OWNER/reports/Atlias token efficient
pipelines.md and CLAUDE MODS dual model pipeline.md. Query_graph and search_text
checked latest Claude work. New notes are research_notes/Atlias subharness
efficiency upgrade/{claude_mods,codex,pipelines}.md. The completed report at
C:/Users/OWNER/reports/Atlias subharness efficiency upgrade.md was read in full
and reviewed for evidence boundaries. It contains recommendations, not model
savings claims. Do not repeat the research.

## Implemented, experimental and not shipped

1. mods/atlias-efficiency: default-off userConfig.enabled, legal tool.describe
   deferral for a known built-in allowlist, only with ENABLE_TOOL_SEARCH=true.
   Full descriptions/contracts unchanged; unknown/core/MCP placement unchanged.
   Native Claude 2.1.296 strict validation passes. Custom endpoint tool-reference
   and actual discovery/execution still need live qualification.
2. flags.authorityLedger, default off: complete instruction-file contents and
   exact earlier requests in chronological order during /compact. Long/middle
   amendments and repeated request occurrences survive. Avoid obsolete clipped
   pinRules fragments in exact mode. Complete authority can exceed a small model
   window; report exhaustion rather than silently discarding instructions.
3. tools/h2h/owned_process.py replaces the base runner's Windows taskkill/PID
   termination with owned suspended processes and Job Object handles. Existing
   mini_swe_runner is not changed. Native no-model self-test including timeouts
   passed 28/28. Base runner releases its job at every exit.
4. Provider accounting rejects negative/bool token counts, exposes unknown peak
   when usage is incomplete, records peakContext separately from peakPrompt and
   nativeCompleted separately from grader pass, and preserves unknown attempts
   on resume. Four accounting edge assertions pass. More adversarial coverage
   and exact raw cache/category/source provenance are still required.

## Verified receipts

- node --check on core/settings/loop/new mod/new test passed.
- Python py_compile for owned_process/base runner/probe/adversarial script passed.
- git diff --check passed.
- Focused functional suites: 9/9 (five authority, four mod placement).
- Second pass: all four planted mutations caught, sources restored, 9/9 rerun.
  Receipt: test/subharness-adversarial-receipt.json.
- Native recording probes, no inference: probe-base and probe-efficiency under
  D:/harness-work/atlias-subharness-runs-1012, both exit 0, original request exact.
  Base first request 68,684 JSON characters; mod first request 25,368 characters.
  Those figures are NOT token savings or quality proof. Deferral placeholder was
  observed, but retrieval/dispatch through ToolSearch was not exercised yet.
- Full repository suite rerun by Claude to a persistent log at 15348a6:
  1294/1294 across 197 suites, exit 0, 20:38:38Z to 20:45:29Z
  (claude-continuation/full-suite-20261012T203837Z.log). The earlier single
  failure did not reproduce and its detail was lost; treat it as an unexplained
  one-off, not as a known pass.
- ToolSearch qualification, recording stand-in, no inference, Claude 2.1.296
  (tools/h2h/toolsearch_probe.py; runs toolsearch-probe-1 before the fix,
  toolsearch-probe-2 after). Four arms: base, off (mod loaded, switch off),
  ts (ENABLE_TOOL_SEARCH=true alone), on (mod on plus ENABLE_TOOL_SEARCH).
  - Every request in every arm carried the exact original request, the project
    CLAUDE.md and the body of an explicitly invoked project skill.
  - off equals base byte for byte on every request once the session id and the
    arm's own folder are taken out; tool arrays identical.
  - ts and on: ToolSearch answers with tool_reference blocks; the next request
    carries the selected tools' full definitions with defer_loading:true, each
    identical to the base arm's apart from that flag; the found Grep really ran
    ("Found 1 file notes	arget.txt").
  - BUG FOUND AND FIXED: the mod's eight extra deferrals (Agent, Glob, Grep,
    ListAgents, ReportFindings, ScheduleWakeup, Skill, Workflow) were absent
    from the engine's deferred listing and from the tool array, so a model could
    not see them at all. The mod now appends their names after ToolSearch's whole
    original text. Probe 2: nothing hidden, ToolSearch original text kept.
  - First-request characters (not tokens): base 74,818, ts 55,094, on 31,474.
  - NOT QUALIFIED for the local benchmark: the client needs the endpoint to
    accept tool_reference blocks and defer_loading. A no-load shape check on
    Ollama 0.35.1 (nonexistent model name) is inconclusive: every shape,
    including an invented block type, returned 404 before parsing
    (ollama-shape-probe/result.json). Needs one real request at a GPU boundary.
- Planted breaks: 6/6 caught (two new: moved tools not named; note replacing
  ToolSearch text); focused suites 11/11; strict plugin validation passes.

## Next steps, in order

1. Capture the full-suite failure in a persistent log; fix genuine failures and
   rerun affected checks. Report reviewed. Initial verified changes committed
   locally as ee7db19; no live merge or push.
2. Add native recording tests of ToolSearch selection followed by actual tool
   dispatch and exact restored schema; compare mod OFF byte behavior and include
   required project/skill instructions. Test raw prompt preservation at every
   step, not merely first-request discovery metadata.
3. Complete the benchmark accounting/provenance: raw request/response usage,
   disjoint cache categories, retries/failures/unknowns, client+source hashes,
   prompt/task+grader hashes, exact loaded context on every task. Resume must not
   replace unknown original costs. A partial peak must never qualify a ratio.
4. Borrow the GPU safely at a boundary. Qualify sufficient model window for BOTH
   native arms without front truncation. Claude's clean opening needs >=32k;
   Codex/Ollama recommends >=64k, to be measured on this PC. Do not change the
   live gate's server context midway. Use private profiles/server settings and
   measured RAM/VRAM. No simultaneous inference with existing gate/controller.
5. Run paired fresh Claude smoke tasks first, then a preregistered repeated screen
   and confirmation with hidden protected graders, identical tasks/model/window/
   sampling/budgets. Plain is ordinary native print mode, NOT --bare. Atlias arm
   loads the full Atlias plugin plus optional mod. Keep failures/unfavorable rows.
6. Immediately implement the corresponding Codex arm. Bundled binary exists at
   C:/Users/OWNER/AppData/Local/OpenAI/Codex/bin/2e5e00daee91c61d/codex.exe,
   0.162.0-alpha.17.2; do not install another CLI unnecessarily. It requires a
   metered /v1/responses path (existing door only handles chat/messages). First
   probe direct Ollama Responses compatibility. Preserve complete function and
   custom/freeform tool items, call IDs, terminal SSE items and usage; support
   namespaces only if actually present. No unsupported hook output rewrite.
   Use task-local CODEX_HOME, custom provider ID, --ignore-user-config/--ignore-rules,
   supported output/catalog/compaction controls, full task/project/skill authority.
7. Compare taskwise outputs, native completion, total tokens per solve and full
   peak context with all costs, repeats and honest uncertainty. Iterate research-
   backed components. Do not mark the 20x goal complete without both host proofs.
8. After release qualification, coordinate shipping at a controller boundary,
   preserve historical pins, complete remaining gate work, and keep benchmarks
   and docs factual. Never push without a newer explicit instruction overriding
   the current atlias-work rule.

## Usage continuation

Last measured reset: 1791844021 = October 12, 2026 17:27:01 America/Chicago.
One-shot heartbeat atlias-subharness-reset-continuation targets this current chat
01a131b1-6ec1-7673-aaea-4722defad1e4 at 17:37:01, reset plus ten minutes.
Saved automation.toml read back: BYHOUR=17, BYMINUTE=37, BYSECOND=1; verified.
Existing daily 21:20 continuation belongs to an older chat and was left alone.
Remove the one-shot after it runs. Read fresh usage before continuing; schedule
another continuation only at measured reset plus 5-10 minutes if necessary.

## Authorized Claude continuation ownership

Gev explicitly authorized Claude bypass/auto runs and Usage Limits relays.
A headless Claude continuation is being launched from this isolated worktree,
with logs and the exact continuation prompt in
D:/harness-work/atlias-subharness-runs-1012/claude-continuation/.
Codex must inspect its run-state.json and recent stream log before editing on
the reset wake. While Claude is active, do not make concurrent source edits or
launch competing GPU inference; coordinate by the handoff/status files. Claude
owns completing the pending full-suite failure diagnosis, native protocol/
accounting, local qualification and paired Claude then Codex trials. The old
suite is finished, so new edits are safe within this isolated worktree.

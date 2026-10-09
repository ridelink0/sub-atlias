# Gev's OpenCode v2 migration research

The migration should use pinned OpenCode v2 as the local agent runtime and retain Atlias's shared memory, verification and execution feedback around it. This is an architectural decision; research does not establish that stock OpenCode outperforms stock nanobot on Gev's Qwen models.

Research fetched October9,2026. Pin: `d2905b8ddae8b0353cd2166d68d59795397921db`, version2.0.26, Bun1.4.2. Existing1.18.32 executable and cached dev checkout are different runtimes. The pinned source and checksum-verified portable Bun are now staged in the migration directory. Actual integration and local-model execution remain separate gates.

## What the evidence supports

V2 has typed packages for schema, core, protocol, server and client; its client is `@opencode/client`, with Promise and Effect entrypoints. Its headless CLI supports JSON events, standalone private services, sessions and forks. Use this pinned API identity; legacy SDK examples and mutable branch caches mixed incompatible versions during research. [Root manifest](https://github.com/anomalyco/opencode/blob/d2905b8ddae8b0353cd2166d68d59795397921db/package.json), [client](https://github.com/anomalyco/opencode/blob/d2905b8ddae8b0353cd2166d68d59795397921db/packages/client/README.md), [CLI contracts](https://github.com/anomalyco/opencode/blob/d2905b8ddae8b0353cd2166d68d59795397921db/packages/cli/src/commands/commands.ts).

V2 exposes durable prompt admission and location-scoped tool access. This helps separate controllers and tools, but does not prove exactly-once side effects or automatic provider replay after a crash. Recovery tests must distinguish accepted prompts, partially performed actions and committed receipts. [Execution implementation](https://github.com/anomalyco/opencode/blob/d2905b8ddae8b0353cd2166d68d59795397921db/packages/core/src/session/execution.ts).

The HELIX comparison records46/55 versus44/55 using recomposed components, MiniMax M2.7 highspeed and two attempts. It supports investigating typed components and deterministic conformance tests. It does not establish a stock OpenCode versus nanobot comparison or local Qwen superiority. Keep baseline/runtime/model/task/attempt identities separate. [HELIX paper, sections5.3–5.4 and Table5](https://arxiv.org/html/2608.13951v1).

## Changes for local models

Use the existing private Ollama11435 endpoint explicitly. Default discovery11434 can select the wrong service. Configure actual installed model identities, declared context/output limits and tool capabilities; provider declarations do not prove actual Ollama allocation. Capture the runtime's effective context and actual provider requests. Disable model-catalog fetches, warming, updates, sharing and cloud credentials for this local experiment. [Ollama discovery](https://github.com/anomalyco/opencode/blob/d2905b8ddae8b0353cd2166d68d59795397921db/packages/core/src/plugin/provider/ollama.ts), [provider schema](https://github.com/anomalyco/opencode/blob/d2905b8ddae8b0353cd2166d68d59795397921db/packages/schema/src/config/provider.ts).

Give each standalone run private XDG data/cache/config/state and temporary roots. Disable ancestor project-config discovery, clear inherited explicit-config paths and set a private service home. Config content is an overlay, so it alone does not isolate Gev's existing profiles. Preserve required project instructions explicitly when disabling discovery. Validate Windows behavior by execution. [Config discovery](https://github.com/anomalyco/opencode/blob/d2905b8ddae8b0353cd2166d68d59795397921db/packages/core/src/config/discovery.ts), [global roots](https://github.com/anomalyco/opencode/blob/d2905b8ddae8b0353cd2166d68d59795397921db/packages/util/src/global-roots.ts).

Set explicit bounded compaction values. Current V2 documentation says keep8000/buffer20000, but this exact source pin defaults keep15000 and a derived buffer. The source governs this experiment. Either default can be inappropriate for an8k/16k local context. Test instruction retention, error counterexamples and lost tool evidence alongside token changes. [Pinned compaction](https://github.com/anomalyco/opencode/blob/d2905b8ddae8b0353cd2166d68d59795397921db/packages/core/src/session/compaction.ts), [current documentation](https://dev.opencode.ai/v2/docs/compaction/).

CLI step-finish events contain input/output/reasoning/cache usage, but normal output selects the primary session and does not emit full peak context. Summing those events cannot establish complete child/compaction accounting. Use a recording local provider boundary, preserve unsuccessful calls and distinguish full native prompt counts from estimates. Missing usage stays unknown. [JSON event implementation](https://github.com/anomalyco/opencode/blob/d2905b8ddae8b0353cd2166d68d59795397921db/packages/cli/src/run/noninteractive.ts), [token schema](https://github.com/anomalyco/opencode/blob/d2905b8ddae8b0353cd2166d68d59795397921db/packages/schema/src/token-usage.ts).

## Direction without an AI judge

Use executable constraints and failure counterexamples as the oracle. Separate target failures, regressions, invalid transport/edit operations, integrity failures and missing accounting. The model proposes a scoped change; protected checks decide whether it works. Property-based state-machine tests can generate replayable seeded counterexamples and shrink them. They guide engineering without awarding quality by model vote. [fast-check model testing](https://fast-check.dev/docs/advanced/model-based-testing/), [Node test events](https://nodejs.org/api/test.html).

The implemented oracle refuses leaked holdout traces, copied run provenance, missing counters, impossible goal ratios and self-awarded proof. It supplies the next observed failure class and preserves separate20x total-token/full-peak targets. Its software fixtures do not prove model improvement. The local evolution loop must keep a disjoint sealed confirmation set and continue after any goal is reached.

## Ultimate Benchmark and statistics

The35-suite ledger maps existing coding corpora and active native capability, workflow, factuality, allowance, recovery, reboot, power/network-loss and useful-days requirements. Historical250 and current252 task sets stay separate. Seven local corpora are data-ready; data readiness is not an executed benchmark pass. Refactor grading is AST structure, not behavioral correctness.

Added suites include SWE-bench Verified, Terminal-Bench, IFEval and HarnessBench. Their dependencies, licensing, task versions and graders must be pinned before execution. HarnessBench and factuality suites have mixed/model grading; keep them outside deterministic promotion claims. Do not fabricate a universal aggregate from incompatible scores. [SWE-bench evaluation](https://www.swebench.com/SWE-bench/guides/evaluation/), [Terminal-Bench](https://www.tbench.ai/), [IFEval source](https://github.com/google-research/google-research/tree/master/instruction_following_eval).

Report solves, failed attempts, input-plus-output totals, full native peak, elapsed time, context/resource failures, missing counters, paired disagreements and uncertainty. Wilson intervals describe this task set. Exact paired tests require matched tasks and independent run provenance. Repeated adaptive search invalidates naive universal inference; a holdout is necessary but not a complete reusable-holdout guarantee. [Reusable holdout research](https://research.google/pubs/the-reusable-holdout-preserving-validity-in-adaptive-data-analysis/).

The original Qwen3.5 9B stage achieved44/60 against champion10/60, with34 gains and no losses. This remains original-stage evidence from the earlier runtime, not an OpenCode result, native20x proof or permission to replay/regrade old runs. Production46 unknownHTTP500 and47–49 failures remain preserved; V30 production49 remains held.

## Evidence limits and execution order

First verify pinned runtime and isolated local transport without inference. Then acquire exclusive GPU ownership at a cooperative stage boundary, preserving original results. Execute fresh paired local tasks, main confirmation and sealed holdout; run an independent functional pass and a separate adversarial hunt. Only real native Codex/Claude evidence can establish capability noninferiority, full-context and subscription-causality claims. Useful days, reboot and power-loss claims need actual observations.

This research reused the existing local redesign and11 specialist source-evidence scrapers, with3 independent central-claim verifiers. Native typed/Sonnet research agents were unavailable; the installed collaboration tool ran the exact role/file contracts on Codex instead. Source paths support codebase observations; hardware and execution claims require receipts. No benchmark superiority, model capability or20x claim was inferred from a fixture.

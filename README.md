![Atlias](assets/atlias-logo.svg)

# Atlias

Gev's harness for local agents and shared verification inside coding hosts. OpenCode v2 is the new standalone runtime target; the migration is in progress. Executed checks give agents direction, and agents keep working after a goal is reached.

[Agent status](https://atlias.vercel.app) | [OpenCode research](docs/OPENCODE-V2-RESEARCH.md) | [Ultimate Benchmark](docs/ULTIMATE-BENCHMARK.md)

## Build. Check. Improve.

Atlias shares project memory, context and recovery notes across hosts. Its verification gate checks what actually ran before accepting a completion claim. Local improvement uses executable task checks and failure counterexamples rather than a model voting on its own output.

The migration pins OpenCode2.0.26 at `d2905b8ddae8b0353cd2166d68d59795397921db` and Bun1.4.2. Existing1.x executables are different runtimes. Actual integration and local-model execution have separate gates; this README does not claim they have passed.

## Ultimate Benchmark

One35-suite ledger covers coding, tools, security, context, workflows, factuality, subscription allowance, recovery and useful unattended work. Every suite retains its actual grading contract. Unavailable suites and unknown costs stay visible.

From this checkout:

```powershell
node tools/ultimate.mjs inspect --corpus-root C:/Users/OWNER/atlias
node tools/ultimate.mjs check
node test/run.mjs "Ultimate execution contracts" "every feature has a test"
```

The oracle keeps total native input plus output separate from full native peak context. It rejects duplicated task identities, leaked holdout traces, unmatched provenance, missing accounting and self-awarded proof. Paired statistics describe the executed tasks; they do not manufacture general capability.

## Targets that need evidence

The goals are separately20x fewer total native tokens and20x smaller full native peak context, with equal or better capability on both Codex and Claude. Actual subscription gains require independent causal evidence. Model capability, general coding, useful days, reboot and power-loss claims need real observations.

No native20x goal is currently proved. Original results remain intact, including failures and unknown costs. The website shows timestamped observations and labels stale state.

## Shared harness

Host hooks and MCP supply shared memory, graph queries, progress handoffs and verification. First-class host paths are Claude Code, Codex, Antigravity and Gemini CLI. Extra host configuration shapes retain their individual verification status.

```powershell
node bin/atlias.mjs doctor
node bin/atlias.mjs status
node bin/atlias.mjs progress
```

The installed3.8.1 package is separate from this isolated migration checkout. Preserve global host profiles and other agents' dirty files while the new runtime is being verified.

## Verification

```powershell
node test/run.mjs
node test/benchmark-oracle-adversarial.mjs
node test/status-adversarial.mjs
node test/site-functional.mjs
```

Website checks use the installed browser runtime. Functional verification comes first, followed by a separate adversarial hunt. Every failed attempt, consumed provider call and unknown counter stays in the evidence. Reaching a target never stops the improvement loop.

## License

Atlias is MIT licensed. OpenCode is an independent MIT licensed upstream project; retain its notices when distributing source or substantial portions. Benchmark datasets retain their own licenses and restrictions. See [corpus provenance](evals/CORPORA.md).

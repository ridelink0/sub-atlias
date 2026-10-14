# Verified native smoke results for Gev

Updated 2026-10-14T07:42:42.408730+00:00. Research basis: RESEARCH-FIRST 0f and 9.

These are exploratory, same-model smoke measurements from frozen source 937b427. Both controllers and the existing recovery queue ended with exit 0. Root checked all twenty receipt hashes per host and recomputed each stored report. No earlier evidence was overwritten.

| Host | Solved base / Atlias | Native base / Atlias | Lost / gained | TOTAL base / Atlias | TOTAL ratio | Full PEAK base / Atlias | PEAK ratio |
|---|---:|---:|---:|---:|---:|---:|---:|
| Claude Code | 8/10 / 10/10 | 9/10 / 10/10 | 0 / 2 | 1,245,163 / 940,198 | 1.32436x | 30,363 / 14,720 | 2.06270x |
| Codex | 7/10 / 7/10 | 10/10 / 10/10 | 0 / 0 | 644,012 / 606,452 | 1.06193x | 14,778 / 12,005 | 1.23099x |

All forty attempts have complete usage and matched model, client and window provenance. The model was private Ollama qwen3.5:9b-32k, with a 32768 context window, 2048 output limit and 32-request budget. Claude base has one capped native-incomplete attempt; Atlias has none. Codex has no capped attempts in either arm.

The stock-versus-stock A/A calibration varied by 1.62584x TOTAL and 1.08776x full PEAK. That is noise, not an Atlias gain. The smoke samples have one repeat, and the small Codex gain needs replication. Claude first and final usage-block input counters also differ; both remain recorded separately.

Neither 20x nor regular 4x Nanobot is achieved. Same-user hidden-grader isolation remains unqualified after the retained access incident. These results do not qualify native worker identity, cancellation, PDF/multimodal fidelity, followup/compaction behavior for the measured profile, or a public performance claim. Nine PID-dependent test omissions and the earlier disposable cleanup warning remain explicit.

New source 3fe46ad fixes the text-only batch Read boundary, exact recovered check identity and gate-report visibility. It is committed only in the private root worktree. New r3 manifest 9a030abd58bddcebda2205bf72ce00c1e31e5879812065d6f423c15cfc6cb379 is distinct from r2; its full preflight is pending, and it has no model benchmark results. Current deferred native CLI fixture returned exit 0 with 24/24 checks, eight deterministic requests, no cap or partial stream. This verifies plumbing only.

The r2 Claude preflight log contains 91 distinct successful planted-break observations, with matching log hash and terminal exit 0. Its per-case JSON was not archived. The retained 52-private and 30-public JSON receipts are a different, older evidence epoch; they are not 82 plus nine missing cases. New r3 preflight archives fresh private and controller JSON receipts.

Evidence: receipts/root/native-batch-32b-r2-root-review.json; receipts/root/codex-hooks-32b-r2-root-review.json; receipts/root/native-recovery-queue-r2.json; receipts/root/native-text-read-probe-r3.json; board/20261014T064826Z-L19-r2-audit.md. Preserve failed/partial and v1/v2 fixture evidence.

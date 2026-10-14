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

## Verified later source and bounded experiments

Private source commit 7fede5d is frozen in r4 manifest 7a15d217c8d08c015d48e5157ed3619552122907916d615ca94cc8cb165e6e5d. Root rechecked all nine preflight terminal exits, log hashes and both fresh per-case archives: 1585/1585 Node checks, nine explicit PID omissions, 104/104 private mutations caught with restored exit 0/source intact, controller 69 functional/25 planted/69 restored. Actual wrapper native-r4-preflight exit 0. Receipt: council/receipts/root/native-r4-preflight-root-review.json. The owned preflight copy is retained as diagnostic evidence; cleanup remains unqualified. r3 failed mutation anchor and read-only Git cleanup evidence is preserved; no r3/r4 corpus inference has run.

Native worker defect is fixed by refusing worker batches before preflight/effects and directing them to standalone tools. Real r4 trial5 used exact spec.atliasConfig before launch: subagentsApart true, guard attempted 0, child ToolSearch then native Read kept the host child ID through native/classic/mod callbacks. Frozen gate.turnEvents parent excluded the child Read and child included it; all seven metadata checks passed. Scope is that tested Read/event-window path, not every worker/gate action. Main text/error/image fixtures and Codex exact original/followups/selected skill after forced compaction remain recorded.

The unchanged r2 corpus results are terminal and root-verified: Claude base 8/10 versus Atlias 10/10, zero lost/two gained, TOTAL 1.32436x and full PEAK 2.06270x; base native 9/10 (one cap), Atlias 10/10. Codex 7/10 both, zero lost/gained, TOTAL 1.06193x and full PEAK 1.23099x, native 10/10 both. All forty usage records complete. Stock A/A TOTAL variation 1.62584x is noise. Neither 20x nor 4x is achieved. Frozen937b427 and the terminal r2 queue remain immutable; never relaunch it.

Root corrected an omitted no-colon-before-tool-calls rule in L20's policy prototype. Scratch shared-policy-compression-r2 changes only exact-hash shared tools/tone and preserves identity/security/authority sections; active native off/on fixture passed all twelve checks. Four real private qwen3.5:9b-32k opening attempts then completed, one request each, stable model/window32768, no cap/errors/partial: off TOTAL19998/fullPEAK9999, on19697/9849, ratios1.01528x/1.01523x,150 input tokens saved per opening. This is two reversed-order generic arithmetic repetitions under default core flags, not corpus quality or the r4 benchmark profile. Keep prototype unmerged. Receipt shared-policy-counter-root-review-r1.json. Shared string/Read codec research is now a higher-impact candidate, pending exact round-trip and same-model quality checks.

Native cancellation API absence was a false finding from reading Agent SDK docs; the native Mods API exposes turn.abort and installed runtime requires {turnId}. Final supported-model fixture observed signal abort after the middle command started: first Write remained, later Write absent, but the command was backgrounded and completed. No command-termination or structured batch-result guarantee is established. Native PDF/pages one-page fixture returned text/image/text through standalone Read; original observer receipt remains false because of hook-script/sanitizer errors. Direct CLI/wire protocol evidence does not qualify those hooks or PDF interpretation.

Regular4x adapter v1 remains unapproved: peer found child-local receipts lost on timeout, missing metadata accepted, no request bound/provenance and false ESM isolation/deadline assumptions. L20 is building NEW synthetic parent-ledger v2; no regular model benchmark started. L19 is researching a lossless native Read dedup codec in scratch only. Do not respawn the completed twenty-agent council. Both reviewers' conclusions require root review.

## Final prototype review and continuation

Five-hour live reading at 09:04:10Z: 11% remaining; estimates vary across three concurrent sessions. No new model run or substantial job started at this boundary. Recovery heartbeat was updated through the app and saved TOML verified: October 14, 06:45:42 America/Chicago = measured reset 11:38:42Z plus seven minutes. Receipt: council/receipts/root/usage-reset-schedule-verified-r6.json. Python timezone data was unavailable; Node Intl performed the America/Chicago conversion. Daily21:20 wake and Claude relay unchanged.

Private source7fede5d remains frozen in r4, with terminal/root-verified 1585 Node checks,104 private plants and controller69 functional/25 planted/69 restored; nine PID omissions and cleanup qualification remain explicit. No r4 corpus inference. Unchanged r2 native results: Claude8/10 base versus10/10Atlias,TOTAL1.32436x/fullPEAK2.06270x,0lost2gained; Codex7/10both,TOTAL1.06193x/fullPEAK1.23099x,0lost/gained. Native Claude9/10base(onecap),10/10Atlias; Codex10/10both. Neither20x nor4x achieved. Stock A/A variation1.62584x TOTAL is noise. Do not relaunch the terminal queue or modify frozen937b427.

Root reviewed both remaining scratch prototypes. L19 text-read-codec-v1 root functional command terminated0 with35 assertions: exact object round trip, generic338to320JSON bytes, no token/model-quality claim. Node Buffer means it cannot be imported directly into nativeMods; serialization key order may change though values round-trip. Keep unmerged until exact model-facing boundary and same-model quality/full TOTAL/PEAK tests are established. Root receipt text-read-codec-functional-root-r1.json.

L20 regular4x-adapter-prototype-v2e is UNAPPROVED. Root replay matched six archived scenario ledgers/accounting, then reproduced six fail-open reducer defects: metadata response delivery false/missing accepted; chat wrong route, GET method and stream=true accepted; truthy string responseDelivered accepted. Parent also drops already constructed upstream counters when downstream delivery fails. Actual root probe exit0; evidence regular4x-adapter-v2e-review-r1.json. Fix in NEW scratch variant preserving all prior evidence; journal provider terminal counters before client forwarding and separate delivered/task/native qualification. Do not run model benchmarks with this adapter yet.

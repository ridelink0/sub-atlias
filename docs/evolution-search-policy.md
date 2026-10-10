# Gev's three-round search penalty

After three completed measured rounds have failed to replace the current champion, `chooseParent` gives every nonchampion branch a parent-selection multiplier of zero. The next candidate inherits the champion's configuration and changes one unseen typed setting. This continues until a measured promotion resets the streak. Agents continue testing after reaching targets.

`selectProposal` enforces the least-penalized available context. An AI proposal cannot bypass typed settings, select a configuration already in the archive, or insist on a setting family that repeatedly lost under this same parent when another unseen family has less negative evidence. Lessons from different parents and mismatched task sets do not penalize the current context. Search priority changes; original task grades, cost unknowns and promotion requirements do not.

Completed rounds require a finalized controller outcome or a finished rejected legacy comparison/smoke screen. A completed smoke test with its paired stage still running does not count. Partial reports, zero-counted-call outages, explicitly held infrastructure outcomes and pending confirmations are excluded. Promotion timestamps delimit the streak. Invalid evidence holds selection.

Functional checks: `node test/evolution-search-functional.mjs` and `node test/evolution-controller-functional.mjs`. Separate adversarial checks: `node test/evolution-search-adversarial.mjs` and `node test/evolution-controller-adversarial.mjs`. Controller checks import the actual sibling `atlias-evolve/evolve.mjs`; they inject a proposer response and perform no model call, process launch or archive write.

The next-process controller at `D:/harness-work/atlias-evolve/evolve.mjs` imports this policy and records its decisions. The running original process loaded its old source. No active evaluation was stopped and no original archive/report was edited. A ready replacement and a verified clean GPU boundary are required before this can affect live selection. Software checks do not prove a new champion, model-weight training, completed OpenCode migration or native efficiency.

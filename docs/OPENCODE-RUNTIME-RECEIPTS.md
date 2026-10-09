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

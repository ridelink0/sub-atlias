# Measuring the native subharness

This controller measures ordinary native Claude Code against the same client with the full Atlias plugin and selected optional Claude mods. Claude smoke runs first, then Codex smoke immediately; Claude's screen, confirmation and optional Ultimate stages follow, then the corresponding Codex stages. Both native hosts qualify before either consumes a full screen. It reuses `tools/h2h/base_harness_runner.py`, the existing task files and their execution graders. It does not mutate, promote into, or overwrite the regular harness evolve loop.

The method rests on `RESEARCH-FIRST.md` section 0f, H6/H7, and sections 1 and 7: matched conditions, repeated paired measurements, retained uncertainty, and execution grading. A reduced JSON payload or a stand-in response is a protocol check, not an inference saving.

## Before starting

Run the Atlias work skill's `scripts/status.sh`. The regular loop and its Ultimate gate retain their own evidence and ownership. Request a safe boundary from their owner before borrowing the GPU. Never delete a foreign GPU lock or end its process. The controller exclusively creates its own GPU lease and removes only the lease carrying its own random owner token.

Prepare a clean, credential-free Codex home by installing this exact candidate's Atlias adapter into an isolated `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and `ATLIAS_HOME`. The controller copies that home and relocates exact candidate source paths to its frozen source. Do not supply a profile that points to a different installed Atlias copy or a global launcher. Native hooks, MCP discovery, project instructions, selected skills, follow-up messages and compaction must be qualified separately against the pinned host version.

Older runner versions used `skills.include_instructions=false`, a departure from an ordinary stock baseline that disqualifies those trials. The qualified runner disables only an explicit frozen list of personal skill files in both arms and preserves the four bundled skills and project skills. Root's native recording probe verified the supported per-skill configuration and selected-skill compaction repair. The controller always leaves general goal completion false; its `measured20xNoTaskLoss` field only describes the retained task set.

## Declare and freeze a trial

Write a JSON specification outside the source tree. The candidate's original default remains available. Select only supported opt-in switches; never shorten active skill text, remove authority, or expose hidden graders to a proposer.

```json
{
  "source": "D:/harness-work/atlias-subharness-1012",
  "candidate": "tool-placement-authority",
  "continuationMinimum": 20,
  "model": "qwen3.5:9b-32k",
  "apiBase": "http://127.0.0.1:11435",
  "tasks": ["C:/Users/OWNER/atlias/evals/humanevalfix", "C:/Users/OWNER/atlias/evals/canitedit"],
  "hosts": [
    {
      "host": "claude",
      "client": "C:/Users/OWNER/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
      "numCtx": 32768,
      "numPredict": 2048,
      "taskTimeout": 1200,
      "startTimeout": 600
    },
    {
      "host": "codex",
      "client": "C:/Users/OWNER/AppData/Local/OpenAI/Codex/bin/2e5e00daee91c61d/codex.exe",
      "codexHomeFrom": "D:/harness-work/atlias-subharness-loop-1012/prepared-codex-home",
      "bypassHookTrust": true,
      "numCtx": 32768,
      "numPredict": 2048,
      "taskTimeout": 1200,
      "startTimeout": 600
    }
  ],
  "claudeMods": ["mods/atlias-efficiency"],
  "claudeSettings": {"pluginConfigs": {"atlias-efficiency": {"options": {"enabled": true}}}},
  "toolSearch": {"base": false, "atlias": true},
  "codexDisabledSkills": "D:/harness-work/atlias-subharness-runs-1012/codex-personal-skill-config.json",
  "atliasConfig": {"flags": {"authorityLedger": true}},
  "checks": [
    ["node", "test/run.mjs"],
    ["python", "tools/h2h/base_harness_selftest.py"],
    ["python", "tools/h2h/base_harness_accounting_test.py"],
    ["python", "tools/h2h/base_harness_responses_test.py"],
    ["python", "tools/h2h/subharness_adversarial.py"]
  ],
  "stages": [
    {"name": "smoke", "ids": ["actual-smoke-task-id"], "repeats": 1},
    {"name": "screen", "ids": ["actual-screen-task-id"], "repeats": 2},
    {"name": "confirmation", "ids": ["actual-held-out-task-id"], "repeats": 2}
  ]
}
```

Replace the example IDs, paths and model with the predeclared real task sets and available clients. Use the existing 10-task smoke and 60-task screen. Select 250 confirmation tasks disjoint from the screen before examining candidate outcomes. An optional fourth `ultimate` stage can declare all existing Ultimate corpus IDs, repeated at least twice. To prepare Claude first while Codex qualification is pending, declare only the Claude host, then prepare a separate complete manifest for Codex; do not revise a started manifest.

The same `model` name is pinned in every arm. Each host's two arms get the same context, output cap, per-task round budget, timeout and sampling (`temperature=0.2`, enforced by the existing meter). The server must actually load the requested window; recording `numCtx` does not establish that it did. If two hosts need different loaded windows, declare those windows and explicitly prepare the model server for each host before continuing at its stage boundary. Both arms within each host remain matched.

`toolSearch` accepts a boolean for both Claude arms or explicit `base`/`atlias` booleans. The example preserves the ordinary default custom-endpoint baseline and opts the enhanced arm into ToolSearch as part of the candidate. Setting the base value true instead is a declared native-host condition that needs a separate frozen sensitivity trial. Claude plugin settings and Atlias configuration affect only the enhanced arm. Every task has a fresh native profile, workspace and Atlias state; base carries no Atlias plugin or prepared home. `bypassHookTrust` applies only to the vetted enhanced Codex home and must be supported by the pinned client; it is not inferred from the model choice. The personal skill exclusion list is copied and hashed into the trial, and both Codex arms use exactly that list.

```powershell
python tools/h2h/subharness_controller.py selftest --receipt D:/harness-work/atlias-subharness-loop-1012/controller-selftest.json
python tools/h2h/subharness_controller.py prepare --spec D:/harness-work/atlias-subharness-loop-1012/spec.json --root D:/harness-work/atlias-subharness-loop-1012/trial-01
```

Preparation copies a candidate source snapshot and task/grader content and pins client, source, task and prepared-profile hashes. It makes no model call. All checks run in a disposable copy before inference, including the full functional suite and existing planted regressions. Mutation tests cannot alter the measured source. The frozen snapshot carries no git history, so the disposable copy alone is committed to a throwaway repository first: the suite's provenance check needs a commit to name. Preflight receipts include actual exits and log hashes; a failed check prevents model calls.

The frozen `continuationMinimum` defaults to 20 for both total tokens and peak context. After the screen, the controller holds before confirmation unless both reductions meet that minimum, no shared task or native completion was lost, every native run completed, and counts/windows/provenance are qualified. The same gate applies between confirmation and Ultimate. A hold stops that host's later stages only; the other host's stages are their own measurement and still run. Held verdicts and their input hashes remain under `gates/`; thresholds cannot change after inference. An explicitly preregistered value of 5 tests a milestone without changing the 20x indicator or completing the goal. Claude and Codex smoke stages precede larger stages.

Inspect a leftover controller or GPU lock's owner and process identity before any manual recovery. The controller deliberately refuses to steal or automatically clear stale locks; receipts and ACTIVE.json must remain intact.

## Run, stop and resume

After the current GPU owner has released the shared lock, launch the controller with a hidden window if using `Start-Process`. The controller does not detach itself or guess that another owner is gone.

```powershell
python tools/h2h/subharness_controller.py run --root D:/harness-work/atlias-subharness-loop-1012/trial-01 --gpu-lock D:/harness-work/atlias-local-1003/LOCAL-ROLE.lock --gpu-approved
```

For a bounded initial check, add `--max-tasks 2`; it counts two native arm attempts. Place `STOP` in the trial directory or send an ordinary stop signal to finish the active task and stop before the next one. A pair interrupted between its arms resumes with the missing arm. Remove only the trial's STOP when ready and run the same command. Do not use the regular evolve folder's STOP for this controller.

The immutable plan alternates base/enhanced order by task and repetition to reduce order bias. Each completed arm writes a retained receipt before journaling it, then updates the report. A process crash with `ACTIVE.json` but no recorded terminal result becomes an explicit interrupted attempt with unknown spend; it is never rerun in place. A repeat requires a new trial directory so the first attempt stays visible.

```powershell
python tools/h2h/subharness_controller.py status --root D:/harness-work/atlias-subharness-loop-1012/trial-01
python tools/h2h/subharness_controller.py report --root D:/harness-work/atlias-subharness-loop-1012/trial-01
```

`STATE.json` names the current stage and task. `MANIFEST.json` freezes conditions. `ATTEMPTS.jsonl` indexes retained files under `receipts/`. Native outputs, model call receipts and workspaces remain under `work/`. `REPORT.json` and `REPORT.md` are derived summaries suitable for inspection and later publication. Supply no account keys in the specification or prepared profiles: this controller permits only a loopback model server, starts native tasks with a clean environment, and rejects a prepared Codex `auth.json`.

A missing count, incomplete attempt, changed model/template/client, wrong or unknown loaded window, source drift, or mismatched task/grader blocks the reduction ratio. A protocol, window or provenance failure holds further trials at the next task boundary for inspection. Total tokens include input and output over every task, rather than selecting successful tasks. Peak context is the meter's full input-plus-output peak. A single task that base solves and enhanced loses, or a lost native completion, blocks the task-set 20x indicator. These checks do not establish broad native capability parity, active skill preservation or follow-up handling by themselves.

At the end, retain all regular harness evidence. Its owner can resume the previous gate/controller at its saved boundary only after this GPU lease is gone. Changed candidates use new manifests; this tool never overwrites `ARCHIVE.json`, re-judges an old round, or promotes a candidate automatically.

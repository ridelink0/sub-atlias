# Changelog

## 4.0.0

- Atlias's own agent from the 2026-10-16/17 harness work: against plain Claude Code on the same local model (qwen3.5:9b), nine 120-run screens averaged 19.5x fewer total tokens (best trial 23.4x, with a 5.4x smaller largest prompt), solving as many tasks or more in eight of nine. The best trial's settings (flags.preloadFiles, visibleCheck, finishOnGreen, quietNoCheck, stallStop, greenFailShown and the rest) are switches, off by default.
- Permission modes beside workspace, ask and read-only: auto-accept, plan, auto and max (never asks; refuses and logs catastrophic actions; full action log). /permissions [mode|next|log].
- One slash-command registry with /help, /model, /usage, /cost, /config, /clear, /resume, /export, /init, /memory, /import, custom commands from .atlias/commands/*.md, and /deep-research.
- A customizable usage display (ui.usageEnabled, usagePosition, usageColor including rainbow, usageAnimation).
- atlias import and a first-run offer: sessions, memory, instructions, skills, commands and MCP definitions from Claude Code, Codex, Gemini CLI and Antigravity; credentials never read; reversible with --undo.
- The version is read from package.json, so a release cannot show an old number.
- `atlias update [--check]` and `/update`: fast-forward a git checkout of Atlias from its update source (`update.source`; empty means the upstream of the current branch). It refuses when tracked files are changed, HEAD is detached, no source is set or the history has diverged, and it never resets, merges, rebases or pushes; it prints the commits it pulled. `atlias --version` shows the version and, in a checkout, the commit and branch.
- Update offer: when the agent starts in a terminal and the source has new commits, it asks "Installed, Wanna Update?" with "Never ask me again (you can run update to update)", "Maybe Later" and "Lets Do It!". Maybe Later asks again after a day; Never sets `update.autoPrompt` to false (settable back with `atlias config` or `/settings`). The check is capped at four seconds, is silent on any failure, and never runs in `exec`, `eval`, `--once` or without a terminal.
- `@file` mentions in the agent (inside the project only, symlinks followed, `.git` never, 20,000 bytes a file, 8 files a message), `/context`, `/rename <name>` with `/resume <name>`, `/release-notes [version]`, and `agent.notifyAfterSeconds` (terminal bell and desktop notification after a long turn; 0, the default, is off). The benchmark path (`runLoop`, `openaiChat`, `eval`, `tools/h2h`) is untouched.

## Unreleased

- In Claude Code, before the gate says no check ran after the last edit, it reads the tail of the session transcript. Under the load of the 3.8.1 study Claude Code cancelled 80 atlias hook calls in 22 of 34 runs, and a cancelled PostToolUse left a check that ran unrecorded, so the gate held a reply that had checked its work. A check the transcript shows after the turn's last edit, by the same rules the hooks use (`track.isCheck`), is recorded and counted with its result: a failing one is still reported as failing. Only a result stamped after the last edit the log recorded counts, so an edit a subagent made after the check (it is in the log, not in the main transcript) still needs one. A transcript that is missing, does not parse, is cut mid-line, has lost an edit the log has, or comes from another host changes nothing. Not yet measured in a study.
- The plugin's tool hooks may take 30 seconds before Claude Code cancels them, as Stop already could (PreToolUse, PostToolUse and PostToolUseFailure were at 8). Claude Code cancels a command hook that reaches its timeout and drops its output, which is the one documented cause of the 80 cancellations in the 3.8.1 study; whether the timeout was the cause there is not yet established. Codex's tool hooks go to 30 seconds and Gemini CLI's to 30,000 ms. PostToolUse now fires only for the edit, shell and read tools `track.postTool` acts on, and PostToolUseFailure only for the shell tools, so a Grep, Glob, Task or MCP call starts Node once, for PreToolUse, instead of twice; PreToolUse keeps `.*`, because the loop guard counts repeats of every tool. The suite holds the matchers to the code's own tool lists and shows both handlers do nothing for the tools left out. Codex keeps `.*` everywhere, since which tool names it hands its hooks is not pinned here.
- Round five's control. Every behaviour change of the round lands behind a flag, a `flags.<name>` config key that is off by default and that the environment can switch for one run as `ATLIAS_FLAG_<NAME>` (`flags.leanBrief` is `ATLIAS_FLAG_LEAN_BRIEF`; 1/0, on/off, true/false; any case, quotes and a trailing carriage return are taken as Windows hands them over). The environment wins over config.json. `atlias eval` names its flags before the first task and in the saved report, refuses to start when an `ATLIAS_FLAG_` variable names no flag or does not parse, and `--resume` will not mix rows run with other flags; `atlias compare` prints both arms' flags; a hooked Claude Code session logs its flags at session start when any flag variable is set. Two runs have the same flags when the flags both know match and any flag only one knows is at its default there, so a baseline saved before a flag was registered is still the control for a later run with that flag off, for `--resume` and for `compare`, and for the golden test's report stamp.
- Behind `flags.leanBrief` (`ATLIAS_FLAG_LEAN_BRIEF`), off by default: a shorter session brief, the fixed text every request pays for. The first line no longer lists eight MCP tool names and the CLI path (Claude Code lists the server's tools itself and loads the rest on demand); the Companions section appears only when it asks something of the model, a companion loaded twice or usage-limits on; and the pass-line rule drops the sentence explaining the gate, which the double-check skill and the gate's own hold both say. On an empty project the Claude Code brief goes from 1,357 characters to 961 and Codex's from 1,408 to 1,012. The two skills' descriptions, which Claude Code lists on every request, go from 307 and 354 characters to 192 and 199 with their triggers kept. They are static SKILL.md files the plugin ships, so no flag can switch them per arm: that cut is in every arm, flags off included, and is the one change of the row not behind a flag. Not yet measured.
- Behind `flags.gateRunsCheck` (`ATLIAS_FLAG_GATE_RUNS_CHECK`), off by default: the gate runs the project's check itself rather than hold a reply for the want of one. When a stop would be held because no check ran after the last edit (a done claim, a pass claim with no check this turn, the second-pass request), or the reply ends on the pass line with none, and the project shows one check the gate can name (check.py, canitedit_check.py, run_tests.sh, a test_*.py that runs itself, the package.json test script; the script-name rule of the hooks' own classifier decides), the gate runs it under the watchdog, stopped with its whole tree at 10 seconds, and records it as a check. A pass holds nothing, so the reply goes through with no model round; a failure holds the reply once and quotes the last lines of the output; a check that ran out of time or could not start leaves the hold as it was and says so. A pytest-shaped test file that runs no test by itself, a test helper module, a config file such as eslint.config.js, an application module named for what it verifies (verify_email.py), or two candidates of the same rank, is no check the gate can name, since each would exit 0 and read as a pass; a package manager that is not on PATH is a check that could not start, not a failing one. With none, or with the flag off, the gate answers byte for byte as before. When it can name one, the brief says the gate will run it and stops asking Claude Code to send an edit and its check in one message. Not yet measured.
- Behind `flags.sameTextSwitch` (`ATLIAS_FLAG_SAME_TEXT_SWITCH`), off by default, in the atlias agent loop: an edit whose new text is its old text, or a byte-for-byte repeat of the last edit that failed, is answered with a steer and does not count against `agent.maxBadReplies` (on the main tier 87 of the 246 edits qwen2.5-coder:7b could not land re-sent its own text, and each was a strike). It still counts as an edit that did not apply, and neither strikes nor clears the counter, so real misses around it still stop the run and the round budget still ends a model that never changes its edit. A repeat also switches that file's next edit: in a Python file whose failed edit names or sits in exactly one def or class of that name, `edit_file` with `old_string` "" and the whole def as `new_string` replaces that def, found by its header (decorators, a header over several lines and a docstring at column 0 included; re-based on the header's indentation; CRLF kept); anywhere else the steer asks for `write_file` with the whole file, and `edit_file` with an empty `old_string` writes `new_string` whole. An `edit_file` that still names its `old_string` is an ordinary edit under the switch, so a `new_string` holding only a def's first lines cannot drop the rest of it; and a bracket or `#` inside a string of a def's header does not stretch the def over the ones after it. The switch lasts one edit, and a whole def or file that is what the file already holds is answered as the same no-op. With the flag off the loop sends and answers byte for byte as before. Every eval row, in both arms, now also counts failed edits that re-sent their own text (`sameText`) and that repeated the last failed edit (`repeatEdits`), and under the flag the ones not counted as a strike (`spared`) and the switches (`switches`); the report sums them, and `atlias compare` prints the same-text share of failed edits for both arms, reading it from the cause tally of a report saved before these fields. Not yet measured.
- An eval row now carries a ledger: edits that landed (`editsApplied`), tool results the model was handed only as a one-line note (`masked`), calls that then asked again for what such a note replaced (`rereads`), and prompt tokens the engine served from its cache, per round and summed (`cachedTokens`, `cachedTotal`: Ollama's `prompt_eval_cached_count` and the OpenAI, DeepSeek and Anthropic shapes; null where the engine said nothing). The report sums them and `atlias compare` prints them beside the engine tokens, deriving landed edits for reports saved before this.
- A golden test holds the control: on a scripted engine and on the echo engine, with no flag set and with every flag set to 0 from the environment, the eval runner sends byte for byte the requests the code before this change sent, and writes the same rows with only the ledger fields added (`test/golden.mjs`, `test/fixtures/golden-flags-off.json`, recorded on d59aa98).

## 3.8.1 (2026-09-28)

In Claude Code, the gate stops buying rounds it does not need. Measured against plain Claude Code on the same 34 tasks with the same model, atlias 3.8.0 cost twice the prompt tokens per solved task; this release brings that to 1.25 times, with no task lost. It does not yet beat plain Claude Code.

The study (Claude Code 2.1.283, Sonnet 5 at medium effort, headless, one fresh workspace per task, hidden graders; 20 HumanEvalFix, 10 CanItEdit and 4 refactor tasks drawn with atlias's seeded sampler) ran plain Claude Code against Claude Code with only atlias added. With 3.8.0 both solved about the same (32 and 31 of 34) but atlias read 282.9k prompt tokens per solved task against 141.5k (ratio 2.00, 95 per cent 1.70 to 2.43), and the gate held 32 of 34 replies. The transcripts say why: `python check.py` ran and passed, but the hooks did not count it as a check, so the gate said "no check ran this turn" (false) and asked for the second pass, and the model re-ran the passing check before it replied. Every held reply is at least one more round, and every round re-sends the whole context.

- A project's own check script run by name is a check (check.py, canitedit_check.py, test_x.py, run_tests.sh, by path or through PowerShell's &), and so are `python -m unittest` and a `python -c` or `node -e` one-liner that asserts; checkout.py, main.py and a bare print are not. The agent loop counts these too.
- The hooks count running a file this turn edited as a check, the rule the agent loop already had (`python main.py`, `from main import f`).
- When a check already ran after the last edit and did not fail, the second-pass request says so and that no tool call is needed if the re-read finds nothing.
- The brief teaches the line the gate accepts ("Pass 1: ... Pass 2: ..."), so the second pass happens inside the first reply, and tells Claude Code to send an edit and its check in the same message. Claude Code runs one message's calls in order (probed: a Write then a PowerShell read of the file in one message; the read saw the write); other hosts were not probed and are not told to.

Measured on fb81be3 (the brief rules were then shortened to fit the brief's 3200-character limit, 1abed38; that final text is not yet measured): 32 of 34 solved in both arms, 177.1k prompt tokens per solved task against 141.5k (ratio 1.25, 95 per cent 1.14 to 1.38), gate holds 8 instead of 32. On the 12 task pairs no cancelled hook touched, 1.16 (1.06 to 1.29). What is left: about 1.3k tokens a call of brief, skill and tool listing, which is the whole gap on the 8 clean HumanEvalFix pairs (4 rounds each, 122.4k against 117.7k per task); CanItEdit, where plain Claude Code ran no check at all and atlias's check costs a round; and the model did not send an edit and its check together. Under the load of the study Claude Code cancelled 80 atlias hook calls in 22 of the 34 runs, and a cancelled PostToolUse leaves a check unrecorded, so the gate can still say "no check ran" when one did; the rows those touched are reported apart. The study, the per-task rows and the scripts are in D:/harness-work/runs/cc-token-study-0928.

Also: npm-installed claude and codex CLIs start on Windows without a shell (Node refuses to spawn a .cmd without one since the CVE-2024-27980 fix, so the agent reported the engine missing).

## 3.8.0 (2026-09-28)

Code the model wrote can no longer outlive the harness, every block a model writes is run or answered, and the first head-to-head against mini-swe-agent on a corpus off the floor.

On 2026-09-26 a model-written make_palindrome that never returned ran under the eval. spawnSync's timeout ended only the shell, three pythons held a core each for hours, and an orphaned head-to-head runner kept starting more. Everything atlias runs that a model wrote - the agent's shell tool, the check that scores an eval task, a benchmark proof - now runs under a watchdog (`lib/watchdog.mjs`) that ends the whole process tree (taskkill /T on Windows, the process group elsewhere) at its limit, when the process that asked for it goes away, and on Ctrl+C; it caps the output it passes on, because an overflowing caller would end the watchdog before the tree. An eval task ends what its commands left running in the background and says how many. `atlias eval` stops when whatever started it is gone (`--outlive-parent` keeps it), the eval shell limit is two minutes, and `tools/h2h/mini_swe_runner.py` drives mini-swe-agent on the same task files with the same safeguards.

The loop ran only the first tool block of a reply. In qwen2.5-coder:7b's main-tier transcripts half the replies held more than one, 96 of 221 blocks never ran and nobody said so, and when the unrun block was an edit the model went on as if it had landed. Every block now runs in order (at most five), a block that fails stops the rest and names them, and a block nobody could read is answered instead of dropped; all 9 unreadable blocks had written `"new_string="` for `"new_string":`, which is now read. A nested helper restated whole at column 0 is re-indented in place instead of refused, and a window grown for one conversation no longer carries into the next.

Measured on the main tier (HumanEvalFix Python 164 and CanItEdit lazy 88) with qwen2.5-coder:7b on Ollama, the same window, temperature and round budgets on both sides, one attempt per task: atlias solved 59 of the 250 tasks both runs hold (Wilson 18.8 to 29.2 per cent) and mini-swe-agent 41 (12.3 to 21.5); 36 tasks only atlias solved and 18 only mini-swe-agent did, McNemar exact p = 0.020, paired interval 1.5 to 12.1 points in atlias's favour. Per solved task atlias read 99.0k prompt tokens against 127.4k; in total it read 1.12 times the prompt tokens for 1.44 times the solves. One run per arm on different days, so `--repeat 3` is next. The gain is not from this release's loop changes: on the 156 tasks both atlias arms ran, the harness before and after them tied 49 and 49, while the share of edits that did not apply fell from 41 to 34 per cent. Tables and caveats are in `docs/NEXTGEN-4.md`.

Also: eval workspaces go to `--work`, `ATLIAS_EVAL_DIR`, `agent.evalDir`, or an atlias-evals folder in the temp folder, checked before the first task (every main-tier run on 2026-09-26 died at its first mkdir in a folder locked against new subfolders); `--save` is written after every task and `--resume` carries on; a kept workspace holds the run's transcript; eval rows carry the engine's own prompt and output tokens and what the model was handed, and `atlias compare` prints tokens per passing attempt. `atlias <command> --help` prints that command's usage and runs nothing (`atlias eval --help` used to start an eval). After a compaction, the brief reads Claude Code's summary from the transcript and names what it left out of the handoff note. Ultimate Frontend Skills enabled at project scope counts, so `atlias install --companions` adds no second copy. CI was red on every OS since 3.6.0 and is green: the script graders need Python but not pytest, a check that cannot run here is printed as SKIP and never counted, the worktree checks compare real paths, and the node 18 fixtures say `"type": "module"`. The test suite leaves nothing in the temp folder, and graphify-out is no longer tracked.

## 3.7.1 (2026-09-26)

Never two copies of a companion. The companion installer and the doctor knew graphify only through the system Python and knew Ultimate Frontend Skills only by its current plugin name, so a machine that already had either one a different way could get a second copy beside it.

graphify installed with pipx or into its own virtual environment is now found: a `graphify` launcher on PATH is followed to the interpreter beside it, pipx's venvs are checked, and `atlias install --companions` searches afresh instead of trusting a cached miss before it installs anything. Ultimate Frontend Skills is recognised under all four of its names (ultimate-frontend-skills, ultimate-website-skills, ultimate-design-skills, cinematic-web-design), as an installed plugin that is only switched off, and as a skills-only folder; any of those means nothing is installed, and the brief and `atlias doctor` say so when two copies would load at once. usage-limits and computer-use were never installed by atlias, only detected, so they could not be doubled.

Also in this release: `atlias compare` prints the characters moved per passing attempt beside the total, so a harness cannot look cheap by solving less.

## 3.7.0 (2026-09-26)

A local model gets the window it was promised, an edit that only needs re-indenting lands, and the eval can say what it could never have detected.

The first real run of aider's polyglot benchmark came back 0 of 27, and the plan in `docs/NEXTGEN-4.md` argued that number measured Ollama rather than the model: atlias sent no `num_ctx`, so every local run got the server's default window of 4096 tokens, and an over-long conversation was cut from the front, task first, without an error. Every Ollama request now carries `num_ctx` (16384 by default, capped at the model's trained length and grown in powers of two when a prompt needs it), `num_predict` and `truncate: false`, so an overflow comes back as an error with its token count, and a conversation that cannot fit even the trained length stops as the new reason `context-full` rather than as a model error. The three settings are `agent.ollamaNumCtx`, `agent.ollamaNumPredict` and `agent.ollamaKeepAlive`.

`edit_file` has one more rung. When an edit would leave a file that parsed unable to parse, the span is widened to whole lines and the new text is re-based on that line's indentation; the first candidate that parses is kept, and the reply says it was repaired. The commonest shape in the captured refusals was a `pass` stub replaced by the whole function, `def` line included. The first draft of this rung nested that function inside the stub, which parses and makes the stub return None, and a replay of the captured refusals caught it before commit: a new_string that restates the enclosing def or class now replaces from that header down, and a def that would become the body of a different function is refused as before. Mid-line edits are never widened and CRLF files stay CRLF. A refusal that remains shows the numbered lines around the parse error.

The eval grew what an A/B on a small corpus needs. `atlias compare` pairs two saved runs by task and reports McNemar's exact test, the Wilson interval per arm, a Jeffreys-prior interval on the difference, and how many one-way flips it would need before any p could reach 0.05. `atlias tiers` and `atlias eval --tier smoke|main|big --sample N --seed s` name a corpus that is the same on every machine; the main tier is HumanEvalFix and CanItEdit, converted by `atlias editbench` with CanItEdit's tests kept hidden until the model stops, and the big tier is aider's refactor benchmark with its AST grader inlined. The generated corpora stay out of git, and `evals/CORPORA.md` says where each comes from and how to regenerate it. A failing task reports partial credit from pytest or unittest's own counts, never as part of the verdict. Every failed edit is tallied by cause, and under eval its arguments and refusal are kept, which is how the re-indent rung was found.

Measured, and still not a pass: on the 27 polyglot tasks with qwen2.5-coder:7b the would-not-parse refusals fell from 25 and 23 in the two runs before the rung to 7, the share of edits that did not apply went from 64 and 70 per cent to 53 (a number a rerun with nothing changed also moves by several points), and the score stayed 0 of 27. Numbers and caveats are in `docs/NEXTGEN-4.md`.

Also: the stop gate names an unfinished check once instead of raising it on a second stop when a git call timed out under load, and a parser that does not finish leaves a file unchecked rather than failed.

## 3.6.0 (2026-09-25)

An edit that nearly matches now lands, and says how it landed.

The largest single harness effect measured anywhere in the field is the share of edits that never apply - one adapter took the same model from 19.1 to 73.4 per cent pass@1 on the same benchmark purely by driving apply failures from 69.1 per cent to under 1.5. atlias measured its own for the first time this week and found 12 of 37 edits changing nothing, which is near a third, so `edit_file` grew a ladder. An exact miss is now retried with whitespace ignored, and then anchored on the first and last line with the middle taken from the file. Every rung still demands exactly one match: two loose matches come back as a count and their line numbers rather than a guess, an anchor pair further apart than twice the lines the model thought it was replacing is refused rather than eating the middle, and the parse guard still has the last word. The reply says which rung caught the edit, so the model can see what it got wrong.

Both of the bugs in the first draft were caught by the checks written for it: a two-line old_string was being anchored, which is two ends and no middle, and the loose branch printed `[object Object]` where the changed lines should have been.

## 3.5.0 (2026-09-25)

Somebody else's benchmark, proved task by task on this machine.

At eight tasks the standard error is about sixteen points and one task flipping moves the score twelve and a half, so the shipped corpus was a tripwire rather than a measurement. `lib/polyglot.mjs` converts aider's polyglot benchmark - 225 Exercism exercises, each a stub, a test and a reference solution - into atlias's own task format, and nothing is taken on trust: every task is run twice here before it is written, and it has to fail with the stub in place and pass with the exercise's own solution. 27 of the 34 Python exercises passed both gates and are in `evals/polyglot`; the other seven are refused with the reason printed. `atlias eval --corpus evals/polyglot` runs them.

Two things this found. Windows ships an App Execution Alias called python.exe under WindowsApps that opens the Store instead of running anything, and spawned without a console it hangs until the timeout; it sat second on PATH here, so the first full conversion converted nothing and blamed a missing python. The runner is resolved to a real path now and baked into each task's check. And the harness stamp printed "unstamped" on a machine that has git, because five seconds could not cover a cold git call under load - the timeout is generous now, an unstamped report says why, and the test that let it through has stopped accepting the excuse.

## 3.4.0 (2026-09-25)

A score that names its own code, and a budget the model can see.

Six research fronts, 268 sources, written up in `docs/NEXTGEN-3.md`. Two findings outranked the whole previous ranking and both are built here: the apply-failure rate is now counted and printed beside every score, and the remaining round budget is disclosed to the model on the newest tool result - a disclosed budget bought +18.6 points at a fixed call budget in the field's own measurement, for about a third of a cent.

The rest is a scoreboard that cannot be talked past. Every report is stamped with the harness version, the sha of the two files that decide how a run behaves, dirty when either is uncommitted, the engine, the model and the round budget. `--repeat` runs each task k times and reports pass^k beside pass@k. A task carries its own round budget. And the files that grade a task are compared against what the task shipped, so a pass bought by editing or deleting the checker is refused and named - which caught qwen2.5-coder rewriting test.mjs on the first real run. Standing instructions now survive a compaction, measured at no violations when the rule survives and nearly four in ten when it is dropped.

## 3.3.2 (2026-09-25)

The stall line counted its kinds in words that agreed with their numbers and then said "1 model replies in a row" one clause earlier. Reachable only with agent.maxBadReplies set to 1, and fixed for the same reason the rest of that line was: the last thing a failed run says should not sound careless.

## 3.3.1 (2026-09-25)

Two things 3.3.0 said badly, found on a second read of what the model actually sees.

The note on a capped result read "To see the rest, To see the rest, run it again narrowed down, or pipe it through a filter.." - the header asks the question and each tool's clause was answering it with the question again, and with a second full stop. The clauses now finish the sentence the header starts, and a check reads every tool's header back to keep it that way.

And a run that stopped because every reply was cut off at the provider's output limit was told to try a stronger model. That is the wrong fix: the model was working, it ran out of room. It is now told to ask for shorter replies, one tool call at a time, or to raise the output limit, and only a run that could not format an action is pointed at the model. The counts in that line also agree with their numbers now rather than reading "1 tool blocks".

## 3.3.0 (2026-09-25)

The next-generation work from docs/NEXTGEN.md, and two fixes read out of other harnesses' source.

**Output is cut once, where it enters.** The elision moved from the point of use to the ingestion gate, so the prompt prefix is written once and never rewritten - and a rewritten prefix is a discarded prompt cache, which costs far more than the bytes it saved. Each tool gets its own share of `agent.outputBudget`, because a shell run, a file read, a grep and a directory listing do not deserve the same room, and each keeps the end that matters: a file read keeps its head and names the offset to carry on from, a shell result keeps mostly its tail because a test puts the failure last. The summary line the mask will show later is written at the same moment rather than recomputed. And the bytes the budget cuts are no longer gone: the whole result is written to `~/.atlias/output/` first and the note names the file, so the model can grep what it missed instead of running the command a second time. The model's own turn goes through the same gate.

**A prompt-cache readout.** `/status` shows the share of the prompt the provider said it served from cache, read from the four shapes that exist: `prompt_tokens_details.cached_tokens` (OpenAI, Azure, OpenRouter), `prompt_cache_hit_tokens` (DeepSeek), `cache_read_input_tokens` (Anthropic-shaped gateways) and `prompt_eval_cached_count` (Ollama). A provider that reports nothing is counted as silent, never as a miss, and the silent calls are named separately, so no number is invented where none was given. The `claude` and `codex` engines run their own conversations, and atlias says so rather than showing a zero.

**A throwaway git worktree.** `atlias agent --sandbox` and `atlias exec --sandbox` run the agent in a worktree of the last commit, show the diff when it stops, and change the project only if you take it. A dirty tree is refused out loud and names the files. A folder that is not a git repository says so and runs as usual rather than pretending to isolate. The worktree is removed whichever way the run ends, and the patch is kept either way.

**Eight eval tasks, up from three.** A failing test, a function to add, a test that must keep passing, a change across three files, a rate to read out of a config file, a bug report that is false and whose right answer is to change nothing and say so, a failure whose message blames the wrong file, and one judged by a linter rather than a test. Every task fails before the work is done, and the suite checks that.

**Replies that produce nothing are counted apart from the rounds.** mini-swe-agent keeps that count separately from its step budget and leaves with a typed status; atlias had only `maxToolRounds` and answered in prose, which an eval harness cannot match on. Every way out of the loop now names itself - answered, malformed-output, truncated-output, rounds-exhausted, model-error - and a tool block that did not parse, an edit that did not apply, or a reply cut off at the output limit counts against `agent.maxBadReplies` (default 3), cleared by any round that did something. `atlias eval` carries the reason into every row.

**A reply the provider cut off is never run.** pi-mono and Aider both read `finish_reason` and refuse the tool calls in a truncated message, because truncated JSON still parses: a path cut short or a patch missing its end arrives looking well formed. atlias's `openaiChat` never read the field. It does now, and every call in such a reply is refused rather than run, while still being answered so the next request stays valid. Ollama's `done_reason` is read the same way; that it says `length` was measured here against gemma3:4b.

Also: the pointer-first nudge and skills discovery from the last stretch. The suite is 748 checks across 105 suites.

## 3.2.0 (2026-09-25)

atlias could say what it cost but never whether the work got done. `atlias eval` runs a task corpus: each task seeds its own scratch workspace, the agent works there, and a command decides. The model's claim never scores anything - only the check's exit code does, a claim with no work behind it fails, a checker that cannot run is a failure rather than a pass, and a failed workspace is kept so the failure can be read. The public suites each start a container per instance and there is no Docker here, so the same idea runs locally; `--engine echo` is a dry run that spends nothing. First real run against the local gemma3:4b: one of three tasks finished.

## 3.1.0 (2026-09-25)

The optimisation target for a harness moved from smallest context to highest prompt-cache hit rate, and atlias was on the wrong side of it: `view()` shrank one more old tool result every turn, so every turn rewrote the prompt prefix and threw the provider cache away. The saving from eliding one observation was paid back many times over by re-reading the whole conversation at full price. Eviction now moves in blocks (`agent.evictBlock`, default 4): between two block edges the prefix is byte-identical and can be served from cache. docs/NEXTGEN.md records the research behind it, with sources, and ranks what is still to build.

## 3.0.1 (2026-09-24)

Codex hooks no longer name the versioned plugin folder. `~/.codex/hooks.json` ran every atlias hook from `.../plugins/cache/atlias/atlias/3.0.0/lib/hooks.mjs`, a folder the next update removes, while the MCP server already went through the `~/.atlias/server.mjs` launcher. Hooks now go through `~/.atlias/hooks.mjs`, built from the same launcher source so the two cannot drift, and the CLI line in every instruction block goes through `~/.atlias/cli.mjs`. `atlias doctor` used to pass a hook that pointed into a versioned folder; it now fails it and says why.

## 3.0.0 (2026-09-22)

atlias becomes a harness in its own right, not only a sub-harness. Its terminal agent used to hand the work to another CLI; it now also drives any OpenAI-compatible model or a local Ollama model directly, through a loop built around what weak models get wrong, and `atlias mode both|sub|standalone` decides whether atlias runs inside other harnesses, on its own, or both. That is a change in what atlias is, so the major number moves.

Done means done. The gate checks the claim against the session: a pass claimed with no test run, a pass claimed after a failing run, done with no check since the last edit, placeholders, weakened tests and new code nothing calls, all in one block per prompt because a host lets the gate speak once. In a live run, gemma3:4b claimed it had fixed a bug the tests had just refuted; the gate held the claim and the model took it back.

Two Codex bugs are fixed from Codex's own source. Its apply_patch hook sends the patch in `tool_input.command`, so atlias never saw a Codex edit; and its PreToolUse fails open on `ask`, so the destructive guard let every flagged command run, as it did in Gemini CLI. On hosts that cannot pause a tool, the guard now denies, tells the model to ask, and lets the identical command through once after the user answers.

The agent: Codex's apply_patch format, parsed from Codex's grammar and applied all or nothing; exact-text edits with a syntax guard that puts a broken file back; undo; windowed reads and an outline tool; tool JSON and foreign tool names repaired; native tool calling with a text fallback; observation masking and plan recitation; project AGENTS.md, CLAUDE.md and GEMINI.md in the prompt; the project's own check run by the harness when the model answers after editing; workspace, ask and read-only permissions; alternating-loop detection; saved sessions and `atlias resume`; `atlias exec` with `--json`; and /status, /diff, /review, /undo, /compact, /sessions and /permissions.

Everywhere else: an `atlias` command in any terminal (`atlias shortcut install`, or `npm install -g github:ridelink0/atlias`); `atlias settings`, a menu over every option; a Usage section in the Claude Code brief that states the 5-hour and weekly windows as information, never as a brake, and defers to the user; a Codex plugin manifest; a logo; a README rewritten around what atlias catches; and docs/RESEARCH.md, naming the source behind each mechanism and what has not been measured. A coverage suite now fails the run when any exported function has no test of its own.

## 2.3.1 (2026-09-22)

What can be verified about the host configs now is. The shapes stay marked UNVERIFIED, because nobody here has those tools installed and claiming otherwise would be the pretending this harness exists to stop, but that was never a reason to leave the files unchecked. A new sandbox install runs on all three platforms in CI: it installs into a throwaway home, parses the config.toml it produced with a real TOML parser and every JSON file with a real JSON parser, proves that installing twice changes nothing at all, and proves that uninstalling removes the atlias entry while another server’s entry beside it survives.

## 2.3.0 (2026-09-22)

The platform gap closes by evidence. Everything here was written and run on Windows, the platform assumptions were reasoned about rather than observed, and the last two platform bugs came from exactly that. The whole suite, the command line, the logo, the agent, the bench and an MCP handshake now run on Linux, macOS and Windows across Node 18, 20 and 22 on every push.

## 2.2.8 (2026-09-22)

The doctor proves the launcher instead of assuming it. It checked that the file exists, which says nothing about whether a host would get its tools from it: a broken resolver, a node that is not on the host’s PATH, a half-written file, all look identical to a file that is there. The doctor now starts it, speaks the initialize handshake, and reports the name and version it answered with, which is exactly what a host does a moment later; a crash is reported with its own first line, and silence is not reported as success.

## 2.2.7 (2026-09-22)

The launcher stops depending on the directory it exists to outlive. 2.2.0 pointed host configs at a launcher in the state directory so they would survive an update, and then had that launcher import its resolver from the copy that wrote it, inside the versioned plugin directory that the next update deletes. It would have failed on its first import, in exactly the situation it was written for. The launcher is now self-contained, on node builtins alone, and resolves the newest installed copy first, then the one that wrote it. A suite asserts it imports nothing that can expire, starts with the recorded copy deleted, and says why when there is nothing left to run.

## 2.2.6 (2026-09-22)

The doctor checks the launcher. Host configs point at ~/.atlias/server.mjs, and if that file is deleted every one of them loses its tools in silence: the server never starts and no host says why. The doctor now reports it, and reports whether the launcher can still find an installed copy to run. The README also catches up: forty suites, the launcher, and the two newest refusals, a memory name that would destroy the index and a write outside the project.

## 2.2.5 (2026-09-22)

A write outside the project is a decision, not a detail. The terminal agent guarded shell commands and let the file tools write anywhere, so a local model that resolved a path badly, or followed an instruction from a file it had just read, could overwrite something in the home directory with nobody asked. Writing outside the directory the agent was started in now asks, treats no answer as no, and says what to do instead; a write inside the project is untouched, because that is the work.

## 2.2.4 (2026-09-22)

Two slow leaks. The gate keeps a flag per prompt so it speaks once per turn, and never dropped an old one, so a four hundred turn session carried four hundred keys in a file that is read and rewritten at the end of every reply while only the current turn is ever consulted; it now keeps a short tail. And saving a memory rebuilt the index from its non-empty lines, which silently deleted every blank line, so an index with sections lost its shape one save at a time; the raw lines are now kept and only the entry being replaced is touched.

## 2.2.3 (2026-09-22)

harness_remember could destroy the memory index. The name went straight into a file beside MEMORY.md, and on Windows and macOS the filesystem is case-insensitive, so remembering something called "memory" wrote the body over MEMORY.md itself; the index rewrite that follows then read that body as the index, appended one line and saved it, and every memory line for that project was gone. A model choosing a reasonable-sounding name could do it without doing anything wrong. Those names are now refused before anything is written, with a working alternative in the message.

## 2.2.2 (2026-09-22)

A turn long enough to push its own beginning out of view. The gate finds where a turn started by looking back for the prompt marker in the last 256 KB of the session log, and a turn with thousands of tool calls pushes that marker past the window. The old code then treated the whole window as the current turn: files changed an hour earlier were syntax-checked and named as though they had just been touched, and every such turn shared one flag key, so the gate would speak once and stay silent for the rest of the session. When the marker is not in the tail atlias now reads the whole log, which is rare enough to be worth paying for and correct when it happens.

## 2.2.1 (2026-09-22)

A setting you cannot corrupt, and a doctor that looks where the answer is. `atlias config set brief.memoryChars` with no value stored the empty string, nothing complained, and the clip that reads it silently stopped clipping, because a number compared to an empty string is never greater; a setting now takes the type its default has, refuses anything else with the reason, and prints what actually took effect rather than what was typed. And the doctor decided whether the Claude Code plugin was enabled by reading one settings file when enablement can equally live in the local one, so it told some users to reinstall something they already had.

## 2.2.0 (2026-09-22)

Host configs stop pointing at a directory that will not exist. The installer wrote the absolute path of the running copy into Codex, Antigravity, Gemini and every extra harness, and when atlias runs as an installed plugin that path contains the version number. The next update writes the new version beside it and removes the old one, so every one of those configs is left pointing at a directory that is gone, and the failure shows up one update after the install, which is the hardest kind to connect to its cause. When the running copy sits at a versioned path the installer now writes a launcher into the state directory and points the hosts at that instead; the launcher resolves the newest installed copy at run time, falls back to the one that wrote it, and its own path never changes.

## 2.1.8 (2026-09-22)

Three small ones that each waste somebody’s afternoon. The Ollama client always used the http module, so pointing it at a remote instance over https failed on every turn with a protocol error that named nothing useful; the transport and the port now follow the url, for the health probe as well as the chat. Switching engine mid-session left the resume flag and the old system prompt in place, so the new engine was asked to continue a conversation it had never had. And atlias --version printed the help, which is what everybody types first.

## 2.1.7 (2026-09-22)

The terminal agent could not start its main engine. It built a session id of the form atlias-<uuid> and handed that to Claude Code as --session-id, which takes a UUID and nothing else, so the very first turn of the agent on the claude engine failed; and the retry path only ran for turns after the first, so the one failure a new user would actually hit was the one with no recovery. atlias now keeps its prefixed id for its own files and gives the host a plain UUID, and any refused turn falls back to continuing the most recent conversation instead.

## 2.1.6 (2026-09-22)

Two more places where something grew without a ceiling and was then cut in the middle. For Codex and Antigravity the brief pastes the memory index inline, and cut it at six thousand characters with an ellipsis, mid-line, saying nothing; with eighty memories that silently dropped half of them, and a model reading a truncated index concludes the rest do not exist. It now cuts on a line boundary and says how many it did not list. And the Dream digest listed every session waiting to be consolidated, so a fortnight of them produced an enormous file that the brief tells the model to read; it now shows the ten most recent and accounts for the rest, while ack still consolidates all of them.

## 2.1.5 (2026-09-22)

The instruction block called every harness Antigravity. It mapped two host ids to their names and everything else to Antigravity, and the extra harnesses passed their own id into it, so the rules file written into Cursor, Windsurf, Kiro, Zed, Amp, Trae, Cline, Continue, CodeBuddy, Hermes, Droid and Aider each opened by telling that tool it was Antigravity. Nothing broke, which is exactly why it survived: it simply told twelve harnesses the wrong thing about themselves on every turn. Cursor also reads its rules only from a .mdc file that carries frontmatter, so one is now written when the extension calls for it, once, not stacked on every install.

## 2.1.4 (2026-09-22)

Stop paying for a turn that did nothing. The handoff note was rewritten at the end of every reply, including one that only answered a question, which cost a file write and a git process for a turn with nothing to hand off, and replaced a note from a turn that did have something to say with one that does not. The note is now written only when the turn changed a file or ran a command. And within a single reply git status ran twice, once for the note and once to find edits made outside the tools; one memo now serves both, and expires after two seconds so it never reports yesterday.

## 2.1.3 (2026-09-22)

Three unbounded things, bounded. Event lines are appended by several processes at once, a hook for this turn, a subagent’s hook, a second session in the same project, and a write under about four kilobytes lands atomically while a longer one can interleave with another and corrupt both; a patch touching forty files was already capable of producing one, so an event is now trimmed to fit and says how many entries it dropped. One bench call could read four megabytes from each of twenty session logs to print a summary of them, and now reads a bounded sample. And the MCP server buffered incoming bytes with no ceiling while waiting for a newline, so a client that never sent one grew the buffer until the process died.

## 2.1.2 (2026-09-22)

The hook could cut its own answer in half, on the platforms not tested here. Every hook wrote its JSON to stdout and called process.exit on the next line. Node documents its own I/O as synchronous for pipes on Windows and asynchronous for pipes on POSIX, and process.exit does not wait for an asynchronous write, so a long brief could arrive truncated on macOS and Linux and be discarded as malformed. A probe on this Windows machine confirms the old code survived there, which is exactly why it went unnoticed: the platform that is safe is the one it was written on. The process now sets an exit code and lets the write drain, with an unreferenced ten second backstop so a stuck handle still cannot hold up the host. A suite writes a brief of over two hundred thousand characters and fails if a single one goes missing, and it will catch a regression on any platform.

## 2.1.1 (2026-09-22)

Two bugs that destroyed work rather than merely annoying. Recording the next step with harness_progress rebuilt the entire handoff note under a placeholder session id, so the one tool whose job is to preserve state across a compaction was wiping the files, checks and prompts the Stop hook had written into it; it now rewrites only the Next section and leaves the rest alone. And when two sessions for the same project ended at the same moment, the second took the Dream lock, failed, and returned without writing anything, losing that session entirely; the digest row is now appended before the lock is taken, with only the tidying serialised, because a skipped prune costs nothing and a lost session costs everything.

## 2.1.0 (2026-09-22)

The gate stops trusting only its own event log. It knew a file had changed because it saw an edit tool touch it, so anything written another way was invisible: a heredoc, sed in place, a generator, a formatter, a script the model ran. Those are precisely the edits nobody reviews. In a git repository the gate now asks git what actually changed since this turn began, adds what it did not already know, and names those files separately in its message, because they are the ones that went through no review at all. Files dirty from before the turn are left alone.

Versioning from here: the patch digit is a bug fix, the minor digit is a feature or a behaviour change, and the major digit is a change in what atlias is. The 1.x entries below moved the minor digit for plain bug fixes, which is how one day of work ran from 1.0.0 to 1.9.1. Rather than renumber them, which would collide with plugin caches already holding those directories, the correction starts here.

## 2.0.0 (2026-09-22)

What atlias is has changed since 1.0.0, so this is the major that should have marked it: it stopped being only a sub-harness and became a thing you can also run on its own. A terminal agent with its own wordmark and ship, three engines behind it, fourteen more harnesses it can link into, a tenth tool, and a bench that measures its own cost. No behaviour changes in this release beyond the number itself and the rule it now follows.

## 1.9.1 (2026-09-22)

A graph that found nothing said so in a wording atlias did not recognise, so "No matching nodes found." was injected into the prompt as though it were a finding. It now recognises the refusal in every wording graphify uses, bounded by length so a real answer that happens to open with those words is still kept.

## 1.9.0 (2026-09-22)

Two things that were quietly wrong in daily use. recall could return eight memory bodies at seven hundred characters each, so the tool whose whole point is to be the cheap way to a fact could cost more than reading the file would have; it now works to a budget and counts what it left out instead of truncating in silence. And the bench counted interventions only from finished sessions, so during the session you were actually in it always reported zero, which reads as the guard never firing rather than as nothing having been written down yet; it now reads the logs of sessions still open and says how many of those there are.

## 1.8.0 (2026-09-22)

The guard stops re-reading the whole session on every tool call. Each call appends a line to the session log, and the guard parsed the entire file to decide whether the call was a repeat, so a four hundred turn session meant thousands of lines parsed thousands of times. The harness was getting slower exactly as the session got long, which is when it is needed most. The guard, the gate and the handoff note now read only the tail of the log, which is all any of them looks at, and Dream still reads the whole file once at session end where that is the right thing to do. A suite builds a log of twenty thousand events and fails if five guard calls take a second between them.

## 1.7.0 (2026-09-22)

Two ways the harness could mislead, closed. A graph built before this session answered with exactly the same confidence as a fresh one, so an injected answer is now marked as possibly out of date when files have changed since the graph was built, and the mark clears itself when the graph is rebuilt. And the second-pass gate quoted its syntax check even on turns where every changed file was one atlias cannot parse; it now says plainly that it reached no floor and that the project’s own check is the only one.

## 1.6.0 (2026-09-22)

The verification tool no longer claims a check it never ran. atlias parses JavaScript, JSON and Python by itself; given a TypeScript, Go, Rust or Swift file it used to check nothing and still answer that the files parse, which is the exact shape of claim the harness exists to stop. It now reports what it checked, what it could not, what does not exist, and what to run instead. The verification detector also learns the runners projects actually use, from go test and cargo clippy to flutter test, dotnet test, rspec and pyright, so a real check stops looking like no check at all. And recall searches the handoff note, which is usually where the answer to where was I already is.

## 1.5.1 (2026-09-22)

Two defects found by reading for platform assumptions rather than by running on a platform I do not have. The Codex MCP entry wrote the server path as a TOML literal string and doubled any apostrophe in it, but literal strings take no escapes at all, so a user named O’Brien would have ended up with a config.toml that does not parse, which stops Codex rather than just atlias. And the check for the home directory folded case on every platform, where on Linux and macOS two paths differing only in case are two different directories, so a project could be mistaken for home and quietly never get a graph. A platform suite now covers both, plus slug stability and hook quoting across path shapes.

## 1.5.0 (2026-09-22)

The bench reaches the model. A tenth MCP tool, harness_bench, lets a session ask what the harness is costing it and what a graph answer replaced, on this project, with no model call. The skill table points at it, so it costs nothing until it is wanted. The README now states the measured numbers with the upper-bound caveat attached, and says fifteen suites because there are fifteen.

## 1.4.1 (2026-09-22)

The bench pointed at the harness itself. The session brief was 5,134 characters on this project, most of it a handoff note allowed 4,000 of them, listing up to thirty files and twenty lines of git status. The note is now capped at 2,400 characters and carries the last four prompts, fifteen files with a count of what it left out, and twelve lines of status. A test builds a deliberately noisy session and fails if the brief passes 4,200 characters, so the one cost paid on every session cannot drift back up unnoticed.

## 1.4.0 (2026-09-22)

A bench. The cost claims are now numbers measured on the project in front of you: what the session brief costs, what a graph answer costs against opening the files it names, and how often the guard and the gate actually interrupted across the sessions already recorded. No model is called, every estimate is labelled as one, and the report ends by naming the thing it does not measure, which is whether any of it changes how often a task succeeds.

## 1.3.0 (2026-09-22)

Reliability inside the host's hook budgets. On a machine without graphify the interpreter search could probe six candidates at fifteen seconds each and remember nothing, so a SessionStart hook could exceed its own timeout and leave the user with no brief at all, every session. The search is now time-boxed, skips paths that are not on disk, and remembers a miss for an hour; the graph's directory walk happens once instead of twice and has a wall clock; the hub lookup is skipped rather than allowed to overrun; a CLI version probe is five seconds rather than twenty minutes; and the SessionStart budget is declared identically to Claude Code and to Codex. A new suite asserts the invariant directly: the work a hook can do must fit inside the timeout it declares.

## 1.2.0 (2026-09-22)

The ship and the terminal. `atlias` with no arguments now asks whether to link as a sub-harness or fly as a regular agent, under a blue block-letter wordmark with a small ship beside it (truecolor, 16-colour and plain-text fallbacks, and a one-line form for narrow terminals). `atlias agent` runs the loop in the terminal with Claude Code, Codex or a local Ollama model as the engine, with the guard, the gate, the graph router, the handoff note and Dream all in place. Fourteen more harnesses can be linked, each in its own config shape, and only when it is actually installed. Guard fix: a recursive delete of the home directory with a trailing slash is now caught.

## 1.0.0 (2026-09-21)

First release. Session brief, graph router, loop and destructive guards, verification gate, handoff notes, Dream digests, MCP server with nine tools, installers for Codex, Antigravity and Gemini CLI, and a nine-suite test runner whose failures explain themselves.
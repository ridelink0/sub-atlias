# atlias: the guide

Everything the README keeps short. Benchmarks are in the [README](../README.md#benchmarks); where each mechanism comes from is in [RESEARCH.md](RESEARCH.md).

## Sub-harness, agent, or both

```
atlias mode both         # the default: hooks in every host, and the agent in a terminal
atlias mode sub          # hooks only; typing atlias shows the status
atlias mode standalone   # agent only; the hooks stay silent in other harnesses
```

`atlias` with nothing after it follows the mode: in `both` it asks which you want, with a third choice for settings. `atlias settings` opens a menu over every option, each with a sentence on what it does; `atlias settings list` prints them.

## The agent

The interactive agent opens the terminal composer by default, with the start
screen, prompt box, live slash palette and session footer. Type `/` to list
commands, use the arrows to select, Tab to complete and Enter to send. Set
`atlias config set ui.terminalEnabled false` to opt out, or reset the setting
to restore the default. Restart Atlias after changing it. Non-TTY input and
terminals without supported raw input use line mode.

```
atlias                          # choose, then fly
atlias agent [--engine claude|codex|openai|ollama|echo]
atlias exec "fix the failing test" [--json]      # one prompt, no questions, scriptable
echo "add a --verbose flag" | atlias exec
atlias resume [id]              # carry on the last session in this folder
```

Engines: Claude Code (`claude -p`, resumed by session id), Codex (`codex exec`), **any OpenAI-compatible endpoint** (OpenAI, OpenRouter, LM Studio, vLLM, llama.cpp: set `agent.openaiModel`, `agent.openaiUrl`, and `ATLIAS_API_KEY` or `OPENAI_API_KEY`), or a local Ollama model. The last two run on atlias's own tool loop, which does for a weak model what a strong one does in its head:

- **It repairs what weak models write.** Single quotes, bare keys, trailing commas, Python `True`, raw newlines in strings, bad escapes and JSON cut off at the token limit are repaired; `bash`, `str_replace`, `file_path` and the rest of other harnesses' vocabulary are mapped onto atlias's tools; native function calling is used where the endpoint has it, with a fallback to text blocks where it refuses.
- **It edits the way the model was trained to.** Exact-text `edit_file` that must match once, and Codex's own `apply_patch` format, parsed from Codex's grammar, applied all or nothing, and accepted when sent through the shell the way Codex models send it. An edit that would break the syntax is refused and the file put back. Every change can be undone with `/undo`.
- **It reads in windows.** Numbered lines, a window at a time, an `outline` of definitions before any reading, and a note instead of a second copy when the same window is read again unchanged.
- **It keeps the context small.** Old tool results shrink to one line, output keeps its head and its tail (errors come last), the plan is repeated after every result, and project `AGENTS.md`, `CLAUDE.md` or `GEMINI.md` files ride in a prompt prefix that does not change between calls.
- **It checks for the model.** When the model answers after editing, atlias runs the project's own check itself (found from `package.json`, `Cargo.toml`, `go.mod` or pytest, or set in `agent.testCommand`) and hands back the result. If there is no check, the model is sent back once to run one. Out of rounds is reported as unfinished, never as done.
- **It asks first when told to.** `/permissions workspace` (edits in the project run), `ask` (every edit and command asks), `read-only` (plan mode).

Inside: `/status`, `/diff`, `/review` (the engine reviews the uncommitted changes), `/undo`, `/compact`, `/plan`, `/sessions`, `/permissions`, `/engine`, `/graph`, `/recall`, `/progress`, `/settings`, `/doctor`.

## In every host

1. **Session start**: one brief. The handoff note from the last stretch, the memory index, the knowledge graph's hubs, and pending Dream digests. Atlias keeps provider-account usage inside the provider; its terminal display shows only its own measured token counts.
2. **Each prompt**: silent, unless it is a codebase question and a graph exists, in which case the graph answers in a few hundred tokens before any file is read.
3. **Before each tool**: silent, unless the call is a loop or the command is destructive. Codex and Gemini CLI cannot pause a tool for the user, so there the command is stopped, the model is told to ask, and the identical command goes through once after you answer.
4. **After each tool**: records the files changed and the checks run, with their outcome read from the tool's own response. Silent, with one exception: when a whole file was read that the knowledge graph could have answered, atlias says so once for that turn and names the query that would have done it. The read is never blocked, and the note is held back unless a graph exists, the graph was not already asked this turn, the file is large enough that asking would have been cheaper, your prompt did not name it, and nothing in the session wrote it.
5. **Compaction**: writes the handoff note before and puts it back after.
6. **End of a reply**: the gate described above.
7. **Session end**: a background worker distils the session for the model to fold into memory later.

Hosts: **Claude Code** (plugin), **Codex** (hooks, MCP, AGENTS.md), **Antigravity** (MCP, GEMINI.md), **Gemini CLI** (MCP, optional hooks), then Cursor, Windsurf, OpenCode, Amp, Zed, Kiro, Droid, Aider, Trae, Cline, Continue, CodeBuddy, Hermes and Pi, each in its own config shape. MCP tools, shared by all of them: `harness_recall`, `harness_remember`, `harness_progress`, `harness_verify`, `harness_digest`, `graph_query`, `graph_affected`, `graph_explain`, `harness_bench`, `harness_status`. Memory is written in Claude Code's own format, so every host shares one memory.

With `flags.subagentsApart` enabled, worker hook events, verification state, exact request/skill ledgers and generated handoff notes are actor-specific. The MCP `harness_progress` tool intentionally shares the parent project note and `next.md` across hosts and workers; MCP provides no trusted actor identity. Use it for shared project steering, not private worker notes. This flag does not isolate the working directory or shared MCP state. `flags.authorityBodiesOnce` separately renders identical selected skill bodies once in the same authority context while retaining every occurrence and amended body; both flags default off.

## Tests

```
node test/run.mjs
```

1,271 checks in 192 suites, each written from one expert's point of view, and each failure printed as what happened, why it matters and how to fix it. A coverage suite fails the run if any exported function is not exercised by a test through its own module, so a feature cannot arrive untested. Host payloads are pinned to the hosts' own source code, not to guesses. CI runs everything on Linux, macOS and Windows under Node 18, 20 and 22, plus a sandboxed install that parses every config atlias writes with a real parser and proves that uninstall leaves other tools' entries alone.

## What it refuses to pretend

- It names what it did not check, and marks a stale graph as stale.
- It reports a test run it cannot read as unknown, never as a pass.
- It tells the agent when it ran out of rounds rather than letting that read as an answer.
- It never invents a cache number: `/status` shows the share of the prompt the provider said it served from cache, counts the calls that reported nothing separately, and says plainly that the `claude` and `codex` engines run their own conversations so atlias never sees their token counts.
- It will not run a tool call out of a reply the provider cut off at its output limit, because truncated JSON still parses and the arguments may be quietly wrong.
- It says which way a run ended rather than leaving them all to read alike: answered, malformed output, a reply cut off, rounds exhausted, or a failed model call.
- It shows the caveat with the number: `atlias bench` measures token cost and says it has not measured task success.
- It says, in [RESEARCH.md](RESEARCH.md), which source each mechanism comes from and what has not been measured. What has been is in the [README's benchmarks](../README.md#benchmarks): with one local model its solve counts sit inside the noise of three other harnesses at a half to a third of their tokens. Whether it helps Claude Code or Codex finish more tasks is not measured.

## Measured

`atlias bench` in any project prints numbers, not claims. On atlias itself: the session brief costs about 1,000 tokens once per session, and one graph answer about 600, against an upper bound of about 26,000 for opening in full the files that answer names.

## Scoring the harness

```
atlias eval                    every task in evals/, with the engine you use
atlias eval --engine echo      a dry run: every task must fail before any work is done
atlias eval --save a.json      keep the report, so a later run can be compared with it
atlias tiers                   the three benchmark tiers, and which are on this machine
atlias eval --tier main --sample 24 --seed s    one tier, the same subset every time
atlias eval --rounds 14        override every task's own round budget, and say so in the report
atlias eval --save a.json --resume   carry on an interrupted run; the report is written after every task
atlias eval --work D:/scratch  where the scratch workspaces go (default: atlias-evals in the temp folder)
atlias compare a.json b.json   the paired question: which tasks flipped, and could a coin have done it
atlias eval --help             the options, and nothing else runs
```

Code the model wrote runs under a watchdog: at its limit (two minutes for a shell
command, the task's own limit for the check) it is ended with every process it
started, a background process a task leaves behind is ended when the task is
scored, and an eval whose starter goes away stops instead of running on.
`tools/h2h/mini_swe_runner.py` runs mini-swe-agent on the same task files with
the same safeguards, so `atlias compare` can pair the two harnesses task by task.

Three tiers: **smoke** (the nine tasks that ship here), **main** (HumanEvalFix
Python and CanItEdit lazy - one-function fixes and short instruction edits) and
**big** (Aider's refactor benchmark: one method out of one class in a real source
file, graded on the AST). The main and big corpora are generated from published
datasets rather than committed - [`evals/CORPORA.md`](../evals/CORPORA.md) has every URL, licence and
regeneration command, and `atlias tiers` prints the command for whatever is not
here. Every converted task was proved on the machine that converted it: it has to
fail as shipped and pass with the benchmark's own reference, or it is refused with
the reason.

Two scores on a corpus this small are not a result. `atlias compare` pairs the
two runs task by task and reports McNemar's exact test on the tasks that changed,
a Wilson interval per arm, a paired Beta interval on the disagreements, and how
many one-way flips would have been needed before any p below 0.05 was reachable -
six, whatever the corpus size - so "4 of 9 beats 3 of 9" is judged rather than
eyeballed. With `--repeat k` it pairs on each task's pass fraction, so a task is
one disagreement however many attempts it ran. A failed edit is also counted by
cause (not-found, no-file, ambiguous, bad-patch and the rest) beside the
apply-failure rate, and a failing task says how much of its check passed when the
check counts its cases.

Eight tasks, each a small project written into a scratch workspace that the
agent then has to fix: a failing test, a function to add, a test that must keep
passing, a change across three files, a rate that has to be read out of a config
file, a bug report that is false and whose right answer is to change nothing and
say so, a failure whose message blames the wrong file, and one judged by a
linter rather than a test. **The model's claim never scores a task** - a command
does, and its exit code is the whole verdict. Every row says how the agent
stopped, so a task that failed because the model could not send a usable action
reads differently from one that ran out of rounds.

## A throwaway worktree

```
atlias agent --sandbox
atlias exec --sandbox "<prompt>"
```

The agent works in a git worktree of the last commit, the diff is shown when it
stops, and the project changes only if you take it. A dirty tree is refused out
loud and names the files, because a worktree is checked out from the last commit
and the agent would not see uncommitted work. A folder that is not a git
repository says so and runs exactly as it would without the sandbox, rather than
pretending to isolate. The worktree is removed whichever way the run ends, and
the patch is kept either way, so a dropped run is still recoverable.

## Settings

`atlias settings`, or `atlias config set <section.key> <value>`. The keys, each described in the menu: `verify.*` (syntax, second pass, integrity, placeholders, weakened tests, unwired code), `guard.*`, `graph.*`, `brief.*`, `recall.*`, `dream.*`, `router.*`, `pointer.*` (the pointer-first note: on or off, the size below which a whole-file read is left alone, and how many notes a session may spend), and `agent.*` (mode, engine, endpoints, permissions, test command, rounds, observations kept, `outputBudget` for how much tool output may enter the context, `maxBadReplies` for how many replies in a row may produce nothing before atlias stops and says which kind, and `sandbox` for the throwaway git worktree). State lives in `~/.atlias/` (`ATLIAS_HOME` overrides it).

## Skills

atlias reads the skill format the hosts already use rather than adding one of its own: a folder holding a `SKILL.md` whose frontmatter carries a name and a description. It looks in what atlias ships, `~/.claude/skills`, `~/.codex/skills`, and the project's own `.claude/skills` or `.codex/skills`, with the nearer folder winning a name clash. `atlias skills` lists them with what each is for, `atlias skills <name>` prints one, and `/skills` does both inside the agent. The agent's system prompt carries no skill index by default (`agent.skillIndex off`): the index of every installed skill was about 1,440 characters on every call, and no benchmark run used a skill. `relevant` names at most five skills that share words with the request, with the path to read each and how to list the rest, chosen with no model; `all` is the old index, one path per folder and the names under it. Whatever the setting, the agent opens a skill with the read tool it already has, and a skill's own instructions are never shortened. atlias does not run or install skills; the hosts stay the ones that do.

## Surviving an update

No host config ever holds a path with a version number in it, because the next update deletes that folder. Hosts point at `~/.atlias/server.mjs` and the terminal command at `~/.atlias/cli.mjs`; both find the newest installed copy when they run.

## Versioning

Plain semantic versioning: patch for a fix, minor for a feature or a behaviour change, major for a change in what atlias is. A test ties the changelog to the version in every manifest.


<p align="center"><img src="assets/atlias-banner.svg" alt="atlias" width="100%"></p>
<p align="center">The coding-agent harness that spends fewer tokens and will not call unfinished work done.</p>
<p align="center">
  <a href="https://github.com/ridelink0/atlias/actions/workflows/test.yml"><img alt="tests" src="https://github.com/ridelink0/atlias/actions/workflows/test.yml/badge.svg" /></a>
  <img alt="node 18 or newer" src="https://img.shields.io/badge/node-%3E%3D18-3b82f6?style=flat-square" />
  <img alt="no dependencies" src="https://img.shields.io/badge/dependencies-0-3b82f6?style=flat-square" />
  <img alt="MIT" src="https://img.shields.io/badge/license-MIT-3b82f6?style=flat-square" />
</p>

---

### Installation

```bash
# The atlias command, from anywhere
npm install -g github:ridelink0/atlias

# Claude Code
/plugin marketplace add ridelink0/atlias
/plugin install atlias@atlias

# Codex
codex plugin marketplace add ridelink0/atlias
atlias install --codex

# Every other harness already on this machine
atlias install
```

> [!TIP]
> `atlias doctor` checks the whole install. `atlias uninstall` removes exactly what `atlias install` wrote and nothing else.

The website offers **curl, npm and Bun** instructions for the public Free sub-atlias package. These downloads do not install the full Atlias app.

### Two ways to run it

- **Sub-harness** - inside Claude Code, Codex, Antigravity, Gemini CLI and fourteen other harnesses: a shared memory, a knowledge graph, loop and destructive-command guards, and a gate that holds a reply until the work behind it is real.
- **Agent** - typed as `atlias` in any terminal, using its own tool loop with a connected Claude plan, ChatGPT, a provider API or a local Ollama model. Choose a connection on first open, then describe a task.

```bash
atlias                     # choose, then fly
atlias exec "fix the failing test"
atlias mode both           # or sub, or standalone
```

No dependencies. Node 18 or newer.

### Choose a model for each subagent

In the full Atlias app, your main agent can delegate a separate task to a worker on another connected engine and model. Keep Claude in charge and ask a ChatGPT model to review a file, or choose a smaller model on the same connection. You can do this for a different perspective, to share work between subscriptions, or to manage usage; savings depend on the task and are not guaranteed.

```text
/agents                                 Show worker defaults and connected engines
/agents chatgpt MODEL                    Choose a ChatGPT worker model
/agents claude-plan claude-haiku-5-5      Choose a Claude worker model
/agents inherit                         Follow the main agent again
/agents off                             Disable workers
/agents on                              Enable workers
```

Replace `MODEL` with an available model from that account. Connect providers first with `/auth` or `/onboarding`. Choosing a worker default does not change the main agent's model. You can also request a particular worker engine/model in plain language; Atlias's agent tool accepts optional `engine` and `model` fields for that task.

Before a worker uses a **different connection**, Atlias shows the model and its subscription or API billing and asks for approval. No approval means no worker on that connection; there is no automatic billing fallback. Each worker launch needs its own approval. **Main-agent `/effort max` or `/permissions max` skips this connection approval**, as requested by Gev. Other permissions, model availability and sign-in requirements still apply. API keys use separate API billing; subscriptions are not transferred or merged. A noninteractive run refuses an unapproved connection change unless one of those max settings applies.

Workers have separate conversations, at most 20 rounds and one level of delegation. Their results return to the main agent; selected routes are shown while they run and their reported usage joins session accounting. Stop the parent turn to stop its provider requests. Give parallel workers separate files.

### Make it yours

`/settings` starts with common options. Type `/image` to search, `section ui` to browse a group, `changed` to review your choices, or `all` for every option. Select by the number shown or the exact `section.key`; `reset section.key` restores its default. The same settings are available with `atlias config set <section.key> <value>` in sub-atlias mode. Terminal usage display, placement, color and animation, provider/model/effort, worker defaults, checks, permissions and attachment limits are configurable. `/help <command>` shows focused usage and examples, including custom commands.

For appearance, use `/config ui.accentColor amber` or a hex color; `atlias` restores the original blue and `none` uses plain text. `/config ui.compactWelcome true` shortens the header; `/config ui.showHints false` hides keyboard tips. Restart Atlias after changing the accent or welcome. The default retains Atlo beside the original wordmark. Large settings groups use `next` and `prev`; select an option to read its full explanation. In the terminal composer, Ctrl+S stashes or restores an unsent draft, or swaps two drafts. The stash stays in memory for this terminal session and is separate from permission answers.

Use `atlias agent --plain` (or `atlias resume --plain`) for a session with line input and append-only, sanitized output, including when token usage is enabled. This is separate from the `none` accent, which removes color but retains the composer. `/help keys` describes the current input mode. Settings show a value choice before changing a boolean; pressing Enter leaves it unchanged. While a task runs, Enter queues a message and leaves a fresh draft; unsent text stays available as queued work finishes. Submitted queue entries can be recovered from input history. If a question cannot fit in the terminal, resize before answering or use Ctrl+C to clear and then cancel it.

The model bar lists every available connection's account allowance. Claude uses the local Claude usage cache (or a newer Usage Limits snapshot); the explicit Codex host uses its local Usage Limits cache. These reads never access credentials or call a provider. Cached, stale, expired and unreported readings are labelled. Dedicated ChatGPT and API connections show their own reported session tokens; their account allowances remain unknown when the provider has supplied no reading. `/usage` shows all connection rows, including those that do not fit a short terminal. `/cost` shows this conversation's tokens separately.

`/resume` and `atlias resume` open a searchable session list. Type a title, request, engine or id; use Up/Down and Enter to choose, or Esc to keep your current chat. Plain mode offers a numbered list and search prompt. `/resume <id or name>` opens an exact saved session; `atlias resume last` explicitly opens the latest one. Sessions from another project are refused.

Attachments stay inside the project by default. To attach an image elsewhere, explicitly enable `/config attachments.allowExternal true`, then mention its quoted absolute path. This opt-in covers images only; outside text files and `.git` contents stay excluded. Your selected model receives the image when you send.

Attach a project image with `@image.png` or `@"image with spaces.png"`, alongside text references such as `@"notes one.txt"`. PNG, JPEG and WebP reach supported direct model connections as image inputs; the selected model must support vision. Atlias keeps the typed request separate from reference-file contents. `/attachments` shows image names and sizes; `/attachments clear` removes image payloads from future requests and saves the chat. `/config attachments.detail high` requests OpenAI image detail; `/config attachments.enabled false` disables images. Model/provider limits and billing still apply. Text estimates exclude image processing; provider-reported usage remains authoritative.


**Sub-atlias:** the public plugin works inside a native host such as Claude Code or Codex. Its setup, launch identity and help use the same beginner guidance, while the host owns its prompt and native worker/model controls. The full app's `/agents` command does not intercept or replace those native tools. The full app is not publicly on sale yet.

### Benchmarks

Use your own API endpoint, model and optional token prices with the native
subharness: `atlias sub --host claude|codex --profile provider.json`. Follow-ups
stay in the native session. See [API setup and measured cost estimates](docs/API-SUBHARNESS.md)
for supported protocols, credentials and resume commands. These optional
features do not establish a 20x benchmark result.

Every number below was measured, on one consumer PC, with a local 9-billion-parameter model (`qwen3.5:9b` through Ollama, a 16,384-token window, replies capped at 2,048 tokens, unless a section says otherwise). A task counts as solved only when its hidden check, a command, exits 0; what the model says about its own work never scores. Tokens per solve is every prompt and output token of the run divided by the tasks solved.

#### Against plain Claude Code

Atlias's own agent against plain Claude Code 2.1.302, the same local model at a 32,768-token window, the same 60 tasks twice (120 matched pairs), step budgets and grader (2026-10-17). The plain arm was measured once and reused for every screen.

| Screen | Atlias solved | Plain Claude Code solved | Fewer total tokens |
| --- | --- | --- | --- |
| 1 | 86 / 120 | 80 / 120 | 22.51x |
| 2 | 83 / 120 | 80 / 120 | 22.36x |
| 3 | 79 / 120 | 80 / 120 | 14.02x |
| 4 | 82 / 120 | 80 / 120 | 15.48x |
| 5 | 89 / 120 | 80 / 120 | 19.66x |
| 6 | 85 / 120 | 80 / 120 | 19.63x |
| 7 | 85 / 120 | 80 / 120 | 23.42x |
| 8 | 83 / 120 | 80 / 120 | 20.95x |
| 9 | 82 / 120 | 80 / 120 | 22.91x |

- Pooled over the nine screens: **19.52x fewer tokens** (a ratio of pooled token totals; the mean of the nine ratios is 20.1x). Screen 1: 10,195 tokens per solved task against 246,712.
- Atlias solved at least as many as plain Claude Code on 8 of 9 screens, but a few tasks were lost on most screens (79_int_to_key in nearly every one), so "20x with no task lost" is not met yet.

**Sub-atlias inside Claude Code** (the free plugin), a ten-task smoke on the same model (2026-10-16, one run per arm, a lead): Claude Code with sub-atlias 250,143 tokens against plain Claude Code's 659,112, **2.63x fewer**, both solving 8 of 10. That trial build carried two Claude Code mods (tool deferral and a short skill listing) that the public 4.0.1 package does not ship yet, and it has not been measured against a Claude plan's 5-hour limit.

**On a Claude plan** (the `claude-plan` engine, Opus 5.5 at effort xhigh, 2026-10-23): over the five tasks measured in every run, a 1-hour prompt cache cost $1.075 at API prices for 196,855 prompt tokens and a 5-minute cache $0.827 for 192,678, so one-shot runs now write the 5-minute cache.

#### Against other harnesses

The same 60 tasks, model, window, step budgets and grader for every row (2026-10-12).

| Harness | Solved | Tokens per solve | Largest prompt |
| --- | --- | --- | --- |
| **atlias 3.8.1** | **44 / 60** | **30,007** | **7,578** |
| mini-swe-agent | 41 / 60 | 34,174 | 11,734 |
| nanobot 0.3.5 (stock) | 40 / 60 | 92,348 | 13,298 |
| OpenCode (stock) | 38 / 60 | 62,831 | 12,671 |

Read it the way it was measured:

- **The solve counts are inside the noise.** The same atlias configuration solved 39 of these 60 tasks in a second run, so 41.5 is its honest centre; nanobot and OpenCode split 6 to 4 on the tasks only one of them solved, which chance alone does three times in four.
- **The token counts are not close.** atlias spent about a third of what nanobot did for each solved task and about half of what OpenCode did.
- mini-swe-agent's 34,174 counts its assistant replies only; with the 22 replies its runner does not count it is 36,237.
- 47 of the 60 tasks were solved by at least one harness, 30 by all four, 13 by none.

#### Full corpora

Every task of seven benchmark sets, 596 in all, one run each (2026-10-10 and 2026-10-11).

| Set | Solved | Tokens per solve |
| --- | --- | --- |
| HumanEvalFix, Python | 136 / 164 | 23,721 |
| HumanEvalFix, JavaScript | 121 / 163 | 22,781 |
| CanItEdit, descriptive instructions | 51 / 88 | 49,072 |
| CanItEdit, lazy instructions | 39 / 88 | 61,848 |
| Aider refactor, graded on the syntax tree | 24 / 57 | 255,560 |
| Aider polyglot, Python | 13 / 27 | 202,147 |
| atlias's own nine plumbing tasks | 9 / 9 | 16,201 |
| **All** | **393 / 596 (65.9%)** | **50,393** |

Two larger fixed samples of the main tier: 178 of 250 (71.2%) at 30,296 tokens per solve, and 88 of 120 (73.3%) at 30,159.

#### Where the tokens go

Measured on the 60-task run above:

| Finding | What atlias does about it |
| --- | --- |
| The opening block (system message, tool list, task) is re-sent on every call: **48.8% of all prompt tokens**, at 8.4 calls a task | It is the first place to cut |
| An index of installed skills was about 1,440 characters of that block, and no run used a skill | `agent.skillIndex` is **off by default**; `relevant` names at most five skills that share words with the request and says how to list the rest |
| Four of eleven tools are 45% of the tool list a model reads in text mode (1,195 characters down to 659), and 42% of the schemas in native mode | `agent.toolSet core` offers the other seven; off until a paired run shows no loss |
| 80% of prompt tokens were served from the model server's cache | Old tool results are masked in blocks, so the cached prefix survives |

A change like these is kept only when a paired run shows fewer tokens with no loss of solved tasks. `atlias compare a.json b.json` does the pairing: which tasks flipped, and whether a coin could have done it.

#### Inside Claude Code

`atlias bench`, on atlias's own repository: the session brief costs about 1,000 tokens once per session, and one knowledge-graph answer about 600 tokens against an upper bound of about 26,000 for opening in full the files that answer names.

#### What has not been measured

- Whether atlias changes how many tasks Claude Code or Codex finish. Their engines run their own conversations and atlias never sees their token counts.
- Any model other than the one above, at any scale beyond these tasks.
- Every row is one run unless it says otherwise. A lead in a single run is a lead, not a result.

Reproduce any of it: `atlias tiers` lists the benchmark sets and how to fetch them, `evals/CORPORA.md` has every source and licence, and `atlias eval --tier main --sample 60 --seed s --save a.json` runs one.

### What it catches

The most expensive thing an agent does is say it finished when it did not. atlias checks the claim against what happened in the session and holds the reply once, with every finding in one message:

| The agent | atlias sees |
| --- | --- |
| says the tests pass, but ran none | a pass claimed with no test run on record |
| says the tests pass after a failing run | the failure, quoted from the run's own output |
| says done after an edit, with no check since | no verification after the last edit |
| leaves `TODO`, `...rest of the code`, placeholder data | the lines, from the diff |
| skips, focuses or deletes a test, or asserts `true` | the weakened test, from the diff |
| adds a function nothing calls | the definition, and that no other line names it |
| saves a file that does not parse | the parser's own error |
| repeats a call, or swaps between two calls | the loop, stopped with what to change |
| runs `rm -rf ~`, a force push, a dropped table | a question to the user first |

Nothing it did not check is claimed: a file it cannot parse is named as unchecked, and a test run it cannot read is recorded as unknown, never as a pass.

### Tests

```bash
node test/run.mjs
```

1,271 checks in 192 suites, each failure printed as what happened, why it matters and how to fix it. A coverage suite fails the run if any exported function has no test of its own. CI runs everything on Linux, macOS and Windows under Node 18, 20 and 22.

### Documentation

- [The guide](docs/GUIDE.md) - the agent and its engines, what atlias does in every host, scoring a harness, the sandbox, settings, skills, updates and versioning
- [Research](docs/RESEARCH.md) - where each mechanism comes from and what is still unmeasured
- [The benchmark ledger](docs/ULTIMATE-BENCHMARK.md) - every benchmark family and the evidence each one needs
- [Corpora](evals/CORPORA.md) - sources, licences and how to regenerate each set

### Known limits

Claude Code can show `Claude Code + atlias` in its supported status line. `atlias install --claude` enables it after a successful plugin install; `atlias statusline install` enables the label on an existing installation. Existing status details are preserved. `atlias statusline remove` restores the previous status line while Atlias still owns that setting.

The Claude-plan engine uses the Claude Agent SDK's bundled runtime for one model turn at a time, with its tools, plugins, MCP servers and settings disabled. Atlias runs the task loop and every tool. This is separate from the explicit Claude Code host-harness engine. Each person signs in with their own eligible account; credentials are never distributed with the app.

- The OpenAI-compatible engine is tested against a local server that speaks the wire format, not against a live paid endpoint in CI.
- The extra harnesses' config shapes follow each tool's documentation and are marked UNVERIFIED in `lib/hosts-extra.mjs`; only Claude Code and Codex are pinned to source.
- Antigravity has no hook API, so it gets the MCP server and the instruction block only.

### Built on

[HKUDS nanobot](https://github.com/HKUDS/nanobot) for the memory and Dream design, [graphify](https://pypi.org/project/graphifyy/) for the knowledge graph, [ultimate-frontend-skills](https://github.com/ridelink0/ultimate-frontend-skills) for frontend work, and the sources in [docs/RESEARCH.md](docs/RESEARCH.md). The name is a tribute to atelier, the art-direction plugin that became Ultimate Frontend Skills.

---

**MIT. Built by Gev.**


### Model connection setup

Use `/connect` to add a subscription, an API provider, a local Ollama model, or a custom OpenAI-compatible endpoint. `/connections` shows the selected connection, configured models and the local environment-variable names for API credentials. It never prints credential values. A failed model-list check leaves your active connection unchanged; an unfinished setup is saved as a draft. API keys belong in your local environment, not in chat or command files.

Common coding workflows are available through `/help`, `/model`, `/effort`, `/permissions`, `/settings`, `/config`, `/status`, `/cost`, `/context`, `/compact`, `/clear`, `/resume`, `/sessions`, `/rewind`, `/undo`, `/diff`, `/review`, `/init`, `/memory`, `/skills`, `/agents`, `/doctor` and `/exit`. `/help <command>` shows exact usage. Provider-specific host commands remain owned by that host; this is not a claim of complete Claude Code feature parity.

### Automatic relay

Enable `/relay on` to let the main Atlias agent schedule a continuation of its own saved task. Relay is off by default. `/relay status` shows receipts; `/relay cancel <id>` cancels an exact pending relay. A model can call the optional `relay` tool, or an MCP client can use `harness_relay` with an exact saved Atlias session and next step. This resumes Atlias sessions; it does not resume a native host chat.

Windows Task Scheduler runs the saved continuation independently of the desktop app. `/relay after-reset <measured ISO reset with timezone> <next step>` requires a freshly measured reset and waits at least five minutes after it. `/relay at <ISO with timezone> <next step>` schedules a specific time. CLI scheduling also takes `--session <exact saved id> --next <text>`. A relay pauses the current task rather than declaring it completed.

The continuation keeps the saved project, conversation, engine, model and permission policy. It will hold if those change, the saved conversation moves on, the previous model outcome is unknown, or ownership cannot be proved. It cannot switch subscriptions or grant new authority. The default chain limit is three runs, configurable with `agent.relayMaxRuns` from one to twenty. Other platforms currently use `atlias resume` manually.

Configuration writes preserve the previous exact settings under `.atlias/config-backups/<sha256>.json`. The full test runner isolates application and provider homes before loading modules and verifies that live settings remain unchanged.

# sub-atlias

> **This is sub-atlias, the free sub version of Atlias, not Atlias itself.** It runs inside a coding host you already use (Claude Code, Codex, Antigravity or Gemini CLI) and adds to it. The full Atlias app, with its own agent loop (about 3x fewer tokens per solved task than plain Claude Code on hard coding tasks; see Benchmarks), is a separate paid product and is not in this repository. The command and plugin are still named `atlias`.

sub-atlias adds shared project memory, a knowledge graph, and verification hooks to the host. It leaves model choice and provider billing with you.

## Install

Install the terminal package with Node.js 18 or newer:

```sh
npm install --global sub-atlias
atlias install --claude
```

Choose the host you use: `--claude`, `--codex`, `--antigravity`, or `--gemini`. Run `atlias doctor` to check the install. `atlias uninstall --codex|--antigravity|--gemini` removes the entries atlias added for that host. Remove the Claude Code plugin with `/plugin uninstall atlias@atlias` inside Claude Code.

For Claude Code's plugin browser, add `ridelink0/sub-atlias` as a marketplace and install `atlias`. Codex users can add the repository as a plugin marketplace, then run `atlias install --codex` to configure its MCP server and hooks.

## What it adds

- One project memory shared through host MCP tools.
- Knowledge graph queries and change-impact lookups when a graph is present.
- Hooks that track edits, check syntax and test evidence, keep a handoff note, and flag repeated or destructive commands.
- Optional native launcher for Claude Code or Codex using a provider profile you supply. The profile stores only the environment variable name for a credential; the credential itself stays in your environment. Usage receipts record provider-reported token counts and optional price estimates.

The launcher accepts Claude's Anthropic Messages API or Codex's Responses API. It does not provide subscription OAuth or promise that provider subscriptions cover API use. See [docs/API-SUBHARNESS.md](docs/API-SUBHARNESS.md) for profiles and receipts.

## Benchmarks

Hard coding tasks, 2026-11-21: 120 tasks from DeepSWE (R2E bug fixes), SWE-Atlas QnA (questions about real repositories) and harness-bench (multi-step work tasks). Every arm ran Claude Haiku 5.5 through Claude Code 2.1.303 with the same tasks, grader, 32-turn budget and 600-second limit, one attempt per task. A task counts as solved only when its hidden check passes (QnA answers are graded against a rubric by a Claude Haiku judge). Tokens are every token the provider counted: input, cache reads, cache writes and output, failed attempts included.

| Harness | Solved | Tokens per solved task | Against plain Claude Code |
| --- | --- | --- | --- |
| Plain Claude Code | 47 / 120 | 896,688 | 1.0x |
| sub-atlias 4.0.2 (previous release) | 49 / 120 | 931,423 | 1.04x more |
| **sub-atlias 4.1.0 (this release)** | **53 / 120** | **763,375** | **1.17x fewer** |
| Atlias, the full app (own agent loop) | 46 / 120 | 324,224 | about 3x fewer (2.77x; 2.89x over four nights) |

- A timed-out attempt counts as unsolved, with its tokens. Paired per task on the 118 tasks it finished without a timeout, sub-atlias 4.1.0 used 1.18x fewer total tokens than plain Claude Code (90% interval 1.09x to 1.27x) and its largest prompt was 1.25x smaller; in tokens per solved task it was 1.09x fewer on R2E, 1.20x on harness-bench and 2.02x on QnA.
- The saving comes from the two plugins this release adds: Claude Code's first request falls from about 75,500 to about 27,800 characters, and that request is sent again on every call.
- All 120 tasks are compared. The plain Claude Code and sub-atlias 4.0.2 rows come from 2026-11-10 and the Atlias row from 2026-11-17, on the same tasks and client; over four nights of its kept setup (2026-11-17 to 2026-11-21) Atlias averaged 2.89x fewer.
- One run per arm on these tasks: a single night moves solves by a few tasks either way, so read the solve counts as a lead.
- Not measured against a Claude plan's 5-hour limit, and not on light tasks.

## Free to use, open to contributors

This sub-harness is free to use, including commercially, under the MIT license. Contributions are welcome; see [Contributing](#contributing).

The exception is the Atlias harness itself: its standalone agent and private harness loop are not in this repository and are not free to use.

## Local development

```sh
npm test
npm run test:install
```

The package has no third-party runtime dependencies. It is distributed under the MIT license; see [LICENSE](LICENSE).

## Contributing

If you're interested in contributing to sub-atlias, please read our [contributing guide](CONTRIBUTING.md) before submitting a pull request.

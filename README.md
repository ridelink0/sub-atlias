# sub-atlias

> **This is sub-atlias, the free sub version of Atlias, not Atlias itself.** It runs inside a coding host you already use (Claude Code, Codex, Antigravity or Gemini CLI) and adds to it. The full Atlias app, with its own agent loop (the one measured at 19.52x fewer tokens than plain Claude Code), is a separate paid product and is not in this repository. The command and plugin are still named `atlias`.

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

Measured on one PC with a local model (qwen3.5:9b through Ollama, 32,768-token window); a task counts as solved only when its hidden check passes.

| Run | Arms | Solved | Total tokens | Fewer tokens |
| --- | --- | --- | --- | --- |
| Ten-task smoke, 2026-10-16 (one run per arm) | Claude Code + this sub-harness / plain Claude Code | 8 / 10 and 8 / 10 | 250,143 and 659,112 | 2.63x |

- That trial build also carried two Claude Code mods (tool deferral and a short skill listing). This 4.0.1 package does not ship them, so the saving of a standard install is not measured.
- Not measured against a Claude plan's 5-hour limit. The session brief this package adds at session start counts toward it, so on a Claude subscription it can use more of that limit than plain Claude Code.
- Atlias's own agent (the full app, not this package) measured a pooled 19.52x fewer tokens than plain Claude Code over nine 120-run screens on the same model; see [the evidence page](https://atlias-ridelink.netlify.app/evidence.html).

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

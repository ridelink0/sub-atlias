# Changelog

## 4.1.0

- Adds two token-saving plugins to the marketplace, installed by `atlias install --claude`: atlias-transaction puts Claude Code's built-in tools other than Read, Edit, Write, Glob and the shell behind ToolSearch, and atlias-efficiency lists skills by name only and leaves out Claude Code's own memory section. Claude Code's first request falls from about 75,500 to about 27,800 characters on Claude Code 2.1.303.
- `atlias install --claude` sets `ENABLE_TOOL_SEARCH=true` in `~/.claude/settings.json` unless a value is already there; `atlias doctor` checks it and both plugins.

## 4.0.0

- Replaces the public package payload with the atlias host integration: install, native launch metering, hooks, MCP, shared memory, graph, and verification.
- Removes the standalone agent, private harness loop, evaluation corpora, internal reports, and benchmark runner from the package payload.
- Preserves the repository's existing Git history and MIT license.

# atlias-meter

A read-only mod for Claude Code 2.1.287 or newer. It counts what a session carries and changes none of it: every event goes on exactly as it arrived.

```bash
claude --plugin-dir /path/to/atlias/mods/atlias-meter
```

Then `/atlias-meter`, at any time and with no model turn, prints:

- every request's tokens as the API reported them: input, cache read, cache written, output, and how many requests subagents made
- characters, exactly, by family and by piece: what Claude Code injects by itself (the skill listing, reminders, instruction files, other plugins' hook context), each skill as it is expanded, each tool's description and whether it waits behind tool search, the blocks sent with the first message, and every tool result as it is stored

It is the first step, not a saving. What each piece costs has to be known before anything is cut, and a later change is kept only when a paired run shows fewer tokens with the same work done.

### Status

- `claude plugin validate --strict` passes on Claude Code 2.1.296 (2026-10-12), and atlias's own suite drives every hook and proves each one passes its event on untouched (`node test/run.mjs "meter:"`).
- It has not yet been run in a live session, so the numbers it prints there are unseen.
- It lives outside the main atlias plugin on purpose: what a Claude Code older than 2.1.287 does with a hooks module is not known.
- Mods are an early-access surface that Anthropic says may change between releases.

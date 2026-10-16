# atlias-meter

A read-only mod for Claude Code 2.1.287 or newer. It counts what a session carries and changes none of it: every event goes on exactly as it arrived.

```bash
claude --plugin-dir /path/to/atlias/mods/atlias-meter
```

Then `/atlias-meter`, at any time and with no model turn, prints:

- every request's tokens as the API reported them: input, cache read, cache written, output, and how many requests subagents made
- characters, exactly, by family and by piece: what Claude Code injects by itself (the skill listing, reminders, instruction files, other plugins' hook context), each skill as it is expanded, each tool's description and whether it waits behind tool search, the blocks sent with the first message, and every tool result as it is stored

It also keeps an exact ledger, one row per request: the turn and step ids, the stop reason, the model, the four token counts, and the name and argument key names of each tool the request called (never the argument values or the answer text). A count that is missing or is not a whole non-negative number stays unknown, and any unknown request makes its role's total and peak, and the overall ones, unknown rather than smaller. A request's tokens are its input, cache read, cache written and output, each counted once; peak is the largest single request. The labels it prints (no tool, each tool, ToolSearch, the batch tool, a standalone call whose only argument is `args`) say what was observed, not why anything passed or cost what it did. The older summed line above still adds a missing count as 0, so whenever a request had no usage or a count that was not a whole number the table adds an INCOMPLETE line saying those sums are a lower bound, not a total; the ledger is the figure to compare. A step for which Claude Code made no request also shows as unknown, because its result carries no usage either.

It is the first step, not a saving. What each piece costs has to be known before anything is cut, and a later change is kept only when a paired run shows fewer tokens with the same work done.

### Status

- `claude plugin validate --strict` passes on Claude Code 2.1.296 (2026-10-12), and atlias's own suite drives every hook and proves each one passes its event on untouched (`node test/run.mjs "meter:"`).
- It has not yet been run in a live session, so the numbers it prints there are unseen.
- MEASURED 2026-10-16 with no model on Claude Code 2.1.301 (native-meter-door-r1, native-meter-retry-r2 in the Gev handoff folder): each ledger row equalled the provider door's count for the same request, and absent cache counts arrive as 0. A request that failed and was retried by Claude Code left no ledger row while the door recorded the failed attempt with no count, so the meter's total can be known while the true all-attempt total is unknown. The ledger therefore never replaces the door for TOTAL or PEAK across attempts and roles; it labels what the finished steps did.
- The exact ledger (2026-10-16) is tested against synthetic step results only. Whether its counts equal what the provider door meters for the same requests on the installed Claude Code is NOT yet qualified; no ratio or saving may be read from it before that comparison passes.
- It lives outside the main atlias plugin on purpose: what a Claude Code older than 2.1.287 does with a hooks module is not known.
- Mods are an early-access surface that Anthropic says may change between releases.

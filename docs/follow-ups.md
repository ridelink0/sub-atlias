# Follow-ups, side questions and drafts

During a terminal turn, Enter steers the running turn at its next model request,
after the current step's tool results. The terminal prints `steer applied` when
it adds the message. This matches the Codex CLI Enter behavior documented at
https://learn.chatgpt.com/docs/developer-commands?surface=cli.

`atlias config set ui.followUp queue` makes Enter queue instead. Values are
`steer` (default) and `queue`; restart the terminal after changing it. Ctrl+Q
sends the other kind for one message. Tab remains slash-command completion.
Queued messages appear above the prompt and run one by one after the current
turn. `/queue` lists them, `/queue edit N text` replaces one, and
`/queue remove N` removes one before it starts. Unapplied steers go first in
the queue when a turn ends or is stopped with Esc or Ctrl+C.

`/btw <question>` makes one separate request about the conversation so far.
No tools are offered or executed. It changes no session, memory, main-turn
state or token tally. Esc dismisses the answer block; PgUp/PgDn scroll it.
Ordinary direct HTTP engines can answer during a running turn. Claude-plan
and ChatGPT side questions wait until the current turn ends, with a notice.
The legacy Claude/Codex host engines cannot expose their conversations and
report that side questions are unavailable. Side exchanges are ephemeral.

Drafts live under `<ATLIAS_HOME>/drafts/<project-hash>.json`. The prompt, queued
messages and pending steers are saved after about 250 ms without changes and
at least every two seconds during continuous typing. Sending clears the
prompt immediately. Exit, SIGINT, SIGTERM and uncaught errors flush the latest
snapshot. A killed process can lose input since its last completed save.
Startup restores the prompt and pending messages with a dim note.

Writes use a unique temporary file, fsync and rename. POSIX files use 0600 and
new directories 0700. The existing importer's recognized secret patterns are
redacted on disk, so recovered text can differ from what was typed. Other
text is plain JSON. A failed write keeps the old complete file, retains the
new snapshot in memory, and reports the error. Concurrent terminals in the
same project share this file; the latest writer wins.

## Embedder API

Existing `agent.turn(state, text, ask, say, options)` calls return a reply string.
Passing `options.steer` opts into the structured result below. Omit the source
to preserve the existing model requests; benchmark callers require no change.

```js
const waiting = [];
const result = await agent.turn(state, text, ask, say, {
  signal: controller.signal,
  steer: {
    take: () => waiting.splice(0), // synchronous, ordered string[]; transfers ownership
    onApplied: text => showApplied(text), // optional, synchronous; should not throw
  },
});
showReply(result.reply);
queue.unshift(...result.unappliedSteers);
// result.appliedSteers lists messages included in model requests, in order.
```

The source is polled before every request and drained once when the turn ends.
Blank strings are ignored. Steers are separate user messages, preserved in
the request ledger, compaction asks and saved history. Applied means added to
a dispatched request, not provider acknowledgment or completion. A request
failure still reports that submission. With host engines or echo, no steering
boundary exists, so all steers are returned unapplied. An exception exposes
`error.steers = { appliedSteers, unappliedSteers }` for recovery. Serialize main
turns for a state; queued work belongs to the caller. A steer received after
the promise resolves belongs to the caller's next turn.

`await agent.btw(state, question, { signal })` returns the ephemeral answer
string. Call it directly without `saveChat` or Dream. The current Max runner
uses `agent.turn` and saves its result; its command wrapper must use this
separate method for `/btw` to preserve byte-identical session files. The Max
app was inspected and was not edited or re-vendored by this change.

For fixture tests, both APIs accept `options.chat(messages, tools, metadata)`;
`turn` also accepts `options.native`. These replace the transport without
selecting or calling a live model.

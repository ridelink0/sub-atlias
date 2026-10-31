---
name: atlias
description: "Use for memory across sessions (remember, recall, what did we decide), the handoff note, session digests and Dream, the project's knowledge graph (how X works, what depends on Y), or atlias's health."
---

# atlias

atlias is the sub-harness under this session. It already ran at SessionStart: the brief lists the handoff note, the memory index, the graph hubs and the working rules. This skill is for the moments you need more than the brief.

## Reach for these tools

| Need | Tool | Cost |
|---|---|---|
| A fact about the user, a past decision, a path or an id | `harness_recall {query}` | a few hundred tokens; searches memory bodies, session digests and the graph |
| Save something durable | `harness_remember {name, type, description, body}` | one file in Claude Code's own memory dir, shared by every host |
| Where was I, what changed, what is next | `harness_progress {action: "get"}` | the handoff note |
| The plan changed | `harness_progress {action: "set", text}` | survives compaction and crashes |
| A codebase question | `graph_query {question}` | far cheaper than reading files; open only what it names |
| What breaks if I change this | `graph_affected {node}` | reverse traversal |
| Changed files parse? | `harness_verify {paths}` | JavaScript, JSON and Python only; it names what it could not check |
| Sessions waiting to become memory | `harness_digest {action: "show"}` then `"ack"` | Dream, stage two |
| Something feels unwired | `harness_status` | every failing check comes with its fix |
| Is the harness worth its cost | `harness_bench` | measured on this project, no model called |

CLI equivalents: `node <plugin>/bin/atlias.mjs recall|remember|progress|dream|graph|doctor|status`.

## What the harness does without being asked

- Denies the fourth identical tool call with a reason that says what to change. Do not retry the same call; change the input or the route.
- Turns destructive shell commands (recursive deletes at a root, force pushes, process kills by PID, DROP TABLE) into a confirmation.
- Holds a reply that ends with files that do not parse, once, with the errors.
- Holds a reply that changed code but names only one bug-check, once, and says what the second adversarial pass looks for. End with one line naming both passes and what each found.
- Writes the handoff note before compaction and re-injects it after.
- Distils each session into a digest at exit. Consolidate at a natural pause: keep facts that are Signal, Novel, Important and Persistent; route them by type (user, feedback, project, reference); a correction replaces the old fact; then ack.

## Memory discipline (from NanoBot's Dream, kept)

Write atomic facts, not descriptions of discussions. Drop resolved incidents, one-off debugging, transient status and anything the code or docs already record. Convert relative dates to absolute. Prefer editing an existing memory over creating a near duplicate.
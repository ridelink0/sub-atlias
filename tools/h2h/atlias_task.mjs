#!/usr/bin/env node
// Atlias's own agent on one task, for the base-harness runner's `atlias` harness (Gev 2026-10-16: the
// real harness for 20x, Atlias with no Claude Code and no other harness under it, against plain
// Claude Code on the same model). The runner prepares the workspace (the current directory), meters
// every model call at its door and grades afterwards; this runs the task the way `atlias eval`
// does (eval.taskState, then loop.runLoop with the task's own round budget), so a task here starts
// exactly as it does in Atlias's own benchmark.
//
// Usage: node atlias_task.mjs [--rounds N]   with the prompt on stdin
// Environment: ATLIAS_HOME (its config.json is Atlias's configuration for the arm),
//              ATLIAS_TASK_URL (the door's OpenAI base, ending in /v1), ATLIAS_TASK_MODEL.
// Prints one JSON line: { stop, rounds, tools, greenChecks }. Nothing it started is ended here by process id: the runner
// owns the whole process tree as one job and ends it as a whole.
import * as loop from '../../lib/loop.mjs';
import * as evals from '../../lib/eval.mjs';
import { newState } from '../../lib/agent.mjs';
import { config } from '../../lib/core.mjs';

const argv = process.argv.slice(2);
const at = argv.indexOf('--rounds');
const rounds = at >= 0 ? Math.floor(Number(argv[at + 1])) : 0;
const url = process.env.ATLIAS_TASK_URL || '';
const model = process.env.ATLIAS_TASK_MODEL || '';
if (!url || !model) {
  process.stdout.write(JSON.stringify({ stop: { reason: 'crashed', detail: 'ATLIAS_TASK_URL and ATLIAS_TASK_MODEL are required' }, rounds: 0 }) + '\n');
  process.exit(2);
}
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
prompt = prompt.trim();

const cwd = process.cwd();
const chat = loop.openaiChat({ ...config().agent, openaiUrl: url, openaiModel: model });
const st = evals.taskState(newState(cwd, 'openai'), cwd);
let error = null;
try {
  await loop.runLoop(st, prompt, { chat, say: () => {}, ask: async () => true,
    limits: { ...(rounds > 0 ? { maxToolRounds: rounds } : {}), shellTimeoutMs: evals.EVAL_SHELL_TIMEOUT_MS } });
} catch (e) {
  error = e && e.message ? e.message : String(e);
}
const stop = error ? { reason: 'crashed', detail: String(error).slice(0, 300) } : st.stop || { reason: 'unknown', detail: '' };
// tools: the tool names in order (no task text); greenChecks: how often finishOnGreen ran the check.
process.stdout.write(JSON.stringify({ stop, rounds: (st.messages || []).filter((m) => m.role === 'assistant').length,
  tools: evals.toolTrace(st.messages).slice(0, 200), greenChecks: st.greenChecks || 0 }) + '\n');
process.exit(error ? 1 : 0);

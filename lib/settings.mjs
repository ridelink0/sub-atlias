// Everything a user can change, in one place: the mode atlias runs in, and
// every key in config.json with what it does, its value and its default.
// `atlias settings` is the menu; `atlias mode` and `atlias config set` are the
// one-line forms of the same writes.
import path from 'node:path';
import { STATE_DIR, DEFAULTS, CHOICES, config, readJson, writeJson, parseSetting, flagEnvName } from './core.mjs';

// What atlias is on this machine. Both is the default and what most people want.
export const MODES = {
  both: 'sub-harness inside Claude Code, Codex and the rest, plus the atlias agent in a terminal',
  sub: 'sub-harness only; typing atlias shows the status instead of asking',
  standalone: 'agent only; the hooks in other harnesses stay silent and typing atlias starts the agent',
};
// Older versions saved the chooser's answer ("ask", "agent", "sub-harness")
// without ever reading it, so those values carry no intent: they read as both.
export function normalizeMode(value) {
  const v = String(value || '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(MODES, v) ? v : 'both';
}
export function mode(cfg = config()) { return normalizeMode(cfg.agent && cfg.agent.mode); }
// The hooks run inside other harnesses. Standalone is the one mode that asks
// them to stay out of those sessions.
export function hooksActive(cfg = config()) { return mode(cfg) !== 'standalone'; }
// What typing atlias with nothing after it does: the help when there is no
// terminal to answer in, otherwise whatever the mode says.
export function bareCommand(m = mode(), isTTY = Boolean(process.stdin.isTTY)) {
  if (!isTTY) return 'help';
  return { both: 'chooser', sub: 'status', standalone: 'agent' }[normalizeMode(m)];
}

// A round-five flag (the flags section) is described here like any other key,
// and says what it changes, off being the behaviour the baseline was run on.
export const DESCRIPTIONS = {
  'flags.leanBrief': 'a shorter session brief: no list of the MCP tool names (the host lists the tools itself), the Companions section only when two copies of a companion load at once or usage-limits is on, and the pass-line rule without the sentence that explains the gate',
  'flags.gateRunsCheck': 'when the gate would hold a reply because no check ran after the last edit, it runs the project\'s own visible check itself (check.py, canitedit_check.py, run_tests.sh, the npm test script and the like), stopped at 10 seconds, records it, and holds the reply only if it fails; the brief then says so and no longer asks for an edit and its check in one message',
  'flags.sameTextSwitch': 'in the atlias agent loop, an edit whose new text is its old text, or a byte-for-byte repeat of the last edit that failed, is answered with a steer and does not count against agent.maxBadReplies; a repeat also makes that file\'s next edit a whole Python def or class, found by its header, or the whole file',
  'flags.finishOnGreen': 'in the atlias agent loop, after a round in which an edit landed, atlias runs the project\'s own visible check (the one the gate can name: check.py, canitedit_check.py, the npm test script) and, when it passes, stops there as answered instead of spending more rounds; a failing check adds nothing to the context',
  'verify.syntax': 'hold a reply whose edited files do not parse',
  'verify.doublePass': 'hold a done reply until a second adversarial read of the changes happened',
  'verify.integrity': 'check claims against evidence: passes that never ran, done with no check after the last edit',
  'verify.stubs': 'flag placeholders, TODOs and elided code added in this change',
  'verify.weakenedTests': 'flag skipped, focused or deleted tests and asserts that cannot fail',
  'verify.unwired': 'flag new functions and classes that nothing calls',
  'guard.loopThreshold': 'identical tool calls in a row before the guard steps in',
  'guard.loopWindow': 'how many recent tool calls the loop guard looks at',
  'guard.destructive': 'ask before rm -rf, force pushes, dropped tables and the like',
  'graph.autoBuild': 'build the knowledge graph at session start when a project has none',
  'graph.autoUpdate': 'refresh the graph in the background after edits',
  'graph.maxFilesForAutoBuild': 'skip the automatic build above this many files',
  'graph.queryBudget': 'characters a graph answer may use',
  'graph.godNodes': 'hub nodes named in the session brief',
  'graph.updateDebounceMs': 'milliseconds between background graph refreshes',
  'brief.memoryChars': 'characters of memory in the session brief',
  'brief.progressChars': 'characters of the handoff note in the session brief',
  'recall.budgetChars': 'characters a recall answer may use',
  'recall.bodyChars': 'characters of each memory body in a recall answer',
  'dream.enabled': 'distil each finished session into the digest for later consolidation',
  'dream.keepHistory': 'digest rows kept',
  'router.graph': 'answer codebase questions from the graph before files are read',
  'router.companions': 'point frontend work at the installed companion skills',
  'pointer.nudge': 'when a whole file is read that the knowledge graph could have answered, say so once and name the query that would have done it; the read is never blocked',
  'pointer.minBytes': 'a whole-file read smaller than this is cheaper than asking, so it passes without a word',
  'pointer.perSession': 'pointer-first nudges one session may spend, at most one per turn',
  'usage.show': 'tell Claude Code where the 5-hour and weekly windows stand, once per session, as information that never cuts scope',
  'agent.mode': 'both, sub or standalone (see atlias mode)',
  'agent.engine': 'auto picks the pinned OpenCode local runtime, then Claude Code or Codex; ollama is an alias for OpenCode and echo is a dry run',
  'agent.ollamaUrl': 'where the local Ollama server listens',
  'agent.ollamaModel': 'the Ollama model the agent drives',
  'agent.allowUnmeasured': 'lets the OpenCode engine run a model and window with no measured fit on this card; off, only the measured pairs run',
  'agent.ollamaNumCtx': 'the context window atlias asks Ollama for, in tokens, on every request; capped at the model\'s trained length and grown in powers of two when a conversation needs it; without it Ollama uses its own default (4096 on a GPU under 24 GiB) and cuts an over-long conversation from the front, task first',
  'agent.ollamaNumPredict': 'the most tokens one Ollama reply may generate; the window is kept at least this much larger than the prompt',
  'agent.ollamaKeepAlive': 'how long Ollama keeps the model loaded after a request (for example 30m); empty leaves it to the server',
  'agent.openaiUrl': 'any OpenAI-compatible endpoint: OpenAI, OpenRouter, LM Studio, vLLM, llama.cpp',
  'agent.openaiModel': 'the model name that endpoint expects; the openai engine needs it',
  'agent.nativeTools': 'use the endpoint\'s own tool calling, falling back to text blocks when it refuses',
  'agent.maxToolRounds': 'tool calls the agent may make for one message',
  'agent.evalDir': 'where atlias eval makes its scratch workspaces; empty means an atlias-evals folder in the system temp folder (ATLIAS_EVAL_DIR or eval --work override it)',
  'agent.maxBadReplies': 'model replies in a row that may produce nothing usable - a tool block that did not parse, an edit that did not apply, or a reply the provider cut off at its output limit - before atlias stops and says which of those it was; counted apart from the round budget, and cleared by any round that did something',
  'agent.keepObservations': 'recent tool results kept in full; older ones shrink to a one-line note',
  'agent.evictBlock': 'how many old tool results are shrunk at once; shrinking one per turn would rewrite the prompt every turn and lose the provider cache',
  'agent.outputBudget': 'characters of tool output allowed into the context, decided once as it enters; each tool gets a share of this, since a shell run, a file read, a grep and a directory listing do not deserve the same room',
  'agent.testCommand': 'the check atlias runs itself when the agent answers after editing: auto finds npm test, pytest, go test or cargo test; off turns it off; or give a command',
  'agent.permissions': 'workspace: edits in the project run; ask: every edit and command asks first; read-only: no edits at all (plan mode)',
  'agent.sandbox': 'work in a throwaway git worktree of the last commit, show the diff when the run stops and change the project only if you take it; a dirty tree is refused and a folder that is not a git repository says so and runs as usual',
};

const CONFIG_PATH = () => path.join(STATE_DIR, 'config.json');

export function rows(cfg = config()) {
  const out = [];
  for (const [section, keys] of Object.entries(DEFAULTS)) {
    for (const [key, def] of Object.entries(keys)) {
      const id = `${section}.${key}`;
      const value = (cfg[section] || {})[key];
      const choices = (CHOICES[section] || {})[key] || (typeof def === 'boolean' ? [true, false] : null);
      // A flag can also be set from the environment for one run, and then the
      // environment wins over what is written here; the listing names the variable.
      out.push({ id, section, key, value, def, changed: JSON.stringify(value) !== JSON.stringify(def), choices, about: DESCRIPTIONS[id] || '', env: section === 'flags' ? flagEnvName(key) : '' });
    }
  }
  return out;
}

export function format(list = rows()) {
  const width = Math.max(...list.map((r) => r.id.length));
  return list.map((r, i) => {
    const n = String(i + 1).padStart(2);
    const val = JSON.stringify(r.value);
    const def = r.changed ? `  (default ${JSON.stringify(r.def)})` : '';
    return `${n}  ${r.id.padEnd(width)}  ${val}${def}\n      ${r.about}${r.env ? ` (for one run: ${r.env}=${typeof r.def === 'boolean' ? '1' : '<value>'})` : ''}`;
  }).join('\n');
}

// Write one setting through parseSetting, and read it back through config()
// so what is reported is what took effect.
export function set(id, raw) {
  const [section, key] = String(id || '').split('.');
  const parsed = parseSetting(section, key, raw);
  if (parsed.error) return { ok: false, text: parsed.error };
  const user = readJson(CONFIG_PATH(), {}) || {};
  user[section] = { ...(user[section] || {}), [key]: parsed.value };
  writeJson(CONFIG_PATH(), user);
  return { ok: true, text: `${id} = ${JSON.stringify(config()[section][key])}` };
}

export function reset(id) {
  const [section, key] = String(id || '').split('.');
  if (!DEFAULTS[section] || !(key in DEFAULTS[section])) return { ok: false, text: `unknown key ${id}` };
  const user = readJson(CONFIG_PATH(), {}) || {};
  if (user[section]) {
    delete user[section][key];
    if (!Object.keys(user[section]).length) delete user[section];
  }
  writeJson(CONFIG_PATH(), user);
  return { ok: true, text: `${id} = ${JSON.stringify(config()[section][key])} (default)` };
}

export function setMode(value) {
  const v = String(value || '').toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(MODES, v)) return { ok: false, text: `mode is one of ${Object.keys(MODES).join(', ')}; got ${JSON.stringify(value)}` };
  const r = set('agent.mode', v);
  return r.ok ? { ok: true, text: `mode ${v}: ${MODES[v]}` } : r;
}

export function describeMode(cfg = config()) {
  const m = mode(cfg);
  return [`mode ${m}: ${MODES[m]}`, '', ...Object.entries(MODES).map(([k, v]) => `  ${k === m ? '*' : ' '} ${k.padEnd(10)} ${v}`), '', 'change it with: atlias mode both|sub|standalone'].join('\n');
}

// The interactive menu. ask(question) returns the answer; out(text) prints.
// Both are injected so the tests can drive it without a terminal.
export async function menu(ask, out) {
  for (;;) {
    const list = rows();
    out(format(list));
    const answer = String(await ask('\nnumber to change, r<number> to reset it, q to quit: ')).trim().toLowerCase();
    if (!answer || answer === 'q' || answer === 'quit' || answer === 'exit') return 0;
    const resetting = answer.startsWith('r');
    const n = parseInt(resetting ? answer.slice(1) : answer, 10);
    const row = list[n - 1];
    if (!row) { out(`no setting ${answer}; pick 1 to ${list.length}`); continue; }
    if (resetting) { out(reset(row.id).text); continue; }
    let raw;
    if (typeof row.def === 'boolean') raw = String(!row.value);
    else if (row.choices) {
      out(row.choices.map((c, i) => `  ${i + 1}  ${c}${c === row.value ? '  (current)' : ''}`).join('\n'));
      const pick = String(await ask(`${row.id}: `)).trim();
      const idx = parseInt(pick, 10);
      raw = Number.isInteger(idx) && row.choices[idx - 1] !== undefined ? String(row.choices[idx - 1]) : pick;
    } else raw = String(await ask(`${row.id} (now ${JSON.stringify(row.value)}): `));
    if (!raw.trim()) { out('unchanged'); continue; }
    out(set(row.id, raw).text);
  }
}

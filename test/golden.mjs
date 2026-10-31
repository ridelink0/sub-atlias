#!/usr/bin/env node
// The control's fingerprint. Round five measures every behaviour change as an
// arm against one baseline run, and that is only honest while the baseline code
// with every flag off still sends the model exactly what it sent when the
// baseline was run. This script drives the eval runner with a scripted model and
// with the echo engine and prints what it saw: every request, byte for byte, and
// every row. test/fixtures/golden-flags-off.json holds that print from the code
// the baseline ran on; the suite (test/eval-suites.mjs) runs this in a fresh
// state folder, with no flag set and with every flag set off from the
// environment, and asks for the same bytes.
//   node test/golden.mjs            print the fingerprint as JSON
//   node test/golden.mjs --write    write it to the fixture (only when a change
//                                   to flags-off behaviour is intended, and the
//                                   baseline runs are then no longer the control)
// The workspace path differs per machine and per run, and the repository root
// per machine (the system prompt names the skills folder under it), so they are
// replaced by <WS> and <ROOT> wherever they appear, and the fields that count
// characters are corrected by exactly what those replacements changed. Nothing
// else is normalised: wall time and the workspace path are dropped, everything
// else must match.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const GOLDEN = path.join(HERE, 'fixtures', 'golden-flags-off.json');
const NL = '\n';
const blk = (obj) => '```atlias' + NL + JSON.stringify(obj) + NL + '```';

// A fix that spends enough rounds for the view to mask old results, fails two
// edits in two different ways, reads a masked file again, lands the fix, is
// nudged for having run no check after it, and checks.
export const TASK = {
  id: 'golden-control',
  name: 'the control fingerprint',
  rounds: 20,
  files: {
    'package.json': '{ "type": "module" }' + NL,
    'sum.js': 'export function two() { return 1; }' + NL,
    'test.mjs': "import { two } from './sum.js';" + NL + 'process.exit(two() === 2 ? 0 : 1);' + NL,
  },
  prompt: 'Make node test.mjs pass.',
  check: ['node', 'test.mjs'],
};
export const REPLIES = [
  blk({ tool: 'read_file', path: 'sum.js' }),
  blk({ tool: 'read_file', path: 'test.mjs' }),
  blk({ tool: 'read_file', path: 'package.json' }),
  blk({ tool: 'read_file', path: 'sum.js', offset: 1, limit: 1 }),
  blk({ tool: 'shell', command: 'node test.mjs' }),
  blk({ tool: 'edit_file', path: 'sum.js', old_string: 'return 1;', new_string: 'return 1;' }),
  blk({ tool: 'edit_file', path: 'sum.js', old_string: 'return one;', new_string: 'return 2;' }),
  blk({ tool: 'read_file', path: 'test.mjs', offset: 1, limit: 2 }),
  blk({ tool: 'read_file', path: 'sum.js' }),
  blk({ tool: 'edit_file', path: 'sum.js', old_string: 'return 1;', new_string: 'return 2;' }),
  'Fixed it.',
  blk({ tool: 'shell', command: 'node test.mjs' }),
  'Fixed: two() returns 2. node test.mjs exits 0.',
];
// Ollama-shaped counts, so the per-round prompt and output logs and the cache
// reading have something to carry.
export const usageFor = (i) => ({ prompt_eval_count: 1000 + 100 * i, prompt_eval_cached_count: i ? 900 + 90 * i : 0, eval_count: 40 + i });

function mapStrings(v, fn) {
  if (typeof v === 'string') return fn(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, fn)]));
  return v;
}

export async function fingerprint() {
  const evals = await import('../lib/eval.mjs');
  const loop = await import('../lib/loop.mjs');
  const { config, DEFAULTS, ROOT } = await import('../lib/core.mjs');
  // A flag nothing reads, registered on request, so the suite can prove that a
  // flag set to 0 from the environment is the same run as a flag not set.
  if (process.env.ATLIAS_GOLDEN_PROBE === '1') DEFAULTS.flags.goldenProbe = false;
  const out = {};
  for (const [name, replies, usage] of [['scripted', REPLIES, true], ['echo', ['echo: no work done'], false]]) {
    const requests = [];
    let i = 0;
    const chat = async (messages, tools) => {
      requests.push({ messages, tools });
      const n = i++;
      return { content: replies[Math.min(n, replies.length - 1)], ...(usage ? { usage: usageFor(n) } : {}) };
    };
    const report = await evals.runSuite([TASK], { chat, state: { sid: `golden-${name}` }, keep: true, stamp: false });
    const row = report.results[0];
    const ws = row.workspace;
    // What the row's character counts were computed from, read back from the
    // transcript the kept workspace holds, so the <WS> correction is exact.
    const messages = JSON.parse(fs.readFileSync(path.join(ws, evals.TRANSCRIPT), 'utf8'));
    const cfg = config().agent;
    const handedOf = (ms) => JSON.stringify(loop.view(ms, cfg.keepObservations, cfg.evictBlock).map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '') }))).length;
    // The workspace first: it is the longer, more specific path. The root also
    // in its forward-slash spelling. On Windows the path that follows either one
    // is joined with backslashes (the skills line is path.join(dir, '<name>',
    // 'SKILL.md')), so that tail is spelled with / as it is everywhere else.
    const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const anchors = [[ws, '<WS>'], [ROOT, '<ROOT>'], [ROOT.split(path.sep).join('/'), '<ROOT>']];
    const normStr = (t) => anchors.reduce((acc, [from, to]) => acc.replace(new RegExp(esc(from) + '([^\\s"\'`]*)', 'g'), (m, tail) => to + tail.replace(/\\/g, '/')), t);
    const normAll = (v) => mapStrings(v, normStr);
    const norm = normAll(messages);
    const charsFix = JSON.stringify(messages).length - JSON.stringify(norm).length;
    const handedFix = handedOf(messages) - handedOf(norm);
    const clean = (r) => {
      const { ms, workspace, ...rest } = r;
      return normAll({ ...rest, chars: r.chars - charsFix, handed: r.handed - handedFix });
    };
    const { ms, results, ...totals } = report;
    out[name] = {
      requests: requests.map((r) => JSON.stringify(normAll(r))),
      row: clean(row),
      report: normAll({ ...totals, chars: report.chars - charsFix, handed: report.handed - handedFix }),
    };
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* the temp tree goes anyway */ }
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // A state folder of its own, so no setting another suite wrote can leak in,
  // and no skill installed on this machine lands in the system prompt.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'atlias-golden-'));
  process.env.ATLIAS_HOME = path.join(base, 'state');
  process.env.CLAUDE_CONFIG_DIR = path.join(base, 'claude');
  process.env.CODEX_HOME = path.join(base, 'codex');
  process.env.ATLIAS_EVAL_DIR = path.join(base, 'work');
  process.env.ATLIAS_EVAL_REAP = '0';
  process.env.ATLIAS_NO_DETACH = '1';
  // The baseline was recorded when the skill index was part of every system
  // message. atlias made it off by default on 2026-10-12 (Gev), so this run
  // holds it at the value the baseline used, the way the evolve controller pins
  // it for a stored champion: with that one setting, every request must still
  // be the baseline's byte for byte.
  fs.mkdirSync(process.env.ATLIAS_HOME, { recursive: true });
  fs.writeFileSync(path.join(process.env.ATLIAS_HOME, 'config.json'), JSON.stringify({ agent: { skillIndex: 'all' } }));
  let code = 0;
  try {
    const fp = await fingerprint();
    const text = JSON.stringify(fp, null, 1) + NL;
    if (process.argv.includes('--write')) { fs.mkdirSync(path.dirname(GOLDEN), { recursive: true }); fs.writeFileSync(GOLDEN, text); process.stdout.write(`wrote ${GOLDEN}${NL}`); }
    else process.stdout.write(text);
  } catch (e) {
    process.stderr.write(String(e && e.stack ? e.stack : e) + NL);
    code = 1;
  }
  try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* temp */ }
  process.exitCode = code;
}

#!/usr/bin/env node
// atlias command line.
//   atlias install [--all|--codex|--antigravity|--gemini [--gemini-hooks]|--claude|--companions]
//   atlias uninstall [--all|--codex|--antigravity|--gemini]
//   atlias doctor | status | brief [--host codex] | test | version
//   atlias tiers | eval [--tier smoke|main|big] [--sample N] | compare <a.json> <b.json>
//   atlias polyglot | editbench | refactorbench <path>   convert somebody else's benchmark
//   atlias shortcut [install|uninstall|status]   the atlias command in any terminal
//   atlias mode [both|sub|standalone] | settings [list]
//   atlias skills [name]   the skills installed here, or one of them in full
//   atlias recall <query> | remember <name> <type> <description> -- <body>
//   atlias progress [set <text>] | dream [show|ack|distil <session-id> [transcript]]
//   atlias graph query|affected|explain|update <arg> | config [set <section.key> <value>]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { VERSION, STATE_DIR, ROOT, readJson, writeJson, DEFAULTS, config, parseSetting, writeLauncher, flagStamp, flagLine, flagEnvName, sameFlags } from '../lib/core.mjs';
import * as hosts from '../lib/hosts.mjs';
import * as brief from '../lib/brief.mjs';
import * as progress from '../lib/progress.mjs';
import * as dream from '../lib/dream.mjs';
import * as graph from '../lib/graph.mjs';
import * as agent from '../lib/agent.mjs';
import * as extra from '../lib/hosts-extra.mjs';
import { logo } from '../lib/logo.mjs';
import * as bench from '../lib/bench.mjs';
import * as shortcut from '../lib/shortcut.mjs';
import * as settings from '../lib/settings.mjs';
import * as skills from '../lib/skills.mjs';
import { recall, remember } from '../mcp/tools.mjs';

const argv = process.argv.slice(2);
// --version and --help are what people type; treat them as the commands.
const FLAG_COMMANDS = { '--version': 'version', '-v': 'version', '--help': 'help', '-h': 'help' };
const cmd = FLAG_COMMANDS[argv[0]] || argv[0] || settings.bareCommand();
const extraIds = () => (argv.includes('--extras') ? argv.slice(argv.indexOf('--extras') + 1).filter((a) => !a.startsWith('--')) : []);
const flag = (f) => argv.includes(f);
// The value after a flag: --engine ollama, --only fix-a-bug.
const optVal = (f) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; };
const after = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
// --sandbox and --no-sandbox both mean something, so undefined has to stay
// distinguishable from false or the flag could not turn the setting off.
const sandboxFlag = () => (flag('--sandbox') ? true : flag('--no-sandbox') ? false : undefined);
const cwd = process.cwd();
const say = (x) => process.stdout.write((Array.isArray(x) ? x.join('\n') : String(x)) + '\n');
const readOr = (p, fallback) => { try { return fs.readFileSync(p, 'utf8'); } catch { return fallback; } };
// The terminal command. Records this copy first, so a checkout or an npm
// install that is not in the plugin cache can still be found by the launcher.
const shortcutInstall = () => { writeLauncher(ROOT); return shortcut.installShortcut().lines; };
const shortcutUninstall = () => { const r = shortcut.uninstallShortcut(); return r.length ? r.map((f) => `removed ${f}`) : ['terminal command: nothing of ours to remove']; };

// `atlias <command> --help` prints that command's usage and runs nothing. It
// used to be read as one more flag: `atlias eval --help` started a real eval on
// the default model and left five workspaces behind.
const HELP = {
  eval: [
    'usage: atlias eval [task ids] [options]   score tasks: the model works in a scratch copy and the check command decides',
    '  --tier smoke|main|big     a named tier (atlias tiers lists them); default: the shipped smoke tasks',
    '  --corpus <dir>            score the task files in another directory instead',
    '  --only <id>               one task by id',
    '  --sample N [--seed s]     the same N tasks every time for a given seed',
    '  --engine ollama|openai|echo   echo is a dry run with no model',
    '  --model <name>            score a named model without changing the settings',
    '  --repeat k                k attempts per task; a task passes only when all k do (pass^k)',
    '  --rounds N                override every task\'s own round budget',
    '  --save <file.json>        keep the report for atlias compare',
    '  --outlive-parent          keep running if the process that started the eval goes away (by default it stops)',
    'Code the model wrote runs under a watchdog: at its limit (shell 2 min, check 60 s) it is ended with everything it',
    'started, and whatever a task left running in the background is ended when the task is scored (ATLIAS_EVAL_REAP=0 turns that off).',
  ],
  compare: ['usage: atlias compare <a.json> <b.json>   two runs saved with atlias eval --save, paired task by task'],
  tiers: ['usage: atlias tiers   the benchmark tiers, which are on this machine, and how to get the rest'],
  polyglot: ['usage: atlias polyglot <path to a polyglot-benchmark clone> [--lang python] [--out <dir>] [--limit N] [--only name,name]'],
  editbench: ['usage: atlias editbench <rows.jsonl> --bench canitedit|humanevalfix [--variant lazy|descriptive] [--lang python|js] [--out <dir>] [--limit N] [--only id,id] [--rounds N]'],
  refactorbench: ['usage: atlias refactorbench <path to refactor-benchmark/refactor-benchmark> [--out <dir>] [--limit N] [--only name,name] [--max-bytes 40960] [--rounds 16]'],
  agent: ['usage: atlias agent [--engine claude|codex|openai|ollama|echo] [--once "<prompt>"] [--resume [id]] [--sandbox]'],
  exec: ['usage: atlias exec "<prompt>" [--engine claude|codex|openai|ollama|echo] [--resume [id]] [--sandbox] [--json]   (or pipe the prompt in)'],
  resume: ['usage: atlias resume [id] [--engine e] [--sandbox]   carry on the last agent session in this folder'],
  install: ['usage: atlias install [--all|--codex|--antigravity|--gemini [--gemini-hooks]|--claude|--extras [ids]|--companions|--shortcut]'],
  uninstall: ['usage: atlias uninstall [--all|--codex|--antigravity|--gemini|--extras|--shortcut]'],
  shortcut: ['usage: atlias shortcut [install|uninstall|status]   the atlias command in any terminal'],
  mode: ['usage: atlias mode [both|sub|standalone]'],
  settings: ['usage: atlias settings [list]'],
  graph: ['usage: atlias graph query|affected|explain|update <arg>'],
  remember: ['usage: atlias remember <name> <user|feedback|project|reference> <description> -- <body>'],
  config: ['usage: atlias config [set <section.key> <value>]'],
};
HELP.run = HELP.agent;
HELP.fly = HELP.agent;
const beforeDashes = argv.slice(1, argv.includes('--') ? argv.indexOf('--') : undefined);
const helpFor = cmd !== 'help' && beforeDashes.some((a) => a === '--help' || a === '-h') ? cmd : null;

if (helpFor) say(HELP[helpFor] || [`atlias ${helpFor}: no usage of its own; atlias --help lists every command.`]);
else switch (cmd) {
  case 'logo': say(logo()); break;
  // Task evaluation: the model works in a scratch copy and a command decides.
  case 'eval': {
    // A long run whose starter is gone has nobody to read it, and on Windows
    // nothing ends it: the orphaned head-to-head runner of 2026-09-26 kept
    // starting tasks for hours. Checked every two seconds between tasks (a
    // check that is running finishes first); --outlive-parent keeps it going,
    // for a run started under nohup or the like on purpose.
    let stopIfOrphaned = () => {};
    if (!flag('--outlive-parent')) {
      const first = process.ppid;
      const gone = () => {
        if (process.platform !== 'win32' && process.ppid !== first) return true;
        try { process.kill(first, 0); return false; } catch (e) { return !(e && e.code === 'EPERM'); }
      };
      stopIfOrphaned = () => { if (gone()) { say('atlias eval: the process that started this run is gone, so the run stops here (--outlive-parent keeps it going).'); process.exit(3); } };
      // The timer covers a long wait on the model; runSuite also asks before
      // every attempt, because a fast engine never yields to a timer.
      setInterval(stopIfOrphaned, 2000).unref();
    }
    const evals = await import('../lib/eval.mjs');
    const loopMod = await import('../lib/loop.mjs');
    const cfg = config().agent;
    // Positional task ids only: the value after --engine or --only belongs to
    // that flag, not to the task list.
    const taken = new Set();
    for (const f of ['--engine', '--only', '--repeat', '--model', '--corpus', '--save', '--tier', '--sample', '--seed', '--rounds', '--work']) { const i = argv.indexOf(f); if (i >= 0) taken.add(i + 1); }
    const want = argv.slice(1).filter((a, i) => !a.startsWith('--') && !taken.has(i + 1));
    const only = optVal('--only');
    // --corpus scores a different task directory, so the shipped nine stay fast
    // and a converted benchmark can be run on purpose rather than by default.
    const corpus = optVal('--corpus');
    // --tier names one of the three tiers instead: smoke (the shipped nine),
    // main (one-function fixes and instruction edits), big (whole source files).
    // A tier that is not on this machine says so and prints how to regenerate it,
    // because a corpus of nothing would otherwise score 0 of 0 and look like a
    // measurement.
    const tierName = optVal('--tier');
    const tiers = await import('../lib/tiers.mjs');
    let chosen = null;
    let tasks;
    if (tierName && corpus) say(`--tier ${tierName} and --corpus ${corpus} were both given; the tier is what ran.`);
    if (tierName) {
      chosen = tiers.tierTasks(tierName);
      if (!chosen.ok) { say([chosen.why, '', tiers.statusLines()]); process.exitCode = 2; break; }
      tasks = chosen.tasks;
    } else tasks = corpus ? evals.loadTasks(path.resolve(corpus)) : evals.loadTasks();
    if (only) tasks = tasks.filter((t) => t.id === only);
    if (want.length) tasks = tasks.filter((t) => want.includes(t.id));
    // --sample takes the same N tasks every time for a given seed, so two arms
    // of an A/B are scored on one subset and compare() pairs them task by task.
    const sample = parseInt(optVal('--sample') || '0', 10) || 0;
    const seed = optVal('--seed') || 'atlias';
    const before = tasks.length;
    if (sample > 0) tasks = tiers.sampleTasks(tasks, sample, seed);
    if (!tasks.length) { say(tierName ? `no tasks in the ${tierName} tier` : 'no tasks; the corpus is in evals/*.json'); process.exitCode = 2; break; }
    if (chosen) say(`tier ${chosen.name}: ${chosen.tier.what}`);
    if (sample > 0 && tasks.length < before) say(`sampled ${tasks.length} of ${before} task(s) with seed "${seed}"; the same seed picks the same tasks again.`);
    const engine = optVal('--engine') || (cfg.openaiModel ? 'openai' : 'ollama');
    // echo is the dry run: it exercises the harness without a model, so a
    // broken corpus or checker shows up before any tokens are spent.
    // --model scores a named model without editing the machine's settings, so
    // two baselines can be taken in a row and the report names which was which.
    const picked = optVal('--model');
    // An eval run keeps the local model loaded between tasks, so no task pays a
    // reload the one before it did not, unless the machine's settings say otherwise.
    const cfgFor = { ...cfg, ...(picked ? { ollamaModel: picked, openaiModel: picked } : {}), ollamaKeepAlive: cfg.ollamaKeepAlive || '30m' };
    if (engine === 'openai' && loopMod.v1ContextWarning(cfgFor.openaiUrl)) say(loopMod.v1ContextWarning(cfgFor.openaiUrl));
    const chat = engine === 'echo' ? async () => ({ content: 'echo: no work done' })
      : engine === 'openai' ? loopMod.openaiChat(cfgFor) : loopMod.ollamaChat(cfgFor);
    // One run of a sampling process is not a result: --repeat 3 runs each task
    // three times and reports pass^3 beside pass@3.
    const repeat = Math.max(1, parseInt(optVal('--repeat') || '1', 10) || 1);
    const model = picked || (engine === 'openai' ? cfg.openaiModel : engine === 'ollama' ? cfg.ollamaModel : '');
    say(`${tasks.length} task(s) against ${engine}${repeat > 1 ? `, ${repeat} attempts each` : ''}. The check command decides, not the model.`);
    // What corpus produced the score, in the report itself: a saved report that
    // does not say which tier and which sample it ran cannot be the A in an A/B.
    const corpusInfo = { tier: chosen ? chosen.name : (corpus ? path.basename(path.resolve(corpus)) : 'shipped'), tasks: tasks.length, of: before, sample: sample > 0 && tasks.length < before ? sample : 0, seed: sample > 0 && tasks.length < before ? seed : '' };
    // --rounds overrides every task's own budget for this run and says so in the
    // report. A tier where most runs end out of rounds is measuring the budget.
    const roundsArg = Math.max(0, parseInt(optVal('--rounds') || '0', 10) || 0);
    // The workspaces' folder is checked before the first task, not discovered
    // broken at it.
    const work = evals.workRoot(optVal('--work') || '');
    const refused = evals.workRootProblem(work);
    if (refused) { say(refused); process.exitCode = 2; break; }
    // An arm is named by its flags. A flag the environment names that does not
    // exist, or a value that does not parse, would run this arm as the control
    // and score it as the change, so the run does not start.
    const flagsNow = flagStamp();
    if (flagsNow.unknown.length || flagsNow.bad.length) {
      const known = Object.keys(flagsNow.values).map(flagEnvName);
      say([...flagsNow.unknown.map((n) => `${n} names no flag.`), ...flagsNow.bad.map((b) => b.error), `The flags are: ${known.length ? known.join(', ') : 'none yet'}. Nothing ran.`].join('\n'));
      process.exitCode = 2;
      break;
    }
    say(`flags: ${flagLine(flagsNow)}`);
    // --save keeps the report so two runs can be compared later. A score nobody
    // wrote down cannot be the A in an A/B. It is written after every task, so a
    // run that dies keeps what it did, and --resume carries on from it.
    const savePath = optVal('--save');
    const out = savePath ? path.resolve(savePath) : '';
    let prior = [];
    if (flag('--resume')) {
      if (!out) { say('--resume needs --save <file>: it carries on from the report in that file.'); process.exitCode = 2; break; }
      let old = null;
      try { old = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { old = null; }
      const same = old && old.engine === engine && (old.model || '') === (model || '') && (old.tries || 1) === repeat;
      if (old && !same) { say(`--resume: ${out} was a ${old.engine} ${old.model || ''} run with ${old.tries || 1} attempt(s) each; this one is ${engine} ${model || ''} with ${repeat}. Refusing to mix them.`); process.exitCode = 2; break; }
      // Nor two arms: rows run with other flags are another arm's rows.
      if (old && old.flags && !sameFlags(old.flags, flagsNow)) { say(`--resume: ${out} ran with flags ${flagLine(old.flags)}; this run has ${flagLine(flagsNow)}. Refusing to mix them.`); process.exitCode = 2; break; }
      const want = new Set(tasks.map((t) => t.id));
      prior = old ? (old.results || []).filter((r) => want.has(r.id)) : [];
      say(prior.length ? `--resume: ${prior.length} of ${tasks.length} task(s) already in ${out}; running the other ${tasks.length - prior.length}.` : `--resume: nothing to carry on from in ${out}; starting fresh.`);
    }
    const save = (rep) => { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, `${JSON.stringify(rep, null, 2)}\n`); };
    // The stamp is taken once, at the start: it names the code that is running.
    const stampNow = out ? evals.harnessStamp() : null;
    const partial = (rows) => { if (out) save({ partial: true, results: rows, engine, model, tries: repeat, corpus: corpusInfo, stamp: stampNow, flags: flagsNow }); };
    const report = await evals.runSuite(tasks, { chat, state: agent.newState(cwd, engine), repeat, engineName: engine, model, corpus: corpusInfo, budget: roundsArg, beforeAttempt: stopIfOrphaned, work, prior, onResult: partial, flags: flagsNow });
    say(evals.format(report));
    if (out) { save(report); say(`saved to ${out}`); }
    process.exitCode = report.passed === report.total ? 0 : 1;
    break;
  }
  case 'bench': say(bench.report(cwd, argv.slice(1).filter((a) => !a.startsWith('--')))); break;
  // Two saved runs, asked the paired question rather than eyeballed. Two scores
  // on a corpus this size are not a result; the disagreements are.
  case 'compare': {
    const evals2 = await import('../lib/eval.mjs');
    const files = argv.slice(1).filter((a) => !a.startsWith('--'));
    if (files.length !== 2) { say('usage: atlias compare <a.json> <b.json>   (write them with atlias eval --save)'); process.exitCode = 1; break; }
    const load = (f) => { try { return JSON.parse(fs.readFileSync(path.resolve(f), 'utf8')); } catch (e) { say(`could not read ${f}: ${e.message}`); return null; } };
    const A = load(files[0]), B = load(files[1]);
    if (!A || !B) { process.exitCode = 1; break; }
    const nameOf = (rep, f) => [rep.stamp && rep.stamp.text, rep.model].filter(Boolean).join(' ') || path.basename(f);
    let aName = nameOf(A, files[0]), bName = nameOf(B, files[1]);
    // Two runs of the same code and model (a rerun, or a changed setting) would
    // otherwise print as "X 3/9 against X 4/9"; the file names tell them apart.
    if (aName === bName) { aName = `${aName} (${path.basename(files[0])})`; bName = `${bName} (${path.basename(files[1])})`; }
    say(evals2.formatCompare(evals2.compare(A, B), aName, bName));
    break;
  }
  // Somebody else's benchmark, converted into tasks this machine can run, with
  // every task proved to fail as shipped and pass with its own reference
  // solution before it is written.
  case 'polyglot': {
    const poly = await import('../lib/polyglot.mjs');
    const valued = new Set(['--lang', '--out', '--limit', '--rounds', '--only']);
    const skip = new Set();
    for (const f of valued) { const i = argv.indexOf(f); if (i >= 0) skip.add(i + 1); }
    const repo = argv.slice(1).find((a, i) => !a.startsWith('--') && !skip.has(i + 1));
    if (!repo) { say('usage: atlias polyglot <path to a polyglot-benchmark clone> [--lang python] [--out <dir>] [--limit N] [--only name,name]'); break; }
    const lang = optVal('--lang') || 'python';
    const out = optVal('--out') || path.join(ROOT, 'evals', 'polyglot');
    const limit = parseInt(optVal('--limit') || '0', 10) || 0;
    const rounds = parseInt(optVal('--rounds') || '18', 10) || 18;
    const only = String(optVal('--only') || '').split(',').map((s) => s.trim()).filter(Boolean);
    say(`converting ${lang} exercises from ${repo}. Each one is run twice here before it is kept: it has to fail as shipped and pass with the exercise's own solution.`);
    const result = poly.convert(path.resolve(repo), lang, out, { limit, rounds, only });
    say(poly.report(result));
    process.exitCode = result.wrote.length ? 0 : 1;
    break;
  }
  // Which tier a measurement can be taken on here, and how to get the ones that
  // are not on this machine.
  case 'tiers': {
    const tiers = await import('../lib/tiers.mjs');
    say(tiers.statusLines());
    break;
  }
  // Aider's refactor benchmark: whole source files, one method to move out of
  // its class, graded on the AST by the benchmark's own rules.
  case 'refactorbench': {
    const rb = await import('../lib/refactorbench.mjs');
    const valued = new Set(['--out', '--limit', '--rounds', '--only', '--max-bytes']);
    const skip = new Set();
    for (const f of valued) { const i = argv.indexOf(f); if (i >= 0) skip.add(i + 1); }
    const dir = argv.slice(1).find((a, i) => !a.startsWith('--') && !skip.has(i + 1));
    if (!dir) { say('usage: atlias refactorbench <path to refactor-benchmark/refactor-benchmark> [--out <dir>] [--limit N] [--only name,name] [--max-bytes 40960] [--rounds 16]'); process.exitCode = 1; break; }
    const out = optVal('--out') || path.join(ROOT, 'evals', 'refactor');
    const limit = parseInt(optVal('--limit') || '0', 10) || 0;
    const rounds = parseInt(optVal('--rounds') || '16', 10) || 16;
    // --max-bytes 0 means no cap; anything that is not a number keeps the
    // default rather than quietly becoming no cap.
    const capArg = optVal('--max-bytes');
    const capNum = capArg === null ? NaN : parseInt(capArg, 10);
    const maxBytes = Number.isFinite(capNum) && capNum >= 0 ? capNum : rb.DEFAULT_MAX_BYTES;
    const only = String(optVal('--only') || '').split(',').map((s) => s.trim()).filter(Boolean);
    say(`converting the refactor benchmark from ${dir}. Each task is proved here first: the file as shipped must fail the AST check, and the same file with the method moved out must pass it.`);
    const result = rb.convert(path.resolve(dir), out, { limit, rounds, only, maxBytes });
    say(rb.report(result));
    process.exitCode = result.wrote.length ? 0 : 1;
    break;
  }
  // CanItEdit and HumanEvalFix, from their JSONL rows, proved the same way.
  case 'editbench': {
    const eb = await import('../lib/editbench.mjs');
    const valued = new Set(['--bench', '--variant', '--lang', '--out', '--limit', '--only', '--rounds']);
    const skip = new Set();
    for (const f of valued) { const i = argv.indexOf(f); if (i >= 0) skip.add(i + 1); }
    const file = argv.slice(1).find((a, i) => !a.startsWith('--') && !skip.has(i + 1));
    const kind = optVal('--bench');
    if (!file || !['canitedit', 'humanevalfix'].includes(kind)) { say('usage: atlias editbench <rows.jsonl> --bench canitedit|humanevalfix [--variant lazy|descriptive] [--lang python|js] [--out <dir>] [--limit N] [--only id,id] [--rounds N]'); process.exitCode = 1; break; }
    const variant = optVal('--variant') || 'lazy';
    const lang = optVal('--lang') || 'python';
    const out = optVal('--out') || path.join(ROOT, 'evals', kind, kind === 'canitedit' ? variant : lang);
    const rows = eb.readJsonl(path.resolve(file));
    if (!rows.length) { say(`no rows in ${file}`); process.exitCode = 1; break; }
    const limit = parseInt(optVal('--limit') || '0', 10) || 0;
    const only = String(optVal('--only') || '').split(',').map((s) => s.trim()).filter(Boolean);
    say(`converting ${rows.length} ${kind} row(s) from ${file}. Each one has to fail as shipped and pass with the benchmark's own reference here before it is kept.`);
    const result = eb.convertRows(rows, kind, out, { variant, lang, limit, only, rounds: Math.max(0, parseInt(optVal('--rounds') || '0', 10) || 0) });
    say(eb.report(result));
    process.exitCode = result.wrote.length ? 0 : 1;
    break;
  }
  case 'chooser': process.exitCode = await agent.chooser(); break;
  case 'agent': case 'run': case 'fly': {
    const r = after('--resume');
    process.exitCode = await agent.repl({ engine: after('--engine'), once: after('--once'), resume: flag('--resume') ? (r && !r.startsWith('--') ? r : 'last') : null, sandbox: sandboxFlag() });
    break;
  }
  case 'resume': process.exitCode = await agent.repl({ engine: after('--engine'), resume: argv[1] && !argv[1].startsWith('--') ? argv[1] : 'last', sandbox: sandboxFlag() }); break;
  case 'exec': {
    // The prompt is every word that is not a flag or a flag's value; - or a
    // pipe reads it from stdin, as codex exec does.
    const valued = new Set(['--engine', '--resume']);
    const words = [];
    for (let i = 1; i < argv.length; i++) { if (valued.has(argv[i])) { i++; continue; } if (!argv[i].startsWith('--')) words.push(argv[i]); }
    let prompt = words.join(' ').trim();
    if (prompt === '-' || (!prompt && !process.stdin.isTTY)) { prompt = ''; for await (const chunk of process.stdin) prompt += chunk; prompt = prompt.trim(); }
    if (!prompt) { say('usage: atlias exec "<prompt>" [--engine claude|codex|openai|ollama|echo] [--resume [id]] [--sandbox] [--json]   (or pipe the prompt in)'); process.exitCode = 2; break; }
    const rs = after('--resume');
    const res = await agent.runOnce({ engine: after('--engine'), prompt, resume: flag('--resume') ? (rs && !rs.startsWith('--') ? rs : 'last') : null, sandbox: sandboxFlag() });
    say(flag('--json') ? JSON.stringify(res.json) : res.text);
    process.exitCode = res.code;
    break;
  }
  case 'version': say(`atlias ${VERSION}`); break;
  case 'install': {
    const all = flag('--all') || !argv.slice(1).some((a) => a.startsWith('--'));
    const out = [];
    if (all || flag('--claude')) out.push(...hosts.installClaude(after('--source')));
    if (all || flag('--codex')) out.push(...hosts.installCodex());
    if (all || flag('--antigravity')) out.push(...hosts.installAntigravity());
    if (all || flag('--gemini')) out.push(...hosts.installGemini(flag('--gemini-hooks')));
    if (all || flag('--extras')) out.push(...extra.installAll(extraIds()));
    if (all || flag('--companions')) out.push(...hosts.installCompanions());
    if (all || flag('--shortcut')) out.push(...shortcutInstall());
    say(out); break;
  }
  case 'uninstall': {
    const all = flag('--all') || !argv.slice(1).some((a) => a.startsWith('--'));
    const out = [];
    if (all || flag('--codex')) out.push(...hosts.uninstallCodex());
    if (all || flag('--antigravity')) out.push(...hosts.uninstallAntigravity());
    if (all || flag('--gemini')) out.push(...hosts.uninstallGemini());
    if (all || flag('--extras')) out.push(...extra.uninstallAll(extraIds()));
    if (all || flag('--shortcut')) out.push(...shortcutUninstall());
    out.push('claude code: /plugin uninstall atlias@atlias inside Claude Code');
    say(out); break;
  }
  case 'mode': {
    if (!argv[1]) { say(settings.describeMode()); break; }
    const r = settings.setMode(argv[1]);
    say(r.text);
    process.exitCode = r.ok ? 0 : 2;
    break;
  }
  case 'settings': {
    if (!process.stdin.isTTY || argv[1] === 'list') { say(settings.format()); break; }
    const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
    process.exitCode = await settings.menu((q) => rl.question(q), say);
    rl.close();
    break;
  }
  case 'shortcut': {
    const sub = argv[1] || 'status';
    if (sub === 'install') say(shortcutInstall());
    else if (sub === 'uninstall' || sub === 'remove') say(shortcutUninstall());
    else if (sub === 'status') {
      const s = shortcut.shortcutStatus();
      const hit = shortcut.whichAtlias();
      say([`launcher: ${s.launcher || 'not written'}`, ...s.shims.map((x) => `command: ${x.file}${x.onPath ? '' : ' (folder not on PATH)'}`), `typing atlias runs: ${hit || 'nothing yet; run atlias shortcut install'}`]);
      process.exitCode = hit ? 0 : 1;
    } else { say('usage: atlias shortcut [install|uninstall|status]'); process.exitCode = 2; }
    break;
  }
  case 'doctor': { const c = hosts.doctor(cwd).concat(extra.doctorRows()); say(hosts.formatDoctor(c)); process.exitCode = c.every((x) => x.ok) ? 0 : 1; break; }
  case 'status': {
    const g = graph.status(cwd);
    const p = dream.pending(cwd);
    say([`atlias ${VERSION}`, `mode: ${settings.mode()} (atlias mode to change it)`, `state: ${STATE_DIR}`, `project: ${cwd}`, `graph: ${g.exists ? `present, updated ${g.age}` : 'none'}`, `dream pending: ${p.count}`, `handoff note: ${progress.read(cwd) ? progress.notePath(cwd) : 'none yet'}`]);
    break;
  }
  case 'brief': say(brief.build({ cwd, session_id: 'cli', source: 'startup' }, after('--host') || 'claude')); break;
  case 'test': { const r = spawnSync(process.execPath, [path.join(ROOT, 'test', 'run.mjs'), ...argv.slice(1)], { stdio: 'inherit' }); process.exitCode = r.status || 0; break; }
  case 'skills': {
    const which = argv.slice(1).filter((a) => !a.startsWith('--')).join(' ').trim();
    if (!which) { say(skills.format(skills.discover(cwd))); break; }
    const one = skills.body(cwd, which);
    if (!one) { say(`no skill matches ${which}; atlias skills lists them`); process.exitCode = 1; break; }
    say(`${one.path}\n\n${one.text}`);
    break;
  }
  case 'recall': say(recall(cwd, argv.slice(1).join(' '))); break;
  case 'remember': {
    const sep = argv.indexOf('--');
    const [name, type, ...desc] = argv.slice(1, sep === -1 ? undefined : sep);
    if (!name || !type) { say('usage: atlias remember <name> <user|feedback|project|reference> <description> -- <body>'); process.exitCode = 2; break; }
    say(remember(cwd, { name, type, description: desc.join(' '), body: sep === -1 ? '' : argv.slice(sep + 1).join(' ') }));
    break;
  }
  case 'progress': {
    if (argv[1] === 'set') { const m = progress.applyNext(cwd, argv.slice(2).join(' ')); say(m || 'next step recorded; no handoff note yet.'); }
    else say(progress.read(cwd) || 'no handoff note yet');
    break;
  }
  case 'dream': {
    if (argv[1] === 'ack') say(`dream: consolidated through cursor ${dream.ack(cwd)}`);
    else if (argv[1] === 'distil') { const row = dream.distil(argv[2] || 'cli', argv[3] || '', cwd); say(row ? `dream: wrote cursor ${row.cursor}` : 'dream: nothing to distil for that session'); }
    else { dream.digest(cwd); say(readOr(dream.digestPath(cwd), 'no digest yet')); }
    break;
  }
  case 'graph': {
    const sub = argv[1]; const arg = argv.slice(2).join(' ');
    if (sub === 'query') say(graph.query(cwd, arg, config().graph.queryBudget) || 'no graph, or no answer');
    else if (sub === 'affected' || sub === 'explain') say(graph.sub(cwd, sub, arg) || 'no graph, or no answer');
    else if (sub === 'update') say(graph.updateNow(cwd) ? 'graph updated' : 'graph update failed (see ~/.atlias/log.txt)');
    else say('usage: atlias graph query|affected|explain|update <arg>');
    break;
  }
  case 'config': {
    const p = path.join(STATE_DIR, 'config.json');
    const user = readJson(p, {}) || {};
    if (argv[1] === 'set' && argv[2]) {
      const [section, key] = argv[2].split('.');
      const parsed = parseSetting(section, key, argv.slice(3).join(' '));
      if (parsed.error) { say(parsed.error); process.exitCode = 2; break; }
      user[section] = { ...(user[section] || {}), [key]: parsed.value };
      writeJson(p, user);
      // Read it back through config() so what is printed is what took effect.
      say(`${argv[2]} = ${JSON.stringify(config()[section][key])}`);
    } else say(JSON.stringify(config(), null, 2));
    break;
  }
  default:
    say([logo(), '', 'atlias                             by mode: ask (both), status (sub), the agent (standalone)', 'agent [--engine claude|codex|openai|ollama|echo] [--once "<prompt>"] [--resume [id]] [--sandbox]', 'exec "<prompt>" [--engine e] [--resume [id]] [--sandbox] [--json]   one prompt, no questions; - or a pipe reads stdin', '  --sandbox                        work in a throwaway git worktree, show the diff at the end, and change the project only if you take it', 'resume [id]                        carry on the last agent session in this folder', 'mode [both|sub|standalone]         what atlias is on this machine', 'settings [list]                    every option, with what it does', 'install [--all|--codex|--antigravity|--gemini [--gemini-hooks]|--claude|--extras [ids]|--companions|--shortcut]', 'uninstall [--all|--codex|--antigravity|--gemini|--extras|--shortcut]', 'shortcut [install|uninstall|status]  the atlias command in any terminal', 'tiers                              the benchmark tiers, which are on this machine, and how to get the rest', 'eval [--tier smoke|main|big] [--sample N [--seed s]] [--engine e] [--repeat k] [--save f]   score tasks; the check decides', 'compare <a.json> <b.json>          two saved runs, paired, with what the corpus could never have shown', 'doctor | status | brief [--host codex] | test | bench [question...] | version | logo', 'skills [name]                      the skills installed here, or one of them in full', 'recall <query> | remember <name> <type> <description> -- <body>', 'progress [set <next step>] | dream [ack|distil <session>] | graph query|affected|explain|update <arg>', 'config [set <section.key> <value>]']);
}
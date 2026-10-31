// The meta-test: every exported function in lib/ and mcp/ has to be named by
// at least one test, or be listed below with the reason it cannot be. A new
// feature with no test fails the suite, which is how "every feature is tested
// in its own right" stays true after this session. Loaded by test/run.mjs.
const WORD = (name) => new RegExp('(^|[^A-Za-z0-9_$])' + name.replace(/[$]/g, '[$]') + '($|[^A-Za-z0-9_$])');
// A test uses a function when it reaches it through the alias its module was
// imported under (graphMod.worker, not dream.worker; agentMod.runTool counts
// for loop.runTool because agent re-exports it). A bare word is not enough:
// "worker" appears in the string graph-worker without anything calling it.
const esc = (s) => s.replace(/[$.]/g, (c) => '[' + c + ']');
function aliasesByModule(tests) {
  const map = new Map();
  const add = (mod, alias) => { if (!map.has(mod)) map.set(mod, new Set()); map.get(mod).add(alias); };
  for (const m of tests.matchAll(/const ([A-Za-z_$][\w$]*) = await import[(]'[.][.]\/((?:lib|mcp)\/[\w-]+[.]mjs)'[)]/g)) add(m[2], m[1]);
  for (const m of tests.matchAll(/import [*] as ([A-Za-z_$][\w$]*) from '[.][.]\/((?:lib|mcp)\/[\w-]+[.]mjs)'/g)) add(m[2], m[1]);
  return map;
}
function reExporters(ROOT, fs, path) {
  // name -> [module that re-exports it] for `export { a, b } from './x.mjs'`
  const out = [];
  for (const dir of ['lib', 'mcp']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((x) => x.endsWith('.mjs'))) {
      const src = fs.readFileSync(path.join(ROOT, dir, f), 'utf8');
      for (const m of src.matchAll(/export [{]([^}]*)[}] from '[.]\/([\w-]+[.]mjs)'/g)) {
        for (const n of m[1].split(',').map((s) => s.trim()).filter(Boolean)) out.push({ from: `${dir}/${m[2]}`, via: `${dir}/${f}`, name: n });
      }
    }
  }
  return out;
}
const usedThrough = (aliases, name) => [...aliases].some((a) => new RegExp('(^|[^A-Za-z0-9_$.])' + esc(a) + '[.]' + esc(name) + '($|[^A-Za-z0-9_$])').test(USED_CORPUS.text));
const USED_CORPUS = { text: '' };
// Named imports from mcp/tools.mjs and the like are called bare.
const calledBare = (name, mod) => new RegExp('import [{][^}]*(^|[^A-Za-z0-9_$])' + esc(name) + '([^A-Za-z0-9_$][^}]*)?[}] from \'[.][.]\/' + esc(mod) + '\'').test(USED_CORPUS.text) && new RegExp('(^|[^A-Za-z0-9_$.])' + esc(name) + '[ ]*[(]').test(USED_CORPUS.text);

// Functions that cannot run under a test, each with the reason and where the
// behaviour is exercised instead. Anything else must be named by a test.
export const EXEMPT = {
  'lib/agent.mjs chooser': 'reads a keypress from a real terminal; the settings menu it opens is tested through settings.menu',
  'lib/agent.mjs ollamaAlive': 'probes a live Ollama server; detectEngines is tested and reports it',
  'lib/agent.mjs ollamaTurn': 'a one-line wrapper around loop.runLoop and loop.ollamaChat, both tested',
  'lib/agent.mjs openaiTurn': 'a one-line wrapper around loop.runLoop and loop.openaiChat, both tested against a local server',
  'lib/graph.mjs worker': 'the detached background process entry point; updateNow, which it runs, is tested',
  'lib/core.mjs readStdin': 'reads the host payload from a real stdin; every hook test feeds it through a spawned hooks.mjs',
  'mcp/server.mjs handle': 'importing the server starts its stdin loop; every answer it gives is checked end to end by hosts.probeServer, which spawns the real server',
  'lib/hosts.mjs uninstallAntigravity': 'same; the sandbox uninstalls and checks the block is gone',
  'lib/hosts.mjs uninstallGemini': 'same; covered by the sandbox uninstall',
  'lib/hosts.mjs installClaude': 'drives the claude CLI plugin commands, which CI does not have',
  'lib/hosts.mjs installCompanions': 'drives the claude CLI plugin commands, which CI does not have',
  'lib/hosts-extra.mjs installAll': 'writes into every detected harness under the real home; the sandbox runs it through atlias install --extras and checks each file',
  'lib/hosts-extra.mjs uninstallAll': 'same; the sandbox uninstall checks other entries survive',
};

export default async function coverageSuites({ suite, check, ROOT, fs, path }) {
  suite('coverage expert', 'every feature has a test of its own', () => {
    // This file names every exempt function, so it is not evidence of a test.
    const tests = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.mjs') && f !== 'coverage-suites.mjs').map((f) => fs.readFileSync(path.join(ROOT, 'test', f), 'utf8')).join('\n');
    USED_CORPUS.text = tests;
    const aliases = aliasesByModule(tests);
    const reexports = reExporters(ROOT, fs, path);
    const isUsed = (mod, name) => {
      const direct = aliases.get(mod) || new Set();
      const via = reexports.filter((r) => r.from === mod && r.name === name).flatMap((r) => [...(aliases.get(r.via) || [])]);
      return usedThrough(new Set([...direct, ...via]), name) || calledBare(name, mod);
    };
    const missing = [];
    const stale = [];
    let total = 0;
    for (const dir of ['lib', 'mcp']) {
      for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((x) => x.endsWith('.mjs')).sort()) {
        const src = fs.readFileSync(path.join(ROOT, dir, f), 'utf8');
        const fns = [...src.matchAll(/^export (?:async )?function\*? ?([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
        for (const name of fns) {
          total++;
          const key = `${dir}/${f} ${name}`;
          const named = isUsed(`${dir}/${f}`, name);
          if (EXEMPT[key]) { if (named) stale.push(key); continue; }
          if (!named) missing.push(key);
        }
      }
    }
    check('the scan found the exported functions', total > 150, { happened: total + ' functions', why: 'A scan that finds nothing passes everything.', fix: 'Check the export regex in coverage-suites.' });
    check('every exported function is named by a test', missing.length === 0, { happened: missing.length + ' untested: ' + missing.join('; '), why: 'A function no test calls is a feature nobody knows works; this is the check that keeps every feature tested in its own right.', fix: 'Write a check that calls it, or add it to EXEMPT with the reason it cannot run under a test.' });
    check('no exemption hides a function that is tested after all', stale.length === 0, { happened: stale.join('; '), why: 'An exemption outliving its reason is how the list grows until it means nothing.', fix: 'Remove it from EXEMPT.' });
    const exemptMissing = Object.keys(EXEMPT).filter((k) => { const [file, name] = k.split(' '); return !WORD(name).test(fs.readFileSync(path.join(ROOT, file), 'utf8')); });
    check('every exemption names a function that exists', exemptMissing.length === 0, { happened: exemptMissing.join('; '), why: 'An exemption for a deleted function is noise.', fix: 'Remove it from EXEMPT.' });

    // asyncSuite points the runner's current-suite pointer at itself before it
    // starts, so an un-awaited one runs at the same time as the next one and
    // its checks are counted under the wrong suite name. The totals still add
    // up, which is what makes it hard to notice: it was found here because a
    // suite reported 0 passed, 0 failed while its checks were plainly running.
    const loose = [];
    for (const f of fs.readdirSync(path.join(ROOT, 'test')).filter((x) => x.endsWith('-suites.mjs')).sort()) {
      const src = fs.readFileSync(path.join(ROOT, 'test', f), 'utf8');
      // Comments name these functions while explaining them, and a checker that
      // reads prose as code reports a bug in a sentence.
      // Split on \r?\n: in a CRLF checkout (core.autocrlf on Windows) a line
      // keeps its \r, `.` stops before it, and `$` then never matches, so no
      // line comment was stripped and a comment naming asyncSuite() was counted
      // as an un-awaited call.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
      const calls = [...code.matchAll(/(await\s+)?asyncSuite\s*\(/g)];
      if (!calls.length) continue;
      const bare = calls.filter((m) => !m[1]).length;
      if (bare) loose.push(`${f}: ${bare} un-awaited asyncSuite call(s)`);
      if (!/export default async function/.test(src)) loose.push(`${f}: register is not async, so it cannot await its suites`);
    }
    check('every async suite is awaited by the file that registers it', loose.length === 0, { happened: loose.join('; ') || 'all awaited', why: 'Checks counted under the wrong suite send whoever reads a failure to the wrong file, and a suite that reports zero checks looks like one that was skipped on purpose.', fix: 'Make register async and await every asyncSuite call.' });
  });
}

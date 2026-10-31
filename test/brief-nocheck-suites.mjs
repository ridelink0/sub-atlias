// PLAN-1013 Step 2.5 to 2.7 (2026-10-13): flags.briefNoCheckRule, flags.briefAllTools and the
// Stop hook's 45 seconds. Each flag is off by default and its off path is the old text byte for
// byte, so stored runs reproduce. Loaded by test/run.mjs.
import * as brief from '../lib/brief.mjs';
import * as integrity from '../lib/integrity.mjs';
import * as hosts from '../lib/hosts.mjs';

export default async function briefNoCheckSuites({ suite, check, core, TMP, fs, path, ROOT }) {
  const project = (name, files) => {
    const dir = path.join(TMP, `nocheck-${name}-${process.pid}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), body); }
    return dir;
  };
  const withFlags = (flags) => ({ ...core.config(), flags: { ...core.config().flags, ...flags } });
  const say = (dir, flags) => brief.build({ cwd: dir, source: 'startup', session_id: `nocheck-${process.pid}-${Date.now()}` }, 'claude', withFlags(flags));
  suite('brief no-check adversary', 'uncertain discovery never claims no check exists', () => {
    const ambiguous = project('ambiguous', { 'check.py': 'assert True\n', 'verify.py': 'assert True\n' });
    const malformed = project('malformed-package', { 'package.json': '{ broken metadata' });
    check('tied best candidates and malformed package metadata cannot select the no-check rule', !/do not write one/.test(say(ambiguous, { briefNoCheckRule: true })) && !/do not write one/.test(say(malformed, { briefNoCheckRule: true })),
      { happened: 'ambiguous and malformed project briefs', why: 'Unknown discovery is not definite absence.', fix: 'Retain discovery uncertainty separately from the optional unique check.' });
    const original = { readdirSync: fs.readdirSync, statSync: fs.statSync, readFileSync: fs.readFileSync };
    const denied = () => { const e = new Error('fixture access denied'); e.code = 'EACCES'; throw e; };
    const same = (a, b) => path.resolve(String(a)) === path.resolve(String(b));
    try {
      const cases = [
        ['readdirSync', '', 'root enumeration', { 'main.py': 'X=1\n' }],
        ['statSync', 'test_x.py', 'candidate stat', { 'test_x.py': 'assert True\n' }],
        ['readFileSync', 'test_x.py', 'candidate read', { 'test_x.py': 'assert True\n' }],
        ['readFileSync', 'pyproject.toml', 'suite metadata read', { 'pyproject.toml': '[project]\nname="x"\n' }],
        ['readdirSync', 'tests', 'tests enumeration', { 'tests/helper.py': 'X=1\n' }],
      ];
      for (const [method, relative, label, files] of cases) {
        const dir = project(label.replaceAll(' ', '-'), files);
        const target = path.join(dir, relative);
        fs[method] = (...args) => same(args[0], target) ? denied() : original[method](...args);
        const text = say(dir, { briefNoCheckRule: true });
        check(`unreadable ${label} is unknown rather than no-check`, !/do not write one/.test(text),
          { happened: text.slice(-400), why: 'An inaccessible project or candidate cannot justify absence of a check.', fix: 'Keep uncertainty and suppress only the optional no-check branch.' });
        fs[method] = original[method];
      }
    } finally { Object.assign(fs, original); }
  });
  suite('brief no-check expert', 'no check is named, so the brief says not to write one', () => {
    const on = brief.doneRule({ none: true });
    const onOff = brief.doneRule({ none: true, doublePass: false });
    check('with none, the done rule says the project names no check and not to write one, in both forms', /do not write one/.test(on) && /do not write one/.test(onOff) && !/smallest real check/.test(on), { happened: on, why: 'Asked for the smallest real check, a 9B wrote one of its own: 14 extra shell calls in 16 screen runs (c10 F1).', fix: 'doneRule returns the no-check text when none is true and no check is named.' });
    check('the no-check pass line reads as honest to the gate, so it is not held as a claim', integrity.HONEST_RE.test(on), { happened: on, why: 'A pass line the gate takes for a claim holds the reply and costs a whole turn.', fix: 'Say "unverified" in the no-check pass line.' });
    check('without none, the done rule is the old text byte for byte', brief.doneRule({}) === brief.doneRule({ none: false }) && brief.doneRule({ check: 'python check.py', none: true }) === brief.doneRule({ check: 'python check.py' }), { happened: brief.doneRule({}), why: 'Stored runs ran with the old words.', fix: 'Only the none branch is new.' });
    const bare = project('bare', { 'main.py': 'def f():\n    return 1\n' });
    const checked = project('checked', { 'main.py': 'def f():\n    return 1\n', 'check.py': 'from main import f\nassert f() == 1\n' });
    check('with briefNoCheckRule, a project with no check gets the no-check rule and one with check.py does not', /do not write one/.test(say(bare, { briefNoCheckRule: true })) && !/do not write one/.test(say(checked, { briefNoCheckRule: true })), { happened: say(checked, { briefNoCheckRule: true }).slice(-400), why: 'Telling a model not to write a check where one exists would cost the check.', fix: 'noCheck() asks visibleCheck(cwd).' });
    check('without briefNoCheckRule, the brief keeps the old done rule', !/do not write one/.test(say(bare, {})), { happened: say(bare, {}).slice(-300), why: 'The flag is off by default.', fix: 'noCheck() returns false unless the flag is on.' });
    // visibleCheck reads only the top of the folder and names only check scripts, so a project whose tests
    // the loop runs (lib/loop.mjs detectTestCommand) looked like one with no check (council 1013b b08 F1).
    const suites = {
      'Cargo.toml': { 'Cargo.toml': '[package]\nname = "x"\nversion = "0.1.0"\n' },
      'go.mod': { 'go.mod': 'module example.com/x\n\ngo 1.22\n' },
      'pytest.ini': { 'pytest.ini': '[pytest]\ntestpaths = tests\n' },
      'conftest.py': { 'conftest.py': 'import pytest\n' },
      'tests/test_x.py': { 'tests/test_x.py': 'def test_x():\n    assert 1 == 1\n' },
      'pyproject with [tool.pytest': { 'pyproject.toml': '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n' },
    };
    const gotRule = Object.entries(suites).filter(([, files], i) => /do not write one/.test(say(project(`suite-${i}`, files), { briefNoCheckRule: true }))).map(([name]) => name);
    check('a project with a Cargo, go, pytest or tests suite does not get the no-check rule', gotRule.length === 0, { happened: 'the no-check rule was given for: ' + gotRule.join(', '), why: 'A model told its project has no check, when the loop runs a test suite there, is sent away from that check (council 1013b b08 F1).', fix: 'noCheck() returns false when Cargo.toml, go.mod, pytest.ini, conftest.py, tests/test_*.py or a pyproject [tool.pytest is present.' });
    const controls = {
      'pyproject without pytest': { 'pyproject.toml': '[project]\nname = "x"\n' },
      'tests folder with no test file': { 'tests/helper.py': 'X = 1\n' },
    };
    const noRule = Object.entries(controls).filter(([, files], i) => !/do not write one/.test(say(project(`control-${i}`, files), { briefNoCheckRule: true }))).map(([name]) => name);
    check('a pyproject without pytest settings, or a tests folder with no test file, still gets the no-check rule', noRule.length === 0, { happened: 'the rule was not given for: ' + noRule.join(', '), why: 'The new marker must not widen into every project with a tests folder.', fix: 'Match tests/test_*.py and [tool.pytest only.' });
    // The full Codex block is written to AGENTS.md and re-sent with every request; it restated "smallest real
    // check run", the rule the flag takes away, so the model got both (council 1013b b08 F3).
    const fullOn = hosts.instructionBlock('codex', { noCheckRule: true });
    const fullOff = hosts.instructionBlock('codex');
    check('with noCheckRule, the full Codex block defers the done rule to the session brief', !/smallest real check/.test(fullOn) && /session brief/.test(fullOn) && hosts.instructionBlock('codex', { noCheckRule: false }) === fullOff, { happened: fullOn.slice(-300), why: 'The block told the model to run the smallest real check while the brief said not to write one, so the model got both (c10 F1 behaviour).', fix: 'instructionBlock takes noCheckRule and the full Codex block defers the done rule when it is set.' });
    check('without noCheckRule the full Codex block keeps the old done sentence', /Done means: smallest real check run, then a second adversarial read of every changed file, and the reply names both passes\./.test(fullOff), { happened: fullOff.slice(-300), why: 'The flag is off by default and the block must stay the old text.', fix: 'Only the done sentence changes, and only when noCheckRule is set.' });
    const agentsPath = path.join(process.env.CODEX_HOME, 'AGENTS.md');
    const flagKey = 'ATLIAS_FLAG_BRIEF_NO_CHECK_RULE';
    const priorFlag = process.env[flagKey];
    try {
      process.env[flagKey] = '1';
      hosts.installCodex();
      const written = fs.readFileSync(agentsPath, 'utf8');
      check('installing Codex with briefNoCheckRule on writes the deferring block to AGENTS.md', !/smallest real check/.test(written) && /session brief/.test(written), { happened: written.slice(-300), why: 'The flag is read from the environment at install; a block written from the flag-off text ignores it.', fix: 'installCodex passes noCheckRule from flags.briefNoCheckRule.' });
    } finally {
      if (priorFlag === undefined) delete process.env[flagKey]; else process.env[flagKey] = priorFlag;
      hosts.installCodex();
    }
    check('briefAllTools names all ten server tools, and the brief without it names the old eight', /harness_bench/.test(say(bare, { briefAllTools: true })) && /harness_status/.test(say(bare, { briefAllTools: true })) && !/harness_bench/.test(say(bare, {})), { happened: say(bare, { briefAllTools: true }).slice(0, 300), why: 'A tool the brief leaves out is one the model does not know to call (c16 F2).', fix: 'Use TOOLS_ALL when flags.briefAllTools is on.' });
  });
  suite('stop budget expert', 'the Stop gate gets 45 seconds on every host', () => {
    const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
    const stop = doc.hooks.Stop[0].hooks[0].timeout;
    const codex = Object.fromEntries(hosts.CODEX_EVENTS.map(([ev, , t]) => [ev, t]));
    const gem = Object.fromEntries(hosts.GEMINI_EVENTS.map(([ev, , t]) => [ev, t]));
    check('Stop is 45 seconds in hooks.json, for Codex and for Gemini CLI', stop >= 45 && codex.Stop >= 45 && gem.AfterAgent >= 45000, { happened: JSON.stringify({ stop, codex: codex.Stop, gemini: gem.AfterAgent }), why: 'The gate can run the project check (10 s) on top of its own reads; at 30 s the host cancels it and the reply goes out unchecked (c16 F5).', fix: 'Set the Stop timeout to 45 in hooks/hooks.json, CODEX_EVENTS and GEMINI_EVENTS.' });
  });
  // With every flag off, the brief for Claude and Codex and the Codex block are the text of commit 0499c78, byte for
  // byte (council 1013b b09 F5: the flag-off promise rested on a comparison of the new code with itself). The fixture was
  // captured once from that commit's lib/ on the same project; only paths are normalised, to tokens.
  suite('flag-off golden expert', 'with every flag off, the brief and the Codex block are the text of commit 0499c78', () => {
    const golden = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'brief-0499c78.json'), 'utf8'));
    // Defaults only, so a config.json left by another suite cannot change the bytes; a cached "no python" answer, so
    // the graphify line is the same on every machine.
    const defaults = JSON.parse(JSON.stringify(core.DEFAULTS));
    fs.mkdirSync(core.STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(core.STATE_DIR, 'python.json'), JSON.stringify({ path: null, checked: Date.now() }));
    const cwd = project('golden', { 'main.py': 'def f():\n    return 1\n' });
    const memDir = core.claudeMemoryDir(cwd);
    const cli = path.join(ROOT, 'bin', 'atlias.mjs');
    const norm = (text) => [[cli, '<CLI>'], [cli.replace(/\\/g, '/'), '<CLI>'], [memDir, '<MEMDIR>'], [cwd, '<PROJECT>'], [core.CLAUDE_DIR, '<CLAUDE_DIR>'], [ROOT, '<ROOT>']].reduce((t, [from, to]) => t.split(from).join(to), String(text));
    const now = {
      claude: norm(brief.build({ cwd, source: 'startup', session_id: 'golden' }, 'claude', defaults)),
      codex: norm(brief.build({ cwd, source: 'startup', session_id: 'golden' }, 'codex', defaults)),
      codexBlock: norm(hosts.instructionBlock('codex')),
    };
    const firstDiff = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i; };
    // The version number in the brief's first words changes with every release; the words around it are what stored runs saw.
    const unversioned = (s) => String(s).replace(/\batlias \d+\.\d+\.\d+/g, 'atlias N');
    const differ = Object.keys(golden).filter((k) => unversioned(now[k]) !== unversioned(golden[k]));
    const detail = differ.length ? (() => { const at = firstDiff(now[differ[0]], golden[differ[0]]); return differ.join(', ') + ' differ; first at character ' + at + ': now "' + now[differ[0]].slice(at, at + 90) + '" against "' + golden[differ[0]].slice(at, at + 90) + '"'; })() : 'all three equal';
    check('with every flag off, the Claude brief, the Codex brief and the Codex block match commit 0499c78 byte for byte', differ.length === 0, { happened: detail, why: 'Stored runs were measured with the old words. A change that is not behind a flag moves every measured arm at once.', fix: 'Find the change in lib/brief.mjs or lib/hosts.mjs that is not behind its flag. The fixture is test/fixtures/brief-0499c78.json.' });
  });
}

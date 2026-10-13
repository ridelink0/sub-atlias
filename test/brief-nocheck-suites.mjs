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
    for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body);
    return dir;
  };
  const withFlags = (flags) => ({ ...core.config(), flags: { ...core.config().flags, ...flags } });
  const say = (dir, flags) => brief.build({ cwd: dir, source: 'startup', session_id: `nocheck-${process.pid}-${Date.now()}` }, 'claude', withFlags(flags));
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
    check('briefAllTools names all ten server tools, and the brief without it names the old eight', /harness_bench/.test(say(bare, { briefAllTools: true })) && /harness_status/.test(say(bare, { briefAllTools: true })) && !/harness_bench/.test(say(bare, {})), { happened: say(bare, { briefAllTools: true }).slice(0, 300), why: 'A tool the brief leaves out is one the model does not know to call (c16 F2).', fix: 'Use TOOLS_ALL when flags.briefAllTools is on.' });
  });
  suite('stop budget expert', 'the Stop gate gets 45 seconds on every host', () => {
    const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
    const stop = doc.hooks.Stop[0].hooks[0].timeout;
    const codex = Object.fromEntries(hosts.CODEX_EVENTS.map(([ev, , t]) => [ev, t]));
    const gem = Object.fromEntries(hosts.GEMINI_EVENTS.map(([ev, , t]) => [ev, t]));
    check('Stop is 45 seconds in hooks.json, for Codex and for Gemini CLI', stop >= 45 && codex.Stop >= 45 && gem.AfterAgent >= 45000, { happened: JSON.stringify({ stop, codex: codex.Stop, gemini: gem.AfterAgent }), why: 'The gate can run the project check (10 s) on top of its own reads; at 30 s the host cancels it and the reply goes out unchecked (c16 F5).', fix: 'Set the Stop timeout to 45 in hooks/hooks.json, CODEX_EVENTS and GEMINI_EVENTS.' });
  });
}

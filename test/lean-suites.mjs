// Round five, row 4: the lean brief (flags.leanBrief), and the brief's side of
// the gate running the check (flags.gateRunsCheck). The brief is paid on every
// request of a session, so each cut is counted in characters here. Measured on
// an empty project in Claude Code: 1357 characters off, 961 lean.
const NL = String.fromCharCode(10);

export default async function ({ suite, check, brief, TMP, ROOT, fs, path }) {
  const withEnv = (vars, fn) => {
    const before = {};
    for (const k of Object.keys(vars)) { before[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
    try { return fn(); } finally { for (const k of Object.keys(vars)) { if (before[k] == null) delete process.env[k]; else process.env[k] = before[k]; } }
  };
  const LEAN = 'ATLIAS_FLAG_LEAN_BRIEF';
  const GATE = 'ATLIAS_FLAG_GATE_RUNS_CHECK';
  let n = 0;
  const project = (files = {}) => {
    const dir = path.join(TMP, 'lean', `p${++n}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); }
    return dir;
  };
  const build = (dir, host, vars) => withEnv({ [LEAN]: null, [GATE]: null, ...vars }, () => brief.build({ cwd: dir, session_id: `lean-${++n}`, source: 'startup' }, host));
  const TOOL_NAMES = ['harness_recall', 'harness_remember', 'harness_progress', 'harness_verify', 'harness_digest', 'graph_query', 'graph_affected', 'graph_explain'];

  suite('lean brief expert', 'the lean brief cuts what every request pays for', () => {
    const empty = project();
    const off = build(empty, 'claude', {});
    const zero = build(empty, 'claude', { [LEAN]: '0', [GATE]: '0' });
    const lean = build(empty, 'claude', { [LEAN]: '1' });
    check('off, the brief is the one every earlier arm saw', off === zero && TOOL_NAMES.every((t) => off.split(NL)[0].includes(t)) && /## Companions/.test(off) && /The gate holds a reply without that line/.test(off), { happened: off.slice(0, 300), why: 'The baseline arm is the control for every flag of the round only if an unset flag and a flag set to 0 both give today\'s brief.', fix: 'brief.build changes nothing unless flags.leanBrief is on.' });
    const first = lean.split(NL)[0];
    check('lean, the first line lists no tool names and no CLI path', !TOOL_NAMES.some((t) => first.includes(t)) && !first.includes('atlias.mjs') && /MCP server "atlias"/.test(first), { happened: first, why: 'Claude Code lists the MCP server\'s tool names itself and loads the rest on demand; repeating eight names is paid on every request.', fix: 'The lean first line names the server only.' });
    check('lean, there is no Companions section when it asks nothing of the model', !/## Companions/.test(lean) && !/graphify missing|ultimate-frontend-skills off/.test(lean), { happened: (lean.match(/## Companions[^]*?(\n\n|$)/) || ['(none)'])[0], why: 'What is installed or missing is for the user and atlias doctor; the model can do nothing with it on every request.', fix: 'Lean keeps the section only for a companion loaded twice.' });
    const dup = project({ '.claude/skills/ultimate-frontend-skills/SKILL.md': '# UFS', '.claude/settings.json': '{"enabledPlugins":{"ultimate-frontend-skills@ridelink0":true}}' });
    const leanDup = build(dup, 'claude', { [LEAN]: '1' });
    check('lean, a companion loaded twice is still said, and only that', /## Companions\nultimate-frontend-skills loaded 2 times .*keep one\.$/m.test(leanDup) && !/graphify missing|graphify ok/.test(leanDup), { happened: (leanDup.match(/## Companions\n[^\n]*/) || ['(none)'])[0], why: 'Two copies of a skill load twice on every request; that is the one companion fact the model should act on.', fix: 'Keep the duplicate warning.' });
    check('lean, the pass line is taught once, without the sentence explaining the gate', lean.split('"Pass 1: <check> passed. Pass 2: <what the re-read found>."').length === 2 && !/The gate holds a reply without that line/.test(lean) && /Done means verified: run the smallest real check/.test(lean), { happened: (lean.match(/- Done means[^\n]*/) || ['(no done rule)'])[0], why: 'The double-check skill and the gate\'s own hold message both explain the line; the brief needs only the line the gate accepts.', fix: 'doneRule({ lean: true }) in lib/brief.mjs.' });
    check('lean, the Claude Code brief is at least 350 characters shorter, under 1000, and the same on every build', lean.length <= off.length - 350 && lean.length < 1000 && lean === build(empty, 'claude', { [LEAN]: '1' }), { happened: `${off.length} characters off, ${lean.length} lean`, why: 'NEXTGEN-5 row 4 aims at the fixed text paid on every request; a cut nobody counted is not a cut, and a brief that changes between builds cannot be cached as a prompt prefix.', fix: 'Check what brief.build adds under leanBrief.' });
    const offCodex = build(empty, 'codex', {});
    const leanCodex = build(empty, 'codex', { [LEAN]: '1' });
    check('lean does the same for the other hosts, and keeps their memory section', leanCodex.length <= offCodex.length - 350 && /## Memory/.test(leanCodex) && !TOOL_NAMES.some((t) => leanCodex.split(NL)[0].includes(t)), { happened: `${offCodex.length} off, ${leanCodex.length} lean`, why: 'Codex has no shared memory of its own; the section is how it finds harness_remember.', fix: 'Only the tool line, Companions and the done rule change.' });
  });

  const baseCfg = (await import('../lib/core.mjs')).config();
  suite('lean brief expert', 'the brief says when the gate will run the check', () => {
    const hooksOnly = brief.build({ cwd: project(), session_id: 'lean-hooks-only', source: 'startup' }, 'codex', { ...baseCfg, flags: { ...baseCfg.flags, hooksOnly: true } });
    const withTools = brief.build({ cwd: project(), session_id: 'lean-hooks-off', source: 'startup' }, 'codex', { ...baseCfg, flags: { ...baseCfg.flags, hooksOnly: false } });
    check('hooks only, the brief names no MCP tool and no section that needs one, and keeps the rules that need none', !/harness_|graph_query|MCP server/.test(hooksOnly) && /It adds no tools here/.test(hooksOnly) && /Never repeat an identical call/.test(hooksOnly) && /Done means verified/.test(hooksOnly) && /Never invent a result/.test(hooksOnly) && !/## Memory|## Knowledge graph|## Companions|## Dream/.test(hooksOnly) && /MCP server "atlias"/.test(withTools) && hooksOnly.length < withTools.length,
      { happened: hooksOnly, why: 'With no server registered, a brief that names its tools sends the model after tools that are not there. On Codex the server cost most of 1,900 tokens a call and a 9B used a real atlias tool once in 10 tasks (subharness trial-02, 2026-10-13).', fix: 'build returns the hooks-only brief before any section that names a tool.' });
    const withPass = (on) => brief.build({ cwd: project(), session_id: `lean-dp-${on}`, source: 'startup' }, 'claude', { ...baseCfg, verify: { ...baseCfg.verify, doublePass: on } });
    check('with verify.doublePass off the done rule asks for no second read and no pass line, and the brief follows the setting', !/re-read|Pass 1/.test(brief.doneRule({ doublePass: false })) && !/re-read|Pass 1/.test(brief.doneRule({ doublePass: false, check: 'python check.py', lean: true })) && /atlias runs `python check.py` when you finish/.test(brief.doneRule({ doublePass: false, check: 'python check.py' })) && brief.doneRule({ doublePass: true }) === brief.RULES[2] && !/re-read each changed file|Pass 1:/.test(withPass(false)) && /Done means verified: when the project has a check/.test(withPass(false)) && /re-read each changed file adversarially/.test(withPass(true)),
      { happened: brief.doneRule({ doublePass: false }), why: 'A brief that asks for what the gate was told not to check cost a 9B model 44% more calls (subharness trial-02, 2026-10-13).', fix: 'doneRule returns the short rule when doublePass is false, and build passes cfg.verify.doublePass.' });
    check('doneRule is the old rule with no flag, loses the gate sentence when lean, and names a check it is given', brief.doneRule() === brief.RULES[2] && !/The gate holds/.test(brief.doneRule({ lean: true })) && /atlias runs `sh run_tests.sh` when you finish/.test(brief.doneRule({ check: 'sh run_tests.sh' })) && /The gate holds/.test(brief.doneRule({ check: 'sh run_tests.sh' })), { happened: [brief.doneRule({ lean: true }), brief.doneRule({ check: 'sh run_tests.sh' })].join(' | '), why: 'Each flag changes only its own part of the rule, so either can be measured alone.', fix: 'doneRule in lib/brief.mjs.' });
    const he = project({ 'main.py': 'x = 1\n', 'tests.py': 'assert x == 1\n', 'check.py': 'print(1)\n' });
    const py = process.platform === 'win32' ? 'python' : 'python3';
    const on = build(he, 'claude', { [GATE]: '1' });
    check('with a check the gate can name, the brief names it and drops the edit-and-check pairing', on.includes(`atlias runs \`${py} check.py\` when you finish and holds the reply only if it fails`) && !/same message/.test(on) && /Pass 2: <what the re-read found>/.test(on), { happened: (on.match(/- Done means[^\n]*/) || [''])[0] + ' | ' + (on.match(/- Every tool round[^\n]*/) || [''])[0], why: 'The saved round is the check the model would run itself; it skips it only if told the gate runs it, and pairing an edit with a check it no longer runs is text paid for nothing.', fix: 'doneRule and roundsRule take the check visibleCheck names.' });
    const bare = project({ 'main.py': 'x = 1\n' });
    const none = build(bare, 'claude', { [GATE]: '1' });
    const offBare = build(bare, 'claude', {});
    check('with no check to name, the flag leaves the brief as it was', none === offBare, { happened: none.slice(-600), why: 'Promising a check the gate cannot run would let a reply through unchecked.', fix: 'Only a check visibleCheck names changes the rules.' });
    const offHe = build(he, 'claude', {});
    check('off, a project with a check gets today\'s brief', offHe === offBare.split(bare).join(he), { happened: offHe.slice(-400), why: 'The control arm must not see the gate\'s promise.', fix: 'Nothing under gateRunsCheck runs when the flag is off.' });
    const both = build(he, 'claude', { [LEAN]: '1', [GATE]: '1' });
    check('both flags: the gate\'s sentence costs less than the pairing and the lean cuts give back', both.length <= offHe.length - 350 && both.length < 1000, { happened: `${offHe.length} characters off, ${both.length} with both flags`, why: 'The CC arm of row 4 runs with both on; this is the brief it pays for on every request.', fix: 'Check doneRule with lean and a check.' });
  });

  suite('lean brief expert', 'the skills the plugin ships describe themselves briefly', () => {
    // Claude Code lists every skill's description on every request. The plugin's
    // SKILL.md files are static, so no flag can switch them per arm: this cut
    // lands for every arm, and is kept to wording, with each trigger kept.
    const desc = (name) => (/^description: "(.*)"$/m.exec(fs.readFileSync(path.join(ROOT, 'skills', name, 'SKILL.md'), 'utf8')) || [])[1] || '';
    const dc = desc('double-check');
    const at = desc('harness');
    const triggers = /done/.test(dc) && /second pass/.test(dc) && /bug-check/.test(dc) && /memory/.test(at) && /recall/.test(at) && /knowledge graph/.test(at) && /handoff/.test(at);
    check('each shipped skill description is 200 characters or fewer and still names what it is for', dc.length <= 200 && at.length <= 200 && triggers, { happened: `double-check ${dc.length}, atlias ${at.length}; triggers ${triggers ? 'kept' : 'lost'}: ${dc} | ${at}`, why: 'They were 307 and 354 characters, listed on every request of every session; and a description is how the model decides to load a skill, so a shorter one that loses its trigger is a skill that never loads.', fix: 'Shorten the description line of each skills/*/SKILL.md, keeping its triggers.' });
  });
}

// agent.skillIndex (2026-10-12). Every run's system message used to carry an
// index of the skills installed on the PC: about 1,440 characters on every call
// of the benchmark, an estimated 16 to 18 percent of all prompt tokens, and no
// run was seen using a skill. Gev's decision: the index is off by default. 'all'
// is the index exactly as it was; 'relevant' is a lean one for when someone does
// want skills (at most five that share words with the request, one short line
// each, capped at about 600 characters, plus how to list the rest; chosen with
// no model); any other value reads as 'off'. Every case builds
// the system message the way the loop does, from a temporary project and the
// temporary Claude and Codex folders test/run.mjs points at. Loaded by
// test/run.mjs, after test/skills-suites.mjs.
import * as skills from '../lib/skills.mjs';
import * as loop from '../lib/loop.mjs';
import * as settings from '../lib/settings.mjs';

export default async function skillIndexSuites({ suite, asyncSuite, check, core, agentMod, TMP, ROOT, fs, path }) {
  const NL = String.fromCharCode(10);
  const write = (dir, name, text) => { fs.mkdirSync(path.join(dir, name), { recursive: true }); fs.writeFileSync(path.join(dir, name, 'SKILL.md'), text); return path.join(dir, name); };
  const front = (name, description) => `---${NL}name: ${name}${NL}description: "${description}"${NL}---${NL}${NL}# ${name}${NL}`;

  // Skills of this suite's own, removed again at the end, so no other suite sees them.
  const CLAUDE_SKILLS = path.join(core.CLAUDE_DIR, 'skills');
  const CODEX_SKILLS = path.join(core.CODEX_DIR, 'skills');
  const HOME_A = 'si-home-claude-marker';
  const HOME_B = 'si-home-codex-marker';
  const PROJ = path.join(TMP, 'skillindex', 'project');
  const BARE = path.join(TMP, 'skillindex', 'bare');
  const MANY = path.join(TMP, 'skillindex', 'many');
  const LONG = 'Use when the work is about a very long description that goes on well past the eighty characters a lean index line may carry for it.';
  const mine = [];
  const made = (dir, name, text) => { mine.push(path.join(dir, name)); return write(dir, name, text); };
  fs.mkdirSync(BARE, { recursive: true });
  fs.mkdirSync(path.join(PROJ, '.claude'), { recursive: true });
  made(CLAUDE_SKILLS, HOME_A, front(HOME_A, 'A skill in the Claude folder of this PC.'));
  made(CODEX_SKILLS, HOME_B, front(HOME_B, 'A skill in the Codex folder of this PC.'));
  made(path.join(PROJ, '.claude', 'skills'), 'si-alpha-check', front('si-alpha-check', 'Short one.'));
  made(path.join(PROJ, '.claude', 'skills'), 'si-zeta-notes', front('si-zeta-notes', LONG));
  made(path.join(PROJ, '.codex', 'skills'), 'si-bare-codex', `# bare${NL}${NL}No frontmatter here.${NL}`);
  const manyDesc = (i) => `Skill number ${i}: ${LONG}`;
  for (let i = 0; i < 30; i++) made(path.join(MANY, '.claude', 'skills'), `si-many-${String(i).padStart(2, '0')}`, front(`si-many-${String(i).padStart(2, '0')}`, manyDesc(i)));

  const off = (cwd, extra = {}) => loop.systemPrompt(cwd, { hasGraph: false, instructions: '', skillIndex: 'off', ...extra });
  const prompt = (cwd, value, extra = {}) => loop.systemPrompt(cwd, { hasGraph: false, instructions: '', skillIndex: value, ...extra });
  // What the system message is for a value of the setting as the loop sees it:
  // written to config.json through settings.set (or by hand), read by runLoop.
  const scripted = () => async () => ({ content: 'Nothing to do.', calls: [] });
  const messageFor = async (cwd, setIt) => {
    const st = agentMod.newState(cwd, 'ollama');
    try { setIt(); await loop.runLoop(st, 'hello', { chat: scripted(), say: () => {}, ask: async () => true, limits: { maxToolRounds: 2, maxBadReplies: 3 } }); } finally { settings.reset('agent.skillIndex'); }
    return st.messages[0].content;
  };
  const lines = (s) => s.split(NL);
  const skillLines = (s) => lines(s).filter((l) => l.startsWith('- '));
  const sandbox = (fn) => {
    // Counts what is read from the home folders, the proof that 'off' never looks there.
    const real = fs.readdirSync;
    const reads = [];
    fs.readdirSync = (p, ...rest) => { reads.push(String(p)); return real(p, ...rest); };
    try { fn(); } finally { fs.readdirSync = real; }
    return reads;
  };
  const homeReads = (reads) => reads.filter((p) => p.startsWith(CLAUDE_SKILLS) || p.startsWith(CODEX_SKILLS)).length;

  suite('skill index expert', 'skill index: the setting is registered with its three choices and defaults to off', () => {
    const row = settings.rows().find((r) => r.id === 'agent.skillIndex');
    check('agent.skillIndex defaults to off and offers off, relevant and all', core.DEFAULTS.agent.skillIndex === 'off' && JSON.stringify(core.CHOICES.agent.skillIndex) === JSON.stringify(['off', 'relevant', 'all']) && row && row.value === 'off' && JSON.stringify(row.choices) === JSON.stringify(['off', 'relevant', 'all']) && !row.changed,
      { happened: JSON.stringify(row || null), why: 'Gev\'s decision of 2026-10-12: the skills index is off unless someone asks for it.', fix: 'DEFAULTS.agent and CHOICES.agent in lib/core.mjs.' });
    check('it is described, with the date, the reason and what every earlier run used', row && /2026-10-12/.test(row.about) && /Gev/.test(row.about) && /1,440 characters/.test(row.about) && /no run was seen using a skill/.test(row.about) && /every earlier run|every run before/.test(row.about) && /off/.test(row.about) && /relevant/.test(row.about) && /all/.test(row.about),
      { happened: row ? row.about : 'no row', why: 'A setting nobody can read about is one nobody can reason about when two runs differ.', fix: 'DESCRIPTIONS in lib/settings.mjs.' });
    const set = core.parseSetting('agent', 'skillIndex', 'Relevant');
    const bad = core.parseSetting('agent', 'skillIndex', 'maybe');
    check('atlias config set takes the three words (any case) and refuses the rest with the list', set.value === 'relevant' && core.parseSetting('agent', 'skillIndex', 'all').value === 'all' && core.parseSetting('agent', 'skillIndex', 'off').value === 'off' && /is one of off, relevant, all/.test(bad.error || ''),
      { happened: JSON.stringify([set, bad]), why: 'A typo here would otherwise quietly mean the default.', fix: 'CHOICES in lib/core.mjs.' });
    check('indexMode reads anything but relevant and all as off', ['off', 'relevant', 'all'].every((v) => skills.indexMode(v) === v) && ['maybe', '', 'ALL', 'Relevant', ' all', true, false, 1, null, undefined, {}].every((v) => skills.indexMode(v) === 'off'),
      { happened: JSON.stringify(['maybe', '', 'ALL', true, null].map((v) => skills.indexMode(v))), why: 'Any other value is read as off.', fix: 'indexMode in lib/skills.mjs.' });
  });

  suite('skill index expert', 'skill index: off, the default, puts nothing in the system message', () => {
    const none = off(PROJ);
    const dflt = loop.systemPrompt(PROJ, { hasGraph: false, instructions: '' });
    check('with the setting at its default there is no index, no heading, no doubled blank line and no skill name', dflt === none && !/Skills/.test(dflt) && !/SKILL\.md/.test(dflt) && !dflt.includes(NL + NL + NL) && !/\s$/.test(dflt) && ![HOME_A, HOME_B, 'si-alpha-check', 'double-check'].some((n) => dflt.includes(n)) && !/^\s*- harness(?:\s|:|\()/m.test(dflt),
      { happened: dflt.slice(-260), why: 'This is the whole saving: the index was about 1,440 characters on every call.', fix: 'skills.indexFor returns an empty string for off, and systemPrompt then adds nothing.' });
    const withRules = off(PROJ, { instructions: 'RULE ONE' });
    check('with project instructions the message ends in exactly one blank line and then the instructions', withRules === none + NL + NL + 'RULE ONE' && !withRules.includes(NL + NL + NL),
      { happened: withRules.slice(-120), why: 'Where the index was there must be no gap and no dangling heading.', fix: 'systemPrompt pushes the index and its blank line only when there is an index.' });
    const reads = sandbox(() => off(PROJ));
    check('off does not read a skills folder at all', reads.length === 0,
      { happened: reads.join(' | '), why: 'The index is not built and thrown away; nothing is read for it.', fix: 'indexFor does not call discover for off.' });
  });

  suite('skill index expert', 'skill index: all is the index exactly as every earlier run built it', () => {
    const base = off(PROJ);
    const index = skills.promptSection(PROJ);
    const all = prompt(PROJ, 'all');
    check('all is the message without an index, a blank line, and what promptSection builds', all === base + NL + NL + index && index.startsWith('Skills installed here (') && index.includes(HOME_A) && index.includes(HOME_B) && index.includes('si-alpha-check'),
      { happened: all.slice(-300), why: 'The code that built the index before was `lines.push(\'\', skills.promptSection(cwd))` between the tool block and the instructions; all must give those bytes.', fix: 'indexFor returns promptSection(cwd) for all.' });
    const withRules = prompt(PROJ, 'all', { instructions: 'RULE ONE' });
    check('with project instructions the index still comes before them, as it did', withRules === base + NL + NL + index + NL + NL + 'RULE ONE',
      { happened: withRules.slice(-200), why: 'The order of the sections is part of the bytes.', fix: 'systemPrompt pushes the index before the instructions.' });
    const native = prompt(PROJ, 'all', { native: true });
    check('in native mode too, and removing the index text from the all message gives exactly the off message', native === off(PROJ, { native: true }) + NL + NL + index && all.replace(NL + NL + index, '') === base && withRules.replace(NL + NL + index, '') === off(PROJ, { instructions: 'RULE ONE' }),
      { happened: native.slice(-160), why: 'Everything but the index is the same message.', fix: 'Only the index section may differ between off and all.' });
    const reads = sandbox(() => prompt(PROJ, 'all'));
    check('all reads the home folders, which is what it always did', homeReads(reads) >= 2,
      { happened: reads.join(' | '), why: 'The control for the old behaviour has to include the old reads.', fix: 'indexFor calls promptSection for all.' });
  });

  suite('skill index expert', 'skill index: relevant names only the skills that share words with the request', () => {
    const list = skills.discover(PROJ);
    const ask = 'alpha zeta';
    const section = skills.relevantSection(list, ask, PROJ);
    const got = skillLines(section);
    const pointer = (n) => `${n} ${n === 1 ? 'skill is' : 'skills are'} installed here; \`atlias skills\` lists them with what each is for.`;
    check('it lists the two skills whose names share a word with the request, by their path from the project, and no other', prompt(PROJ, 'relevant', { request: ask }) === off(PROJ) + NL + NL + section && got.length === 2 && got[0] === `- ${path.join('.claude', 'skills', 'si-alpha-check', 'SKILL.md')}: Short one.` && got[1].startsWith(`- ${path.join('.claude', 'skills', 'si-zeta-notes', 'SKILL.md')}: `) && !section.includes(HOME_A) && !section.includes(HOME_B) && !/Skills installed here/.test(section),
      { happened: section, why: 'Choosing a skill should cost a few lines, not a line for every skill on the PC.', fix: 'relevantSection keeps the skills whose relevance reaches RELEVANT_MIN.' });
    check('the first line says how many are installed and how to list them all', lines(section)[0] === `Skills that may fit this request, of ${list.length} installed (\`atlias skills\` lists them all). Read a skill's SKILL.md before work it covers, and follow it over your own defaults.` && list.length >= 5,
      { happened: lines(section)[0], why: 'A reader shown two skills must know there are more and how to see them.', fix: 'The header of relevantSection.' });
    const desc = got[1] ? got[1].slice(got[1].indexOf(': ') + 2) : '';
    const bare = skillLines(skills.relevantSection(list, 'the bare one', PROJ));
    check('a long description is cut to 80 characters, a short one is kept, and a skill with none is just its path', desc.length <= 80 && desc.endsWith('...') && LONG.startsWith(desc.slice(0, -3)) && bare.includes(`- ${path.join('.codex', 'skills', 'si-bare-codex', 'SKILL.md')}`),
      { happened: [got[1], bare.join(' | ')].join(' || '), why: 'One short line per skill. The description is cut; the skill itself never is.', fix: 'relevantSection cuts the description at RELEVANT_DESC.' });
    const named = skillLines(skills.relevantSection(list, `use ${HOME_B} for the alpha zeta thing`, PROJ, 100000));
    const commit = { name: 'commit', folder: 'commit', description: '' };
    check('a skill the request names outright comes first, by its full path when it is outside the project', named.length <= skills.RELEVANT_MAX && named[0] === `- ${path.join(CODEX_SKILLS, HOME_B, 'SKILL.md')}: A skill in the Codex folder of this PC.` && skills.relevance(commit, 'please commit this') >= 100 && skills.relevance(commit, 'recommitted everything') === 0,
      { happened: named.join(' | '), why: 'A person who names a skill wants that one, whatever else shares a word.', fix: 'relevance adds 100 when mentions() finds the name with nothing word-like on either side.' });
    check('with nothing in common, or no request at all, it is one line saying how to list them, and with no skills nothing', skills.relevantSection(list, 'qqqq wwww', PROJ) === pointer(list.length) && skills.relevantSection(list, '', PROJ) === pointer(list.length) && skills.relevantSection(list, undefined, PROJ) === pointer(list.length) && prompt(PROJ, 'relevant') === off(PROJ) + NL + NL + pointer(list.length) && skills.relevantSection([], ask, PROJ) === '',
      { happened: skills.relevantSection(list, 'qqqq wwww', PROJ), why: 'Skills that are not shown must still be findable, and an empty list is no section.', fix: 'relevantSection returns the one line when nothing reaches RELEVANT_MIN.' });
    const one = { name: 'xx-tool', folder: 'xx-tool', description: 'Formats python sources', path: path.join(PROJ, 'x', 'SKILL.md') };
    check('one shared word of a description is not enough, two are, and a word of the name is', skills.relevance(one, 'a python script') === 1 && skills.relevance(one, 'python sources') === 2 && skills.relevance(one, 'the tool') === 3 && skills.relevantSection([one], 'a python script', PROJ) === pointer(1) && skillLines(skills.relevantSection([one], 'python sources', PROJ)).length === 1,
      { happened: JSON.stringify([skills.relevance(one, 'a python script'), skills.relevance(one, 'python sources'), skills.relevance(one, 'the tool')]), why: 'One word of a description matches by chance; a list of chance matches is noise paid for on every call.', fix: 'RELEVANT_MIN and the weights in relevance.' });
    const RU = String.fromCodePoint(0x43c, 0x438, 0x440);
    check('words are told apart in any script that writes them apart, and common or short ones do not count', JSON.stringify(skills.words(`${RU}, Use the Alpha_2 file`)) === JSON.stringify([RU, 'alpha']),
      { happened: JSON.stringify(skills.words(`${RU}, Use the Alpha_2 file`)), why: 'People ask in their own language; a splitter that knows only a to z finds nothing for them.', fix: 'words() splits on anything that is not a letter or a digit.' });
    const reads = sandbox(() => prompt(PROJ, 'relevant', { request: ask }));
    check('it looks in every folder the full index reads, the home ones too, and nowhere else', homeReads(reads) >= 2 && reads.every((p) => skills.roots(PROJ).some((r) => r.dir === p)),
      { happened: reads.join(' | '), why: 'A person\'s own skills live in the home folders, so a relevant index that skipped them would never name those.', fix: 'indexFor passes discover(cwd) to relevantSection.' });
  });

  suite('skill index expert', 'skill index: relevant is capped, in lines and in characters', () => {
    const list = skills.discover(MANY);
    const section = skills.relevantSection(list, 'many', MANY);
    const kept = skillLines(section);
    const lineFor = (i) => `- ${path.join('.claude', 'skills', `si-many-0${i}`, 'SKILL.md')}: `;
    check('thirty matching skills give a few whole lines under the cap, in name order when they tie', kept.length >= 1 && kept.length <= skills.RELEVANT_MAX && section.length <= skills.RELEVANT_CAP && kept.every((l, i) => l.startsWith(lineFor(i)) && /SKILL\.md: .{1,80}$/.test(l)),
      { happened: `${section.length} characters, ${kept.length} lines`, why: 'The index is paid for on every call of the session.', fix: 'relevantSection stops at RELEVANT_MAX lines and at the cap, between lines.' });
    const roomy = skillLines(skills.relevantSection(list, 'many', MANY, 100000));
    const tight = skills.relevantSection(list, 'many', MANY, 320);
    check('the cap is a parameter: with room there are five lines, with little room one, and with none the one line that says how to list them', roomy.length === skills.RELEVANT_MAX && roomy.every((l, i) => l.startsWith(lineFor(i))) && tight.length <= 320 && skillLines(tight).length === 1 && /^\d+ skills are installed here; /.test(skills.relevantSection(list, 'many', MANY, 50)) && skillLines(skills.relevantSection(list, 'many', MANY, 50)).length === 0,
      { happened: `${roomy.length} lines with room; ${tight.length} characters at cap 320`, why: 'The cap decides how much is said, never whether the rest can be found.', fix: 'relevantSection returns the one line when not even one skill fits.' });
    check('the same request gives the same text every time', skills.relevantSection(list, 'many', MANY) === section && skills.indexFor(MANY, 'relevant', 'many') === section,
      { happened: `${section.length} characters`, why: 'A system message that changes between calls cannot be cached by the model server.', fix: 'relevance and the sort are pure functions of the list and the request.' });
  });


  await asyncSuite('skill index expert', 'skill index: the loop reads the setting and an unknown value is off', async () => {
    const msg = async (value) => messageFor(BARE, () => { if (value !== undefined) settings.set('agent.skillIndex', value); });
    const baseline = off(BARE);
    check('through runLoop: unset and off give the message without an index; all and relevant give theirs', await msg(undefined) === baseline && await msg('off') === baseline && await msg('all') === prompt(BARE, 'all') && await msg('relevant') === prompt(BARE, 'relevant') && prompt(BARE, 'all') !== baseline && prompt(BARE, 'relevant') !== baseline,
      { happened: `${(await msg(undefined)).length} / ${(await msg('all')).length} / ${(await msg('relevant')).length} characters`, why: 'The setting has to reach the system message of a real run, as the config.json a study writes.', fix: 'runLoop passes cfg.skillIndex to systemPrompt.' });
    // A hand-edited config.json can hold anything.
    const byHand = async (value) => {
      const file = path.join(core.STATE_DIR, 'config.json');
      const before = core.readJson(file, {}) || {};
      core.writeJson(file, { ...before, agent: { ...(before.agent || {}), skillIndex: value } });
      try { return await messageFor(BARE, () => {}); } finally { core.writeJson(file, before); }
    };
    const odd = [];
    for (const v of ['maybe', '', 'ALL', true, 7, null]) odd.push(await byHand(v) === baseline);
    check('a value that is none of the three, written by hand into config.json, reads as off', odd.every(Boolean),
      { happened: JSON.stringify(odd), why: 'Any other value is read as off, so a typo never turns the index on by accident.', fix: 'indexMode in lib/skills.mjs.' });
    check('the same for the function systemPrompt calls', ['maybe', '', 'ALL', true, 7, null, {}].every((v) => prompt(BARE, v) === baseline),
      { happened: prompt(BARE, 'maybe').slice(-120), why: 'An unknown value must not behave as all.', fix: 'indexFor goes through indexMode.' });
    // The built-in default, with config.json holding nothing about it.
    const cfg = core.config().agent.skillIndex;
    check('with config.json silent the setting is off', cfg === 'off' && loop.systemPrompt(BARE, { hasGraph: false, instructions: '' }) === baseline,
      { happened: String(cfg), why: 'The default.', fix: 'DEFAULTS.agent.skillIndex.' });
  });

  // Take this suite's skills out again.
  for (const d of mine) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } }
}

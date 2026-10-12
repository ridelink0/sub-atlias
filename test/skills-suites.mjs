// Skills: the format the hosts already read, discovered and listed rather than
// reinvented. Nine of the eleven agents in the field have a skill system and
// atlias had none it could see; these checks are the difference between reading
// the format correctly and reading most of it. Loaded by test/run.mjs, which
// owns suite() and check(), after it has pointed CLAUDE_CONFIG_DIR and
// CODEX_HOME at a temp directory, so nothing here reads a real home.
import * as skills from '../lib/skills.mjs';
import * as loop from '../lib/loop.mjs';

export default async function skillsSuites({ suite, check, core, TMP, ROOT, fs, path }) {
  const NL = String.fromCharCode(10);
  const write = (dir, name, text) => { fs.mkdirSync(path.join(dir, name), { recursive: true }); fs.writeFileSync(path.join(dir, name, 'SKILL.md'), text); return path.join(dir, name); };
  const front = (name, description, extra = '') => `---${NL}name: ${name}${NL}description: "${description}"${NL}${extra}---${NL}${NL}# ${name}${NL}${NL}The body of ${name}.${NL}`;

  const CLAUDE_SKILLS = path.join(core.CLAUDE_DIR, 'skills');
  const CODEX_SKILLS = path.join(core.CODEX_DIR, 'skills');
  const SPROJ = path.join(TMP, 'skills-project');
  const PROJ_SKILLS = path.join(SPROJ, '.claude', 'skills');
  fs.mkdirSync(CLAUDE_SKILLS, { recursive: true });
  fs.mkdirSync(CODEX_SKILLS, { recursive: true });
  fs.mkdirSync(PROJ_SKILLS, { recursive: true });

  write(CLAUDE_SKILLS, 'tidy-imports', front('tidy-imports', 'Sort and dedupe imports. Use when the imports of a file are a mess.', `license: MIT${NL}metadata:${NL}  author: someone${NL}  version: "1.0"${NL}`));
  write(CLAUDE_SKILLS, 'shared-name', front('shared-name', 'The machine-wide copy, which the project is allowed to beat.'));
  write(CODEX_SKILLS, 'ship-notes', front('ship-notes', 'Write the release notes. Use when cutting a version.'));
  write(PROJ_SKILLS, 'shared-name', front('shared-name', 'The project copy, which wins.'));
  // A folder with no SKILL.md is not a skill: ~/.claude/skills holds learned/
  // and synced/ beside the real ones and neither is one.
  fs.mkdirSync(path.join(CLAUDE_SKILLS, 'not-a-skill'), { recursive: true });
  // No frontmatter at all is still a skill; the folder name is its name.
  fs.mkdirSync(path.join(CLAUDE_SKILLS, 'bare-skill'), { recursive: true });
  fs.writeFileSync(path.join(CLAUDE_SKILLS, 'bare-skill', 'SKILL.md'), `# bare${NL}${NL}No frontmatter here.${NL}`);
  // Claude Code installs most skills as directory junctions into the plugin
  // cache. A junction reports itself as a symbolic link, not a directory.
  const linkTarget = write(path.join(TMP, 'skills-elsewhere'), 'linked-skill', front('linked-skill', 'Installed by a link, the way the hosts install most of them.'));
  let linked = false;
  try { fs.symlinkSync(linkTarget, path.join(CLAUDE_SKILLS, 'linked-skill'), 'junction'); linked = true; } catch { /* the OS refused a link; the check below says so */ }

  suite('skills expert', 'the skills the hosts already read', () => {
    const dirs = skills.roots(SPROJ).map((r) => r.dir);
    check('every folder a host reads is searched', dirs.includes(CLAUDE_SKILLS) && dirs.includes(CODEX_SKILLS) && dirs.includes(PROJ_SKILLS) && dirs.includes(path.join(ROOT, 'skills')), { happened: dirs.join(' | '), why: 'A skill atlias cannot see is a skill the terminal agent does not have, which is the whole gap this closes.', fix: 'Check skills.roots.' });

    const f = skills.parseFrontmatter(front('tidy-imports', 'Sort the imports.', `license: MIT${NL}metadata:${NL}  author: someone${NL}`));
    check('the frontmatter is read, quotes stripped, nested keys skipped', f.name === 'tidy-imports' && f.description === 'Sort the imports.' && f.license === 'MIT' && f.author === undefined, { happened: JSON.stringify(f), why: 'Several installed skills carry a metadata: block; reading its indented lines as top-level keys would overwrite name or description with whatever came last.', fix: 'Skip indented lines in parseFrontmatter.' });
    check('a file with no frontmatter reads as none, not as a failure', JSON.stringify(skills.parseFrontmatter(`# just a heading${NL}text`)) === '{}' && JSON.stringify(skills.parseFrontmatter('')) === '{}', { happened: JSON.stringify(skills.parseFrontmatter(`# just a heading${NL}text`)), why: 'A skill with a bare SKILL.md is still a skill, and throwing there would take the whole index down with it.', fix: 'Return an empty object when the block is absent.' });

    const bare = skills.readSkill(path.join(CLAUDE_SKILLS, 'bare-skill'), 'claude');
    check('a skill with no name falls back to its folder', bare && bare.name === 'bare-skill' && bare.source === 'claude' && bare.bytes > 0, { happened: JSON.stringify(bare), why: 'That is the fallback the hosts use, and a nameless entry in the index is one the model cannot ask for.', fix: 'Check readSkill.' });
    check('a folder with no SKILL.md is not a skill', skills.readSkill(path.join(CLAUDE_SKILLS, 'not-a-skill'), 'claude') === null && skills.readSkill(path.join(TMP, 'nowhere-at-all'), '') === null, { happened: JSON.stringify(skills.readSkill(path.join(CLAUDE_SKILLS, 'not-a-skill'), 'claude')), why: 'The skills folder holds working directories beside the skills; listing them as skills makes the index lie.', fix: 'Require a readable SKILL.md.' });

    const found = skills.discover(SPROJ);
    const names = found.map((s) => s.name);
    check('skills are found in every root', ['tidy-imports', 'ship-notes', 'bare-skill'].every((n) => names.includes(n)) && names.includes('atlias'), { happened: names.join(', '), why: 'The machine\'s skills, the project\'s and the ones atlias ships are all skills; missing a root means missing that whole class of them.', fix: 'Check skills.discover.' });
    check('a skill installed as a directory junction is found', !linked || names.includes('linked-skill'), { happened: linked ? names.join(', ') : 'the OS refused to create a junction, so this machine could not exercise it', why: 'Forty-eight of the fifty-three folders in ~/.claude/skills on this machine are junctions. Filtering on isDirectory() found five of them, and the first version of this module did exactly that.', fix: 'Do not filter on the entry type; let readSkill stat the SKILL.md, which follows the link.' });
    check('the list is sorted, so an index built from it is cacheable', JSON.stringify(names) === JSON.stringify([...names].sort((a, b) => a.localeCompare(b))), { happened: names.join(', '), why: 'The index rides in the agent\'s system prompt; an order that changes between sessions rewrites the prefix and throws away the provider cache.', fix: 'Sort in discover.' });
    const shared = found.filter((s) => s.name === 'shared-name');
    check('the project\'s copy of a name beats the machine\'s', shared.length === 1 && /project copy/.test(shared[0].description), { happened: shared.map((s) => s.source + ': ' + s.description).join(' | '), why: 'A project that ships its own version of a skill means it, and two entries with one name is an index that cannot be indexed by name.', fix: 'Search the nearer roots last and key the map on the name.' });

    check('a skill is found by name, by folder and by part of a name', skills.find(SPROJ, 'tidy-imports').name === 'tidy-imports' && skills.find(SPROJ, 'harness').name === 'atlias' && skills.find(SPROJ, 'ship').name === 'ship-notes' && skills.find(SPROJ, 'no-such-skill') === null && skills.find(SPROJ, '') === null, { happened: JSON.stringify([skills.find(SPROJ, 'harness') && skills.find(SPROJ, 'harness').name, skills.find(SPROJ, 'ship') && skills.find(SPROJ, 'ship').name, skills.find(SPROJ, 'no-such-skill')]), why: 'People and models name a skill by its folder as often as by its frontmatter name; refusing one of the two spellings makes the feature feel broken.', fix: 'Check skills.find.' });

    const one = skills.body(SPROJ, 'tidy-imports');
    check('the body is the skill without its frontmatter', one && !/^---/.test(one.text) && !one.text.includes('license: MIT') && one.text.includes('The body of tidy-imports.'), { happened: one ? one.text.slice(0, 120) : 'null', why: 'The frontmatter is the index; paying for it again when the skill itself is read is paying twice for the same words.', fix: 'Strip the block in skills.body.' });
    check('and it is clipped to what was asked for', skills.body(SPROJ, 'tidy-imports', 20).text.length <= 20 && skills.body(SPROJ, 'no-such-skill') === null, { happened: JSON.stringify(skills.body(SPROJ, 'tidy-imports', 20).text), why: 'A skill can run to forty kilobytes; handing one back whole with no cap is how a cheap feature becomes the most expensive call in the session.', fix: 'Check the clip in skills.body.' });

    const listed = skills.format(found);
    check('the listing names each skill, where it came from and what it is for', /tidy-imports\s+claude\s+Sort and dedupe imports/.test(listed) && /ship-notes\s+codex/.test(listed), { happened: listed.split(NL).slice(0, 3).join(' | '), why: 'Without the source, two skills of the same name are indistinguishable; without the description, nobody can tell which to use.', fix: 'Check skills.format.' });
    check('an empty list says what a skill is and where to put one', /no skills found/.test(skills.format([])) && /SKILL\.md/.test(skills.format([])), { happened: skills.format([]), why: 'An empty listing that says only "none" leaves the user with nothing to do about it.', fix: 'Keep the explanation in skills.format.' });

    const section = skills.promptSection(SPROJ);
    const missing = found.filter((s) => !section.includes(s.folder)).map((s) => s.folder);
    check('the prompt index names every skill once, grouped by its folder', missing.length === 0 && section.includes(path.join(CLAUDE_SKILLS, '<name>', 'SKILL.md')) && section.length < skills.LIST_BUDGET + 400, { happened: `${missing.length} missing (${missing.join(', ')}), ${section.length} chars`, why: 'One path per folder and a list of names is what makes fifty skills cost a few hundred characters instead of a few thousand; the model opens the one it recognises with the read_file it already has.', fix: 'Check skills.promptSection.' });
    const tight = skills.promptSection(SPROJ, 30);
    check('and says how many it left out when the budget is short', /and \d+ more/.test(tight) && tight.length < section.length, { happened: tight, why: 'Cutting a list silently tells the reader there are no more; a prompt is not a directory listing and the tail has to be counted.', fix: 'Count the omitted names in promptSection.' });

    const prompt = loop.systemPrompt(SPROJ, { hasGraph: false, instructions: '', skillIndex: 'all' });
    check('the agent\'s own system prompt carries the index when agent.skillIndex is all', prompt.includes('Skills installed here') && prompt.includes('tidy-imports'), { happened: prompt.slice(-300), why: 'This is the point of the whole feature: the sub-harness hosts show their model the skills they have, and until now the terminal agent was the one harness that could not.', fix: 'Push skills.promptSection into systemPrompt.' });
  });
}

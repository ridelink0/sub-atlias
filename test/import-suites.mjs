// `atlias import`: moving from Claude Code, Codex, Gemini CLI and Antigravity (lib/import.mjs).
// Gev 2026-10-17: a first-run offer that copies nothing without a yes, never a credential, nothing that
// looks like a secret, nothing over what Atlas already has, and a manifest so --undo removes exactly what
// the import made. Every home here is a fake folder with fake files; the real ones are never read.
// Loaded by test/run.mjs, which owns suite(), asyncSuite() and check().
import { spawnSync } from 'node:child_process';
import * as importer from '../lib/import.mjs';
import * as commands from '../lib/commands.mjs';
import * as skills from '../lib/skills.mjs';
import crypto from 'node:crypto';

export default async function importSuites({ suite, asyncSuite, check, skip, core, agentMod, TMP, ROOT, fs, path }) {
  const NL = String.fromCharCode(10);
  let n = 0;
  // Fake secrets are built from pieces so no scanner mistakes this file for a leak.
  const KEY = 'sk-' + 'abcdefghijklmnopqrstuvwx1234';
  const GHP = 'ghp_' + 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5';
  const put = (root, rel, text) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
  const walk = (dir, out = []) => { try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else out.push(p); } } catch { /* absent */ } return out; };
  const allText = (dir) => walk(dir).map((f) => fs.readFileSync(f, 'latin1')).join(NL);
  const snapshot = (dir) => walk(dir).sort().map((f) => `${f}:${fs.statSync(f).size}`).join('|');

  // A whole fake machine: a user home with the four tools in it, and an empty Atlias home.
  function machine(tag = '') {
    const root = path.join(TMP, 'import', `m${process.pid}-${++n}${tag}`);
    const homes = { userHome: root, atlias: path.join(root, 'atlias-home'), claude: path.join(root, '.claude'), codex: path.join(root, '.codex'), gemini: path.join(root, '.gemini') };
    const cwd = path.join(root, 'work', 'proj');
    fs.mkdirSync(cwd, { recursive: true });
    // Claude Code
    put(homes.claude, 'CLAUDE.md', `# Rules${NL}Always be brief.${NL}api_key = ${KEY}${NL}Use plain words.${NL}`);
    put(homes.claude, 'rules/style.md', `No emojis.${NL}`);
    put(homes.claude, '.credentials.json', JSON.stringify({ claudeAiOauth: { accessToken: 'CREDENTIAL-ACCESS-TOKEN-AAAA', refreshToken: 'CREDENTIAL-REFRESH-TOKEN-BBBB' } }));
    put(homes.claude, 'projects/C--proj/memory/MEMORY.md', '- index');
    put(homes.claude, 'projects/C--proj/memory/feedback_a.md', `---${NL}name: a${NL}description: a note${NL}---${NL}Keep it short.${NL}token: ${GHP}${NL}`);
    put(homes.claude, 'projects/C--proj/memory/auth.json', '{"secret":"CREDENTIAL-IN-MEMORY-CCCC"}');
    put(homes.claude, 'skills/good-skill/SKILL.md', `---${NL}name: good-skill${NL}description: does a good thing${NL}---${NL}Body.${NL}`);
    put(homes.claude, 'skills/good-skill/scripts/run.sh', 'echo hi');
    put(homes.claude, 'skills/good-skill/.env', 'SKILL_SECRET=CREDENTIAL-DOTENV-DDDD');
    put(homes.claude, 'skills/leaky-skill/SKILL.md', `---${NL}name: leaky-skill${NL}---${NL}Use ${KEY} to call it.${NL}`);
    put(homes.claude, 'commands/ship.md', `---${NL}description: ship it${NL}---${NL}Ship $ARGUMENTS now.${NL}`);
    put(homes.claude, 'commands/team/review.md', 'Review the diff.');
    put(homes.claude, 'commands/bad name.md', 'x');
    put(homes.claude, 'plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: { 'a@b': [{}], 'c@d': [{}] } }));
    put(homes.userHome, '.claude.json', JSON.stringify({ oauthAccount: { emailAddress: 'someone@example.com' }, mcpServers: { files: { command: 'npx', args: ['-y', 'server-files', '--token', KEY], env: { API_KEY: 'CREDENTIAL-ENV-EEEE' } }, remote: { type: 'http', url: 'https://example.com/mcp?api_key=CREDENTIAL-URL-FFFF&x=1', headers: { Authorization: 'Bearer CREDENTIAL-HEADER-GGGG-0123456789' } } } }));
    // Codex
    put(homes.codex, 'AGENTS.md', 'Codex rules.');
    put(homes.codex, 'auth.json', JSON.stringify({ OPENAI_API_KEY: 'CREDENTIAL-OPENAI-HHHH', tokens: { access_token: 'CREDENTIAL-CODEX-IIII' } }));
    put(homes.codex, 'memories/note.md', 'A codex memory.');
    put(homes.codex, 'skills/codex-skill/SKILL.md', `---${NL}name: codex-skill${NL}description: codex only${NL}---${NL}x${NL}`);
    put(homes.codex, 'skills/good-skill/SKILL.md', 'duplicate of the claude one');
    put(homes.codex, 'config.toml', `model = "x"${NL}[mcp_servers.docs]${NL}command = "docs-server"${NL}args = ["--stdio", "--key=${KEY}"]${NL}[mcp_servers.docs.env]${NL}DOCS_TOKEN = "CREDENTIAL-TOML-JJJJ"${NL}[features]${NL}memories = true${NL}`);
    // Gemini CLI and Antigravity
    put(homes.gemini, 'GEMINI.md', 'Gemini rules.');
    put(homes.gemini, 'oauth_creds.json', '{"refresh_token":"CREDENTIAL-GEMINI-KKKK"}');
    put(homes.gemini, 'settings.json', JSON.stringify({ mcpServers: { geminimcp: { command: 'gm', args: ['serve'] } } }));
    put(homes.gemini, 'commands/fix.toml', `description = "Fix a thing"${NL}prompt = """${NL}Fix {{args}} carefully.${NL}"""${NL}`);
    put(homes.gemini, 'commands/shelly.toml', `prompt = "Run !{git status} and tell me"${NL}`);
    put(homes.gemini, 'config/skills/agy-skill/SKILL.md', `---${NL}name: agy-skill${NL}description: agy${NL}---${NL}x${NL}`);
    put(homes.gemini, 'config/mcp_config.json', JSON.stringify({ mcpServers: { agymcp: { command: 'agy-mcp' } } }));
    put(homes.gemini, 'jetski-standalone-oauth-token', 'CREDENTIAL-JETSKI-LLLL');
    return { root, homes, cwd };
  }
  const claudeSession = (cwd, extra = []) => [
    { type: 'mode', mode: 'normal' },
    { type: 'summary', summary: 'Earlier the user set up the build.' },
    { type: 'user', isMeta: true, message: { role: 'user', content: 'caveat noise' }, cwd },
    { type: 'user', message: { role: 'user', content: `Please read the config.<system-reminder>hook noise</system-reminder>` }, cwd, timestamp: '2026-10-01T10:00:00Z', sessionId: 'x' },
    { type: 'user', message: { role: 'user', content: '<command-name>/login</command-name>' }, cwd },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret thoughts' }, { type: 'text', text: 'I will read it.' }, { type: 'tool_use', name: 'Read', input: { file_path: 'config.json' } }] }, cwd, timestamp: '2026-10-01T10:00:05Z' },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(5000) }] }, cwd },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: `curl -H "x" ${KEY}` } }] }, cwd },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'ok small' }] }] }, cwd },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Done. I saw the key ${GHP} in it.` }] }, cwd },
    { type: 'user', isSidechain: true, message: { role: 'user', content: 'subagent chatter' }, cwd },
    { type: 'user', message: { role: 'user', content: 'Now second question' }, cwd, timestamp: '2026-10-01T10:05:00Z' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Second answer.' }] }, cwd, timestamp: '2026-10-01T10:05:09Z' },
    ...extra,
  ].map((o) => JSON.stringify(o)).join(NL) + NL;
  const codexSession = (cwd) => [
    { type: 'session_meta', payload: { id: 'cx', cwd } },
    { type: 'response_item', timestamp: '2026-10-02T09:00:00Z', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'developer rules' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for x\n<INSTRUCTIONS>...' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the parser please' }] } },
    { type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'zzz' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'ls'] }) } },
    { type: 'response_item', payload: { type: 'function_call_output', output: 'file-a file-b' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `Parser fixed. Token ${KEY}.` }] } },
  ].map((o) => JSON.stringify(o)).join(NL) + NL;

  suite('import expert', 'import: finding what is there, and what is not touched', () => {
    const m = machine();
    const before = snapshot(m.root);
    const plan = importer.scan({ homes: m.homes });
    check('scan and describe write nothing at all', snapshot(m.root) === before && !fs.existsSync(m.homes.atlias), { happened: 'the fake machine changed or an Atlias home appeared', why: 'A plan is shown before anything is copied; making it must not copy.', fix: 'scan and describe only read.' });
    const kinds = (tool) => [...new Set(plan.filter((i) => i.tool === tool && i.status === 'new').map((i) => i.kind))].sort().join(',');
    check('Claude Code: instructions, memory, skills, commands and MCP are found', kinds('claude') === 'commands,instructions,mcp,memory,skills', { happened: kinds('claude'), why: 'These are what the research says Claude Code keeps and Atlias can use.', fix: 'Check scanClaude.' });
    check('Codex: instructions, memory, skills and MCP; Gemini: instructions, commands, MCP; Antigravity: skills and MCP', kinds('codex') === 'instructions,mcp,memory,skills' && kinds('gemini') === 'commands,instructions,mcp' && kinds('antigravity') === 'mcp,skills', { happened: [kinds('codex'), kinds('gemini'), kinds('antigravity')].join(' / '), why: 'Each tool keeps different things in different formats.', fix: 'Check scanCodex, scanGemini, scanAntigravity.' });
    const cred = plan.filter((i) => i.kind === 'credentials');
    check('each tool\'s credential file is listed as skipped and never read', cred.length === 4 && cred.every((i) => i.status === 'skip') && !JSON.stringify(plan).includes('CREDENTIAL-'), { happened: JSON.stringify(cred.map((i) => i.label)), why: 'The user sees that credentials were found and left alone; the plan must not even hold their contents.', fix: 'Add an info row, never a read.' });
    check('a credential-named file inside memory is not a plan item', !plan.some((i) => /auth\.json$/.test(i.src || '') && i.kind === 'memory'), { happened: 'auth.json planned as memory', why: 'Only .md files are memory, and credential names are refused anyway.', fix: 'scanMarkdownDir.' });
    check('the duplicate skill from Codex defers to the Claude one, and a bad command name is skipped with a reason', plan.some((i) => i.tool === 'codex' && i.label === 'good-skill' && i.status === 'present') && plan.some((i) => i.label === '/bad name' && i.status === 'skip'), { happened: JSON.stringify(plan.filter((i) => i.label === 'good-skill' || /bad/.test(i.label)).map((i) => [i.tool, i.label, i.status])), why: 'Two destinations of one name would overwrite each other.', fix: 'Dedupe in scan.' });
    check('plugins are counted and reported as not importable', plan.some((i) => i.kind === 'plugins' && /2 installed plugins/.test(i.label) && i.status === 'skip'), { happened: 'no plugin row', why: 'Plugins are not runnable by Atlias; the person should be told, not left to wonder.', fix: 'Add the info row.' });
    const text = importer.describe(plan, { detail: true });
    check('the plan text names counts per tool and kind and promises no credentials', /Claude Code:/.test(text) && /skills\s+1 to import/.test(text) && /never read or copied/.test(text), { happened: text.slice(0, 300), why: 'The first-run offer is the plan text; it has to say what and from where.', fix: 'Check describe.' });
    check('--from limits the scan to one tool and rejects an unknown one', importer.scan({ homes: m.homes, from: 'codex' }).every((i) => i.tool === 'codex') && (() => { try { importer.scan({ homes: m.homes, from: 'cursor' }); return false; } catch { return true; } })(), { happened: 'from not honoured', why: 'atlias import --from codex means only Codex.', fix: 'Check scan.' });
    check('real credential reads are refused by name and by folder', ['.credentials.json', 'auth.json', 'oauth_creds.json', 'jetski-standalone-oauth-token', '.env', '.env.local', 'id_rsa', 'server.pem', 'x/.ssh/config', 'x/.aws/credentials'].every((p) => importer.isCredentialPath(p)) && !['CLAUDE.md', 'notes.md', 'SKILL.md', 'run.sh'].some((p) => importer.isCredentialPath(p)), { happened: 'isCredentialPath wrong', why: 'It is the one gate every read in the importer goes through.', fix: 'Check CRED_BASENAME and CRED_DIR.' });
  });

  suite('import expert', 'import: the small pieces', () => {
    const h = importer.defaultHomes();
    check('defaultHomes follows the Atlias home of this process', h.atlias === core.STATE_DIR && h.claude === core.CLAUDE_DIR && h.codex === core.CODEX_DIR, { happened: JSON.stringify(h), why: 'The real command reads the real folders.', fix: 'defaultHomes.' });
    check('looksSecret sees keys, tokens, bearer headers, private keys and key=value, and passes plain prose', [KEY, GHP, 'Bearer abcdefghijklmnop1234', '-----BEGIN RSA PRIVATE KEY-----', 'password = hunter2hunter2', 'https://u:pw@host/x'].every((s) => importer.looksSecret(s)) && !['Always be brief.', 'the token is a word', 'use the key files'].some((s) => importer.looksSecret(s)), { happened: 'a shape missed or prose flagged', why: 'It is the gate for everything written.', fix: 'SECRET_RES.' });
    const red = importer.redactInline(`a ${KEY} b ${GHP} c`);
    check('redactInline replaces only the secret and counts it', red.n === 2 && red.text === 'a [redacted] b [redacted] c', { happened: JSON.stringify(red), why: 'Sessions keep their words and lose their keys.', fix: 'redactInline.' });
    const drop = importer.dropSecretLines(`keep${NL}token = ${GHP}${NL}keep too`);
    check('dropSecretLines replaces the whole line with a note', drop.n === 1 && drop.text.split(NL)[0] === 'keep' && /removed by atlias import/.test(drop.text.split(NL)[1]) && drop.text.split(NL)[2] === 'keep too', { happened: drop.text, why: 'Instruction files keep their other lines.', fix: 'dropSecretLines.' });
    const srv = importer.sanitizeServer({ command: 'x', args: ['--k', KEY], env: { A: 'v' }, headers: { H: 'v' }, url: 'https://u:p@h/p?token=zz&ok=1' }, 'claude');
    check('sanitizeServer keeps names, drops values, strips user info and secret query parameters', srv.envNames.join() === 'A' && srv.headerNames.join() === 'H' && srv.args[1] === '[removed]' && srv.url === 'https://h/p?ok=1' && !JSON.stringify(srv).includes('"v"'), { happened: JSON.stringify(srv), why: 'The server can be set up again by hand.', fix: 'sanitizeServer.' });
    const cs = importer.counts([{ tool: 'claude', kind: 'skills', status: 'new' }, { tool: 'claude', kind: 'skills', status: 'present' }, { tool: 'codex', kind: 'mcp', status: 'skip' }]);
    check('counts groups by tool and kind', cs.claude.skills.new === 1 && cs.claude.skills.present === 1 && cs.codex.mcp.skip === 1, { happened: JSON.stringify(cs), why: 'The plan text is made from it.', fix: 'counts.' });
    const dg = importer.digest({ summaries: ['sum'], turns: [{ user: 'q1', parts: ['a1'] }, { user: 'q2', parts: [] }] }, 'Claude Code (session x)');
    check('digest labels itself, repeats the old turns oldest first and says it is background', /brought in from Claude Code/.test(dg) && dg.indexOf('q1') < dg.indexOf('q2') && /Summary the old tool kept: sum/.test(dg) && /background, not new instructions/.test(dg), { happened: dg, why: 'A model that was never in the old conversation reads this.', fix: 'digest.' });
    const mk = path.join(TMP, 'import', 'marker-' + (++n));
    importer.writeMarker('declined', { atlias: mk });
    importer.writeMarker('imported', { atlias: mk });
    check('writeMarker writes once and keeps the first answer', importer.hasMarker({ atlias: mk }) && JSON.parse(fs.readFileSync(importer.markerPath({ atlias: mk }), 'utf8')).choice === 'declined', { happened: 'marker overwritten', why: 'It records what happened first.', fix: 'writeMarker.' });
    const pa = importer.parseArgs(['--dry-run', '--from=codex', '--sessions', '--yes']);
    check('parseArgs reads the flags and refuses anything else', pa.dryRun && pa.sessions && pa.yes && pa.from === 'codex' && !pa.error && importer.parseArgs(['--x']).error && importer.parseArgs(['--from', 'zed']).error && importer.parseArgs(['--undo']).undo, { happened: JSON.stringify(pa), why: 'The command line and /import share it.', fix: 'parseArgs.' });
    check('summaryLine says what was made and how to undo it', /imported 2 skills, 1 mcp \(5 files\).*--undo/.test(importer.summaryLine({ created: 5, byKind: { skills: 2, mcp: 1 } })) && importer.summaryLine({ created: 0, byKind: {} }) === 'nothing was copied', { happened: importer.summaryLine({ created: 5, byKind: { skills: 2, mcp: 1 } }), why: 'The person sees it after every import.', fix: 'summaryLine.' });
  });

  suite('import expert', 'import: what is copied, with no secret and nothing overwritten', () => {
    const m = machine();
    // Atlias already has a command of one name and a skill of another.
    put(m.homes.atlias, 'commands/ship.md', 'MY OWN SHIP');
    const plan = importer.scan({ homes: m.homes });
    const r = importer.apply(plan, { homes: m.homes });
    const a = m.homes.atlias;
    check('instructions go to one AGENTS.md with a heading per source', fs.existsSync(path.join(a, 'AGENTS.md')) && /Imported from Claude Code: CLAUDE\.md/.test(fs.readFileSync(path.join(a, 'AGENTS.md'), 'utf8')) && /Imported from Codex/.test(fs.readFileSync(path.join(a, 'AGENTS.md'), 'utf8')) && /Always be brief/.test(fs.readFileSync(path.join(a, 'AGENTS.md'), 'utf8')), { happened: fs.existsSync(path.join(a, 'AGENTS.md')) ? fs.readFileSync(path.join(a, 'AGENTS.md'), 'utf8').slice(0, 300) : 'no file', why: 'Atlias reads one AGENTS.md from its home.', fix: 'Check apply.' });
    check('a line that looked like a secret is removed from the instructions and the memory note', !allText(a).includes(KEY) && !allText(a).includes(GHP) && /line removed by atlias import/.test(fs.readFileSync(path.join(a, 'AGENTS.md'), 'utf8')), { happened: 'the fake key is present in the Atlias home', why: 'Nothing that looks like a secret may be copied.', fix: 'dropSecretLines on every text import.' });
    check('no credential value from any tool appears anywhere in the Atlias home', !/CREDENTIAL-/.test(allText(a)), { happened: (allText(a).match(/CREDENTIAL-[A-Z0-9-]+/) || [])[0], why: 'Credentials, tokens and OAuth files are never copied.', fix: 'Find the path that read it.' });
    check('the skill came over with its script, without its .env', fs.existsSync(path.join(a, 'skills/good-skill/SKILL.md')) && fs.existsSync(path.join(a, 'skills/good-skill/scripts/run.sh')) && !fs.existsSync(path.join(a, 'skills/good-skill/.env')), { happened: walk(path.join(a, 'skills')).join(','), why: 'A skill is a folder; a credential inside it is left out.', fix: 'copySkill skips credential paths.' });
    check('a skill that holds a secret is not imported at all, and the report says why', !fs.existsSync(path.join(a, 'skills/leaky-skill')) && plan.some((i) => i.label === 'leaky-skill' && i.status === 'skip' && /secret/.test(i.why)), { happened: JSON.stringify(plan.filter((i) => i.label === 'leaky-skill')), why: 'Half a skill is worse than none, and the secret must not travel.', fix: 'copySkill returns a reason.' });
    check('commands come over in the Atlias layout, a Gemini toml becomes markdown, a shell-running one is refused', fs.existsSync(path.join(a, 'commands/team/review.md')) && /Fix \$ARGUMENTS carefully/.test(fs.readFileSync(path.join(a, 'commands/fix.md'), 'utf8')) && /description: Fix a thing/.test(fs.readFileSync(path.join(a, 'commands/fix.md'), 'utf8')) && !fs.existsSync(path.join(a, 'commands/shelly.md')) && plan.some((i) => /shelly/.test(i.label) && i.status === 'skip'), { happened: walk(path.join(a, 'commands')).join(',') + ' | ' + JSON.stringify(plan.filter((i) => /shelly/.test(i.label))), why: 'The registry in lib/commands.mjs reads markdown with $ARGUMENTS.', fix: 'geminiCommandToMarkdown.' });
    check('a command Atlias already had is not overwritten', fs.readFileSync(path.join(a, 'commands/ship.md'), 'utf8') === 'MY OWN SHIP', { happened: fs.readFileSync(path.join(a, 'commands/ship.md'), 'utf8'), why: 'Skip anything Atlias already has.', fix: 'Made.file refuses an existing path.' });
    // A file that appears between the plan and the copy (another session, the person) is not overwritten either.
    const late = machine('-late');
    const latePlan = importer.scan({ homes: late.homes });
    put(late.homes.atlias, 'commands/team/review.md', 'LATE USER FILE');
    put(late.homes.atlias, 'skills/good-skill/SKILL.md', 'LATE SKILL');
    const lateRun = importer.apply(latePlan, { homes: late.homes });
    check('a file that appeared after the plan was made is left exactly as it is', fs.readFileSync(path.join(late.homes.atlias, 'commands/team/review.md'), 'utf8') === 'LATE USER FILE' && fs.readFileSync(path.join(late.homes.atlias, 'skills/good-skill/SKILL.md'), 'utf8') === 'LATE SKILL' && lateRun.created > 0, { happened: fs.readFileSync(path.join(late.homes.atlias, 'commands/team/review.md'), 'utf8'), why: 'Never overwrite what Atlas already has, even if it arrived a moment ago.', fix: 'Made.file refuses an existing path.' });
    const claudeMcp = JSON.parse(fs.readFileSync(path.join(a, 'imported/mcp-claude.json'), 'utf8')).mcpServers;
    check('MCP definitions keep names of environment variables and headers, never their values, and secret arguments are removed', claudeMcp.files.envNames.join() === 'API_KEY' && !claudeMcp.files.args.includes(KEY) && claudeMcp.files.args.includes('[removed]') && claudeMcp.remote.headerNames.join() === 'Authorization' && !/api_key/i.test(claudeMcp.remote.url) && /x=1/.test(claudeMcp.remote.url), { happened: JSON.stringify(claudeMcp), why: 'The server can be set up again; the secret must not be in the copy.', fix: 'sanitizeServer.' });
    const codexMcp = JSON.parse(fs.readFileSync(path.join(a, 'imported/mcp-codex.json'), 'utf8')).mcpServers;
    check('a Codex TOML server is read, its env table by name only', codexMcp.docs.command === 'docs-server' && codexMcp.docs.envNames.join() === 'DOCS_TOKEN' && codexMcp.docs.args[0] === '--stdio', { happened: JSON.stringify(codexMcp), why: 'Codex keeps servers as TOML tables.', fix: 'mcpFromToml.' });
    check('the .claude.json account and OAuth fields are dropped unread', !/someone@example/.test(allText(a)), { happened: 'an account address was copied', why: 'Only the mcpServers map is taken from that file.', fix: 'mcpFromJson.' });
    check('memory notes land under the project folder, MEMORY.md and credential files are left', fs.existsSync(path.join(a, 'projects/C--proj/memory/feedback_a.md')) && !fs.existsSync(path.join(a, 'projects/C--proj/memory/MEMORY.md')) && !fs.existsSync(path.join(a, 'projects/C--proj/memory/auth.json')) && fs.existsSync(path.join(a, 'memory/codex/note.md')), { happened: walk(path.join(a, 'projects')).join(','), why: 'recall reads these folders.', fix: 'scanMarkdownDir.' });
    check('the Atlias skill index finds an imported skill after the other tool is gone', skills.roots(m.cwd).some((r) => r.dir === path.join(core.STATE_DIR, 'skills')), { happened: 'no home root', why: 'Imported skills live in the Atlias home and must be discoverable.', fix: 'Add the root to skills.roots.' });
    const again = importer.apply(importer.scan({ homes: m.homes }), { homes: m.homes });
    check('running it again copies nothing, because everything is now present', again.created === 0 && importer.newItems(importer.scan({ homes: m.homes })).length === 0, { happened: JSON.stringify(again.byKind), why: 'Skip anything Atlias already has; an import is idempotent.', fix: 'status present on existing dest.' });
    check('the result is counted by kind', r.byKind.skills >= 2 && r.byKind.memory === 2 && r.byKind.mcp >= 4 && r.created > 8, { happened: JSON.stringify(r.byKind), why: 'The summary tells the person what happened.', fix: 'Check apply.' });
  });

  suite('import expert', 'import: Claude Code and Codex sessions become Atlias saved sessions', () => {
    const m = machine();
    const jsonl = path.join(m.homes.claude, 'projects/C--proj/aaaaaaaa-1111-4222-8333-444444444444.jsonl');
    put(m.homes.claude, 'projects/C--proj/aaaaaaaa-1111-4222-8333-444444444444.jsonl', claudeSession(m.cwd));
    put(m.homes.codex, 'sessions/2026/10/02/rollout-2026-10-02T09-00-00-01a14b70-cbd8-7143-a554-166fea22c83a.jsonl', codexSession(m.cwd));
    const conv = importer.convertClaude(jsonl);
    check('a Claude Code transcript becomes two turns: records for meta, sidechain, thinking and command wrappers are dropped', conv && conv.turns.length === 2 && conv.history.length === 4 && conv.history[0].text === 'Please read the config.' && conv.history[2].text === 'Now second question' && !JSON.stringify(conv).includes('secret thoughts') && !JSON.stringify(conv).includes('subagent chatter') && !JSON.stringify(conv).includes('caveat noise') && !JSON.stringify(conv).includes('/login'), { happened: JSON.stringify(conv && conv.history), why: 'The user and assistant text stay; the plumbing does not.', fix: 'Check convertClaude.' });
    check('tool calls are kept as a compact note, small results kept, results over the limit dropped with their size', conv && /\[tool Read: config\.json\]/.test(conv.history[1].text) && /result omitted: 5000 characters/.test(conv.history[1].text) && /\[result: ok small\]/.test(conv.history[1].text) && !conv.history[1].text.includes('xxxxx'), { happened: conv && conv.history[1].text, why: 'The point is a short record of what was done.', fix: 'Turns.result.' });
    check('a secret in a message or a tool command is redacted', conv && !JSON.stringify(conv).includes(KEY) && !JSON.stringify(conv).includes(GHP) && conv.redacted >= 2, { happened: JSON.stringify(conv && conv.history[1]), why: 'Never copy anything that looks like a secret.', fix: 'redactInline in Turns.clean.' });
    const cx = importer.convertCodex(path.join(m.homes.codex, 'sessions/2026/10/02/rollout-2026-10-02T09-00-00-01a14b70-cbd8-7143-a554-166fea22c83a.jsonl'));
    check('a Codex rollout keeps real user and assistant messages, drops the injected context, the developer role and reasoning', cx && cx.turns.length === 1 && cx.history[0].text === 'Fix the parser please' && /\[tool shell: bash -lc ls\]/.test(cx.history[1].text) && !JSON.stringify(cx).includes('AGENTS.md instructions') && !JSON.stringify(cx).includes('developer rules') && !JSON.stringify(cx).includes(KEY), { happened: JSON.stringify(cx && cx.history), why: 'Codex puts instructions in the first user message; they are not the person\'s words.', fix: 'CODEX_INJECTED.' });
    check('a transcript with no messages or no project folder is nothing to import', importer.convertClaude(put(m.root, 'empty.jsonl', JSON.stringify({ type: 'mode' }) + NL)) === null, { happened: 'not null', why: 'An empty chat file is clutter in /sessions.', fix: 'Return null.' });

    const atliasHomes = { ...m.homes, atlias: core.STATE_DIR };
    const plan = importer.scan({ homes: atliasHomes, sessions: true }).filter((i) => i.kind === 'sessions');
    check('sessions are in the plan only when asked for, and counted per tool', importer.scan({ homes: atliasHomes }).every((i) => i.kind !== 'sessions') && plan.filter((i) => i.tool === 'claude').length === 1 && plan.filter((i) => i.tool === 'codex').length === 1, { happened: JSON.stringify(plan.map((i) => i.tool)), why: 'Sessions are large; they are opt-in.', fix: 'opts.sessions.' });
    const r = importer.apply(plan, { homes: atliasHomes });
    const list = agentMod.listChats(m.cwd, 50);
    const mine = list.find((c) => c.sid === 'atlias-aaaaaaaa-1111-4222-8333-444444444444');
    check('the imported sessions are listed for their project folder, newest by the time of the old session', r.byKind.sessions === 2 && mine && list.some((c) => c.sid.startsWith('atlias-codex-')) && Math.abs(fs.statSync(agentMod.chatPath(mine.sid)).mtimeMs - Date.parse('2026-10-01T10:05:09Z')) < 5000, { happened: JSON.stringify(list.map((c) => c.sid)), why: 'The point is that atlias agent can /resume them.', fix: 'Write the chat file the way saveChat does.' });
    const state = agentMod.loadChat(mine.sid, m.cwd);
    check('loadChat opens one, with the history and the digest of the old conversation', state && state.history.length === 4 && /brought in from Claude Code/.test(state.importedNote) && /Earlier the user set up the build/.test(state.importedNote) && state.messages.length === 0, { happened: JSON.stringify(state && Object.keys(state)), why: '/resume uses loadChat.', fix: 'Keep importedNote in loadChat.' });
    check('the saved file holds no secret and no tool result body', !/sk-abc|ghp_a1b2/.test(fs.readFileSync(agentMod.chatPath(mine.sid), 'utf8')) && !fs.readFileSync(agentMod.chatPath(mine.sid), 'utf8').includes('xxxxxxxx'), { happened: 'secret in the chat file', why: 'Sessions are the likeliest place for a pasted key.', fix: 'redactInline everywhere.' });
    check('importing the same sessions again changes nothing', importer.newItems(importer.scan({ homes: atliasHomes, sessions: true })).filter((i) => i.kind === 'sessions').length === 0, { happened: 'new sessions on the second scan', why: 'The sid is taken from the old session id.', fix: 'status present when the chat file exists.' });
  });

  await asyncSuite('import expert', 'import: an imported session carries its digest into the first new turn only', async () => {
    const m = machine();
    put(m.homes.claude, 'projects/C--proj/bbbbbbbb-1111-4222-8333-444444444444.jsonl', claudeSession(m.cwd));
    const atliasHomes = { ...m.homes, atlias: core.STATE_DIR };
    importer.apply(importer.scan({ homes: atliasHomes, from: 'claude', sessions: true }).filter((i) => i.kind === 'sessions'), { homes: atliasHomes });
    const state = agentMod.loadChat('bbbbbbbb-1111-4222-8333-444444444444', m.cwd);
    state.engine = 'echo';
    const first = await agentMod.turn(state, 'carry on', null, null);
    const second = await agentMod.turn(state, 'and again', null, null);
    check('the first reply\'s prompt starts with the digest, the second does not', /atlias import: this session was brought in from Claude Code/.test(first) && /carry on/.test(first) && !/atlias import/.test(second) && state.importedNote === undefined, { happened: first.slice(0, 200) + ' || ' + second.slice(0, 120), why: 'Otherwise every turn would repeat the old conversation.', fix: 'delete state.importedNote in turn.' });
    agentMod.saveChat(state);
    check('after the first turn is saved the file no longer carries the digest', !('importedNote' in JSON.parse(fs.readFileSync(agentMod.chatPath(state.sid), 'utf8'))), { happened: 'importedNote still saved', why: 'It was sent once.', fix: 'saveChat writes it only when set.' });
    const plain = agentMod.newState(m.cwd, 'echo');
    agentMod.saveChat(plain);
    check('an ordinary session\'s file has no import fields at all', !('importedNote' in JSON.parse(fs.readFileSync(agentMod.chatPath(plain.sid), 'utf8'))), { happened: 'importedNote in a plain session', why: 'Flag-off serialization must not change.', fix: 'Spread only when set.' });
  });

  await asyncSuite('import expert', 'import: nothing is copied without a yes, and the question is asked once', async () => {
    const m = machine();
    const said = [];
    const asked = [];
    const run = (answers, extra = {}) => importer.firstRunOffer({ homes: m.homes, interactive: true, out: (s) => said.push(String(s)), ask: async (q) => { asked.push(q); return answers.shift() ?? 'n'; }, ...extra });
    const r1 = await run(['n', 'n']);
    check('answering no copies nothing, writes the marker, and the offer showed counts per tool', !fs.existsSync(path.join(m.homes.atlias, 'AGENTS.md')) && !fs.existsSync(path.join(m.homes.atlias, 'skills')) && fs.existsSync(path.join(m.homes.atlias, 'import-marker.json')) && r1.asked && /Claude Code:/.test(said.join(NL)) && /memory\s+1 to import/.test(said.join(NL)), { happened: said.join(NL).slice(0, 300), why: 'Nothing is copied without a yes; a marker is written either way.', fix: 'firstRunOffer.' });
    check('the marker records the answer', JSON.parse(fs.readFileSync(path.join(m.homes.atlias, 'import-marker.json'), 'utf8')).choice === 'declined', { happened: fs.readFileSync(path.join(m.homes.atlias, 'import-marker.json'), 'utf8'), why: 'So it can be told apart from an import.', fix: 'writeMarker.' });
    const before = asked.length;
    const r2 = await run(['y', 'y']);
    check('with the marker present it does not ask again, even with a yes ready', r2.skipped === 'marker' && asked.length === before && !fs.existsSync(path.join(m.homes.atlias, 'AGENTS.md')), { happened: JSON.stringify(r2), why: 'It asks once.', fix: 'hasMarker.' });

    const m2 = machine('-yes');
    put(m2.homes.claude, 'projects/C--proj/cccccccc-1111-4222-8333-444444444444.jsonl', claudeSession(m2.cwd));
    const home2 = { ...m2.homes, atlias: path.join(m2.root, 'atlias-yes') };
    const asks = [];
    const r3 = await importer.firstRunOffer({ homes: home2, interactive: true, out: () => {}, ask: async (q) => { asks.push(q); return /session/.test(q) ? 'n' : 'yes'; } });
    check('a yes imports the config items; the sessions have their own question and a no leaves them', r3.yes && fs.existsSync(path.join(home2.atlias, 'AGENTS.md')) && fs.existsSync(path.join(home2.atlias, 'skills/good-skill/SKILL.md')) && asks.length === 2 && !fs.existsSync(path.join(home2.atlias, 'sessions')), { happened: asks.join(' | ') + ' ' + walk(home2.atlias).length, why: 'Sessions are big and personal; they are asked about separately.', fix: 'Two questions.' });
    check('the import is in a manifest', importer.manifests(home2).length >= 1, { happened: 'no manifest', why: 'Undo needs it.', fix: 'apply writes it.' });

    const m3 = machine('-pipe');
    const r4 = await importer.firstRunOffer({ homes: m3.homes, interactive: false, out: () => {}, ask: async () => 'y' });
    check('not interactive (a pipe, a script): nothing asked, nothing copied, no marker', r4.skipped === 'not interactive' && !fs.existsSync(m3.homes.atlias), { happened: JSON.stringify(r4), why: 'A piped agent session must not have its input eaten or its home written.', fix: 'The interactive gate.' });

    const empty = { userHome: path.join(TMP, 'import', 'empty-' + (++n)), atlias: path.join(TMP, 'import', 'empty-atlias-' + n), claude: path.join(TMP, 'import', 'e-c' + n), codex: path.join(TMP, 'import', 'e-x' + n), gemini: path.join(TMP, 'import', 'e-g' + n) };
    const r5 = await importer.firstRunOffer({ homes: empty, interactive: true, out: () => {}, ask: async () => { throw Error('should not be asked'); } });
    check('nothing found: not asked, and the marker is written so it stays quiet', r5.skipped === 'nothing found' && fs.existsSync(path.join(empty.atlias, 'import-marker.json')), { happened: JSON.stringify(r5), why: 'There is nothing to offer.', fix: 'Write the marker.' });

    const m4 = machine('-explicit');
    const lines = [];
    const noYes = await importer.runImport([], { homes: m4.homes, out: (s) => lines.push(s) });
    check('atlias import with no way to ask and no --yes copies nothing', noYes.code === 1 && !fs.existsSync(path.join(m4.homes.atlias, 'AGENTS.md')), { happened: lines.join(NL).slice(-200), why: 'Nothing is copied without a yes.', fix: 'runImport.' });
    const dry = await importer.runImport(['--dry-run'], { homes: m4.homes, out: (s) => lines.push(s), ask: async () => { throw Error('dry run must not ask'); } });
    check('--dry-run prints the plan with the files it would write and does not write or ask', dry.dryRun && !fs.existsSync(m4.homes.atlias) && lines.some((l) => /would be written/.test(l)), { happened: lines.join(NL).slice(-200), why: 'Dry run is the plan only.', fix: 'runImport.' });
    const declined = await importer.runImport([], { homes: m4.homes, out: () => {}, ask: async () => 'no' });
    check('answering no to the question copies nothing', declined.declined && !fs.existsSync(path.join(m4.homes.atlias, 'AGENTS.md')), { happened: JSON.stringify(Object.keys(declined)), why: 'A yes is required.', fix: 'isYes.' });
    const yes = await importer.runImport(['--yes', '--from', 'codex'], { homes: m4.homes, out: () => {} });
    check('--yes with --from imports only that tool', yes.code === 0 && fs.existsSync(path.join(m4.homes.atlias, 'memory/codex/note.md')) && !fs.existsSync(path.join(m4.homes.atlias, 'commands')), { happened: walk(m4.homes.atlias).join(','), why: '--from claude|codex|gemini|antigravity.', fix: 'parseArgs and scan.' });
    check('a bad option is an error with the usage line', (await importer.runImport(['--frm', 'x'], { homes: m4.homes, out: (s) => lines.push(s) })).code === 2 && (await importer.runImport(['--from', 'cursor'], { homes: m4.homes, out: () => {} })).code === 2, { happened: 'accepted', why: 'A typo must not run a real import.', fix: 'parseArgs.' });
  });

  await asyncSuite('import expert', 'import: undo removes exactly what the import made', async () => {
    const m = machine();
    put(m.homes.atlias, 'config.json', '{"mine":true}');
    put(m.homes.atlias, 'commands/mine.md', 'my command');
    put(m.homes.atlias, 'skills/my-skill/SKILL.md', 'mine');
    const outside = put(m.root, 'outside/keep.txt', 'not in the atlias home');
    const mineBefore = snapshot(m.homes.atlias);
    const r = importer.apply(importer.scan({ homes: m.homes }), { homes: m.homes });
    const made = JSON.parse(fs.readFileSync(r.manifest, 'utf8')).created.map((f) => f.path);
    check('the manifest lists every file the import created, with a hash', made.length === r.created && made.every((p) => fs.existsSync(p)) && JSON.parse(fs.readFileSync(r.manifest, 'utf8')).created.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)), { happened: `${made.length} listed, ${r.created} created`, why: 'Undo can only remove what it knows it made.', fix: 'Made.file records every write.' });
    // The person edits one imported file, and adds a file of their own inside an imported folder.
    const edited = path.join(m.homes.atlias, 'commands/team/review.md');
    fs.appendFileSync(edited, 'MY EDIT');
    const added = put(m.homes.atlias, 'skills/good-skill/my-notes.txt', 'my notes');
    const u = await importer.runImport(['--undo'], { homes: m.homes, out: () => {} });
    check('undo removes the imported files that are unchanged', !fs.existsSync(path.join(m.homes.atlias, 'AGENTS.md')) && !fs.existsSync(path.join(m.homes.atlias, 'skills/codex-skill/SKILL.md')) && !fs.existsSync(path.join(m.homes.atlias, 'imported/mcp-claude.json')), { happened: walk(m.homes.atlias).join(','), why: 'That is the undo.', fix: 'undo.' });
    check('a file the person edited, and a file the person added, stay', fs.existsSync(edited) && fs.readFileSync(edited, 'utf8').endsWith('MY EDIT') && fs.existsSync(added) && u.undo.kept.some((k) => k.path === path.resolve(edited)), { happened: JSON.stringify(u.undo.kept), why: 'Undo removes only what it made, and only while it is still what it wrote.', fix: 'Compare the hash.' });
    check('everything that was there before the import is untouched, and so is the file outside the home', fs.readFileSync(path.join(m.homes.atlias, 'config.json'), 'utf8') === '{"mine":true}' && fs.readFileSync(path.join(m.homes.atlias, 'commands/mine.md'), 'utf8') === 'my command' && fs.existsSync(path.join(m.homes.atlias, 'skills/my-skill/SKILL.md')) && fs.existsSync(outside), { happened: snapshot(m.homes.atlias), why: 'Exactly those files.', fix: 'Never remove by folder.' });
    check('empty folders the import made are gone; folders that still hold something stay', !fs.existsSync(path.join(m.homes.atlias, 'imported')) && !fs.existsSync(path.join(m.homes.atlias, 'projects')) && fs.existsSync(path.join(m.homes.atlias, 'skills/good-skill')), { happened: walk(m.homes.atlias).join(','), why: 'Leave no litter, take no one\'s work.', fix: 'rmdir only when empty.' });
    const second = await importer.runImport(['--undo'], { homes: m.homes, out: () => {} });
    check('undo twice is harmless', second.undo.removed.length === 0 && second.undo.manifests === 0, { happened: JSON.stringify(second.undo), why: 'The manifest is marked undone.', fix: 'm.undone.' });

    // A manifest that was edited to name a file outside the home is not obeyed.
    const m2 = machine('-evil');
    const r2 = importer.apply(importer.scan({ homes: m2.homes, from: 'codex' }), { homes: m2.homes });
    const doc = JSON.parse(fs.readFileSync(r2.manifest, 'utf8'));
    const victim = put(m2.root, 'victim.txt', 'precious');
    doc.created.push({ path: victim, sha256: crypto.createHash('sha256').update('precious').digest('hex') });
    fs.writeFileSync(r2.manifest, JSON.stringify(doc));
    importer.undo({ homes: m2.homes });
    check('a manifest naming a file outside the Atlias home does not remove it', fs.existsSync(victim), { happened: 'the outside file was deleted', why: 'Undo must stay inside the Atlias home whatever the manifest says.', fix: 'insideAtlias in undo.' });
  });

  await asyncSuite('import expert', 'import: the /import command, atlias import, and the benchmark path', async () => {
    const names = commands.BUILTINS.map((b) => b.name);
    check('/import is in the registry and /help lists it', names.includes('import') && commands.helpText(ROOT, path.join(TMP, 'import', 'nohome')).includes('/import'), { happened: names.join(','), why: 'One table runs and lists every command.', fix: 'Add it to BUILTINS.' });
    const m = machine('-cli');
    const env = { ...process.env, ATLIAS_HOME: m.homes.atlias, HOME: m.root, USERPROFILE: m.root, CLAUDE_CONFIG_DIR: m.homes.claude, CODEX_HOME: m.homes.codex };
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'atlias.mjs'), 'import', '--dry-run', '--from', 'codex'], { env, encoding: 'utf8', timeout: 60000 });
    check('atlias import --dry-run --from codex prints the plan from the fake home and writes nothing', r.status === 0 && /Codex:/.test(r.stdout) && !/Claude Code:/.test(r.stdout) && /dry run: nothing was copied/.test(r.stdout) && !fs.existsSync(m.homes.atlias), { happened: (r.stdout + r.stderr).slice(0, 300), why: 'The command is the same code as the offer.', fix: 'bin case import.' });
    const r2 = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'atlias.mjs'), 'import', '--from', 'codex'], { env, encoding: 'utf8', timeout: 60000, input: '' });
    check('atlias import without a terminal and without --yes copies nothing', r2.status === 1 && !fs.existsSync(path.join(m.homes.atlias, 'memory')), { happened: (r2.stdout + r2.stderr).slice(0, 300), why: 'There is no one to say yes.', fix: 'ask is null without a TTY.' });
    const r3 = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'atlias.mjs'), 'import', '--yes', '--from', 'codex'], { env, encoding: 'utf8', timeout: 60000 });
    const r4 = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'atlias.mjs'), 'import', '--undo'], { env, encoding: 'utf8', timeout: 60000 });
    check('atlias import --yes imports and atlias import --undo takes it back', r3.status === 0 && /imported/.test(r3.stdout) && r4.status === 0 && /removed \d+ file/.test(r4.stdout) && !fs.existsSync(path.join(m.homes.atlias, 'memory/codex/note.md')), { happened: (r3.stdout + r4.stdout).slice(0, 300), why: 'End to end through the real entry point.', fix: 'bin case import.' });

    // The /import command through the registry, with a scripted yes.
    const out = [];
    const asked = [];
    const m2 = machine('-slash');
    const d1 = await commands.dispatch('/import --dry-run --from gemini', { state: {}, cwd: m2.cwd, out: (s) => out.push(String(s)), ask: async (q) => { asked.push(q); return 'n'; }, api: {} });
    check('/import --dry-run runs through the dispatcher, prints a plan and asks nothing', d1.handled && /dry run: nothing was copied/.test(out.join(NL)) && asked.length === 0, { happened: out.join(NL).slice(0, 200), why: 'The slash command is the same body as the command line.', fix: 'The BUILTINS entry.' });
    out.length = 0;
    await commands.dispatch('/import --bogus', { state: {}, cwd: m2.cwd, out: (s) => out.push(String(s)), ask: async () => 'y', api: {} });
    check('/import with a bad option says so and copies nothing', /unknown option/.test(out.join(NL)), { happened: out.join(NL), why: 'A typo must not run an import.', fix: 'parseArgs.' });

    const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const touched = ['lib/loop.mjs', 'lib/eval.mjs', 'tools/h2h/atlias_task.mjs'].filter((f) => fs.existsSync(path.join(ROOT, f)));
    check('the benchmark path does not reach the importer: runLoop, eval and the h2h tools never mention it', touched.length >= 2 && touched.every((f) => !/import\.mjs|firstRunOffer|importedNote/.test(read(f))) && (fs.readdirSync(path.join(ROOT, 'tools/h2h'), { withFileTypes: true }).filter((e) => e.isFile()).every((e) => !/import\.mjs|firstRunOffer/.test(fs.readFileSync(path.join(ROOT, 'tools/h2h', e.name), 'utf8')))), { happened: touched.join(','), why: 'Gev: the benchmark path must not change. Optional interactive image inputs were requested October 24; 25f0280 preserves exact no-attachment baseline requests, as verified by the golden fingerprint checks. Eval and h2h tools remain unchanged. Re-pinned from 68ffb8c on 2026-10-21 for the sub-agent tool, which is off on the eval path (test/golden.mjs keeps the requests byte for byte); any other change still fails here.', fix: 'Keep the importer out of loop.mjs, eval.mjs and tools/h2h.' });
    const src = read('lib/agent.mjs');
    const exec = src.slice(src.indexOf('async function execOnce'), src.indexOf('export const slashApi'));
    check('atlias exec and --once never offer an import: the offer is inside the repl only, and not for --once', !/importer/.test(exec) && /if \(!opts\.once && state\.engine !== 'setup' && !edition\) await importer\.firstRunOffer/.test(src) && (src.match(/importer\.firstRunOffer/g) || []).length === 1, { happened: 'importer referenced in execOnce or twice', why: 'exec is non-interactive and has no one to ask.', fix: 'Call it only in replIn.' });
    // Gev requested optional steering on October 29. Reviewed c54f780 adds
    // request-boundary input only when a source is passed; eval/h2h keep the old pin.
    // Golden fingerprints still enforce byte-identical benchmark requests.
    const r5 = spawnSync('git', ['diff', '--name-only', '25f0280', '--', 'lib/eval.mjs', 'tools/h2h'], { cwd: ROOT, encoding: 'utf8' });
    if (r5.status === 0) check('git: eval and h2h remain byte-identical to the frozen base 25f0280', r5.stdout.trim() === '', { happened: r5.stdout.trim(), why: 'The relay must not change measured runners or their grader path.', fix: 'Restore the frozen eval/h2h source.' });
    else skip('git diff against 25f0280', 'the base commit is not in this checkout');
    // Reviewed 92edfc2 (2026-10-30, for Gev): the sub-agent ledger changes runSubagent only, which the
    // benchmark path never reaches (the agent tool is not offered there), and state.subagent stays null there.
    const relayBase = '92edfc2';
    const loopDiff = spawnSync('git', ['diff', '--name-only', relayBase, '--', 'lib/loop.mjs'], { cwd: ROOT, encoding: 'utf8' });
    if (loopDiff.status === 0) check('git: loop matches the reviewed optional-input source; golden requests enforce the benchmark baseline', loopDiff.stdout.trim() === '', { happened: loopDiff.stdout.trim(), why: 'Optional steering and interruption sources are absent from evals. Golden checks retain byte-identical benchmark requests. Any later loop change needs a review.', fix: 'Review the loop change, preserve golden fingerprints and pin the reviewed commit explicitly.' });
    else skip('git diff against reviewed relay source', 'the reviewed commit is not in this checkout');
  });
}

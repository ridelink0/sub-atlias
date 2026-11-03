// Claude Code plugins and MCP servers in Atlias's own loop (Gev, 2026-11-03): skills, commands, agents,
// hooks and MCP servers read from the files Claude Code and Codex already keep, and one mcp tool for
// interactive turns only. Every fixture lives in TMP; the MCP server is a real stdio process.
import * as plugins from '../lib/plugins.mjs';
import * as mcp from '../lib/mcp-client.mjs';
import * as hooks from '../lib/plugin-hooks.mjs';
import * as skills from '../lib/skills.mjs';
import * as commands from '../lib/commands.mjs';
import * as loop from '../lib/loop.mjs';
import * as agent from '../lib/agent.mjs';

export default async function pluginsMcpSuites({ suite, asyncSuite, check, core, TMP, fs, path }) {
  const detail = (happened) => ({ happened: typeof happened === 'string' ? happened : JSON.stringify(happened), why: 'Gev: plugins and MCP servers set up for Claude Code and Codex work in Atlias, with the prompt kept to one short line per item.', fix: 'Repair lib/plugins.mjs, lib/mcp-client.mjs or lib/plugin-hooks.mjs.' });
  const root = path.join(TMP, 'plugins-mcp');
  const claudeDir = path.join(root, 'claude'), codexDir = path.join(root, 'codex'), project = path.join(root, 'project');
  const write = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
  // A plugin with every part, a disabled plugin, and Atlias's own plugin (always left out).
  const pr = path.join(claudeDir, 'plugins', 'cache', 'mk', 'kit', '1.0.0');
  write(path.join(pr, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'kit', userConfig: { mode: { default: 'calm' } } }));
  write(path.join(pr, 'skills', 'tidy', 'SKILL.md'), '---\nname: tidy\ndescription: Tidy a folder of notes\n---\nSort the notes by date.');
  write(path.join(pr, 'commands', 'hello.md'), '---\ndescription: say hello\n---\nSay hello to $ARGUMENTS.');
  write(path.join(pr, 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Reviews a diff for bugs\n---\nYou review diffs. List each bug with file:line.');
  const server = path.join(root, 'echo-server.mjs');
  write(server, [
    "let buf = '';",
    "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
    "process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; const m = JSON.parse(line);",
    "  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1' } } });",
    "  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', description: 'Echo the text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }, { name: 'peek', description: 'Read only', annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } }] } });",
    "  else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: (m.params.name === 'peek' ? 'peeked ' : 'echo: ') + (m.params.arguments.text || '') + ' mode=' + (process.env.KIT_MODE || '') }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }] } });",
    "  else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no' } });",
    "} });",
  ].join('\n'));
  write(path.join(pr, '.mcp.json'), JSON.stringify({ mcpServers: { kitecho: { command: process.execPath, args: [server], env: { KIT_MODE: '${user_config.mode}', KIT_ROOT: '${CLAUDE_PLUGIN_ROOT}' } } } }));
  write(path.join(pr, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/deny.mjs"' }] }] } }));
  const off = path.join(claudeDir, 'plugins', 'cache', 'mk', 'offkit', '1.0.0');
  write(path.join(off, 'skills', 'hidden', 'SKILL.md'), '---\nname: hidden\n---\nx');
  const own = path.join(claudeDir, 'plugins', 'cache', 'atlias', 'atlias', '4.0.0');
  write(path.join(own, '.mcp.json'), JSON.stringify({ mcpServers: { atlias: { command: 'node', args: ['mcp/server.mjs'] } } }));
  write(path.join(claudeDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'kit@mk': [{ scope: 'user', installPath: pr }], 'offkit@mk': [{ scope: 'user', installPath: off }], 'atlias@atlias': [{ scope: 'user', installPath: own }] } }));
  write(path.join(claudeDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'kit@mk': true, 'offkit@mk': false, 'atlias@atlias': true } }));
  write(path.join(claudeDir, '.claude.json'), JSON.stringify({ mcpServers: { userweb: { type: 'http', url: 'http://127.0.0.1:9/mcp' }, olden: { type: 'sse', url: 'http://127.0.0.1:9/sse' }, gone: { command: 'x', disabled: true } }, projects: { [project]: { enabledMcpjsonServers: ['approved'] } } }));
  write(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { approved: { command: 'a' }, stranger: { command: 'evil' } } }));
  write(path.join(codexDir, 'config.toml'), '[mcp_servers.codexone]\ncommand = "node"\nargs = ["x.js"]\n\n[mcp_servers.codexone.env]\nTOKEN = "kept-value"\n\n[mcp_servers.codexoff]\ncommand = "node"\nenabled = false\n');
  const opts = { claudeDir, cfg: { plugins: 'on', mcp: 'on' } };

  suite('plugins expert', 'Claude Code plugins: enabled ones only, every part read where it is installed', () => {
    const list = plugins.enabled(opts);
    check('only enabled plugins, never Atlias itself', list.map((p) => p.key).join() === 'kit@mk', detail(list.map((p) => p.key)));
    const roots = plugins.skillRoots(opts);
    check('skill roots carry the plugin: prefix', roots.length === 1 && roots[0].prefix === 'kit:' && roots[0].source === 'plugin', detail(roots));
    const tidy = skills.readSkill(path.join(roots[0].dir, 'tidy'), 'plugin', roots[0].prefix);
    check('a plugin skill is named plugin:skill', tidy && tidy.name === 'kit:tidy', detail(tidy));
    const agents = plugins.agents(opts), body = plugins.agentBody('reviewer', opts);
    check('agents are named plugin:agent and their instructions are read on demand', agents.length === 1 && agents[0].name === 'kit:reviewer' && body && body.text.startsWith('You review diffs') && !body.text.includes('---'), detail({ agents, body }));
    const servers = plugins.mcpServers(opts);
    check('plugin MCP servers get CLAUDE_PLUGIN_ROOT and user_config filled in; Atlias\'s own is left out', servers.length === 1 && servers[0].name === 'kitecho' && servers[0].def.env.KIT_MODE === 'calm' && servers[0].def.env.KIT_ROOT === pr, detail(servers));
    const h = plugins.hooks(opts);
    check('hooks are read by event with the plugin root filled in', h.PreToolUse && h.PreToolUse.length === 1 && h.PreToolUse[0].command.includes(pr) && h.PreToolUse[0].matcher === 'Bash', detail(h));
    check('agent.plugins off reads nothing', plugins.enabled({ claudeDir, cfg: { plugins: 'off' } }).length === 0, detail('read'));
  });

  // The same plugin, installed in the Claude folder this test run uses (core.CLAUDE_DIR), for the code
  // paths that read it from there. The folder's own files are put back afterwards.
  write(path.join(pr, 'hooks', 'deny.mjs'), "let s='';process.stdin.on('data',(d)=>{s+=d;}).on('end',()=>{process.stderr.write('no shell here: '+JSON.parse(s).tool_input.command);process.exit(2);});");
  const live = core.CLAUDE_DIR, liveFiles = [path.join(live, 'plugins', 'installed_plugins.json'), path.join(live, 'settings.json')];
  const installLive = () => { const saved = liveFiles.map((f) => (fs.existsSync(f) ? fs.readFileSync(f) : null)); write(liveFiles[0], fs.readFileSync(path.join(claudeDir, 'plugins', 'installed_plugins.json'))); write(liveFiles[1], JSON.stringify({ ...(saved[1] ? JSON.parse(saved[1]) : {}), enabledPlugins: { 'kit@mk': true } })); return () => liveFiles.forEach((f, i) => (saved[i] === null ? fs.rmSync(f, { force: true }) : fs.writeFileSync(f, saved[i]))); };

  await asyncSuite('plugins expert', 'plugin skills and commands join the lists, hooks run on interactive tools, the pinned all index is unchanged', async () => {
    const indexBefore = skills.promptSection(project);
    const restore = installLive();
    try {
      const names = skills.discover(project).map((s) => s.name);
      check('a plugin skill is listed as plugin:skill', names.includes('kit:tidy'), detail(names));
      const indexNow = skills.promptSection(project);
      check('the all index stays byte for byte what the stored runs had', indexNow === indexBefore && !/(^|[ ,:])tidy([ ,]|$)/m.test(indexNow), detail({ indexBefore, indexNow }));
      const body = skills.body(project, 'kit:tidy');
      check('a plugin skill is read in full on demand', body && body.text === 'Sort the notes by date.', detail(body));
      const cmds = commands.loadCustom(project, path.join(root, 'home')).list;
      const hello = cmds.find((c) => c.name === 'kit:hello');
      check('a plugin command is a slash command named plugin:command', hello && hello.source === 'plugin' && commands.expand(hello.body, 'Gev') === 'Say hello to Gev.', detail(cmds.map((c) => c.name)));
      core.setRunOverride({ agent: { pluginHooks: 'on' } });
      try {
        const st = { cwd: project, sid: 'hooks', interactive: true, clock: 0 };
        const refused = await loop.runTool(st, { tool: 'shell', command: 'echo hi' }, null);
        check('a plugin PreToolUse hook refuses an interactive shell call with its reason', refused.startsWith('refused by a plugin hook (kit hook: no shell here: echo hi)'), detail(refused));
        const quiet = await loop.runTool({ ...st, interactive: false }, { tool: 'shell', command: 'echo hi' }, null);
        check('outside an interactive turn no plugin hook runs (eval and benchmark runs are unchanged)', !/plugin hook/.test(String(quiet)), detail(quiet));
      } finally { core.setRunOverride(null); }
    } finally { restore(); }
    check('with the plugin gone the lists are what they were', !skills.discover(project).some((s) => s.name === 'kit:tidy'), detail('kit:tidy still listed'));
  });

  suite('mcp expert', 'MCP servers: every source, first name wins, disabled and unapproved ones left out', () => {
    const list = mcp.servers(project, { homeDir: path.join(root, 'nohome'), claudeDir, codexDir, cfg: { mcp: 'on', plugins: 'on' } });
    const names = list.map((s) => `${s.name}:${s.source}`);
    check('Claude user servers, approved project servers, Codex and plugins; not disabled, unapproved or Atlias', JSON.stringify(names) === JSON.stringify(['approved:.mcp.json', 'codexone:codex', 'kitecho:plugin kit', 'olden:claude', 'userweb:claude']), detail(names));
    const codexOne = list.find((s) => s.name === 'codexone');
    check('Codex servers keep their real environment values, which import.mjs never copies', codexOne && codexOne.def.env.TOKEN === 'kept-value' && codexOne.def.args[0] === 'x.js', detail(codexOne));
    check('agent.mcp off finds nothing', mcp.servers(project, { homeDir: root, claudeDir, codexDir, cfg: { mcp: 'off' } }).length === 0, detail('found'));
    const spec = mcp.toolSpec(['a', 'b']);
    check('the model sees one tool, one line, the servers by name', spec.name === 'mcp' && spec.about.includes('Servers: a, b') && Object.keys(spec.params).join() === 'server,name,arguments' && spec.about.length < 400, detail(spec));
  });

  await asyncSuite('mcp expert', 'MCP over stdio: list, describe, call, permissions, failures', async () => {
    const list = mcp.servers(project, { homeDir: path.join(root, 'nohome'), claudeDir, codexDir, cfg: { mcp: 'on', plugins: 'on' } });
    const state = { cwd: project };
    try {
      const tools = await mcp.run(state, { tool: 'mcp', server: 'kitecho' }, { list, perm: 'workspace' });
      check('{server} starts it and lists its tools, one line each', tools.startsWith('kitecho: 2 tools') && tools.includes('- echo: Echo the text back') && tools.includes('- peek'), detail(tools));
      const about = await mcp.run(state, { tool: 'mcp', server: 'kitecho', name: 'echo' }, { list, perm: 'workspace' });
      check('{server, name} shows the parameters and runs nothing', about.includes('parameters: {"type":"object"') && !about.includes('mode='), detail(about));
      const ran = await mcp.run(state, { tool: 'mcp', server: 'kitecho', name: 'echo', arguments: { text: 'hi' } }, { list, perm: 'workspace' });
      check('a call returns its text, the plugin environment reached the server, and an image is named not invented', ran.startsWith('echo: hi mode=calm') && ran.includes('[image image/png: not shown here]'), detail(ran));
      const asString = await mcp.run(state, { tool: 'mcp', server: 'kitecho', name: 'echo', arguments: '{"text":"s"}' }, { list, perm: 'workspace' });
      check('arguments sent as a JSON string are read', asString.startsWith('echo: s'), detail(asString));
      let asked = '';
      const refused = await mcp.run(state, { tool: 'mcp', server: 'kitecho', name: 'echo', arguments: {} }, { list, perm: 'ask', ask: async (q) => { asked = q; return 'n'; } });
      check('ask mode asks before a tool that may act, and a no runs nothing', asked.includes('kitecho.echo') && refused.startsWith('refused by the user'), detail({ asked, refused }));
      const planned = await mcp.run(state, { tool: 'mcp', server: 'kitecho', name: 'echo', arguments: {} }, { list, perm: 'plan' });
      check('plan mode refuses a tool that may act', planned.startsWith('plan mode:'), detail(planned));
      const peek = await mcp.run(state, { tool: 'mcp', server: 'kitecho', name: 'peek', arguments: {} }, { list, perm: 'plan', ask: async () => 'n' });
      check('a tool marked read-only runs in plan mode without asking', peek.startsWith('peeked'), detail(peek));
      const none = await mcp.run(state, { tool: 'mcp', server: 'nope' }, { list, perm: 'workspace' });
      check('an unknown server names the real ones', none.includes('there is no server named nope') && none.includes('kitecho'), detail(none));
      const old = await mcp.run(state, { tool: 'mcp', server: 'olden' }, { list, perm: 'workspace' });
      check('the old HTTP+SSE transport is named as unsupported, never faked', old.includes('older HTTP+SSE transport') && old.includes('Nothing ran'), detail(old));
      const dead = await mcp.run(state, { tool: 'mcp', server: 'approved' }, { list, perm: 'workspace' });
      check('a server that cannot start says so and runs nothing', dead.startsWith('mcp: approved could not start') && dead.includes('Nothing ran'), detail(dead));
      const web = await mcp.run(state, { tool: 'mcp', server: 'userweb' }, { list, perm: 'workspace' });
      check('an HTTP server that cannot be reached says so', web.startsWith('mcp: userweb could not start'), detail(web));
    } finally { mcp.closeAll(); }
  });

  await asyncSuite('mcp expert', 'the mcp tool is offered to interactive turns only, so benchmark requests are unchanged', async () => {
    const offered = loop.offeredTools('all', true, ['web_fetch', mcp.toolSpec(['x'])]).map((t) => t.name);
    check('an object in extra is offered as a tool', offered.includes('mcp') && offered.includes('web_fetch'), detail(offered));
    const plain = loop.offeredTools('all', true, []).map((t) => t.name);
    check('with no extra the tool list is what it was', !plain.includes('mcp') && JSON.stringify(plain) === JSON.stringify(loop.TOOLS.map((t) => t.name)), detail(plain));
    const st = { cwd: project, interactive: false, clock: 0 };
    const refused = await loop.runTool(st, { tool: 'mcp', server: 'kitecho' }, null);
    check('outside an interactive turn the mcp tool is unknown', /^unknown tool mcp/.test(refused), detail(refused));
  });

  await asyncSuite('plugin hooks expert', 'plugin hooks: Claude Code\'s contract, off by default', async () => {
    check('off by default', core.config().agent.pluginHooks === 'off' && !hooks.hooksOn(core.config().agent), detail(core.config().agent.pluginHooks));
    check('tool names map to Claude Code\'s and MCP calls to mcp__server__tool', hooks.claudeToolName({ tool: 'shell' }) === 'Bash' && hooks.claudeToolName({ tool: 'mcp', server: 's', name: 't' }) === 'mcp__s__t' && hooks.claudeToolName({ tool: 'constructor' }) === 'constructor', detail('names'));
    check('matchers are anchored regular expressions', hooks.matches('Edit|Write', 'Write') && !hooks.matches('Edit', 'EditX') && hooks.matches('', 'Bash') && hooks.matches('*', 'Bash'), detail('matchers'));
    const fake = (results) => { let i = 0; const seen = []; return { run: async (h, input) => { seen.push(input); return results[i++]; }, seen }; };
    const h = { plugin: 'kit', matcher: 'Bash', command: 'x', timeout: 5 };
    let f = fake([{ code: 2, stdout: '', stderr: 'no rm here' }]);
    let r = await hooks.fire('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm -rf x' } }, { cwd: project, toolName: 'Bash', list: [h], run: f.run, cfg: { permissions: 'workspace' } });
    check('exit 2 denies a tool with stderr as the reason, and the input is Claude Code\'s shape', r.deny === 'kit hook: no rm here' && f.seen[0].hook_event_name === 'PreToolUse' && f.seen[0].tool_input.command === 'rm -rf x', detail({ r, seen: f.seen }));
    f = fake([{ code: 0, stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'ask', permissionDecisionReason: 'sure?' } }) }]);
    r = await hooks.fire('PreToolUse', {}, { cwd: project, toolName: 'Bash', list: [h], run: f.run });
    check('permissionDecision ask asks', r.ask === 'kit hook: sure?' && !r.deny, detail(r));
    f = fake([{ code: 0, stdout: 'remember the style guide' }]);
    r = await hooks.fire('UserPromptSubmit', { prompt: 'p' }, { cwd: project, list: [{ ...h, matcher: '' }], run: f.run });
    check('plain stdout from UserPromptSubmit is context for the model', r.context.join() === 'remember the style guide', detail(r));
    f = fake([{ code: 0, stdout: JSON.stringify({ decision: 'block', reason: 'tests are red', systemMessage: 'held' }) }]);
    r = await hooks.fire('Stop', {}, { cwd: project, list: [{ ...h, matcher: '' }], run: f.run });
    check('decision block holds a Stop, and systemMessage is for the screen', r.block === 'kit hook: tests are red' && r.messages[0] === 'kit hook: held', detail(r));
    f = fake([{ code: 0, stdout: 'x' }]);
    r = await hooks.fire('PreToolUse', {}, { cwd: project, toolName: 'Read', list: [h], run: f.run });
    check('a hook whose matcher does not match never runs', f.seen.length === 0 && !r.deny, detail(f.seen));
    f = fake([{ code: 1, stdout: '', stderr: 'boom' }]);
    r = await hooks.fire('PreToolUse', {}, { cwd: project, toolName: 'Bash', list: [h], run: f.run });
    check('a hook that fails without exit 2 blocks nothing and is reported', !r.deny && r.messages[0].includes('failed (1)'), detail(r));
    const real = await hooks.runHook({ root: root, command: `"${process.execPath.replace(/\\/g, '/')}" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stderr.write(JSON.parse(s).tool_name);process.exit(2)})"`, timeout: 20 }, { tool_name: 'Bash' }, project);
    check('a real hook command gets the event on stdin and its exit code back', real.code === 2 && real.stderr === 'Bash', detail(real));
  });

  await asyncSuite('plugins expert', 'plugin agents: a subagent type runs with the agent\'s instructions', async () => {
    const st = { cwd: project, sid: 's', interactive: true, clock: 0, subagent: null };
    const listed = await loop.runSubagent({ ...st, subagent: { chat: async () => ({ content: 'x' }) } }, { tool: 'agent', task: 't', type: '?' });
    check('type ? lists the plugin agents (none in this run\'s Claude folder) and starts no worker', /plugin agents|no plugin agents are installed/.test(listed), detail(listed));
    check('the agent tool names type, and nothing else about it changed shape', Object.keys(loop.AGENT_TOOL.params).join() === 'task,name,engine,model,type', detail(loop.AGENT_TOOL.params));
  });

  suite('terminal display expert', 'status words for MCP servers: computer use shows as computer use', () => {
    check('an MCP call on a computer-use server shows Working on computer use; any other MCP server shows Working', agent.toolActivity('mcp', 'computer-use computer_click') === 'Working on computer use' && agent.toolActivity('mcp', 'gev-knowledge query_graph') === 'Working' && agent.toolRow('  tool mcp kitecho echo') === '● Use(kitecho echo)', detail([agent.toolActivity('mcp', 'computer-use x'), agent.toolRow('  tool mcp kitecho echo')]));
  });
}

// Gev 2026-11-03: the model stays silent during a turn; the status shows the app's fixed words for its tool,
// and goes back to Working each time the model is called again.
export async function silentModelSuite({ asyncSuite, check, core, TMP, fs, path }) {
  const dir = path.join(TMP, 'silent-model'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'read.txt'), 'fixture');
  const frame = (s) => '```atlias\n' + JSON.stringify(s) + '\n```';
  await asyncSuite('terminal display expert', 'the model is silent during a turn and the status follows its tools', async () => {
    core.setRunOverride({ agent: { testCommand: 'off', maxToolRounds: 4 } });
    try {
      const shown = [], statuses = [], state = agent.newState(dir, 'openai');
      let calls = 0;
      const reply = await agent.turn(state, 'Read the fixture.', null, (line) => shown.push(String(line)), {
        onActivity: (label) => statuses.push(label),
        chat: async () => (++calls === 1 ? { content: 'NARRATION-ONE Let me open the file first.\n' + frame({ tool: 'read_file', path: 'read.txt' }) } : { content: 'Done.' }),
      });
      const rows = shown.filter((l) => /read\.txt/.test(l));
      check('model text between tool calls never reaches the screen; the tool row does', reply === 'Done.' && rows.length === 1 && !shown.some((l) => l.includes('NARRATION')), { happened: JSON.stringify(shown), why: 'Gev: the harness is not shown; the model does not speak during a turn.', fix: 'Keep interim model text out of say().' });
      check('the status follows the tool and goes back to Working when the model is called again', JSON.stringify(statuses) === JSON.stringify(['Working', 'Working on files', 'Working']) && !Object.getOwnPropertySymbols(state).length, { happened: JSON.stringify(statuses), why: 'The status is the app\'s own words for what the model is doing now.', fix: 'Check toolActivity, ACTIVITY and activityChat in lib/agent.mjs.' });
    } finally { core.setRunOverride(null); }
  });
}

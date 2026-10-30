// The claude-plan engine (Gev, 2026-10-19): Atlias's own loop on the person's
// own Claude plan through the Claude Agent SDK, never an API key and never
// Claude Code's agent loop; host harnesses off by default; effort chosen and
// shown; first-open setup that finds what is already on the computer.
import * as plan from '../lib/claude-plan.mjs';
import * as engines from '../lib/engines.mjs';
import * as onboarding from '../lib/onboarding.mjs';
import * as commands from '../lib/commands.mjs';
import * as settings from '../lib/settings.mjs';
import { authCommand } from '../lib/auth-command.mjs';
import { offerClaudeForTests } from '../lib/edition.mjs';

// These suites cover the founders edition, the only one with the Claude engine (Gev, 2026-10-29);
// test/edition-suites.mjs covers the release, which has none.
export default async function claudePlanSuites(args) {
  offerClaudeForTests(true);
  try { await founderSuites(args); } finally { offerClaudeForTests(false); }
}
async function founderSuites({ asyncSuite, suite, check, core, agentMod, TMP, fs, path }) {
  let n = 0;
  const temp = (name) => { const d = path.join(TMP, 'claude-plan', `${name}-${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
  // A stand-in SDK: records the options and replays a scripted message stream.
  const fakeSdk = (script, seen = {}) => ({ query: ({ prompt, options }) => { seen.options = options; seen.prompt = prompt; return (async function* () { for (const m of script) { if (options.abortController?.signal.aborted) return; yield m; } })(); } });
  const init = (src = 'none') => ({ type: 'system', subtype: 'init', apiKeySource: src, tools: [], model: 'claude-opus-5-5' });
  const reply = (text) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text }] } });
  const ok = (text, extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: text, stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 }, ...extra });
  const msgs = [{ role: 'system', content: 'SYSTEM RULES' }, { role: 'user', content: 'fix it' }, { role: 'assistant', content: 'reading' }, { role: 'tool', content: 'file text' }];

  await asyncSuite('claude plan expert', 'claude-plan: one SDK turn, plan login only, Atlias runs the tools', async () => {
    const seen = {};
    const chat = plan.claudePlanChat({ claudePlanModel: 'claude-opus-5-5', claudePlanEffort: 'xhigh' }, { sdk: fakeSdk([init(), reply('PONG'), ok('PONG')], seen), env: { ANTHROPIC_API_KEY: 'sk-live', ANTHROPIC_BASE_URL: 'http://x', CLAUDE_CODE_USE_BEDROCK: '1', PATH: 'p' } });
    const r = await chat(msgs, null, { cwd: TMP });
    check('a plan call returns the reply text and the provider usage', r.content === 'PONG' && r.usage?.providerUsage?.cache_read_input_tokens === 100 && r.requestUsages.length === 1 && r.truncated === false,
      { happened: JSON.stringify(r), why: 'The loop reads content and counts tokens from these fields.', fix: 'Collect assistant text blocks and map result.usage.' });
    const o = seen.options || {};
    check('Claude Code runs no tool, setting, plugin, MCP server or session of its own: one turn only', Array.isArray(o.tools) && o.tools.length === 0 && o.allowedTools.length === 0 && o.settingSources.length === 0 && o.plugins.length === 0 && o.strictMcpConfig === true && Object.keys(o.mcpServers).length === 0 && o.maxTurns === 1 && o.persistSession === false,
      { happened: JSON.stringify({ ...o, env: undefined, abortController: undefined }), why: 'Gev: Atlias runs itself; Claude Code must not run the task in its own loop.', fix: 'Keep planOptions tools [], settingSources [], maxTurns 1.' });
    check('the chosen model and effort are sent', o.model === 'claude-opus-5-5' && o.effort === 'xhigh', { happened: `${o.model} ${o.effort}`, why: 'Opus 5.5 defaults to medium effort unless one is set.', fix: 'Pass cfg.claudePlanEffort as effort.' });
    check('no API key, base URL or cloud-provider switch reaches the SDK process', !('ANTHROPIC_API_KEY' in o.env) && !('ANTHROPIC_BASE_URL' in o.env) && !('CLAUDE_CODE_USE_BEDROCK' in o.env) && o.env.PATH === 'p' && /^atlias\//.test(o.env.CLAUDE_AGENT_SDK_CLIENT_APP),
      { happened: JSON.stringify(o.env), why: 'An API key in the environment would bill an API account instead of the plan.', fix: 'Build env with cleanEnv.' });
    check('a call with no interactive flag asks for the 5-minute cache', o.env.CLAUDE_CODE_PROMPT_CACHE_TTL === '5m', { happened: String(o.env.CLAUDE_CODE_PROMPT_CACHE_TTL), why: 'exec and sub-agent calls come seconds apart', fix: 'claudePlanChat passes at.interactive to planOptions' });
    const seenLive = {};
    await plan.claudePlanChat({}, { sdk: fakeSdk([init(), reply('x'), ok('x')], seenLive), env: { PATH: 'p' } })(msgs, null, { cwd: TMP, interactive: true });
    check('an interactive call leaves the CLI 1-hour default in place', Boolean(seenLive.options) && !('CLAUDE_CODE_PROMPT_CACHE_TTL' in seenLive.options.env),
      { happened: JSON.stringify(seenLive.options && seenLive.options.env), why: 'a person may pause past 5 minutes; the whole conversation would be written again', fix: 'claudePlanChat passes at.interactive to planOptions' });
    check('Atlias\'s system prompt is the whole system prompt, with the transcript note', o.systemPrompt.startsWith('SYSTEM RULES') && o.systemPrompt.endsWith(plan.TRANSCRIPT_NOTE),
      { happened: o.systemPrompt, why: 'Atlias\'s own text tools are described there.', fix: 'Use systemText.' });

    const api = await plan.claudePlanChat({}, { sdk: fakeSdk([init('ANTHROPIC_API_KEY'), reply('x'), ok('x')]) })(msgs, null, {});
    check('a call whose credential is an API key is refused and its reply is never used', /refused/.test(api.error || '') && !api.content,
      { happened: JSON.stringify(api), why: 'Gev: the plan, never the API.', fix: 'Abort when init.apiKeySource is not none.' });
    const console = await plan.claudePlanChat({}, { sdk: fakeSdk([init('/login managed key'), ok('x')]) })(msgs, null, {});
    check('a Console login (an API account) is refused too', /refused/.test(console.error || ''), { happened: JSON.stringify(console), why: 'A /login managed key bills the API.', fix: 'Accept only apiKeySource none.' });
    const early = await plan.claudePlanChat({}, { sdk: fakeSdk([reply('early'), init(), ok('early')]) })(msgs, null, {});
    check('a reply that arrives before the credential source is refused', /before reporting/.test(early.error || '') && !early.content, { happened: JSON.stringify(early), why: 'The source must be known before any text is used.', fix: 'Refuse assistant messages before init.' });
    const failed = await plan.claudePlanChat({}, { sdk: fakeSdk([init(), { type: 'result', subtype: 'error_during_execution', is_error: true, api_error_status: 429, result: 'rate limited' }]) })(msgs, null, {});
    check('a failed call is an error with its status, never a silent empty answer', /HTTP 429/.test(failed.error || '') && failed.content === undefined, { happened: JSON.stringify(failed), why: 'The loop stops on errors and says why.', fix: 'Map is_error results to error.' });
    const cut = await plan.claudePlanChat({}, { sdk: fakeSdk([init(), reply('half'), ok('half', { stop_reason: 'max_tokens' })]) })(msgs, null, {});
    check('a reply cut at the output limit is marked truncated', cut.truncated === true && cut.finish === 'max_tokens', { happened: JSON.stringify(cut), why: 'The loop never runs tool calls from a cut reply.', fix: 'Set truncated from stop_reason.' });
    const none = await plan.claudePlanChat({}, { root: temp('empty') })(msgs, null, {});
    check('with no SDK installed the call says how to set it up and tries nothing else', /not installed/.test(none.error || '') && /atlias setup claude/.test(none.error), { happened: JSON.stringify(none), why: 'Never a silent fallback to another route.', fix: 'Throw from loadSdk with SETUP_COMMAND.' });
  });

  suite('claude plan expert', 'claude-plan helpers: transcript, status, install and sign-in', () => {
    const blocks = plan.transcript(msgs);
    check('the transcript is one labelled block per non-system message, in order', blocks.length === 3 && blocks[0].text === '[user]\nfix it' && blocks[1].text.startsWith('[assistant]') && blocks[2].text.startsWith('[tool result]'),
      { happened: JSON.stringify(blocks), why: 'Separate blocks keep the shared prefix cacheable.', fix: 'Check transcript.' });
    check('systemText appends the note even with no system message', plan.systemText([{ role: 'user', content: 'x' }]) === plan.TRANSCRIPT_NOTE, { happened: plan.systemText([]), why: 'The model must know the layout.', fix: 'Check systemText.' });
    const stable = plan.planOptions({}, { system: 's', env: { HOME: 'h' } }).env;
    check('each call turns off the git status snapshot, CLAUDE.md files and attachments', stable.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS === '1' && stable.CLAUDE_CODE_DISABLE_CLAUDE_MDS === '1' && stable.CLAUDE_CODE_DISABLE_ATTACHMENTS === '1' && stable.CLAUDE_CODE_PROMPT_CACHE_TTL === '5m' && stable.HOME === 'h',
      { happened: JSON.stringify(stable), why: 'Each call is a new CLI process; a git status taken again after an edit sits before the transcript and voids its cache.', fix: 'Merge STABLE_PREFIX_ENV into planOptions env.' });
    const live = plan.planOptions({}, { system: 's', env: { HOME: 'h' }, interactive: true }).env;
    const own = plan.planOptions({}, { system: 's', env: { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }, interactive: false }).env;
    check('an interactive turn keeps the 1-hour default; a one-shot call asks for 5 minutes over any inherited value', !('CLAUDE_CODE_PROMPT_CACHE_TTL' in live) && live.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS === '1' && own.CLAUDE_CODE_PROMPT_CACHE_TTL === '5m',
      { happened: JSON.stringify({ live, own }), why: 'Gev: 26% of prompts came 5-60 minutes after the last event; a 5-minute entry is gone by then and the whole conversation is written again.', fix: 'planOptions: ONE_SHOT_TTL_ENV only when not interactive.' });
    const env = plan.cleanEnv({ anthropic_api_key: 'lower', ANTHROPIC_AUTH_TOKEN: 't', HOME: 'h' });
    check('cleanEnv drops blocked names in any case and keeps the rest', !('anthropic_api_key' in env) && !('ANTHROPIC_AUTH_TOKEN' in env) && env.HOME === 'h', { happened: JSON.stringify(env), why: 'Windows environment names are case-insensitive.', fix: 'Compare upper-cased names.' });
    const opts = plan.planOptions({ claudePlanEffort: 'model' }, { system: 's' });
    check('effort "model" sends none and the default model is Opus 5.5', !('effort' in opts) && opts.model === 'claude-opus-5-5', { happened: JSON.stringify({ model: opts.model, effort: opts.effort }), why: 'model means the provider default.', fix: 'Only send a listed effort.' });
    check('parsePlanStatus: a claude.ai login is a plan; a Console login is not', plan.parsePlanStatus({ status: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai","email":"secret@x"}' }).plan === true
      && plan.parsePlanStatus({ status: 0, stdout: '{"loggedIn":true,"authMethod":"console"}' }).plan === false && plan.parsePlanStatus({ status: 1, stdout: '' }).authenticated === false
      && !JSON.stringify(plan.parsePlanStatus({ status: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai","email":"secret@x"}' })).includes('secret'),
      { happened: 'see parsePlanStatus', why: 'Only booleans may leave; an account e-mail must not.', fix: 'Return { authenticated, plan } only.' });
    const root = temp('runtime');
    check('prepared is false until the pinned SDK version is on disk', plan.prepared({ root }) === false && plan.binaryPath({ root }) === null, { happened: 'prepared on an empty folder', why: 'A half install must not count as ready.', fix: 'Check package.json version and sdk.mjs.' });
    const calls = [];
    const fakeInstall = (file, args) => { calls.push([file, ...args]); const dir = path.join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: plan.SDK_VERSION })); fs.writeFileSync(path.join(dir, 'sdk.mjs'), ''); const bin = path.join(root, 'node_modules', '@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`); fs.mkdirSync(bin, { recursive: true }); fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'claude.exe' : 'claude'), ''); return { status: 0 }; };
    const done = plan.prepare({ root, npm: { file: 'npm-x', args: ['cli.js'] }, spawn: fakeInstall });
    check('prepare installs the exact pinned SDK into its own folder and then reports ready', done.ok && calls[0].includes(`${plan.SDK_PACKAGE}@${plan.SDK_VERSION}`) && calls[0].includes('--prefix') && plan.prepared({ root }) && plan.binaryPath({ root }),
      { happened: JSON.stringify(calls), why: 'A floating version could change the protocol under Atlias.', fix: 'Install SDK_PACKAGE@SDK_VERSION with --prefix.' });
    const viaCli = plan.npmCommand({ execPath: 'C:/node/node.exe', env: {}, exists: (p) => /npm-cli\.js$/.test(p) && p.includes('node_modules') });
    const viaEnv = plan.npmCommand({ execPath: 'N', env: { npm_execpath: 'X/npm-cli.js' }, exists: () => true });
    const bare = plan.npmCommand({ execPath: 'N', env: {}, exists: () => false, platform: 'win32' });
    check('npmCommand runs npm-cli.js under this Node (no shell, no .cmd shim), and names npm.cmd only as a last resort', viaCli.file === 'C:/node/node.exe' && /npm-cli\.js$/.test(viaCli.args[0]) && viaEnv.args[0] === 'X/npm-cli.js' && bare.file === 'npm.cmd',
      { happened: JSON.stringify({ viaCli, viaEnv, bare }), why: 'Node refuses to spawn npm.cmd without a shell, so the one-key install failed on Windows.', fix: 'Prefer npm_execpath, then npm-cli.js beside process.execPath.' });
    const statusCalls = [];
    const st = plan.planStatus({ root, env: { ANTHROPIC_API_KEY: 'k' }, spawn: (file, args, o) => { statusCalls.push({ args, env: o.env }); return { status: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai"}' }; } });
    check('planStatus asks the SDK\'s own binary, without an API key in its environment', st.plan === true && statusCalls[0].args.join(' ') === 'auth status --json' && !('ANTHROPIC_API_KEY' in statusCalls[0].env),
      { happened: JSON.stringify(statusCalls), why: 'The status must describe the login the SDK will use.', fix: 'Spawn binaryPath with cleanEnv.' });
    let loginArgs = null;
    const lg = plan.planLogin({ root, spawn: (file, args, o) => { loginArgs = { args, stdio: o.stdio }; return { status: 0 }; } });
    check('planLogin runs Anthropic\'s own Claude-plan sign-in in this terminal', lg.started && lg.exitCode === 0 && loginArgs.args.join(' ') === 'auth login --claudeai' && loginArgs.stdio === 'inherit',
      { happened: JSON.stringify(loginArgs), why: 'Sign-in must complete through Anthropic\'s own flow, and --claudeai picks the plan, not Console billing.', fix: 'Spawn auth login --claudeai with stdio inherit.' });
  });

  await asyncSuite('claude plan expert', 'engines, effort and the host-harness switch', async () => {
    check('claude-plan is a direct engine with its own model and effort settings', engines.DIRECT_ENGINES.includes('claude-plan') && engines.MODEL_KEYS['claude-plan'] === 'claudePlanModel' && engines.EFFORT_KEYS['claude-plan'] === 'claudePlanEffort',
      { happened: JSON.stringify(engines.EFFORT_KEYS), why: 'The loop, /model and /effort read these maps.', fix: 'Register claude-plan in engines.mjs.' });
    const d = engines.describeEngine('claude-plan', { claudePlanModel: 'claude-opus-5-5', claudePlanEffort: 'xhigh' });
    check('the engine line names the model, the effort and the plan billing', d.model === 'claude-opus-5-5' && d.reasoning === 'xhigh' && /Claude plan/.test(d.billing) && d.execution === 'direct; Atlias loop',
      { happened: JSON.stringify(d), why: 'Gev: the effort must show in the UI.', fix: 'Read EFFORT_KEYS in describeEngine.' });
    check('Anthropic API effort shows too, and "model" reads as the provider default', engines.describeEngine('anthropic', { anthropicEffort: 'high' }).reasoning === 'high' && engines.describeEngine('anthropic', { anthropicEffort: 'model' }).reasoning === 'provider default',
      { happened: 'describeEngine anthropic', why: 'Every engine with an effort shows it.', fix: 'Map anthropicEffort.' });
    check('host harnesses are off by default and on only when set', core.DEFAULTS.agent.hostEngines === 'off' && engines.hostEnginesAllowed({}) === false && engines.hostEnginesAllowed({ hostEngines: 'on' }) === true,
      { happened: core.DEFAULTS.agent.hostEngines, why: 'Gev: Atlias runs the model itself and never hands the task to a host CLI.', fix: 'Default agent.hostEngines to off.' });
    const before = core.config().agent.hostEngines;
    settings.set('agent.hostEngines', 'off');
    try {
      const st = agentMod.newState(temp('host'), 'claude');
      let spawned = false;
      const r = await agentMod.turn(st, 'hello', null, null, { run: () => { spawned = true; return { status: 0, stdout: 'x' }; } });
      check('with host harnesses off a saved claude engine is refused, says what to do, and runs nothing', /host harness is off/.test(r) && /claude-plan/.test(r) && !spawned,
        { happened: r, why: 'A saved engine from an older version must not silently run Claude Code.', fix: 'Return HOST_OFF in engineTurn.' });
      check('pickEngine will not select a host harness while they are off', agentMod.pickEngine('claude') === null && agentMod.pickEngine('codex') === null, { happened: String(agentMod.pickEngine('claude')), why: 'Launch and exec go through pickEngine.', fix: 'Gate host engines in pickEngine.' });
      const out = [];
      await commands.dispatch('/engine codex', { state: agentMod.newState(temp('slash'), 'echo'), cwd: TMP, out: (t) => out.push(t), ask: async () => '', api: agentMod.slashApi });
      check('/engine refuses a host harness while they are off and names the plan route', /host harness is off/.test(out.join(' ')) && /claude-plan/.test(out.join(' ')), { happened: out.join(' '), why: 'The person must learn the right route, not a bare refusal.', fix: 'Check the /engine entry.' });
    } finally { settings.set('agent.hostEngines', before); }
    const prevEffort = core.config().agent.claudePlanEffort;
    try {
      const out = [];
      const ctx = { state: agentMod.newState(temp('effort'), 'claude-plan'), cwd: TMP, out: (t) => out.push(t), ask: async () => '', api: agentMod.slashApi };
      await commands.dispatch('/effort', ctx);
      await commands.dispatch('/effort max', ctx);
      const saved = core.config().agent.claudePlanEffort;
      await commands.dispatch('/effort turbo', ctx);
      check('/effort shows the current effort with its choices, saves a valid one and refuses an invalid one', /effort /.test(out[0]) && /xhigh/.test(out[0]) && saved === 'max' && core.config().agent.claudePlanEffort === 'max' && /not one of/.test(out[2]),
        { happened: JSON.stringify(out), why: 'Gev: the person chooses the effort from the UI.', fix: 'Check the /effort entry.' });
      const none = [];
      await commands.dispatch('/effort', { ...ctx, state: agentMod.newState(temp('effort2'), 'ollama'), out: (t) => none.push(t) });
      check('/effort says when an engine takes no effort', /takes no reasoning effort/.test(none[0]), { happened: none.join(' '), why: 'No silent no-op.', fix: 'Check EFFORT_KEYS lookup.' });
    } finally { settings.set('agent.claudePlanEffort', prevEffort); }
    const authOut = [];
    await authCommand('claude-plan status', { out: (t) => authOut.push(t), api: { claudePlan: { prepared: () => true, planStatus: () => ({ authenticated: true, plan: false }), SETUP_COMMAND: plan.SETUP_COMMAND } } });
    check('/auth claude-plan status says a Console login is refused, without reading credentials', /Console/.test(authOut[0]) && /refuses/.test(authOut[0]), { happened: authOut.join(' '), why: 'The person must see why the route will not run.', fix: 'Check authCommand claude-plan.' });
    const helpers = agentMod.setupHelpers({ spawn: () => ({ status: 0 }) });
    check('setupHelpers gives first-open its installers, each a visible command', typeof helpers.prepareChatGPT === 'function' && helpers.pullOllama('m') === true && typeof helpers.resolve === 'function',
      { happened: Object.keys(helpers).join(','), why: 'Seamless setup offers installs instead of naming commands.', fix: 'Return the installers from setupHelpers.' });
  });

  await asyncSuite('first-open onboarding expert', 'first-open finds what is set up and makes the Claude plan one key', async () => {
    const fakePlan = (state) => ({ ...plan, prepared: () => state.prepared, prepare: () => { state.installs++; state.prepared = true; return { ok: true, exitCode: 0 }; },
      planStatus: () => ({ authenticated: state.signedIn, plan: state.signedIn }), planLogin: () => { state.logins++; state.signedIn = true; return { started: true, exitCode: 0 }; }, runtimeRoot: () => 'R' });
    const found = await onboarding.detectRoutes({ claudePlan: fakePlan({ prepared: true, signedIn: true }), isChatGPTPrepared: () => false, fetchImpl: async () => ({ ok: true, json: async () => ({ models: [{ name: 'q' }] }) }), env: { GEMINI_API_KEY: 'g' } });
    check('detectRoutes reports the Claude sign-in, Ollama models and key names as booleans only', found.claudePlan === true && found.ollama === true && found.gemini === true && found.anthropic === false && Object.values(found).every((v) => typeof v === 'boolean'),
      { happened: JSON.stringify(found), why: 'Only readiness may leave detection.', fix: 'Check detectRoutes.' });
    check('recommended picks the Claude plan first, then ChatGPT, keys, Ollama', onboarding.recommended(found) === '1' && onboarding.recommended({ chatgpt: true }) === '2' && onboarding.recommended({ ollama: true }) === '3' && onboarding.recommended({}) === '1',
      { happened: onboarding.recommended(found), why: 'Enter must take the route that works now.', fix: 'Check recommended.' });
    const text = onboarding.welcomeText(found, { hostEngines: 'off' });
    const narrow = onboarding.welcomeText(found, { hostEngines: 'off' }, 80).split(String.fromCharCode(10));
    check('on an 80-column terminal every onboarding line fits and no word is split', narrow.every((l) => l.length < 80) && narrow.some((l) => /^ {3}\S/.test(l)) && narrow.join(' ').includes('(recommended)'),
      { happened: narrow.filter((l) => l.length >= 80).join(' | '), why: 'Gev saw (rec / ommended) when the terminal broke the line itself (Computer Use check 2026-10-23)', fix: 'wrapChoice in onboarding.mjs' });
    check('the welcome says what was found, marks the recommended row, and hides host harnesses while they are off', /Found on this computer: your Claude sign-in/.test(text) && /1 {2}Use my Claude plan.*\(recommended\)/.test(text) && !/native host/.test(text),
      { happened: text, why: 'A new user should press Enter, not read nine options.', fix: 'Check welcomeText and visibleChoices.' });
    const rows = text.split(String.fromCharCode(10));
    check('beginners see the sign-ins and the local model first, API keys under their own line, and no engine jargon',
      rows.findIndex((l) => /^Have an API key\?/.test(l)) === rows.findIndex((l) => /^4 {2}/.test(l)) - 1 && rows.findIndex((l) => /^Have an API key\?/.test(l)) > rows.findIndex((l) => /^3 {2}/.test(l))
        && !/direct loop|local inference|Responses API;|Messages API;|plan authorization/.test(text) && (text.match(/Press Enter/g) || []).length === 1,
      { happened: text, why: 'Gev 2026-10-24: make the UI simpler for beginner vibe coders.', fix: 'Keep the CHOICES details in plain words and the API-key line in welcomeText.' });
    check('host rows appear only when host harnesses are on', onboarding.visibleChoices({ hostEngines: 'on' }).some((r) => r.method === 'claude') && !onboarding.visibleChoices({ hostEngines: 'off' }).some((r) => r.host),
      { happened: 'visibleChoices', why: 'The setting decides what is offered.', fix: 'Filter host rows.' });
    const prev = { engine: core.config().agent.engine, model: core.config().agent.claudePlanModel, effort: core.config().agent.claudePlanEffort };
    try {
      const state = { prepared: false, signedIn: false, installs: 0, logins: 0 };
      const answers = ['', 'y', 'y', '', ''];
      const lines = [];
      const row = await onboarding.firstOpen({ file: path.join(temp('fo'), 'o.json'), ask: async () => answers.shift(), out: (l) => lines.push(l), claudePlan: fakePlan(state), isChatGPTPrepared: () => false, fetchImpl: async () => { throw Error('offline'); } });
      check('Enter on a fresh computer installs the SDK, signs in through Anthropic, and selects claude-plan at xhigh', row.status === 'complete' && row.method === 'claude-plan' && state.installs === 1 && state.logins === 1 && core.config().agent.engine === 'claude-plan' && row.details.effort === 'xhigh' && row.details.model === 'claude-opus-5-5',
        { happened: JSON.stringify({ row, state, lines }), why: 'Gev: setup must be seamless for anybody.', fix: 'Check configureClaudePlan.' });
      const declineAnswers = ['1', 'n'];
      const declined = await onboarding.firstOpen({ file: path.join(temp('fo'), 'o.json'), ask: async () => declineAnswers.shift(), out: () => {}, claudePlan: fakePlan({ prepared: false, signedIn: false, installs: 0, logins: 0 }), detect: false, isChatGPTPrepared: () => false });
      check('declining the install stays deferred and selects nothing', declined.status === 'deferred' && declined.verification === 'sdk_install_skipped',
        { happened: JSON.stringify(declined), why: 'No route may be chosen for the person.', fix: 'Return deferred on a declined install.' });
      const noLogin = { ...fakePlan({ prepared: true, signedIn: false, installs: 0, logins: 0 }), planLogin: () => ({ started: true, exitCode: 1 }) };
      const failedLogin = await onboarding.setupClaudePlan({ ask: async () => 'y', out: () => {}, claudePlan: noLogin });
      check('a sign-in that does not reach a Claude plan stays deferred and selects nothing', failedLogin.status === 'deferred' && failedLogin.verification === 'plan_sign_in_unverified',
        { happened: JSON.stringify(failedLogin), why: 'An unfinished or Console sign-in must never unlock the plan route.', fix: 'Re-check planStatus after planLogin and defer when it is not a plan.' });
      const badEffort = await onboarding.setupClaudePlan({ ask: (() => { const a = ['', 'turbo']; return async () => a.shift(); })(), out: () => {}, claudePlan: fakePlan({ prepared: true, signedIn: true, installs: 0, logins: 0 }) });
      check('an effort outside the list changes nothing and stays deferred', badEffort.status === 'deferred' && badEffort.verification === 'invalid_effort',
        { happened: JSON.stringify(badEffort), why: 'Only listed efforts are sent.', fix: 'Validate effort before saving.' });
    } finally { settings.set('agent.engine', prev.engine); settings.set('agent.claudePlanModel', prev.model); settings.set('agent.claudePlanEffort', prev.effort); }
  });
}

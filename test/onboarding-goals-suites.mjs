import * as onboarding from '../lib/onboarding.mjs';
import * as goals from '../lib/goals.mjs';
import * as commands from '../lib/commands.mjs';
import * as settings from '../lib/settings.mjs';
import * as copy from '../lib/selection-copy.mjs';
import * as auth from '../lib/auth-command.mjs';
import { offerClaudeForTests } from '../lib/edition.mjs';

export default async function onboardingGoalsSuites({ asyncSuite, suite, check, core, agentMod, TMP, fs, path }) {
  let sequence = 0;
  const temp = (name) => {
    const dir = path.join(TMP, 'onboarding-goals', `${name}-${++sequence}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body, body: { cancel: async () => {} } });

  await asyncSuite('first-open onboarding expert', 'first-open provider choices, deferred setup and local Ollama verification', async () => {
    const previous = Object.fromEntries(['engine', 'ollamaUrl', 'ollamaModel', 'chatgptModel', 'chatgptReasoningEffort', 'openaiUrl', 'openaiModel'].map((key) => [key, core.config().agent[key]]));
    const welcome = onboarding.welcomeText();
    check('the first-open screen explicitly offers ChatGPT, every direct API billing route, Ollama and set up later',
      /Sign in with ChatGPT/.test(welcome) && /OpenAI API/.test(welcome) && /Google Gemini API/.test(welcome) && /OpenAI-compatible API endpoint/.test(welcome) && /Local models with Ollama/.test(welcome) && /Set up later/.test(welcome),
      { happened: welcome, why: 'A first install must show actionable choices without hiding billing differences.', fix: 'Render CHOICES from welcomeText.' });
    check('the first-open route list contains every explicit provider and host choice exactly once',
      onboarding.CHOICES.length === 11 && new Set(onboarding.CHOICES.map((choice) => choice.method)).size === 11
        && ['claude-plan', 'chatgpt', 'responses', 'anthropic', 'gemini', 'openai', 'ollama', 'claude', 'codex', 'antigravity', 'later'].every((method) => onboarding.CHOICES.some((choice) => choice.method === method)),
      { happened: JSON.stringify(onboarding.CHOICES.map((choice) => choice.method)), why: 'The visible menu and routed methods must not drift apart.', fix: 'Keep one explicit row for each supported or clearly unsupported route.' });

    const localFile = path.join(temp('state'), 'onboarding.json');
    const prompts = ['Local models with Ollama', 'http://127.0.0.1:11434', 'qwen-local:latest'];
    let probes = 0;
    let localInstructions = '';
    const local = await onboarding.firstOpen({ detect: false, file: localFile, ask: async () => prompts.shift(), out: (line) => { localInstructions += line + '\n'; }, fetchImpl: async (url, options) => {
      probes++;
      check('Ollama setup gives install, start, pull, select and non-inference connection-check instructions',
        /ollama\.com\/download/.test(localInstructions) && /ollama pull <model>/.test(localInstructions) && /GET \/api\/tags/.test(localInstructions) && /no inference/i.test(localInstructions),
        { happened: JSON.stringify({ url: String(url), options }), why: 'The complete local setup must lead from installation through a selected installed model.', fix: 'Show the Ollama instructions and use only GET /api/tags.' });
      check('the local readiness check is GET /api/tags with no request body', options.method === 'GET' && new URL(url).pathname === '/api/tags' && options.body === undefined,
        { happened: JSON.stringify({ url: String(url), options }), why: 'A connection check must not spend tokens or run inference.', fix: 'Call the local tags listing endpoint only.' });
      return response({ models: [{ name: 'qwen-local:latest' }] });
    } });
    check('the requested local-model wording selects Ollama and completes only after the exact model is listed',
      local.status === 'complete' && local.method === 'ollama' && local.verification === 'tags_verified' && core.config().agent.engine === 'ollama' && probes === 1,
      { happened: JSON.stringify({ local, probes }), why: 'The record and engine must match what Ollama actually reported.', fix: 'Require the selected model name in the tags response.' });
    check('the persistent record is versioned and contains no credential material',
      onboarding.readOnboarding(localFile)?.schema === 'atlias.onboarding.v1' && !/token|secret|api.?key/i.test(fs.readFileSync(localFile, 'utf8')),
      { happened: fs.readFileSync(localFile, 'utf8'), why: 'Provider setup state is not a credential store.', fix: 'Persist only provider name, verification and non-secret configuration.' });
    let askedAgain = false;
    const repeated = await onboarding.firstOpen({ detect: false, file: localFile, ask: async () => { askedAgain = true; return ''; }, out: () => {} });
    check('a verified first-open setup persists across starts', repeated.status === 'complete' && repeated.method === 'ollama' && !askedAgain,
      { happened: JSON.stringify({ repeated, askedAgain }), why: 'A configured install should not re-run its first-open wizard.', fix: 'Read the onboarding record before asking.' });

    const missingFile = path.join(temp('state'), 'missing-model.json');
    const activeLocal = JSON.stringify(['engine', 'ollamaUrl', 'ollamaModel'].map(key => core.config().agent[key]));
    const missingAnswers = ['3', 'http://127.0.0.1:11436', 'not-installed:latest'];
    let missingInstructions = '';
    const missing = await onboarding.firstOpen({ detect: false, file: missingFile, ask: async () => missingAnswers.shift(), out: (line) => { missingInstructions += line + '\n'; }, fetchImpl: async () => response({ models: [{ name: 'other:latest' }] }) });
    check('a reachable Ollama server without the selected model remains deferred and shows the pull step',
      missing.status === 'deferred' && missing.verification === 'model_not_installed' && /ollama pull not-installed:latest/.test(missingInstructions) && /No inference was run/.test(missingInstructions),
      { happened: JSON.stringify(missing), why: 'Reachability is not model readiness and a failed setup cannot be marked complete.', fix: 'Return deferred and tell the user to pull the exact selected model.' });
    check('an unavailable local model stays a setup draft and preserves the working connection',
      activeLocal === JSON.stringify(['engine', 'ollamaUrl', 'ollamaModel'].map(key => core.config().agent[key])) && missing.details.endpoint === 'http://127.0.0.1:11436' && missing.details.model === 'not-installed:latest',
      { happened: JSON.stringify({ missing, agent: core.config().agent }), why: 'Selecting an absent model must not break a working local connection.', fix: 'Save active Ollama settings only after the exact installed model is verified.' });
    const offlineAnswers = ['3', 'http://127.0.0.1:11437', 'offline:latest'];
    const offline = await onboarding.firstOpen({ detect: false, file: path.join(temp('state'), 'offline-ollama.json'), ask: async () => offlineAnswers.shift(), out: () => {}, fetchImpl: async () => { throw Error('offline fixture'); } });
    check('an unreachable local endpoint preserves active settings and records the candidate separately',
      offline.status === 'deferred' && offline.verification === 'connection_unverified' && offline.details.endpoint === 'http://127.0.0.1:11437' && activeLocal === JSON.stringify(['engine', 'ollamaUrl', 'ollamaModel'].map(key => core.config().agent[key])),
      { happened: JSON.stringify(offline), why: 'A failed connectivity check is not permission to replace a working endpoint.', fix: 'Persist only the deferred setup record on failure.' });
    let resumeNotice = '';
    await onboarding.firstOpen({ detect: false, file: missingFile, ask: async () => { throw Error('deferred state must not silently restart'); }, out: (line) => { resumeNotice += line; } });
    check('later first opens show the deferred reason and /onboarding recovery path', /remains deferred/.test(resumeNotice) && /\/onboarding/.test(resumeNotice),
      { happened: resumeNotice, why: 'An incomplete setup must remain visible and have a clear recovery command.', fix: 'Print the persisted deferred status and resume path.' });
    let unsafeCalls = 0;
    const unsafe = await onboarding.checkOllamaTags('http://user:private@localhost:11434?key=hidden#fragment', async () => { unsafeCalls++; return response({ models: [] }); });
    check('Ollama URL validation rejects userinfo, query parameters and fragments before network access', !unsafe.ok && unsafeCalls === 0 && /without credentials/.test(unsafe.error),
      { happened: JSON.stringify({ unsafe, unsafeCalls }), why: 'A local diagnostic must not forward credential-like URL data.', fix: 'Validate the endpoint before constructing the GET request.' });

    const chatFile = path.join(temp('state'), 'chatgpt.json');
    let authCalls = 0, modelCalls = 0, validated = '';
    const chatEngine = {
      session: async () => (++authCalls === 1 ? { status: 'disconnected', sharing: false } : { status: 'connected', sharing: true }),
      login: async () => ({ status: 'connected', sharing: true }),
      models: async () => { modelCalls++; return [{ slug: 'gpt-6.1-sol', displayName: 'GPT 6.1 Sol' }]; },
      validate: async (model, effort) => { validated = `${model}/${effort}`; },
    };
    const chatAnswers = ['2', 'yes'];
    const chat = await onboarding.firstOpen({ detect: false, file: chatFile, ask: async () => chatAnswers.shift(), out: () => {}, chatgptEngine: chatEngine, isChatGPTPrepared: () => true });
    check('ChatGPT first-open calls Atlias Personal sign-in, verifies account and requested model, and does not fall back',
      chat.status === 'complete' && chat.method === 'chatgpt' && chat.verification === 'plan_authorized_model_verified' && modelCalls === 1 && validated === 'gpt-6.1-sol/xhigh' && core.config().agent.engine === 'chatgpt',
      { happened: JSON.stringify({ chat, authCalls, modelCalls, validated }), why: 'The direct ChatGPT engine must be wired to its own SDK and preserve the explicitly requested model and effort.', fix: 'Use the plan engine session/login/models/validate flow with no substitute.' });

    const claudeFile = path.join(temp('state'), 'claude-native.json');
    let nativeLogins = 0, nativeChecks = 0, nativeCopy = '';
    const claudeAnswers = ['9', 'yes'];
    // The claude host is a founders-edition route (Gev, 2026-10-30); test/edition-suites.mjs checks the release refuses it.
    const asFounders = async (fn) => { offerClaudeForTests(true); try { return await fn(); } finally { offerClaudeForTests(false); } };
    const claude = await asFounders(() => onboarding.firstOpen({ detect: false, file: claudeFile, ask: async () => claudeAnswers.shift(), out: (line) => { nativeCopy += line; },
      nativeAuthStatus: async (provider) => (++nativeChecks === 1 ? { available: true, authenticated: false, subscription: false } : { available: provider === 'claude', authenticated: true, subscription: true }),
      nativeLogin: async (provider) => { if (provider === 'claude') nativeLogins++; return { started: true, exitCode: 0 }; } }));
    check('Claude subscription setup uses only its native CLI status and login and labels billing as native-owned',
      claude.status === 'complete' && claude.method === 'claude' && nativeLogins === 1 && nativeChecks === 2 && /unmodified CLI owns sign-in/.test(nativeCopy) && /did not inspect credentials/.test(nativeCopy),
      { happened: JSON.stringify({ claude, nativeLogins, nativeChecks, nativeCopy }), why: 'The supported subscription path stays inside the actual Claude Code CLI and cannot imply Atlias SDK token relay.', fix: 'Use the native login command and status booleans only.' });
    const failedAnswers = ['9', 'yes'];
    const failedClaude = await asFounders(() => onboarding.firstOpen({ detect: false, file: path.join(temp('state'), 'claude-cancel.json'), ask: async () => failedAnswers.shift(), out: () => {},
      nativeAuthStatus: async () => ({ available: true, authenticated: false, subscription: false }), nativeLogin: async () => ({ started: true, exitCode: 1 }) }));
    check('a native CLI login that does not authenticate stays deferred', failedClaude.status === 'deferred' && failedClaude.verification === 'native_sign_in_unverified',
      { happened: JSON.stringify(failedClaude), why: 'An unsuccessful sign-in cannot unlock the selected host.', fix: 'Require a verified native auth status before marking setup complete.' });

    const unavailableFile = path.join(temp('state'), 'chatgpt-unprepared.json');
    let unexpectedlyLoggedIn = false;
    const unavailable = await onboarding.firstOpen({ detect: false, file: unavailableFile, ask: async () => '2', out: () => {}, chatgptEngine: { login: async () => { unexpectedlyLoggedIn = true; } }, isChatGPTPrepared: () => false });
    check('an unprepared local ChatGPT runtime stays deferred and never pretends sign-in happened', unavailable.status === 'deferred' && unavailable.verification === 'personal_runtime_missing' && !unexpectedlyLoggedIn,
      { happened: JSON.stringify({ unavailable, unexpectedlyLoggedIn }), why: 'The parent owns SDK installation and no grant can be invented before it exists.', fix: 'Give the local preparation command and keep onboarding deferred.' });

    const cancelledFile = path.join(temp('state'), 'cancelled.json');
    const cancelled = await onboarding.firstOpen({ detect: false, file: cancelledFile, ask: async () => null, out: () => {} });
    check('cancelled first-open setup persists as deferred rather than complete', cancelled.status === 'deferred' && cancelled.verification === 'cancelled' && onboarding.readOnboarding(cancelledFile).status === 'deferred',
      { happened: JSON.stringify(cancelled), why: 'Escape, EOF or a cancelled prompt cannot certify a provider.', fix: 'Catch explicit cancellation and persist only a deferred record.' });
    check('a deferred or absent marker blocks inherited provider selection while explicit diagnostics remain available',
      onboarding.requiresFirstOpen(null) && onboarding.requiresFirstOpen(cancelled) && !onboarding.requiresFirstOpen({ status: 'complete' })
        && !onboarding.requiresFirstOpen(cancelled, { engine: 'echo' }) && !onboarding.requiresFirstOpen(cancelled, { engine: 'codex' })
        && onboarding.requiresFirstOpen(cancelled, { resume: true }) && onboarding.requiresFirstOpen(cancelled, { once: true }),
      { happened: JSON.stringify([onboarding.requiresFirstOpen(null), onboarding.requiresFirstOpen(cancelled), onboarding.requiresFirstOpen(cancelled, { engine: 'codex' }), onboarding.requiresFirstOpen(cancelled, { resume: true })]), why: 'A first-run cancel or resume cannot silently route through a saved Codex host; only an explicit engine selection may proceed.', fix: 'Gate implicit selection on a complete first-open record.' });
    const resumed = agentMod.resolveLaunchEngine({ engine: 'codex', messages: [{ role: 'user', content: 'prior prompt' }] }, { resume: true }, cancelled, () => 'codex');
    check('the actual launch resolver replaces a resumed stale Codex engine with setup when onboarding is deferred', resumed.blocked && resumed.selected === null && resumed.engine === 'setup',
      { happened: JSON.stringify(resumed), why: 'A blocked first-open prompt is ineffective if the loaded session still reaches its previous provider.', fix: 'Resolve the launch engine to setup before restoring a deferred session.' });

    const keyFile = path.join(temp('state'), 'api.json');
    const prior = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'fixture-private-key';
    try {
      let request;
      const apiAnswers = ['5', 'gpt-fixture', 'yes'];
      const api = await onboarding.firstOpen({ detect: false, file: keyFile, ask: async () => apiAnswers.shift(), out: (line) => { check('API setup never prints the environment key', !line.includes('fixture-private-key'), { happened: line, why: 'Keys stay out of chat/logs.', fix: 'Sanitize provider output and never print credential values.' }); }, fetchImpl: async (url, options) => { request = { url: String(url), options }; return response({ data: [{ id: 'gpt-fixture' }] }); } });
      check('OpenAI API setup checks only authenticated GET /models and stores no key',
        api.status === 'complete' && api.method === 'responses' && request.options.method === 'GET' && new URL(request.url).pathname === '/v1/models' && request.options.headers.authorization === 'Bearer fixture-private-key' && !fs.readFileSync(keyFile, 'utf8').includes('fixture-private-key'),
        { happened: JSON.stringify({ api, request: { url: request?.url, method: request?.options?.method }, record: fs.readFileSync(keyFile, 'utf8') }), why: 'API account routing and billing must be explicit while secrets stay local.', fix: 'Read the key from the named environment variable and persist only endpoint/model.' });
      const active = JSON.stringify(['engine', 'openaiUrl', 'openaiModel'].map(key => core.config().agent[key]));
      const refusedAnswers = ['7', 'https://models.example/v1', 'not-offered', 'yes'];
      const refused = await onboarding.firstOpen({ detect:false, file:path.join(temp('state'), 'rejected-api.json'), ask:async()=>refusedAnswers.shift(), out:()=>{}, fetchImpl:async()=>response({data:[{id:'offered-model'}]}) });
      check('a rejected custom model keeps the active provider settings intact', refused.status === 'deferred' && active === JSON.stringify(['engine', 'openaiUrl', 'openaiModel'].map(key => core.config().agent[key])), {happened:JSON.stringify(core.config().agent),why:'An unsuccessful setup must not replace a working connection.',fix:'Save active connection settings only after validation.'});
      const lines=[];
      await commands.dispatch('/connections',{cwd:temp('project'),state:{engine:'responses'},out:text=>lines.push(text)});
      check('connections help names custom providers and local credential variables without leaking keys', /Custom OpenAI-compatible API/.test(lines.join(' ')) && /key available locally/.test(lines.join(' ')) && !lines.join(' ').includes('fixture-private-key'), {happened:lines.join(' '),why:'Beginners need an actionable connection inventory without exposed credentials.',fix:'Show availability and environment variable names only.'});
    } finally { if (prior === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prior; }

    const savedDeferred = onboarding.onboardingText(missingFile);
    check('onboardingText reports the saved state', savedDeferred.startsWith('onboarding deferred: ollama;'),
      { happened: savedDeferred, why: 'Setup state must be readable without rerunning a provider check.', fix: 'Format the persisted status row.' });
    const records = onboarding.readOnboarding(path.join(temp('state'), 'absent.json'));
    check('readOnboarding treats missing or malformed files as no record', records === null && path.basename(onboarding.onboardingPath()) === 'onboarding.json',
      { happened: JSON.stringify(records), why: 'Corrupt setup markers must not be trusted.', fix: 'Validate the schema and return null on unreadable files.' });

    settings.set('agent.engine', previous.engine);
    settings.set('agent.ollamaUrl', previous.ollamaUrl);
    settings.set('agent.ollamaModel', previous.ollamaModel);
    settings.set('agent.chatgptModel', previous.chatgptModel);
    settings.set('agent.chatgptReasoningEffort', previous.chatgptReasoningEffort);
    settings.set('agent.openaiUrl', previous.openaiUrl);
    settings.set('agent.openaiModel', previous.openaiModel);
  });

  await asyncSuite('persistent goals expert', 'project-owned goals with explicit bounds and verified completion', async () => {
    const cwd = temp('project');
    const other = temp('other-project');
    const created = goals.createGoal(cwd, 'finish a real task', { check: 'node --version', rounds: 2 });
    check('goalFile binds the goal under the project and stores a versioned active record',
      goals.goalFile(cwd) === path.join(cwd, '.atlias', 'goals.json') && goals.readGoals(cwd).active.id === created.id && created.status === 'active',
      { happened: JSON.stringify(goals.readGoals(cwd)), why: 'A saved goal must survive relaunch and belong to one project.', fix: 'Use the project .atlias/goals.json record.' });
    check('goal parser requires and preserves the requested check, objective and round count',
      JSON.stringify(goals.parseCreateArgs('--rounds 2 --check "node --version" finish it')) === JSON.stringify({ rounds: 2, check: 'node --version', objective: 'finish it' }) && goals.MAX_ROUNDS === 10,
      { happened: JSON.stringify(goals.parseCreateArgs('--rounds 2 --check "node --version" finish it')), why: 'Continuation needs an explicit finite bound and exact check command.', fix: 'Parse quoted arguments and cap rounds.' });
    let runCount = 0;
    const declined = await goals.runGoalCheck(cwd, { ask: async () => 'no', run: () => { runCount++; return { exitCode: 0 }; } });
    check('a declined completion check runs nothing and cannot complete a goal', !declined.ran && runCount === 0 && goals.readGoals(cwd).active.status === 'active',
      { happened: JSON.stringify(declined), why: 'The user must approve the exact completion command.', fix: 'Treat every non-yes response as a refusal.' });
    const updated = goals.updateGoal(cwd, 'finish the revised task', { rounds: 3 });
    check('update increments the revision and invalidates the old check receipt', updated.revision === 2 && updated.lastCheck === null && updated.maxRounds === 3,
      { happened: JSON.stringify(updated), why: 'An old check cannot complete a changed objective.', fix: 'Clear prior check evidence on update.' });
    goals.setGoalStatus(cwd, 'paused');
    check('pause and resume persist on the same project goal', goals.readGoals(cwd).active.status === 'paused' && goals.setGoalStatus(cwd, 'active').status === 'active',
      { happened: goals.statusText(cwd), why: 'A pause must prevent autonomous continuation until resumed.', fix: 'Persist lifecycle status.' });
    let turns = 0, checks = 0;
    const continued = await goals.continueGoal(cwd, { rounds: 5, state: {}, ask: async () => 'yes', turn: async () => { turns++; return 'claim complete'; }, run: () => { checks++; return { exitCode: checks === 1 ? 1 : 0, output: 'check result' }; } });
    check('continuation cannot trust a model completion claim and stops only after its own passing check', turns === 2 && checks === 2 && continued.goal.status === 'complete' && continued.goal.roundsUsed === 2,
      { happened: JSON.stringify({ turns, checks, goal: continued.goal }), why: 'The explicit goal check, not the model wording, decides completion.', fix: 'Consume rounds before calls and use the approved check result.' });
    check('goals stay project scoped and status reports that owner', goals.readGoals(other).active === null && goals.statusText(cwd).includes(`project ${path.resolve(cwd)}`),
      { happened: goals.statusText(cwd), why: 'A goal in one folder must not control another folder.', fix: 'Bind each goal state to its normalized cwd.' });
    const broken = temp('corrupt');
    fs.mkdirSync(path.dirname(goals.goalFile(broken)), { recursive: true });
    fs.writeFileSync(goals.goalFile(broken), '{broken');
    check('corrupt goal state fails closed and remains visibly unavailable', goals.readGoals(broken).error && goals.statusText(broken).startsWith('goals unavailable'),
      { happened: JSON.stringify(goals.readGoals(broken)), why: 'Damaged state cannot become an invented fresh or complete goal.', fix: 'Return a read error.' });
    check('runCheckCommand returns a normalized result without starting a process in this test',
      goals.runCheckCommand('node check.js', cwd, { spawnSyncFn: () => ({ status: 0, stdout: 'ok', stderr: '' }) }).exitCode === 0,
      { happened: goals.runCheckCommand('node check.js', cwd, { spawnSyncFn: () => ({ status: 0, stdout: 'ok', stderr: '' }) }).output, why: 'A check result must include a numeric exit status and captured output.', fix: 'Normalize the injected spawn result.' });
  });

  await asyncSuite('goal commands expert', 'goal aliases expose the persistent project lifecycle', async () => {
    const cwd = temp('command-project');
    const output = [];
    const state = { engine: 'echo', messages: [], started: false, textTools: false };
    const api = { turn: async () => 'one bounded step', saveChat: () => {} };
    const ctx = { cwd, state, api, out: (text) => output.push(String(text)), ask: async () => 'yes' };
    await commands.dispatch('/goal create --rounds 1 --check "node --version" ship it', ctx);
    await commands.dispatch('/goals status', ctx);
    await commands.dispatch('/goal continue --rounds 1', { ...ctx, api: { ...api, turn: async () => 'done' } });
    check('/goal and /goals share the stored objective and bounded continuation', goals.readGoals(cwd).active.roundsUsed === 1 && output.some((line) => /goal .* \(active\)/.test(line)) && output.some((line) => /used 1 round/.test(line)),
      { happened: JSON.stringify({ output, goal: goals.readGoals(cwd).active }), why: 'Both command aliases must call the same goal state and continuation logic.', fix: 'Dispatch aliases through runGoalCommand.' });
  });

  await asyncSuite('copy on select expert', 'copy-on-select changes only an explicitly confirmed supported host setting', async () => {
    const root = temp('terminal');
    const output = [];
    const previousPermissions = core.config().agent.permissions;
    settings.set('agent.permissions', 'workspace');
    const env = { LOCALAPPDATA: root, WT_SESSION: 'synthetic-session' };
    const file = path.join(root, 'Packages', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'LocalState', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const initial = '{\r\n  // keep this host comment\r\n  "copyOnSelect": false,\r\n  "copyFormatting": "none",\r\n  "profiles": { "defaults": { "fontFace": "Cascadia Code" }, "list": [] },\r\n}\r\n';
    fs.writeFileSync(file, initial);
    check('supportedHost requires an active Windows Terminal session and selection-copy lookup is host scoped',
      copy.supportedHost({ platform: 'win32', env }) && !copy.supportedHost({ platform: 'win32', env: {} }) && copy.settingsCandidates({ env }).includes(file),
      { happened: JSON.stringify({ supported: copy.supportedHost({ platform: 'win32', env }), candidates: copy.settingsCandidates({ env }) }), why: 'A terminal profile file must never change just because Windows Terminal happens to be installed.', fix: 'Require WT_SESSION and locate only its documented settings roots.' });
    const before = copy.copyOnSelectStatus({ platform: 'win32', env });
    check('readCopyOnSelect honors an explicit false and status explains host-wide scope',
      copy.readCopyOnSelect(initial).configured && copy.readCopyOnSelect(initial).value === false && before.supported && before.value === false && /every Windows Terminal profile/.test(before.text),
      { happened: before.text, why: 'An explicit false is a user preference and must not be treated as missing.', fix: 'Read the root boolean and report its scope.' });
    const configOutput = [];
    const configCtx = { ask: async () => 'no', out: (line) => configOutput.push(String(line)), api: { copyOnSelectOptions: { platform: 'win32', env } } };
    await commands.dispatch('/config ui.copyOnSelect', configCtx);
    await commands.dispatch('/config all', configCtx);
    check('/config and /config all expose the live terminal setting without persisting an Atlias boolean',
      configOutput.length === 2 && configOutput.every((line) => /ui\.copyOnSelect/.test(line) && /every Windows Terminal profile/.test(line))
        && !Object.hasOwn(core.config().ui, 'copyOnSelect'),
      { happened: JSON.stringify({ configOutput, ui: core.config().ui }), why: 'The setting must be discoverable and backed by the real terminal preference, not an inert Atlias toggle.', fix: 'Render host status from the selection-copy adapter.' });
    const changedText = copy.setCopyOnSelectText(initial, true);
    check('setCopyOnSelectText changes only the requested root boolean and preserves JSONC comments and other settings',
      copy.readCopyOnSelect(changedText).value === true && changedText.includes('// keep this host comment') && changedText.includes('"copyFormatting": "none"') && changedText.includes('"fontFace": "Cascadia Code"') && changedText.includes('\r\n'),
      { happened: changedText, why: 'Terminal configuration must preserve unrelated profiles and JSONC comments.', fix: 'Replace just the copyOnSelect value.' });
    const inserted = copy.setCopyOnSelectText('{\n  "profiles": {"list": []}\n}\n', true);
    check('missing copyOnSelect is inserted without overwriting the profiles object', copy.readCopyOnSelect(inserted).value === true && inserted.includes('"profiles"'),
      { happened: inserted, why: 'A supported root option must be added without rebuilding or dropping other settings.', fix: 'Insert only the absent property.' });
    let reads = 0;
    const unsupported = copy.copyOnSelectStatus({ platform: 'win32', env: {}, existsSync: () => { reads++; return false; } });
    check('unsupported terminals are reported honestly without reading or editing settings', !unsupported.supported && reads === 0 && /unsupported host/.test(unsupported.text),
      { happened: JSON.stringify({ unsupported, reads }), why: 'ANSI selection is owned by the terminal and there is no safe portable clipboard hook.', fix: 'Do not poll clipboards or claim unsupported behavior.' });
    const applied = copy.configureCopyOnSelect(true, { platform: 'win32', env });
    const saved = fs.readFileSync(file, 'utf8');
    check('configureCopyOnSelect writes only the isolated synthetic profile after an explicit call', applied.ok && copy.readCopyOnSelect(saved).value === true && saved.includes('"copyFormatting": "none"') && /every profile/.test(applied.text),
      { happened: JSON.stringify({ applied, saved }), why: 'Only an actual requested toggle may change host-wide settings.', fix: 'Keep file writes behind configureCopyOnSelect.' });
    const disabled = copy.configureCopyOnSelect(false, { platform: 'win32', env });
    check('an explicit opt-out writes false and leaves the other terminal settings intact', disabled.ok && copy.readCopyOnSelect(fs.readFileSync(file, 'utf8')).value === false && fs.readFileSync(file, 'utf8').includes('"fontFace": "Cascadia Code"'),
      { happened: JSON.stringify(disabled), why: 'The user must be able to reverse the opt-in.', fix: 'Set the same documented host property to false.' });
    const malformed = '{"copyOnSelect":"yes","profiles":{"list":[]}}';
    let malformedRejected = false;
    try { copy.readCopyOnSelect(malformed); } catch { malformedRejected = true; }
    const invalidWrite = copy.configureCopyOnSelect(true, { platform: 'win32', env: { ...env, LOCALAPPDATA: temp('bad-terminal') }, existsSync: () => true, readFileSync: () => malformed });
    check('an invalid non-boolean host setting is rejected without rewriting it', malformedRejected && !invalidWrite.ok && /not changed/.test(invalidWrite.text),
      { happened: JSON.stringify({ malformedRejected, invalidWrite }), why: 'A hand-edited unexpected value must not be silently coerced or overwritten.', fix: 'Require a boolean Windows Terminal setting.' });
    let askText = '';
    const ctx = { ask: async (prompt) => { askText = prompt; return 'no'; }, out: (line) => output.push(String(line)), api: { copyOnSelectOptions: { platform: 'win32', env } } };
    await commands.dispatch('/copy-on-select on', ctx);
    check('the slash command shows the global scope before changing anything and honors opt-out', /every profile/.test(askText) && /right-click pastes/.test(askText) && copy.readCopyOnSelect(fs.readFileSync(file, 'utf8')).value === false,
      { happened: JSON.stringify({ askText, file: fs.readFileSync(file, 'utf8') }), why: 'The host-wide effect must be clear before the user confirms a change.', fix: 'Ask and require yes before writing.' });
    const virtualDenied = { ...ctx, ask: async (prompt) => { askText = prompt; return 'no'; } };
    await commands.dispatch('/config ui.copyOnSelect true', virtualDenied);
    const cancelOutput = [];
    await commands.dispatch('/config ui.copyOnSelect true', { ...ctx, ask: async () => '', out: (line) => cancelOutput.push(String(line)) });
    const invalidBefore = fs.readFileSync(file, 'utf8');
    let invalidAsked = false;
    await commands.dispatch('/config ui.copyOnSelect definitely', { ...ctx, ask: async () => { invalidAsked = true; return 'yes'; } });
    check('/config host toggle requires a strict boolean and a positive confirmation',
      /every profile/.test(askText) && cancelOutput.some((line) => /unchanged/.test(line)) && copy.readCopyOnSelect(fs.readFileSync(file, 'utf8')).value === false && !invalidAsked && fs.readFileSync(file, 'utf8') === invalidBefore,
      { happened: JSON.stringify({ askText, cancelOutput, invalidAsked, file: fs.readFileSync(file, 'utf8') }), why: 'Typos, a declined confirmation, and an empty/cancelled answer must not change the host terminal.', fix: 'Validate true/false and require an affirmative answer before using the host adapter.' });
    const accepted = { ...ctx, ask: async (prompt) => { askText = prompt; return 'yes'; } };
    await commands.dispatch('/config ui.copyOnSelect true', accepted);
    check('/config host toggle changes only the synthetic terminal file after explicit opt-in', /every profile/.test(askText) && copy.readCopyOnSelect(fs.readFileSync(file, 'utf8')).value === true && fs.readFileSync(file, 'utf8').includes('"copyFormatting": "none"') && !Object.hasOwn(core.config().ui, 'copyOnSelect'),
      { happened: JSON.stringify({ askText, file: fs.readFileSync(file, 'utf8'), ui: core.config().ui }), why: 'The integrated config route must change the actual host setting only after confirmation, without storing a duplicate app value.', fix: 'Share the existing explicit host adapter.' });
    let readOnlyAsked = false;
    settings.set('agent.permissions', 'read-only');
    await commands.dispatch('/config ui.copyOnSelect false', { ...accepted, ask: async () => { readOnlyAsked = true; return 'yes'; } });
    check('read-only permissions block the virtual host setting without asking or writing', !readOnlyAsked && copy.readCopyOnSelect(fs.readFileSync(file, 'utf8')).value === true,
      { happened: JSON.stringify({ readOnlyAsked, file: fs.readFileSync(file, 'utf8') }), why: 'A host config file is still a write and must respect the configured permission mode.', fix: 'Apply the same permission gate as the original command.' });
    settings.set('agent.permissions', 'workspace');
    await commands.dispatch('/config reset ui.copyOnSelect', accepted);
    check('reset uses the same confirmed host route and restores Windows Terminal copy-off', /Set it off/.test(askText) && copy.readCopyOnSelect(fs.readFileSync(file, 'utf8')).value === false,
      { happened: JSON.stringify({ askText, file: fs.readFileSync(file, 'utf8') }), why: 'Reset must not create an unrelated Atlias default; it restores the host default through the same confirmation.', fix: 'Delegate reset to the false host setting.' });
    await commands.dispatch('/copy-on-select on', accepted);
    check('the original copy-on-select command still shares the host adapter', /Set it on/.test(askText) && copy.readCopyOnSelect(fs.readFileSync(file, 'utf8')).value === true,
      { happened: JSON.stringify({ askText, file: fs.readFileSync(file, 'utf8') }), why: 'The config alias must not replace the existing command path.', fix: 'Delegate both command forms to setCopyOnSelect.' });
    let malformedResetAsked = false;
    await commands.dispatch('/config reset ui.copyOnSelect false', { ...accepted, ask: async () => { malformedResetAsked = true; return 'yes'; } });
    check('reset rejects trailing arguments before asking or touching the host file', !malformedResetAsked && copy.readCopyOnSelect(fs.readFileSync(file, 'utf8')).value === true,
      { happened: JSON.stringify({ malformedResetAsked, file: fs.readFileSync(file, 'utf8') }), why: 'A malformed reset must not silently perform a different host change.', fix: 'Require exact reset syntax.' });
    let unsupportedAsked = false;
    await commands.dispatch('/copy-on-select on', { ...ctx, ask: async () => { unsupportedAsked = true; return 'yes'; }, api: { copyOnSelectOptions: { platform: 'win32', env: {} } } });
    check('an unsupported host never asks for confirmation or changes any profile', !unsupportedAsked && copy.readCopyOnSelect(fs.readFileSync(file, 'utf8')).value === true,
      { happened: JSON.stringify({ unsupportedAsked, file: fs.readFileSync(file, 'utf8') }), why: 'A portable terminal has no safe host setting to modify.', fix: 'Report the unsupported terminal before asking.' });
    let configUnsupportedAsked = false;
    const unsupportedConfigOutput = [];
    const unsupportedConfigCtx = { ...ctx, out: (line) => unsupportedConfigOutput.push(String(line)), ask: async () => { configUnsupportedAsked = true; return 'yes'; }, api: { copyOnSelectOptions: { platform: 'win32', env: {} } } };
    await commands.dispatch('/config ui.copyOnSelect', unsupportedConfigCtx);
    await commands.dispatch('/config ui.copyOnSelect true', unsupportedConfigCtx);
    check('the config alias reports unsupported hosts and never asks or changes another terminal',
      /unsupported/.test(unsupportedConfigOutput[0]) && !configUnsupportedAsked && copy.readCopyOnSelect(fs.readFileSync(file, 'utf8')).value === true,
      { happened: JSON.stringify({ unsupportedConfigOutput, configUnsupportedAsked, file: fs.readFileSync(file, 'utf8') }), why: 'The virtual setting must not claim ANSI terminals have a controllable selection option.', fix: 'Use the host adapter status and stop before confirmation when unsupported.' });
    settings.set('agent.permissions', previousPermissions);
  });

  await asyncSuite('native auth status expert', 'native provider auth parsing discards credentials and account text', async () => {
    const codex = agentMod.parseNativeAuthStatus('codex', { status: 0, stdout: '', stderr: 'Logged in using ChatGPT\n' });
    const notLoggedIn = agentMod.parseNativeAuthStatus('codex', { status: 0, stdout: 'Not logged in\n', stderr: '' });
    const key = agentMod.parseNativeAuthStatus('codex', { status: 0, stdout: '', stderr: 'Logged in using an API key - private-secret\n' });
    const claude = agentMod.parseNativeAuthStatus('claude', { status: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai","account":"private@example.test"}', stderr: '' });
    const cancelledClaude = agentMod.parseNativeAuthStatus('claude', { status: 0, stdout: '{"loggedIn":false,"authenticated":false,"authMethod":"claude.ai"}', stderr: '' });
    check('parseNativeAuthStatus reports only native login booleans and never returns account or key text',
      codex.authenticated && codex.subscription && !notLoggedIn.authenticated && key.authenticated && !key.subscription && claude.authenticated && claude.subscription
        && !cancelledClaude.authenticated && !cancelledClaude.subscription && !JSON.stringify([codex, notLoggedIn, key, claude, cancelledClaude]).match(/private-secret|private@example/),
      { happened: JSON.stringify([codex, notLoggedIn, key, claude, cancelledClaude]), why: 'An explicit failed native auth result must override stale auth-method text; Atlias needs only a boolean status.', fix: 'Honor explicit false login fields and return no raw CLI output.' });
    check('nativeAuthStatus executes only the named CLI status command and nativeLogin/logout use native subcommands',
      agentMod.nativeAuthStatus('codex', { available: true, run: (cmd, args) => ({ status: cmd === 'codex' && args.join(' ') === 'login status' ? 0 : 1, stdout: 'Logged in using ChatGPT', stderr: '' }) }).subscription
        && !agentMod.nativeAuthStatus('ollama').available
        && agentMod.nativeLogin('claude', { spawn: (file, args, opts) => ({ status: file === 'claude' && args.join(' ') === 'auth login' && opts.stdio === 'inherit' ? 0 : 1 }) }).started
        && agentMod.nativeLogout('claude', { spawn: (file, args) => ({ status: file === 'claude' && args.join(' ') === 'auth logout' ? 0 : 1 }) }).supported,
      { happened: 'native CLI calls did not match expected commands', why: 'Native auth must remain in each official CLI with inherited user I/O.', fix: 'Use the official login/status/logout subcommands.' });
    let unavailableCalls = 0, loginCalls = 0, authText = '';
    const missing = agentMod.nativeAuthStatus('claude', { available: false, run: () => { unavailableCalls++; return { status: 0, stdout: '{"loggedIn":true}', stderr: '' }; } });
    // The claude host is founders-only (Gev, 2026-10-30); here it is offered but its CLI is missing.
    offerClaudeForTests(true);
    try { await auth.authCommand('claude login', { out: (line) => { authText += line; }, api: { nativeAuthStatus: () => ({ available: false }), nativeLogin: () => { loginCalls++; } } }); } finally { offerClaudeForTests(false); }
    check('an unavailable native CLI is neither invoked for status nor presented as a successful login route',
      !missing.available && unavailableCalls === 0 && loginCalls === 0 && /native CLI unavailable/.test(authText),
      { happened: JSON.stringify({ missing, unavailableCalls, loginCalls, authText }), why: 'A missing host cannot receive a login command or be shown as available.', fix: 'Stop before invoking provider auth when binary detection fails.' });
  });
}

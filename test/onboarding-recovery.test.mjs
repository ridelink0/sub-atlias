import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atlias-onboarding-recovery-'));
process.env.ATLIAS_HOME = home;
const onboarding = await import('../lib/onboarding.mjs');
const auth = await import('../lib/auth-command.mjs');
const settings = await import('../lib/settings.mjs');
const { config } = await import('../lib/core.mjs');
let sequence = 0;
const state = () => path.join(home, `setup-${++sequence}.json`);
const tags = models => ({ ok: true, status: 200, json: async () => ({ models: models.map(name => ({ name })) }) });
const connected = { status: 'connected', sharing: true };
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test('expired sign-in can continue directly into an explicit installed Ollama model', async () => {
  settings.set('agent.engine', 'echo');
  const answers = ['2', 'y', 'l', 'http://127.0.0.1:11434', '2'];
  const output = []; let probes = 0, logins = 0;
  const row = await onboarding.firstOpen({ detect: false, file: state(), ask: async question => {
    if (question.startsWith('Choose an installed')) assert.ok(output.some(line => line.includes('2  second:latest')));
    return answers.shift();
  }, out: line => output.push(line), isChatGPTPrepared: () => true, chatgptEngine: {
    session: async () => ({ status: 'disconnected', sharing: false }),
    login: async () => { logins++; throw Object.assign(Error('ChatGPT synthetic-private-body'), { code: 'cancelled' }); },
  }, fetchImpl: async (url, options) => {
    probes++; assert.equal(new URL(url).pathname, '/api/tags'); assert.equal(options.method, 'GET'); assert.equal(options.body, undefined);
    return tags(['first:latest', 'second:latest']);
  } });
  assert.equal(row.status, 'complete'); assert.equal(row.method, 'ollama');
  assert.equal(config().agent.engine, 'ollama'); assert.equal(config().agent.ollamaModel, 'second:latest');
  assert.equal(logins, 1); assert.equal(probes, 1); assert.equal(answers.length, 0);
  assert.match(output.join('\n'), /cancelled or expired/);
  assert.ok(!output.join('\n').includes('synthetic-private-body'));
});

test('finishing later preserves the original failed setup and never selects a host or API', async () => {
  settings.set('agent.engine', 'echo');
  const file = state(), answers = ['2', 'y', ''];
  const row = await onboarding.firstOpen({ detect: false, file, ask: async () => answers.shift(), isChatGPTPrepared: () => true,
    chatgptEngine: { session: async () => ({ status: 'disconnected' }), login: async () => { throw Object.assign(Error('secret'), { code: 'network_error' }); } },
    fetchImpl: () => assert.fail('no endpoint may be probed') });
  assert.equal(row.verification, 'sign_in_cancelled_or_failed'); assert.equal(row.status, 'deferred');
  assert.equal(onboarding.readOnboarding(file).method, 'chatgpt'); assert.equal(config().agent.engine, 'echo');
  assert.ok(onboarding.requiresFirstOpen(row));
});

test('local setup retries its own route without restarting the app', async () => {
  const answers = ['3', 'http://localhost:11434', 'not-installed', 'r', 'http://localhost:11434', '1'];
  let probes = 0;
  const row = await onboarding.firstOpen({ detect: false, file: state(), ask: async () => answers.shift(), fetchImpl: async () => { probes++; return tags(['ready:latest']); } });
  assert.equal(row.status, 'complete'); assert.equal(row.details.model, 'ready:latest'); assert.equal(probes, 2);
});

test('missing API credentials can return to the provider chooser and defer', async () => {
  const old = [process.env.ATLIAS_RESPONSES_API_KEY, process.env.OPENAI_API_KEY];
  delete process.env.ATLIAS_RESPONSES_API_KEY; delete process.env.OPENAI_API_KEY;
  settings.set('agent.engine', 'echo');
  try {
    const answers = ['5', 'synthetic-model', 'c', '0'];
    const row = await onboarding.firstOpen({ detect: false, file: state(), ask: async () => answers.shift(), fetchImpl: () => assert.fail('missing keys cannot make requests') });
    assert.equal(row.method, 'later'); assert.equal(row.status, 'deferred'); assert.equal(config().agent.engine, 'echo');
  } finally {
    for (const [index, name] of ['ATLIAS_RESPONSES_API_KEY', 'OPENAI_API_KEY'].entries()) {
      if (old[index] === undefined) delete process.env[name]; else process.env[name] = old[index];
    }
  }
});

test('local model lists reject terminal and shell content and retain exact valid names', async () => {
  const result = await onboarding.checkOllamaTags('http://localhost:11434', async () => tags(['safe:latest', 'safe:latest', '\x1b[2Jhidden', 'bad;echo', '--help', 'with space']));
  assert.deepEqual(result.models, ['safe:latest']);
  settings.set('agent.engine', 'echo');
  const answers = ['3', 'http://localhost:11434', 'safe;echo private', ''];
  const row = await onboarding.firstOpen({ detect: false, file: state(), ask: async () => answers.shift(), fetchImpl: async () => tags(['safe:latest']) });
  assert.equal(row.status, 'deferred'); assert.equal(row.verification, 'invalid_selection'); assert.equal(config().agent.engine, 'echo');
});

test('a missing pinned ChatGPT model stays pinned when the user declines replacement', async () => {
  settings.set('agent.chatgptModel', 'pinned-model'); settings.set('agent.chatgptReasoningEffort', 'xhigh'); settings.set('agent.engine', 'echo');
  const answers = ['2', '', '']; let validations = 0;
  const row = await onboarding.firstOpen({ detect: false, file: state(), ask: async () => answers.shift(), isChatGPTPrepared: () => true,
    chatgptEngine: { session: async () => connected, models: async () => [{ slug: 'available-model' }], validate: async () => { validations++; } } });
  assert.equal(row.verification, 'requested_model_unavailable'); assert.equal(validations, 0);
  assert.equal(config().agent.chatgptModel, 'pinned-model'); assert.equal(config().agent.engine, 'echo');
});

test('an available replacement is saved only after explicit choice and successful effort validation', async () => {
  for (const valid of [false, true]) {
    settings.set('agent.chatgptModel', 'pinned-model'); settings.set('agent.chatgptReasoningEffort', 'xhigh'); settings.set('agent.engine', 'echo');
    const answers = ['2', '1', 'model', ''];
    const row = await onboarding.firstOpen({ detect: false, file: state(), ask: async () => answers.shift(), isChatGPTPrepared: () => true,
      chatgptEngine: { session: async () => connected, models: async () => [{ slug: 'available-model' }], validate: async (model, effort) => {
        assert.equal(model, 'available-model'); assert.equal(effort, 'model'); if (!valid) throw Error('unsupported');
      } } });
    assert.equal(row.status, valid ? 'complete' : 'deferred');
    assert.equal(config().agent.chatgptModel, valid ? 'available-model' : 'pinned-model');
    assert.equal(config().agent.chatgptReasoningEffort, valid ? 'model' : 'xhigh');
    assert.equal(config().agent.engine, valid ? 'chatgpt' : 'echo');
  }
});

test('auth failures expose reviewed recovery text without trusting provider text or success exit', async () => {
  const lines = [];
  assert.match(auth.authFailure({ code: 'cancelled', message: 'private' }), /cancelled or expired/);
  assert.ok(!auth.authFailure({ code: 'unknown', message: 'ChatGPT private-provider-body' }).includes('private-provider-body'));
  const result = await auth.authCommand('chatgpt login', { out: line => lines.push(line), engine: {
    login: async () => { throw Object.assign(Error('private-provider-body'), { code: 'cancelled' }); }, cancel: async () => {},
  } });
  assert.equal(result.ok, false); assert.ok(!lines.join('\n').includes('private-provider-body'));
  const cli = fileURLToPath(new URL('../bin/atlias.mjs', import.meta.url));
  const spawned = spawnSync(process.execPath, [cli, 'auth', 'chatgpt', 'login'], { cwd: home, env: { ...process.env, ATLIAS_HOME: home }, encoding: 'utf8', windowsHide: true });
  assert.equal(spawned.status, 1, spawned.stderr); assert.match(spawned.stdout, /failed/, spawned.stderr);
});

test('native Claude auth waits for its async login before checking status', async () => {
  const lines = []; let signedIn = false;
  await auth.authCommand('claude login', { out: line => lines.push(line), api: {
    claudeOffered: () => true, nativeAuthStatus: async () => ({ available: true, authenticated: signedIn }),
    nativeLogin: async () => { await Promise.resolve(); signedIn = true; },
  } });
  assert.equal(signedIn, true); assert.match(lines.at(-1), /claude: authenticated/);
});

test('failed native sign-in returns failure and never prints adapter errors', async () => {
  for (const provider of ['claude', 'codex']) {
    const lines = [];
    const failed = await auth.authCommand(`${provider} login`, { out: line => lines.push(line), api: {
      claudeOffered: () => true, nativeAuthStatus: async () => ({ available: true, authenticated: false }), nativeLogin: async () => { throw Error('synthetic-private-login'); },
    } });
    assert.equal(failed.ok, false); assert.match(lines.at(-1), /sign-in is not verified/);
    const unavailable = await auth.authCommand(`${provider} status`, { out: line => lines.push(line), api: {
      claudeOffered: () => true, nativeAuthStatus: async () => { throw Error('synthetic-private-status'); },
    } });
    assert.equal(unavailable.ok, false); assert.ok(!lines.join('\n').includes('synthetic-private'));
  }
});

test('sign-in cancellation absorbs cancellation-adapter failure without an unhandled rejection', async () => {
  const lines = []; let cancelled = 0;
  const result = await auth.authCommand('chatgpt login', { out: line => lines.push(line), engine: {
    login: async () => { process.emit('SIGINT'); await new Promise(resolve => setImmediate(resolve)); throw Object.assign(Error('private-login'), { code: 'cancelled' }); },
    cancel: async () => { cancelled++; throw Error('private-cancel'); },
  } });
  assert.equal(cancelled, 1); assert.equal(result.ok, false);
  assert.match(lines.at(-1), /cancelled or expired/); assert.ok(!lines.join('\n').includes('private-'));
});

test('permission refusals return failure for every authentication mutation', async () => {
  const prior = config().agent.permissions;
  try {
    settings.set('agent.permissions', 'read-only');
    for (const provider of ['chatgpt', 'claude', 'codex']) {
      const lines = [];
      const result = await auth.authCommand(`${provider} login`, { out: line => lines.push(line), engine: { login: () => assert.fail('permission refusal cannot start sign-in') }, api: { claudeOffered: () => true, nativeLogin: () => assert.fail('permission refusal cannot start native sign-in') } });
      assert.equal(result?.ok, false); assert.match(lines.at(-1), /disabled in this permission mode/);
    }
  } finally { settings.set('agent.permissions', prior); }
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'atlias-auth-check-'));
process.env.ATLIAS_HOME = home;
const chatgpt = await import('../lib/chatgpt.mjs');
const auth = await import('../lib/auth-command.mjs');
const credentials = await import('../lib/credential-protection.mjs');
const engines = await import('../lib/engines.mjs');
const settings = await import('../lib/settings.mjs');
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test('only the reviewed personal runtime marker enables readiness', () => {
  assert.equal(chatgpt.prepared(), false);
  const file = path.join(home, 'personal-chatgpt/runtime/PERSONAL-ONLY.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(file), 'index.js'), 'export function createChatGPT() {}');
  fs.writeFileSync(path.join(path.dirname(file), 'package.json'), '{"type":"module"}');
  fs.writeFileSync(file, JSON.stringify({ commit: 'other', personalOnly: true, installComplete: true }));
  assert.equal(chatgpt.prepared(), false);
  fs.writeFileSync(file, JSON.stringify({ commit: '0a36fefeb913055c8c7a1a29b63d82b96b2e841a', personalOnly: false, installComplete: true }));
  assert.equal(chatgpt.prepared(), false);
  fs.writeFileSync(file, JSON.stringify({ commit: '0a36fefeb913055c8c7a1a29b63d82b96b2e841a', personalOnly: true }));
  assert.equal(chatgpt.prepared(), false, 'legacy marker before dependency installation is not ready');
  fs.writeFileSync(file, JSON.stringify({ commit: '0a36fefeb913055c8c7a1a29b63d82b96b2e841a', personalOnly: true, installComplete: true }));
  fs.unlinkSync(path.join(path.dirname(file), 'index.js'));
  assert.equal(chatgpt.prepared(), false, 'marker without runtime files is not ready');
  fs.writeFileSync(path.join(path.dirname(file), 'index.js'), 'export function createChatGPT() {}');
  fs.writeFileSync(path.join(path.dirname(file), 'package.json'), '{"type":"module"}');
  assert.equal(chatgpt.prepared(), true);
  fs.unlinkSync(file);
  assert.equal(chatgpt.prepared(), false);
});

test('credential protection rejects unsupported hosts without plaintext fallback', () => {
  const protection = credentials.windowsCredentialProtection({ platform: 'unsupported' });
  assert.equal(protection.isAvailable(), false);
  assert.throws(() => protection.encrypt('synthetic value'), /No plaintext fallback/);
});

test('Windows DPAPI encrypts and recovers a synthetic local credential', { skip: process.platform !== 'win32' }, () => {
  const protection = credentials.windowsCredentialProtection();
  const text = 'Atlias synthetic credential fixture';
  assert.equal(protection.isAvailable(), true);
  const encrypted = protection.encrypt(text);
  assert.ok(Buffer.isBuffer(encrypted));
  assert.notDeepEqual(encrypted, Buffer.from(text));
  assert.equal(protection.decrypt(encrypted), text);
});

test('status distinguishes direct API, local and host billing', () => {
  assert.equal(engines.describeEngine('claude').execution, 'host harness');
  assert.match(engines.describeEngine('anthropic').billing, /API.*separate billing/);
  assert.equal(engines.describeEngine('ollama').billing, 'local endpoint');
});

test('auth commands preserve identity-only status and require selection validation', async () => {
  const lines = [], state = { engine: 'echo', messages: ['old'], started: true };
  let validated = 0;
  const engine = {
    session: async () => ({ status: 'connected', sharing: false }),
    models: async () => [{ slug: 'gpt-6.1-sol', displayName: 'Synthetic catalog entry' }],
    validate: async (model, effort) => { assert.equal(model, 'gpt-6.1-sol'); assert.equal(effort, 'xhigh'); validated++; },
  };
  const context = { state, engine, out: line => lines.push(line) };
  await auth.authCommand('chatgpt status', context);
  assert.match(lines.join('\n'), /plan usage not authorized/);
  await auth.authCommand('chatgpt models', context);
  assert.match(lines.join('\n'), /gpt-6.1-sol/);
  await auth.authCommand('chatgpt use gpt-6.1-sol xhigh', context);
  assert.equal(validated, 1);
  assert.equal(state.engine, 'chatgpt');
  assert.deepEqual(state.messages, []);
  assert.equal(state.started, false);
});

test('read-only auth cannot start login or change accounts', async () => {
  settings.set('agent.permissions', 'read-only');
  try {
    let logins = 0; const lines = [];
    await auth.authCommand('chatgpt login', { engine: { login: () => { logins++; } }, out: line => lines.push(line) });
    assert.equal(logins, 0);
    assert.match(lines.join('\n'), /disabled/);
  } finally { settings.set('agent.permissions', 'workspace'); }
});

test('unexpected provider errors do not leak response bodies', async () => {
  const lines = [];
  await auth.authCommand('chatgpt status', { engine: { session: async () => { throw Error('unexpected synthetic-secret-body'); } }, out: line => lines.push(line) });
  assert.ok(!lines.join('\n').includes('synthetic-secret-body'));
  assert.match(lines.join('\n'), /failed/);
});

test('installed setup command names the actual script and CLI auth reaches the native adapter', () => {
  const cliPath = fileURLToPath(new URL('../bin/atlias.mjs', import.meta.url));
  const setupScript = fileURLToPath(new URL('../scripts/setup-chatgpt-personal.mjs', import.meta.url));
  assert.equal(chatgpt.PREPARE_COMMAND, `"${process.execPath}" "${setupScript}" --personal`);
  const bin = path.join(home, 'fixture-bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'fixture-cli.mjs'), `if (process.argv.includes('--version')) console.log('synthetic CLI'); else if (process.argv.slice(2).join(' ') === 'auth status --json') console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai'})); else if (process.argv.slice(2).join(' ') === 'login status') console.log('Logged in using ChatGPT'); else process.exitCode=1;`);
  if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'claude.cmd'), '"%dp0%\\fixture-cli.mjs" %*');
  else fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}\nimport './fixture-cli.mjs';`, { mode: 0o755 });
  const env = { ...process.env, ATLIAS_HOME: home, PATH: bin };
  delete env.Path;
  if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'codex.cmd'), '"%dp0%\\fixture-cli.mjs" %*');
  else fs.writeFileSync(path.join(bin, 'codex'), `#!${process.execPath}\nimport './fixture-cli.mjs';`, { mode: 0o755 });
  // An installed package without the founders manifest is the release: it has no Claude route (Gev, 2026-10-30).
  const refused = spawnSync(process.execPath, [cliPath, 'auth', 'claude', 'status'], { cwd: home, env, encoding: 'utf8', windowsHide: true });
  assert.match(refused.stdout, /only in the founders edition/);
  const result = spawnSync(process.execPath, [cliPath, 'auth', 'codex', 'status'], { cwd: home, env, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /codex: authenticated; subscription sign-in reported/);
  assert.ok(!/unavailable/.test(result.stdout));
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import * as setup from '../scripts/setup-chatgpt-personal.mjs';

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlias-personal-setup-'));
  t.after(() => {
    assert.equal(path.dirname(temp), path.resolve(os.tmpdir()));
    fs.rmSync(temp, { recursive: true, force: true });
  });
  const sourceDir = path.join(temp, 'source'), baseDir = path.join(temp, 'state');
  fs.mkdirSync(path.join(sourceDir, 'packages/local/src'), { recursive: true });
  // The fixture's callback exercises the same injected extension point without
  // contacting an identity provider or reading a real account credential.
  fs.writeFileSync(path.join(sourceDir, 'packages/local/src/index.ts'), `
export function createChatGPT() {
  const authenticated = async (request, signal) => request('synthetic-fixture-token', signal);
  return {
    async streamResponse(options) { return options; },
  };
}
class ChatGPTError extends Error {}
`);
  fs.writeFileSync(path.join(sourceDir, 'package-lock.json'), JSON.stringify({ packages: Object.fromEntries(['jose', 'openai', 'proper-lockfile'].map(n => ['node_modules/' + n, { version: '1.0.0' }])) }));
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) fs.writeFileSync(path.join(sourceDir, name), 'Synthetic fixture');
  let installs = 0, failInstall = false, failSmoke = false;
  function run(command, args, options) {
    if (command === 'git') return { status: 0, stdout: args.includes('rev-parse') ? setup.PIN : '' };
    if (/^npm(?:\.cmd)?$/.test(command)) { installs++; assert.ok(args.includes('--ignore-scripts')); return { status: failInstall ? 1 : 0 }; }
    assert.equal(command, process.execPath);
    return failSmoke ? { status: 1 } : spawnSync(command, args, options);
  }
  return { sourceDir, baseDir, run, installs: () => installs, failInstall: value => { failInstall = value; }, failSmoke: value => { failSmoke = value; } };
}

test('failed dependency installation never publishes readiness and can retry', async t => {
  const f = fixture(t);
  f.failInstall(true);
  assert.throws(() => setup.preparePersonalRuntime({ ...f, personal: true }), /dependencies were not installed/);
  assert.equal(fs.existsSync(path.join(f.baseDir, 'runtime')), false);
  assert.deepEqual(fs.readdirSync(f.baseDir), []);
  f.failInstall(false);
  const result = setup.preparePersonalRuntime({ ...f, personal: true });
  const marker = JSON.parse(fs.readFileSync(path.join(result.runtime, 'PERSONAL-ONLY.json'), 'utf8'));
  assert.equal(marker.installComplete, true);
  const sdk = await import(pathToFileURL(path.join(result.runtime, 'index.js')).href);
  assert.equal(await sdk.createChatGPT().requestAuthorized(token => token === 'synthetic-fixture-token'), true);
  assert.equal(setup.preparePersonalRuntime({ ...f, personal: true }).alreadyPrepared, true);
  assert.equal(f.installs(), 2, 'a valid runtime does not reinstall dependencies');
});

test('legacy partial runtime is archived only after a complete replacement', t => {
  const f = fixture(t), runtime = path.join(f.baseDir, 'runtime');
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, 'PERSONAL-ONLY.json'), JSON.stringify({ commit: setup.PIN, personalOnly: true }));
  fs.writeFileSync(path.join(runtime, 'diagnostic.txt'), 'preserve failed install');
  const credentials = path.join(f.baseDir, 'credentials'); fs.mkdirSync(credentials); fs.writeFileSync(path.join(credentials, 'fixture.txt'), 'preserve account');
  f.failInstall(true);
  assert.throws(() => setup.preparePersonalRuntime({ ...f, personal: true }));
  assert.equal(fs.readFileSync(path.join(runtime, 'diagnostic.txt'), 'utf8'), 'preserve failed install');
  f.failInstall(false);
  const result = setup.preparePersonalRuntime({ ...f, personal: true });
  assert.equal(fs.readFileSync(path.join(result.backup, 'diagnostic.txt'), 'utf8'), 'preserve failed install');
  assert.equal(fs.readFileSync(path.join(credentials, 'fixture.txt'), 'utf8'), 'preserve account');
});

test('failed import validation leaves an unknown runtime and account files intact', t => {
  const f = fixture(t);
  f.failSmoke(true);
  assert.throws(() => setup.preparePersonalRuntime({ ...f, personal: true }), /import validation failed/);
  assert.equal(fs.existsSync(path.join(f.baseDir, 'runtime')), false);
  const runtime = path.join(f.baseDir, 'runtime'); fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(runtime, 'owner.txt'), 'unrecognized files');
  assert.throws(() => setup.preparePersonalRuntime({ ...f, personal: true }), /Unknown personal runtime/);
  assert.equal(fs.readFileSync(path.join(runtime, 'owner.txt'), 'utf8'), 'unrecognized files');
  assert.equal(f.installs(), 1);
});

test('missing personal consent or a missing source argument does not initialize state', t => {
  const f = fixture(t);
  assert.throws(() => setup.preparePersonalRuntime(f), /noncommercial license/);
  assert.equal(fs.existsSync(f.baseDir), false);
  const result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../scripts/setup-chatgpt-personal.mjs'), '--personal', '--source'], { env: { ...process.env, ATLIAS_HOME: f.baseDir }, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires a checkout directory/);
  assert.equal(fs.existsSync(f.baseDir), false);
});

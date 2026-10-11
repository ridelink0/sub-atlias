import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { sandbox, GIST } from './publish-live-sandbox.mjs';

const lockOf = pid => JSON.stringify({ pid, at: new Date().toISOString(), scope: 'atlias-live' });
const held = (text, count) => (text.match(new RegExp('"consecutive":' + count + ',', 'g')) || []).length;

// One push: the artifact is checked once, updated once, and the lock is given back.
{
  const s = sandbox('once');
  try {
    const run = s.once();
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(s.calls().map(call => call.method), ['GET', 'PATCH']);
    assert.equal(s.receipt().verified, true);
    assert.equal(s.receipt().endpoint, 'https://api.github.com/gists/' + GIST);
    assert.equal(fs.existsSync(s.lockFile), false);
    assert.match(s.log(), /"verified":true/);
    assert.equal(JSON.parse(fs.readFileSync(s.at('site', 'status.json'), 'utf8')).schema, 'atlias.public-status.v1');
    assert.equal(JSON.parse(fs.readFileSync(s.at('site', 'history.json'), 'utf8')).schema, 'atlias.public-history.v1');
  } finally { await s.clean(); }
}

// A first publication creates the artifact and records where it lives.
{
  const s = sandbox('create', { endpoint: false });
  try {
    const run = s.once();
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(s.calls().map(call => call.method), ['POST']);
    assert.equal(JSON.parse(fs.readFileSync(s.configFile, 'utf8')).endpoint, 'https://api.github.com/gists/' + GIST);
  } finally { await s.clean(); }
}

// --watch keeps publishing, checks the artifact's owner once, and ends cleanly when asked.
{
  const s = sandbox('watch');
  try {
    const child = s.watch();
    assert.ok(await s.until(() => s.calls().filter(call => call.method === 'PATCH').length >= 3), 'three cycles published');
    assert.equal(s.calls().filter(call => call.method === 'GET').length, 1);
    assert.equal(s.lock().pid, child.pid);
    fs.writeFileSync(s.stopFile, '{}');
    assert.equal(await s.exit(child), 0);
    assert.equal(fs.existsSync(s.lockFile), false);
    assert.match(s.log(), /stopped cooperatively/);
  } finally { await s.clean(); }
}

// The nightly network pause: every failed cycle is held, the publisher stays
// up, and it publishes again by itself once the network is back.
{
  const s = sandbox('outage');
  try {
    s.mode('down');
    const child = s.watch();
    assert.ok(await s.until(() => held(s.log(), 3) === 1), 'three cycles were held in a row');
    assert.equal(child.exitCode, null, 'the publisher is still running');
    assert.equal(s.receipt(), null);
    s.mode('ok');
    assert.ok(await s.until(() => s.receipt()?.verified === true), 'it published once the network returned');
    const before = held(s.log(), 1);
    s.mode('down');
    assert.ok(await s.until(() => held(s.log(), 1) > before), 'a later outage is counted from one again');
    assert.equal(child.exitCode, null);
    assert.equal(s.lock().pid, child.pid);
  } finally { await s.clean(); }
}

// A lock left by a publisher that was ended without cleaning up is taken over.
{
  const s = sandbox('stale');
  try {
    const gone = spawnSync(process.execPath, ['-e', '']).pid;
    fs.writeFileSync(s.lockFile, lockOf(gone));
    const run = s.once();
    assert.equal(run.status, 0, run.stderr);
    assert.match(s.log(), new RegExp('"staleLock":' + gone + ','));
    assert.equal(s.receipt().verified, true);
    assert.equal(fs.existsSync(s.lockFile), false);
  } finally { await s.clean(); }
}

console.log('PASS publish-live functional: one push, first creation, watch with cooperative stop, held outage with recovery, and stale-lock takeover');

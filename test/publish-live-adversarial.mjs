import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { sandbox, sleep } from './publish-live-sandbox.mjs';

const lockOf = pid => JSON.stringify({ pid, at: new Date().toISOString(), scope: 'atlias-live' });
const writes = s => s.calls().filter(call => call.method !== 'GET');

// A second publisher never displaces a running one.
{
  const s = sandbox('second');
  try {
    const first = s.watch();
    assert.ok(await s.until(() => s.receipt()?.verified === true));
    const second = s.once();
    assert.equal(second.status, 1);
    assert.match(second.stderr, /belongs to a running or unknown publisher/);
    assert.equal(s.lock().pid, first.pid, 'the running publisher keeps its lock');
    const seen = s.calls().length;
    assert.ok(await s.until(() => s.calls().length > seen), 'and it keeps publishing');
  } finally { await s.clean(); }
}

// A lock whose pid now belongs to some other program is stale; that program is left alone.
if (process.platform === 'win32') {
  const s = sandbox('reused');
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore', windowsHide: true });
  try {
    fs.writeFileSync(s.lockFile, lockOf(other.pid));
    const run = s.once();
    assert.equal(run.status, 0, run.stderr);
    assert.match(s.log(), new RegExp('"staleLock":' + other.pid + ','));
    assert.equal(other.exitCode, null, 'the other program is still running');
  } finally { other.kill(); await s.clean(); }
}

// A lock nobody can read: a fresh one may be a launch in progress and is
// respected; an old one has no owner and is taken over.
for (const body of ['', '{"pid":"12"}', '{"pid":-4}', '{"pid":1.5}', 'not json']) {
  const s = sandbox('unreadable');
  try {
    fs.writeFileSync(s.lockFile, body);
    const fresh = s.once();
    assert.equal(fresh.status, 1, 'a fresh unreadable lock is respected: ' + body);
    assert.equal(s.calls().length, 0);
    assert.equal(fs.readFileSync(s.lockFile, 'utf8'), body, 'and left as it was');
    const old = new Date(Date.now() - 120000);
    fs.utimesSync(s.lockFile, old, old);
    const later = s.once();
    assert.equal(later.status, 0, later.stderr);
    assert.match(s.log(), /"staleLock":/);
  } finally { await s.clean(); }
}

// An artifact that is not Gev's ends the publisher at once, even in --watch,
// and nothing is written to it.
{
  const s = sandbox('foreign');
  try {
    s.mode('foreign');
    assert.equal(await s.exit(s.watch()), 1);
    assert.deepEqual(s.calls().map(call => call.method), ['GET']);
    assert.match(s.log(), /Refusing to modify an unrelated public artifact/);
    assert.equal(fs.existsSync(s.lockFile), false);
  } finally { await s.clean(); }
}
{
  const s = sandbox('foreign-reply');
  try {
    s.mode('foreign-patch');
    assert.equal(await s.exit(s.watch()), 1);
    assert.deepEqual(s.calls().map(call => call.method), ['GET', 'PATCH']);
    assert.equal(s.receipt(), null);
  } finally { await s.clean(); }
}

// Creating the artifact is never retried: a lost reply plus a second attempt would leave two.
{
  const s = sandbox('create-down', { endpoint: false });
  try {
    s.mode('down');
    assert.equal(await s.exit(s.watch()), 1);
    await sleep(1200);
    assert.deepEqual(s.calls().map(call => call.method), ['POST']);
    assert.equal(fs.existsSync(s.configFile), false);
  } finally { await s.clean(); }
}

// A bundle carrying a private path is never sent; the publisher holds and
// publishes the next clean one.
{
  const s = sandbox('private');
  try {
    fs.writeFileSync(s.at('leak.flag'), '1');
    const child = s.watch();
    assert.ok(await s.until(() => (s.log().match(/privacy\/size gate refused/g) || []).length >= 2));
    assert.equal(writes(s).length, 0, 'nothing private left the machine');
    assert.equal(child.exitCode, null);
    assert.equal(s.log().includes('private/file'), false);
    fs.rmSync(s.at('leak.flag'));
    assert.ok(await s.until(() => s.receipt()?.verified === true));
  } finally { await s.clean(); }
}

// A reply that does not match what was sent is not recorded as published.
{
  const s = sandbox('mangle');
  try {
    s.mode('mangle');
    const child = s.watch();
    assert.ok(await s.until(() => /could not be reconciled/.test(s.log())));
    assert.equal(s.receipt(), null);
    assert.equal(child.exitCode, null);
    s.mode('ok');
    assert.ok(await s.until(() => s.receipt()?.verified === true));
  } finally { await s.clean(); }
}

// When the lock comes to name another publisher, this one ends and leaves that lock alone.
{
  const s = sandbox('displaced');
  try {
    const child = s.watch();
    assert.ok(await s.until(() => s.receipt()?.verified === true));
    fs.writeFileSync(s.lockFile, lockOf(1));
    assert.equal(await s.exit(child), 0);
    assert.equal(s.lock().pid, 1);
    assert.match(s.log(), /the lock now names another publisher/);
  } finally { await s.clean(); }
}

// Without --watch a failed push still ends with a failure and no receipt.
{
  const s = sandbox('once-down');
  try {
    s.mode('down');
    const run = s.once();
    assert.equal(run.status, 1);
    assert.equal(s.receipt(), null);
    assert.equal(fs.existsSync(s.lockFile), false);
    assert.deepEqual(s.calls().map(call => call.method), ['GET']);
  } finally { await s.clean(); }
}

// The log on disk is bounded.
{
  const s = sandbox('rotate');
  try {
    fs.writeFileSync(s.logFile, 'x'.repeat(1048577));
    const run = s.once();
    assert.equal(run.status, 0, run.stderr);
    assert.equal(fs.statSync(s.logFile + '.1').size, 1048577);
    assert.ok(fs.statSync(s.logFile).size < 4096);
  } finally { await s.clean(); }
}

console.log('PASS publish-live separate adversarial: second publisher, reused pid, unreadable locks, foreign artifact, unrepeatable creation, private bundle, mismatched reply, displaced lock, one-shot failure and log bound');

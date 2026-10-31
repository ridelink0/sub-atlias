import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as status from '../lib/evolution-status.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlias-status-adversarial-'));
const now = new Date('2026-10-09T20:00:00Z');
const put = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value));
try {
  const empty = status.collectStatus({ root, now, processProbe: () => true });
  assert.equal(empty.agents[0].state, 'unknown');
  assert.deepEqual(empty.results, []);
  for (const at of ['invalid', '2030-01-01T00:00:00Z']) {
    put('HEARTBEAT.json', { at, pid: 1 });
    assert.equal(status.collectStatus({ root, now, processProbe: () => true }).agents[0].state, 'unknown');
  }
  put('HEARTBEAT.json', { at: now.toISOString(), pid: 1, variant: 'v', stage: 's2' });
  put('EVOLVE-GPU.lock', { pid: 2, variant: 'v', stage: 's2' });
  assert.equal(status.collectStatus({ root, now, processProbe: () => true }).agents[0].inferenceLock, false);
  put('ARCHIVE.json', { variants: [{ id: 'bad', s1: { n: 1, passed: 2 } }, { id: 'unknown', s1: { n: 1, passed: 0, tokens: -1, output: '20', peak: Infinity } }] });
  const malformed = status.collectStatus({ root, now, processProbe: () => true });
  assert.equal(malformed.results.length, 1);
  assert.equal(malformed.results[0].promptTokens, null);
  assert.equal(malformed.results[0].outputTokens, null);
  assert.equal(malformed.results[0].providerReportedPeak, null);
  assert.equal(malformed.goals.fullNativePeak.proved, false);
  const registry = status.collectStatus({ root, now, processProbe: () => true, agentRegistry: [
    { id: 'blocked', name: 'Claude', state: 'blocked', observedAt: now.toISOString() },
    { id: 'stale', name: 'Codex', state: 'working', observedAt: '2020-01-01T00:00:00Z' },
    { id: 'done', name: 'Research', state: 'completed', observedAt: '2020-01-01T00:00:00Z' },
    { id: 'future', name: 'Future', state: 'working', observedAt: '2030-01-01T00:00:00Z' },
  ] });
  assert.equal(registry.agents.find(a => a.id === 'blocked').state, 'blocked');
  assert.equal(registry.agents.find(a => a.id === 'stale').state, 'unknown');
  assert.equal(registry.agents.find(a => a.id === 'done').state, 'completed');
  assert.equal(registry.agents.find(a => a.id === 'future').state, 'unknown');
  assert.throws(() => status.collectStatus({ root, now: new Date('invalid') }));
  console.log('PASS separate adversarial missing files, malformed/future heartbeat, conflicting lock, impossible score, invalid accounting and goal claims');
} finally { fs.rmSync(root, { recursive: true, force: true }); }

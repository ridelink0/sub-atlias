import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as status from '../lib/evolution-status.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlias-status-'));
const put = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value));
const now = new Date('2026-10-09T20:00:00Z');
try {
  put('HEARTBEAT.json', { at: now.toISOString(), pid: 1, phase: 'eval', variant: 'v0002', stage: 's2', secret: 'must never ship' });
  put('EVOLVE-GPU.lock', { pid: 1, variant: 'v0002', stage: 's2' });
  put('ARCHIVE.json', { champion: 'v0000', iterations: 2, variants: [{ id: 'v0002', config: { 'agent.ollamaModel': 'qwen3.5:9b' }, s2: { n: 60, passed: 44, tokens: 1144310, peak: 7578, hiddenTasks: ['sealed'] } }] });
  const live = status.collectStatus({ root, now, processProbe: () => true });
  assert.equal(live.agents[0].state, 'running');
  assert.equal(live.agents[0].model, 'qwen3.5:9b');
  assert.equal(live.results[0].outputTokens, null);
  assert.equal(live.results[0].fullNativePeak, null);
  assert.ok(!JSON.stringify(live).includes('must never ship') && !JSON.stringify(live).includes('sealed'));
  assert.equal(status.collectStatus({ root, now, processProbe: () => false }).agents[0].state, 'stopped');
  assert.equal(status.collectStatus({ root, now: new Date(now.getTime() + 181000), processProbe: () => true }).agents[0].state, 'unknown');
  const destination = path.join(root, 'public', 'status.json');
  const written = status.writePublicStatus({ stateRoot: root, destination, now, processProbe: () => true });
  assert.deepEqual(JSON.parse(fs.readFileSync(destination)), written);
  put('HEARTBEAT.json', { at: 'invalid', pid: -1 });
  assert.equal(status.collectStatus({ root, now, processProbe: () => true }).agents[0].state, 'unknown');
  console.log('PASS state liveness, stale heartbeat, missing native accounting, privacy whitelist and written snapshot');
} finally { fs.rmSync(root, { recursive: true, force: true }); }

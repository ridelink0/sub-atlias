import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runUltimateBoundary } from '../tools/ultimate-boundary.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-ultimate-boundary-'));
try {
  assert.equal(await runUltimateBoundary({ root, champion: { id: 'v0002', config: {} }, stopRequested: () => true }), null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'ULTIMATE-RUNS.json'))).jobs.length, 0);
  await assert.rejects(runUltimateBoundary({ root, champion: { config: {} }, engine: 'opencode' }), /original champion/);
  assert.equal(fs.existsSync(path.join(root, 'ultimate')), false);
  console.log('PASS boundary stop and wrong-engine holds start no inference and retain unavailable suites');
} finally { fs.rmSync(root, { recursive: true, force: true }); }

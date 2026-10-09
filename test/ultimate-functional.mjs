import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as fitness from '../lib/benchmark-fitness.mjs';
import * as ultimate from '../lib/ultimate-benchmark.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlias-ultimate-'));
try {
  const c = ultimate.catalog();
  assert.equal(c.suites.length, 35);
  assert.equal(new Set(c.suites.map(s => s.id)).size, 35);
  const absent = ultimate.inspectCatalog({ corpusRoot: root });
  assert.equal(absent.suites.find(s => s.id === 'main252').availability, 'corpus-unavailable-or-incomplete');
  assert.ok(absent.suites.every(s => s.completed === false));
  const interval = ultimate.wilsonInterval(44, 60);
  assert.ok(interval.lower < 44 / 60 && interval.upper > 44 / 60);
  assert.equal(ultimate.wilsonInterval(0, 0), null);
  assert.equal(ultimate.wilsonInterval(3, 2), null);
  const row = { id: 'a', tries: 1, pass: true, checkExit: true, promptTokens: [1], outputTokens: [1], peakPrompt: 1, tampered: [], weakened: [] };
  const summary = fitness.summarizeReport({ results: [row], tries: 1 }, { expectedIds: ['a'] });
  assert.equal(summary.passed, 1);
  assert.equal(fitness.pairedExact(summary, summary).bOnly, 0);
  assert.ok(fitness.playbookDelta({}, { setting: 'test', direction: 'neutral', note: 'Gev contract fixture' }));
  assert.equal(fitness.promotionEvidence(summary, summary, {}).promote, false);
  const contracts = ultimate.runSoftwareContracts({ sourceRoot: path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..') });
  assert.equal(contracts.passed, true);
  console.log('PASS Ultimate35-suite identity, unavailable-data control, statistics, direct fitness contracts and both oracle passes');
} finally { fs.rmSync(root, { recursive: true, force: true }); }

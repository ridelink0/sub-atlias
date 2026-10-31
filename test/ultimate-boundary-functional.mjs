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

// Functional: a job a dead controller left running is held, and its suite gets one retry.
{
  const { sweepOrphans, nextSuite, ORPHANED } = await import('../tools/ultimate-boundary.mjs');
  const catalog = { suites: [{ id: 'a', kind: 'corpus', availability: 'data-ready-runtime-unverified' }, { id: 'b', kind: 'corpus', availability: 'data-ready-runtime-unverified' }] };
  const journal = sweepOrphans({ jobs: [{ id: 'a', status: 'running', solved: undefined }] });
  assert.equal(journal.jobs[0].status, 'held');
  assert.equal(journal.jobs[0].reason, ORPHANED);
  assert.equal(journal.jobs[0].solved, undefined);
  assert.equal(nextSuite(catalog, journal).id, 'a');
  console.log('PASS an orphaned running job is held and its suite is retried once');
}

// Adversarial: finished jobs are untouched, a second orphan stops retries, a real hold is never retried.
{
  const { sweepOrphans, nextSuite, ORPHANED } = await import('../tools/ultimate-boundary.mjs');
  const catalog = { suites: [{ id: 'a', kind: 'corpus', availability: 'data-ready-runtime-unverified' }, { id: 'b', kind: 'corpus', availability: 'data-ready-runtime-unverified' }, { id: 'c', kind: 'corpus', availability: 'execution-evidence-required' }] };
  const done = { id: 'b', status: 'completed', solved: 9, exit: 0 }, held = { id: 'b', status: 'held', exit: 1 };
  const before = JSON.stringify([done, held]);
  const journal = sweepOrphans({ jobs: [done, held, { id: 'a', status: 'held', reason: ORPHANED }, { id: 'a', status: 'running' }] });
  assert.equal(JSON.stringify(journal.jobs.slice(0, 2)), before);
  assert.equal(nextSuite(catalog, journal), undefined);
  assert.equal(nextSuite(catalog, { jobs: [{ id: 'a', status: 'held', exit: 1 }] }).id, 'b');
  assert.equal(nextSuite({ suites: [catalog.suites[2]] }, { jobs: [] }), undefined);
  // A preferred suite goes first while it is still open; preferring a finished, unavailable or unknown suite changes nothing.
  assert.equal(nextSuite(catalog, { jobs: [] }).id, 'a');
  assert.equal(nextSuite(catalog, { jobs: [] }, ['b']).id, 'b');
  assert.equal(nextSuite(catalog, { jobs: [] }, ['zzz', 'c', 'b', 'a']).id, 'b');
  assert.equal(nextSuite(catalog, { jobs: [done] }, ['b']).id, 'a');
  assert.equal(nextSuite(catalog, { jobs: [] }, 'b').id, 'a');
  assert.equal(nextSuite(catalog, journal, ['a', 'b']), undefined);
  console.log('PASS finished jobs unchanged, retry capped at one, real holds and unavailable suites never run');
}

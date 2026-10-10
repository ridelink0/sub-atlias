// The public history after the next evolution controller: refreshed stage
// views (unrounded tokens per solve, counted output), round outcomes, the search
// policy, the three-round penalty and promotion routes. Zero inference.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectHistory } from '../lib/evolution-status.mjs';
import { collectLive } from '../lib/live-status.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlias-history-search-'));
const rows = (n, k) => Array.from({ length: n }, (_, i) => ({ key: `humanevalfix-python-${i}`, pass: i < k }));
const stage = (n, k, tokens, output) => ({ n, passed: k, tokens, output, tokensPerPass: k ? tokens / k : null, peak: 5000, partial: false, rows: rows(n, k) });
const base = { 'agent.ollamaModel': 'qwen3.5:9b' };
const champion = { id: 'v0002', parent: 'v0000', born: '2026-10-10T00:00:00Z', change: base, config: base, s1: stage(10, 7, 170000, 16000), s2: stage(60, 44, 1144308, 176008) };
const losses = [3, 4, 5].map(i => ({ id: `v000${i}`, parent: 'v0002', born: `2026-10-10T0${i}:00:00Z`, by: 'qwen3.5:9b', change: { 'agent.evictBlock': i }, config: { ...base, 'agent.evictBlock': i }, s1: stage(10, 7, 170000, 16000), s2: stage(60, 40, 1200000, 180000), vsChampionS2: { champion: 'v0002', wins: false }, roundOutcome: { status: 'completed', championBefore: 'v0002', outcome: 'not-promoted' }, searchDecision: { policy: 'archive-exploration' } }));
const superseded = { id: 'v0006', parent: 'v0002', born: '2026-10-10T06:00:00Z', by: 'qwen3.5:9b', change: { 'flags.finishOnGreen': true }, config: { ...base, 'flags.finishOnGreen': true }, roundOutcome: { status: 'not-run', outcome: 'superseded-before-evaluation' }, searchDecision: { policy: 'champion-anchored-three-round-penalty' } };
const archive = { champion: 'v0002', iterations: 6, playbook: {}, variants: [{ id: 'v0000', parent: null, born: '2026-10-09T00:00:00Z', config: {}, s1: stage(10, 1, 250000, 10000), s2: stage(60, 10, 1428530, 87874) }, champion, ...losses, superseded], promotions: [{ at: '2026-10-10T00:07:00Z', from: 'v0000', to: 'v0002', route: 'cost' }] };
fs.writeFileSync(path.join(root, 'ARCHIVE.json'), JSON.stringify(archive));
const now = new Date('2026-10-10T12:00:00Z');
const h = collectHistory({ root, now });
const v2 = h.variants.find(v => v.id === 'v0002');
// Per-solve figures from the counts: an unrounded stored ratio no longer reads as missing.
assert.equal(v2.stages.s2.tokensPerPass, 26007);
assert.equal(v2.stages.s2.outputTokens, 176008);
assert.equal(v2.stages.s2.totalPerPass, 30007);
assert.equal(h.search.penaltyActive, true);
assert.equal(h.search.measuredWithoutPromotion, 3);
assert.equal(h.search.nextParent, 'v0002');
assert.deepEqual(h.promotions, [{ at: '2026-10-10T00:07:00Z', from: 'v0000', to: 'v0002', route: 'cost' }]);
const s6 = h.variants.find(v => v.id === 'v0006');
assert.equal(s6.status, 'superseded');
assert.equal(s6.outcome, 'superseded-before-evaluation');
assert.equal(s6.searchPolicy, 'champion-anchored-three-round-penalty');
assert.equal(h.variants.find(v => v.id === 'v0003').outcome, 'not-promoted');
// The live feed names every typed change the controller can make.
const live = collectLive({ stateRoot: root, now });
assert.ok(live.status.communications.some(m => m.variant === 'v0006' && m.text === 'flags.finishOnGreen = true'));
assert.ok(live.status.communications.some(m => m.variant === 'v0003' && m.text === 'agent.evictBlock = 3'));
assert.ok(!/[A-Za-z]:[\\/]/.test(JSON.stringify(live)));
fs.rmSync(root, { recursive: true, force: true });
console.log('PASS history search functional: per-solve and output counts from refreshed views, penalty state, promotion route, outcomes, superseded rounds and every typed change in the live feed');

// Separate adversarial pass over the same public fields: missing or malformed
// counters stay Unknown (never zero), unknown outcomes and policies are dropped,
// an archive with no champion has no penalty state, and collaborator messages
// with a path, a key or an address anywhere, sender and recipient included, are
// withheld. Zero inference.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectHistory } from '../lib/evolution-status.mjs';
import { collectLive } from '../lib/live-status.mjs';
const now = new Date('2026-10-10T12:00:00Z');
const rows = (n, k) => Array.from({ length: n }, (_, i) => ({ key: `canitedit-lazy-${i}`, pass: i < k }));
const write = (archive) => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlias-history-adv-')); fs.writeFileSync(path.join(root, 'ARCHIVE.json'), JSON.stringify(archive)); return root; };
const roots = [];
// Counters: fractional tokens are not a count; absent output is Unknown, not zero.
const r1 = write({ champion: null, iterations: 1, playbook: {}, variants: [
  { id: 'v0000', parent: null, born: '2026-10-09T00:00:00Z', config: {}, s1: { n: 10, passed: 2, tokens: 12.5, output: 7, peak: 4000, rows: rows(10, 2) }, s2: { n: 60, passed: 9, tokens: 900000, peak: 7000, rows: rows(60, 9) } },
  { id: 'v0001', parent: 'v0000', born: '2026-10-09T01:00:00Z', config: {}, roundOutcome: { outcome: 'made-up' }, searchDecision: { policy: 'D:/private/x' } },
  { id: 'v0002', parent: 'v0000', born: '2026-10-09T02:00:00Z', config: {}, roundOutcome: { outcome: 'infrastructure-held' }, searchDecision: { policy: 'Archive Exploration!' } },
], promotions: [{ at: 'not a date', from: 'v0000', to: 'v0001', route: 'cost' }, { at: '2026-10-09T03:00:00Z', from: 'v0000', to: 'v0002', route: 'magic' }] });
roots.push(r1);
const h = collectHistory({ root: r1, now });
const v0 = h.variants.find(v => v.id === 'v0000');
assert.equal(v0.stages.s1.promptTokens, null); assert.equal(v0.stages.s1.tokensPerPass, null); assert.equal(v0.stages.s1.outputTokens, null); assert.equal(v0.stages.s1.totalPerPass, null);
assert.equal(v0.stages.s2.tokensPerPass, 100000); assert.equal(v0.stages.s2.outputTokens, null); assert.equal(v0.stages.s2.totalPerPass, null);
assert.equal(h.variants.find(v => v.id === 'v0001').outcome, null);
assert.equal(h.variants.find(v => v.id === 'v0001').searchPolicy, null);
assert.equal(h.variants.find(v => v.id === 'v0002').outcome, 'infrastructure-held');
assert.equal(h.variants.find(v => v.id === 'v0002').searchPolicy, null);
assert.equal(h.search, null);
assert.deepEqual(h.promotions, [{ at: '2026-10-09T03:00:00Z', from: 'v0000', to: 'v0002', route: null }]);
// A zero-solve stage has no per-solve figure, never a division by zero.
const r2 = write({ champion: 'v0000', iterations: 1, playbook: {}, variants: [{ id: 'v0000', parent: null, born: '2026-10-09T00:00:00Z', config: {}, s2: { n: 60, passed: 0, tokens: 500000, output: 40000, peak: 7000, rows: rows(60, 0) } }] });
roots.push(r2);
const z = collectHistory({ root: r2, now }).variants[0].stages.s2;
assert.equal(z.tokensPerPass, null); assert.equal(z.totalPerPass, null); assert.equal(z.outputTokens, 40000);
// Messages: anything private anywhere withholds the whole message; unknown change keys stay withheld.
const r3 = write({ champion: null, iterations: 1, playbook: {}, variants: [{ id: 'v0000', parent: null, born: '2026-10-09T00:00:00Z', config: {} }, { id: 'v0001', parent: 'v0000', born: '2026-10-09T01:00:00Z', by: 'qwen3.5:9b', config: {}, change: { 'agent.secretThing': 'x' } }] });
roots.push(r3);
const msg = (sender, recipient, text) => ({ visibility: 'reviewed-public', at: '2026-10-10T10:00:00Z', sender, recipient, text });
const live = collectLive({ stateRoot: r3, now, messages: [msg('C:\\Users\\someone', 'Claude', 'ok'), msg('Codex', 'D:/harness-work', 'ok'), msg('Codex', 'person@example.com', 'ok'), msg('Codex', 'Claude', 'Bearer abc'), msg('Codex', 'Claude', 'handoff delivered')] });
const reviewed = live.status.communications.filter(m => m.kind === 'reviewed collaborator message');
assert.equal(reviewed.length, 1); assert.equal(reviewed[0].text, 'handoff delivered');
assert.equal(live.status.communications.find(m => m.variant === 'v0001').text, 'A proposal was recorded; its contents are withheld.');
assert.ok(!/[A-Za-z]:[\\/]|example\.com|Bearer/.test(JSON.stringify(live)));
// Conversations and activity: raw words and task text never appear, unknown
// stop reasons read as other, a sealed stage shows no per-task rows, and a
// proposer label that is not a model name is never echoed.
const secretRows = (n) => Array.from({ length: n }, (_, i) => ({ key: `humanevalfix-python-${i}`, pass: i % 2 === 0 }));
const r4 = write({ champion: 'v0000', iterations: 3, playbook: {}, variants: [
  { id: 'v0000', parent: null, born: '2026-10-09T00:00:00Z', config: { 'agent.ollamaModel': 'qwen3.5:9b' }, s2: { n: 4, passed: 2, tokens: 4000, rows: secretRows(4) } },
  { id: 'v0001', parent: 'v0000', born: '2026-10-09T01:00:00Z', by: 'D:/x SECRET-LABEL', reason: 'SECRET-REASON-TEXT', change: { 'agent.evictBlock': 2 }, config: { 'agent.ollamaModel': 'C:/evil' }, s1: { n: 10, passed: 0, tokens: 0, rows: secretRows(10).map(r => ({ ...r, pass: false })) }, broken: 's1: 0 vs champion 7' },
  { id: 'v0002', parent: 'v0000', born: '2026-10-09T02:00:00Z', by: 'random (proposer unavailable)', reason: 'SECRET-REASON-TEXT', change: { 'agent.evictBlock': 6 }, config: { 'agent.ollamaModel': 'qwen3.5:9b' } },
] });
roots.push(r4);
fs.writeFileSync(path.join(r4, 'HEARTBEAT.json'), JSON.stringify({ at: now.toISOString(), pid: 1, phase: 'eval', variant: 'v0002', stage: 's1' }));
fs.mkdirSync(path.join(r4, 'variants', 'v0002'), { recursive: true });
fs.writeFileSync(path.join(r4, 'variants', 'v0002', 's1.json'), JSON.stringify({ partial: true, results: [{ id: 'humanevalfix-python-3', pass: false, stop: 'weird-new-reason', why: 'SECRET-TASK-TEXT', said: 'SECRET-TASK-TEXT', rounds: 2, promptTotal: 100, outputTotal: 10 }] }));
const l4 = collectLive({ stateRoot: r4, now });
const dump = JSON.stringify(l4);
assert.ok(!/SECRET|[A-Za-z]:[\\/]/.test(dump));
assert.equal(l4.status.activity.recent[0].stop, 'other');
const c1 = l4.status.conversations.find(c => c.variant === 'v0001').turns;
assert.ok(c1.some(t => t.from === 'Coder (model unknown)'));
assert.ok(c1.some(t => t.from === 'Evolution controller' && t.to === null && t.text === 'Chose a random change itself: agent.evictBlock = 2.'));
assert.equal(c1.at(-1).text, 'Not a capability result: no model call was counted because the model server was unreachable.');
const c2 = l4.status.conversations.find(c => c.variant === 'v0002').turns;
assert.ok(c2.some(t => t.from === 'Proposer' && t.text === 'No answer: the model server was unreachable.'));
fs.writeFileSync(path.join(r4, 'HEARTBEAT.json'), JSON.stringify({ at: now.toISOString(), pid: 1, phase: 'eval', variant: 'v0002', stage: 'c250' }));
fs.writeFileSync(path.join(r4, 'variants', 'v0002', 'c250.json'), JSON.stringify({ partial: true, results: [{ id: 'humanevalfix-python-9', pass: true, stop: 'answered', rounds: 4, promptTotal: 100, outputTotal: 10 }] }));
const sealed = collectLive({ stateRoot: r4, now }).status.activity;
assert.equal(sealed.sealed, true); assert.deepEqual(sealed.recent, []); assert.equal(sealed.stageLabel, 'sealed confirmation (250 tasks)');
// Live numbers: a sealed stage keeps its tallies private, and with no start line
// in the log there is no elapsed time, pace or finish estimate, never a guess.
const sealedStats = collectLive({ stateRoot: r4, now }).status.liveStats;
assert.deepEqual(sealedStats.stage.stopReasons, {}); assert.deepEqual(sealedStats.stage.suites, {});
assert.equal(sealedStats.stage.elapsedMinutes, null); assert.equal(sealedStats.stage.tasksPerHour, null); assert.equal(sealedStats.stage.finishEstimate, null);
assert.deepEqual(sealedStats.proposals, { modelAnswered: 0, unusableReply: 0, unreachable: 1, other: 1 });
// The two newer notes the controller writes on a held round are published as
// written; anything that only looks like one is withheld.
const notes = ['s1: this PC ran out of committed memory (300 MiB left)', 's1: too slow for the screen (300 of 360 min)', 's1: this PC ran out of committed memory (D:/private left)', 's1: too slow for the screen (300 of 360 min) at D:/private', 's1: this PC ran out of committed memory'];
const r6 = write({ champion: 'v0000', iterations: 1, playbook: {}, variants: [{ id: 'v0000', parent: null, born: '2026-10-09T00:00:00Z', config: {} }, ...notes.map((broken, i) => ({ id: `v000${i + 1}`, parent: 'v0000', born: '2026-10-11T00:00:00Z', config: {}, broken }))] }); roots.push(r6);
assert.deepEqual(collectHistory({ root: r6, now }).variants.slice(1).map(v => v.broken), [notes[0], notes[1], 'details withheld', 'details withheld', 'details withheld']);
for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
console.log('PASS history search separate adversarial: malformed and missing counters stay Unknown, zero-solve stages have no ratio, unknown outcomes/policies/routes dropped, no-champion archive has no penalty, private senders/recipients/text withheld');

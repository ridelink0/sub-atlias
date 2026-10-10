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
for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
console.log('PASS history search separate adversarial: malformed and missing counters stay Unknown, zero-solve stages have no ratio, unknown outcomes/policies/routes dropped, no-champion archive has no penalty, private senders/recipients/text withheld');

import fs from 'node:fs';
import path from 'node:path';
import * as agent from '../lib/agent.mjs';
import { executeLocal } from '../lib/opencode-agent.mjs';
import * as native from '../lib/opencode-agent.mjs';
import * as runtime from '../lib/opencode-runtime.mjs';
import * as status from '../lib/evolution-status.mjs';
import * as search from '../lib/evolution-search.mjs';
import { recordEvent } from '../lib/core.mjs';

export default async function register({ asyncSuite, check, TMP }) {
  const evidence = { happened: 'standalone adapter', why: 'A held answer must not claim completion.', fix: 'Check the native turn and exit paths.' };
  await asyncSuite('standalone functional', 'OpenCode standalone holds and host gate replay', async () => {
    const held = await executeLocal({ cwd: TMP }, 'no inference', {}, { permissions: 'read-only' });
    check('unsupported permissions hold before a process starts', !held.executed && !held.receipt && /^OpenCode held:/.test(held.text), evidence);
    check('automatic engine selection begins with OpenCode', agent.ENGINE_ORDER[0] === 'opencode', evidence);
    const dir = path.join(TMP, 'native-gate'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'broken.mjs'), 'export const = 1;');
    const st = agent.newState(dir, 'opencode');
    recordEvent(st.sid, { kind: 'edit', cwd: dir, files: ['broken.mjs'] });
    let calls = 0;
    const reply = await agent.turn(st, 'fix it', null, null, { engineTurn: async () => { calls++; return 'All tests pass now.'; } });
    check('native false completion is held by the real gate', st.lastTurnHeld && reply.includes('[atlias held the answer above:'), evidence);
    check('a held native answer does not silently buy another call', calls === 1, evidence);
  });
  await asyncSuite('native helper adversarial', 'OpenCode readiness and public history helper boundaries', async () => {
    check('source identity is independently verified', native.sourceReady().ok, evidence);
    check('localOptions denies unsupported permissions', (() => { try { native.localOptions({ permissions: 'read-only' }); return false; } catch { return true; } })(), evidence);
    check('unmeasured models stay held', !native.profileReady({ ollamaModel: 'unmeasured', ollamaNumCtx: 8192 }).ok && !native.localReady({ ollamaModel: 'unmeasured', ollamaNumCtx: 8192 }).ok, evidence);
    let now = 10, reads = 0; const cached = native.cachedReadiness(() => ({ ok: true, problems: [String(++reads)] }), 5, () => now);
    const first = cached(); first.problems.push('mutation'); cached(); now = 20; cached(); now = 1; cached();
    check('readiness cache expires and survives clock rollback and mutations', reads === 3 && cached().problems.length === 1, evidence);
    const st = { cwd: TMP, history: [] };
    const text = await native.localTurn(st, 'unmeasured default model');
    check('localTurn reports a pre-inference hold', !st.nativeExecuted && /held|not ready/.test(text), evidence);
    check('shell is denied while file tools are allowed', runtime.permissionRules().some(r => r.action === 'shell' && r.effect === 'deny') && runtime.permissionRules().some(r => r.action === 'edit' && r.effect === 'allow'), evidence);
    check('no spawned child is never reported as surveyed', !runtime.surveyDescendants(null, null).checked, evidence);
    check('profile signature sees an empty isolated home', Object.values(runtime.globalProfileSignature(TMP)).every(v => v === null), evidence);
    check('private settings never reach public changes', status.safeChange({ secret: 'private', 'agent.ollamaNumCtx': 8192 }) === 'agent.ollamaNumCtx = 8192', evidence);
    const target = path.join(TMP, 'published-history.json');
    const history = status.writePublicHistory({ stateRoot: TMP, destination: target });
    check('history writer publishes the actual empty archive', history.variants.length === 0 && JSON.parse(fs.readFileSync(target)).schema === 'atlias.public-history.v1', evidence);
    const champion = { id: 'v0000', born: new Date(0).toISOString(), config: {}, s2: { n: 1, passed: 1, rows: [{ key: 'x', pass: true }] } };
    check('a baseline has no invented plateau', search.plateauState({ champion: champion.id, variants: [champion] }).measuredUnpromoted === 0, evidence);
  });
}

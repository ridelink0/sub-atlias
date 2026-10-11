import fs from 'node:fs';
import path from 'node:path';
import { plateauState } from '../lib/evolution-search.mjs';
import { safeChange, writePublicHistory, collectHistory } from '../lib/evolution-status.mjs';

export default async function ({ asyncSuite, check: record, TMP }) {
  const check = (name, passed) => record(name, passed, { happened: String(passed), why: 'Search and publication must hold malformed evidence and preserve atomic output.', fix: 'Inspect the helper boundary before repeating the suite.' });
  await asyncSuite('evolution helper boundaries', 'evolution expert and adversary', async () => {
    let held = false;
    try { plateauState({ variants: [], champion: null }); } catch (error) { held = /dated champion/.test(error.message); }
    check('an undated archive holds the search', held);
    check('a dated champion starts without a plateau penalty', plateauState({ variants: [{ id: 'v0002', born: '2026-10-10T00:00:00Z' }], champion: 'v0002' }).penalty.active === false);
    check('only typed public settings survive hostile changes', safeChange({ 'unsafe.command': 'run', 'agent.ollamaModel': 'C:/private', 'agent.ollamaNumCtx': 16384 }) === 'agent.ollamaNumCtx = 16384');
    check('the sampling and paragraph choices are published as typed', safeChange({ 'agent.ollamaTemperature': 0.6 }) === 'agent.ollamaTemperature = 0.6' && safeChange({ 'agent.ollamaPresencePenalty': 0 }) === 'agent.ollamaPresencePenalty = 0' && safeChange({ 'agent.ollamaPresencePenalty': 0.5 }) === 'agent.ollamaPresencePenalty = 0.5' && safeChange({ 'agent.ollamaThink': 'off' }) === 'agent.ollamaThink = "off"' && safeChange({ 'flags.impliedChanges': true }) === 'flags.impliedChanges = true');
    check('a number that is negative or not finite, and any value that is not a plain scalar, stays unpublished', [-1, -0.5, NaN, Infinity, -Infinity, null, undefined, {}, [0.6], '0.6/..', 'C:/private'].every(v => safeChange({ 'agent.ollamaTemperature': v }) === '') && safeChange({ 'agent.ollamaThink': 'D:/secret/off' }) === '' && safeChange({ 'agent.ollamaSeed': 7 }) === '');
    const root = path.join(TMP, 'history-helper');
    fs.mkdirSync(root, { recursive: true });
    const destination = path.join(root, 'public.json');
    writePublicHistory({ stateRoot: root, destination });
    const history = JSON.parse(fs.readFileSync(destination, 'utf8'));
    check('a real missing archive writes an honest empty public history', history.schema === 'atlias.public-history.v1' && history.variants.length === 0 && history.champion === null);
    check('atomic history publication leaves no temporary sibling', fs.readdirSync(root).length === 1);
    // A round screened against the champion's pooled runs publishes that rule's numbers, and nothing else from it.
    const pooledRoot = path.join(TMP, 'history-pooled');
    fs.mkdirSync(pooledRoot, { recursive: true });
    const born = '2026-10-11T06:00:00Z', good = { championMean: 41.26, net: 3.74, p: 0.2031, runsPerTask: [1, 2], runs: 2, source: 'D:/private/report.json' };
    const round = (id, vsChampionS2) => ({ id, parent: 'v0002', born, change: { 'flags.impliedChanges': true }, config: {}, vsChampionS2 });
    const bad = [{ ...good, championMean: NaN }, { ...good, championMean: '41' }, { ...good, championMean: -1 }, { ...good, net: 'x' }, { ...good, p: 2 }, { ...good, p: -0.1 }, { ...good, p: null }, { ...good, runsPerTask: [0, 2] }, { ...good, runsPerTask: [1] }, { ...good, runsPerTask: 'x' }, { ...good, runsPerTask: [1, 2, 3] }, { ...good, runsPerTask: [1.5, 2] }, { ...good, runsPerTask: [3, 2] }, null, 'x'];
    fs.writeFileSync(path.join(pooledRoot, 'ARCHIVE.json'), JSON.stringify({ champion: 'v0002', iterations: 3, playbook: {}, variants: [{ id: 'v0002', parent: null, born, config: {} }, round('v0040', { rule: 'pooled champion runs', wins: false, pooled: good }), round('v0041', { rule: 'pooled champion runs', wins: true, pooled: good }), round('v0042', { wins: false, pooled: good }), round('v0043', { rule: 'something else', pooled: good }), ...bad.map((pooled, i) => round('v01' + String(i).padStart(2, '0'), { rule: 'pooled champion runs', wins: true, pooled }))] }));
    const published = collectHistory({ root: pooledRoot }), of = id => published.variants.find(v => v.id === id)?.screen;
    check('a pooled screen is published as its rounded numbers', JSON.stringify(of('v0040')) === '{"rule":"pooled","championMean":41.3,"net":3.7,"p":0.2031,"runsPerTask":[1,2],"leads":false}' && of('v0041').leads === true);
    check('a round without the pooled rule, or with a malformed record of it, publishes no screen, and no path leaves with one', of('v0002') === null && of('v0042') === null && of('v0043') === null && bad.every((_, i) => of('v01' + String(i).padStart(2, '0')) === null) && !JSON.stringify(published).includes('private'));
  });
}

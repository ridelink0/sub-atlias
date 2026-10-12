import assert from 'node:assert/strict';
import {plateauState,chooseParent,proposalChoices,selectProposal,untriedAttempt,effectiveConfig,standing} from '../lib/evolution-search.mjs';
const s={n:1,passed:1,tokens:10,rows:[{key:'a',pass:true}]};
const c={id:'v0002',born:'2026-10-10T00:00:00Z',config:{x:2},s1:s,s2:s};
const failures=[3,4,5].map(n=>({id:'v000'+n,born:`2026-10-10T00:0${n}:00Z`,config:{x:n},s1:{...s,passed:0,tokens:0,rows:[{key:'a',pass:false}]},broken:'model unavailable'}));
const a={champion:c.id,variants:[c,...failures]};
assert.equal(plateauState(a).plateau,false);assert.equal(plateauState(a).infrastructureFailures,3);
assert.equal(chooseParent(a,{random:()=>0}).parent.id,c.id);
assert.throws(()=>chooseParent(a,{random:()=>1}));assert.throws(()=>plateauState(a,{threshold:0}));
const malformed={...a,variants:[c,{...failures[0],s2:{n:2,passed:2,tokens:20,rows:[{key:'a',pass:true},{key:'a',pass:true}]}}]};
assert.equal(chooseParent(malformed,{random:()=>0.99}).parent.id,c.id);
const wrongTasks={...a,variants:[c,{...failures[0],broken:null,s2:{...s,rows:[{key:'different',pass:true}]}}]};
assert.equal(chooseParent(wrongTasks,{random:()=>0.99}).parent.id,c.id);
const newChampion={...c,born:'2026-10-10T01:00:00Z'};assert.equal(plateauState({...a,variants:[newChampion,...failures]}).measuredUnpromoted,0);
assert.equal(proposalChoices(a,c,{x:[2]}).length,0);
const pending=failures.map(v=>({...v,broken:null,s1:s,s2:undefined}));
assert.equal(plateauState({...a,variants:[c,...pending]}).measuredUnpromoted,0);
const partial=failures.map(v=>({...v,broken:null,s2:{...s,partial:true},vsChampionS2:{champion:c.id,wins:false}}));
assert.equal(plateauState({...a,variants:[c,...partial]}).measuredUnpromoted,0);
const confirmation=failures.map(v=>({...v,broken:null,s1:s,s2:s,vsChampionS2:{champion:c.id,wins:true},s3:{...s,partial:true}}));
assert.equal(plateauState({...a,variants:[c,...confirmation]}).measuredUnpromoted,0);
const losses=failures.map(v=>({...v,broken:null,s2:s,vsChampionS2:{champion:c.id,wins:false}}));
assert.equal(plateauState({...a,variants:[c,...losses]}).penalty.active,true);
assert.equal(plateauState({...a,variants:[c,...losses],promotions:[{to:c.id,at:'2026-10-10T00:06:00Z'}]}).penalty.active,false);
assert.throws(()=>plateauState({...a,promotions:[{to:c.id,at:'invalid'}]}));
assert.throws(()=>plateauState({...a,promotions:[{to:c.id,at:''}]}));
assert.equal(plateauState({...a,variants:[c,...losses.map(v=>({...v,roundOutcome:{status:'completed',championBefore:c.id,outcome:'infrastructure-held'}}))]}).measuredUnpromoted,0);
assert.throws(()=>proposalChoices(a,c,{x:[NaN]}));assert.throws(()=>selectProposal(a,c,{x:[6]},{random:()=>1}));
assert.equal(selectProposal(a,c,{x:[2]}).change,null);
const contextual={...a,variants:[c,{...losses[0],parent:'other',change:{x:3},s2:{...s,passed:0,rows:[{key:'a',pass:false}]}}]};
assert.equal(proposalChoices(contextual,c,{x:[4]})[0].contextualPenalty,0);
// An outage-only attempt (no counted call) never bans its change; a counted or pending attempt does.
assert.equal(failures.every(untriedAttempt),true);assert.ok(proposalChoices(a,c,{x:[3]}).some(ch=>ch.change.x===3));
assert.equal(proposalChoices({...a,variants:[c,...pending]},c,{x:[3]}).length,0);
assert.equal(untriedAttempt({roundOutcome:{outcome:'infrastructure-held'},s1:{...s,tokens:5}}),true);
assert.equal(untriedAttempt({roundOutcome:{outcome:'not-promoted'},s1:{...s,tokens:5}}),false);
assert.equal(untriedAttempt({roundOutcome:{outcome:'superseded-before-evaluation'}}),true);
// A value equal to the harness default is no change, and spelling a default out is the same configuration.
assert.deepEqual(effectiveConfig({x:2,y:1},{y:1}),{x:2});
assert.deepEqual(proposalChoices({...a,variants:[c]},c,{y:[1,5]},{defaults:{y:1}}).map(ch=>ch.change),[{y:5}]);
assert.equal(proposalChoices({...a,variants:[c,{...c,id:'v0009',config:{x:2,y:5},s1:s,s2:s}]},c,{y:[5]},{defaults:{y:1}}).length,0);
assert.equal(proposalChoices({...a,variants:[c,{...c,id:'v0009',config:{x:3,y:1},s1:s,s2:s}]},c,{x:[3]},{defaults:{y:1}}).length,0);
assert.deepEqual(selectProposal({...a,variants:[c]},c,{y:[1,5]},{defaults:{y:1},random:()=>0}).change,{y:5});
console.log('PASS separate adversarial: outages/pending/partial/confirmation excluded, promotion resets punishment, malformed evidence held, context scoped and exhausted search terminates safely');
// Gev, 2026-10-11, separate adversarial pass on the rounds spared the penalty.
{
  const { standing } = await import('../lib/evolution-search.mjs');
  const run = (n, passes, prefix = 't') => ({ n, passed: passes, tokens: 100, rows: Array.from({ length: n }, (_, i) => ({ key: prefix + i, pass: i < passes })) });
  const champ = { id: 'v0002', born: '2026-10-10T00:00:00Z', config: { model: 'local' }, s1: run(10, 7), s2: run(60, 44) };
  const round = (id, extra = {}) => ({ id, born: '2026-10-10T00:01:00Z', parent: 'v0002', config: { model: 'local', keep: 2 }, change: { keep: 2 }, s1: run(10, 9), s2: run(60, 50), vsChampionS2: { champion: 'v0002', better: false, cheaper: false }, ...extra });
  // A broken round, the champion itself, missing input and a round on other tasks are never at first better.
  assert.equal(standing(round('v0003', { broken: 's2: partial' }), champ, { mean: 41.5 }), 'below');
  assert.equal(standing(champ, champ, { mean: 0 }), 'below');
  for (const bad of [null, undefined, {}, { id: 'v0009' }]) assert.equal(standing(bad, champ, { mean: 41.5 }), 'below');
  assert.equal(standing(round('v0003'), null), 'below');
  assert.equal(standing(round('v0003', { s1: run(10, 9, 'other'), s2: run(60, 50, 'other') }), champ, { mean: 41.5 }), 'below');
  assert.equal(standing(round('v0003', { s2: { ...run(60, 50), partial: true }, s1: run(10, 7) }), champ, { mean: 41.5 }), 'below');
  // A mean that is not a number falls back to the champion's own screen; it never throws and never spares everything.
  for (const mean of [NaN, 'x', null, undefined, Infinity]) assert.equal(standing(round('v0003', { s1: run(10, 7), s2: run(60, 43) }), champ, { mean }), 'below');
  assert.equal(standing(round('v0003', { s1: run(10, 7), s2: run(60, 43) }), champ, { mean: -5 }), 'level');
  // Equal at the smoke stage is not ahead; one more is.
  assert.equal(standing(round('v0003', { s1: run(10, 7), s2: run(60, 30) }), champ, { mean: 41.5 }), 'below');
  assert.equal(standing(round('v0003', { s1: run(10, 8), s2: run(60, 30) }), champ, { mean: 41.5 }), 'started-ahead');
  // Under the penalty a round that only started ahead, a broken one and an unfinished one are never parents.
  const ahead = round('v0003', { s2: run(60, 30) }), broken = round('v0004', { broken: 's1: 2 vs champion 7', born: '2026-10-10T00:02:00Z' }), pending = { ...round('v0005', { born: '2026-10-10T00:03:00Z' }), vsChampionS2: undefined }, lost = round('v0006', { s1: run(10, 6), s2: run(60, 30), born: '2026-10-10T00:04:00Z' }), lost2 = round('v0007', { s1: run(10, 6), s2: run(60, 31), born: '2026-10-10T00:05:00Z' });
  const arch = { champion: 'v0002', variants: [champ, ahead, broken, pending, lost, lost2] };
  const state = plateauState(arch, { mean: 41.5 });
  assert.equal(state.penalty.active, true); assert.deepEqual(state.levelIds, []); assert.deepEqual(state.startedAheadIds, ['v0003']);
  for (let i = 0; i < 50; i++) assert.equal(chooseParent(arch, { mean: 41.5, random: () => i / 50 }).parent.id, 'v0002');
  // With a level round present the draw is checked like every other.
  const withLevel = { champion: 'v0002', variants: [champ, lost, lost2, round('v0008', { s1: run(10, 7), s2: run(60, 42), born: '2026-10-10T00:06:00Z' })] };
  for (const unit of [-0.1, 1, NaN, 'x']) assert.throws(() => chooseParent(withLevel, { mean: 41.5, random: () => unit }), /randomness/);
  // Sparing never removes a penalty earned by another round on the same setting, and never changes the archive.
  const keep = [round('v0003', { s1: run(10, 9), s2: run(60, 40) }), round('v0004', { config: { model: 'local', keep: 3 }, change: { keep: 3 }, s1: run(10, 6), s2: run(60, 40), born: '2026-10-10T00:02:00Z' })];
  const mixed = { champion: 'v0002', variants: [champ, ...keep] };
  const frozen = JSON.stringify(mixed);
  assert.equal(proposalChoices(mixed, champ, { keep: [1, 2, 3], model: ['local', 'other'] }, { mean: 41.5 }).find(ch => ch.change.keep === 1).contextualPenalty, 1);
  plateauState(mixed, { mean: 41.5 }); assert.equal(JSON.stringify(mixed), frozen);
  console.log('PASS separate adversarial: broken, unfinished, unmatched and merely-equal rounds are not spared; a bad mean spares nothing; only level rounds become parents');
}
{
  // standing() against what must not be spared: nothing to compare, the champion itself, a broken round, other tasks, a bad mean.
  const run = (n, passes) => ({ n, passed: passes, tokens: 100, rows: Array.from({ length: n }, (_, i) => ({ key: 't' + i, pass: i < passes })) });
  const champ = { id: 'v0002', s1: run(10, 7), s2: run(60, 44) };
  assert.equal(standing(null, champ), 'below');
  assert.equal(standing({ id: 'a', s1: run(10, 9), s2: run(60, 50) }, null), 'below');
  assert.equal(standing(champ, champ, { mean: 0 }), 'below');
  assert.equal(standing({ id: 'a', broken: 'crash', s1: run(10, 10), s2: run(60, 60) }, champ, { mean: 41.5 }), 'below');
  assert.equal(standing({ id: 'a', s1: run(10, 7), s2: run(30, 30) }, champ, { mean: 20 }), 'below');
  assert.equal(standing({ id: 'a', s1: run(5, 5), s2: run(60, 10) }, champ, { mean: 41.5 }), 'below');
  assert.equal(standing({ id: 'a', s1: run(10, 7), s2: run(60, 44) }, champ, { mean: NaN }), 'level');
  assert.equal(standing({ id: 'a', s1: run(10, 7), s2: run(60, 43) }, champ, { mean: NaN }), 'below');
  console.log('PASS separate adversarial: standing spares nothing it cannot compare');
}

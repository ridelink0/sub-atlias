import assert from 'node:assert/strict';
import {plateauState,chooseParent,proposalChoices,selectProposal,standing} from '../lib/evolution-search.mjs';
const stage=(passes,tokens=100)=>({n:4,passed:passes,tokens,rows:[0,1,2,3].map(i=>({key:'task-'+i,pass:i<passes}))});
const champion={id:'v0002',born:'2026-10-10T00:00:00Z',config:{budget:8,model:'local'},s1:stage(3),s2:stage(3)};
const variants=[champion,...[3,4,5].map((n,i)=>({id:'v000'+n,born:`2026-10-10T00:0${i+1}:00Z`,parent:champion.id,config:{budget:4+i,model:'local'},change:{budget:4+i},s2:stage(2),vsChampionS2:{champion:champion.id,better:false,cheaper:false}}))];
const a={champion:champion.id,variants};
assert.equal(plateauState(a).plateau,true);assert.equal(chooseParent(a).parent.id,champion.id);
assert.equal(plateauState(a).regressions.length,3);
assert.equal(plateauState({...a,variants:variants.slice(0,3)}).penalty.active,false);
assert.equal(plateauState(a).penalty.parentWeightMultiplier,0);
assert.deepEqual(plateauState(a).penalty.excludedParentIds,['v0003','v0004','v0005']);
for(const random of [0,0.5,0.999])assert.equal(chooseParent(a,{random:()=>random}).parent.id,champion.id);
const choices=proposalChoices(a,champion,{budget:[4,5,6,8,12],model:['local','different']});
assert.equal(choices.some(c=>c.change.budget===4),false);assert.ok(choices.some(c=>c.change.budget===12));
assert.deepEqual(selectProposal(a,champion,{budget:[8,12],model:['local','different']},{proposed:{budget:12},random:()=>0}).change,{model:'different'});
const before=JSON.stringify(a);chooseParent(a);proposalChoices(a,champion,{budget:[12]});assert.equal(JSON.stringify(a),before);
console.log('PASS functional: third completed round applies branch-weight penalty, champion anchoring, enforced least-penalized unseen actions and immutable scores');
// Gev, 2026-10-11: a round that was at first better than the champion is not held against its technique.
{
  const { standing } = await import('../lib/evolution-search.mjs');
  const run = (n, passes) => ({ n, passed: passes, tokens: 100, rows: Array.from({ length: n }, (_, i) => ({ key: 't' + i, pass: i < passes })) });
  const champ = { id: 'v0002', born: '2026-10-10T00:00:00Z', config: { model: 'local' }, s1: run(10, 7), s2: run(60, 44) };
  const round = (id, change, smoke, screen, minute) => ({ id, born: '2026-10-10T00:0' + minute + ':00Z', parent: 'v0002', config: { model: 'local', ...change }, change, s1: run(10, smoke), s2: run(60, screen), vsChampionS2: { champion: 'v0002', better: false, cheaper: false } });
  // Below at both stages, level with the mean, ahead at the smoke stage only, and level with the champion's own screen.
  const below = round('v0003', { keep: 2 }, 6, 40, 1), level = round('v0004', { evict: 2 }, 7, 43, 2), ahead = round('v0005', { budget: 12 }, 9, 40, 3), equal = round('v0006', { green: true }, 7, 44, 4);
  const arch = { champion: 'v0002', variants: [champ, below, level, ahead, equal] };
  assert.deepEqual([below, level, ahead, equal].map(v => standing(v, champ, { mean: 41.5 })), ['below', 'level', 'started-ahead', 'level']);
  assert.deepEqual([below, level, ahead, equal].map(v => standing(v, champ)), ['below', 'below', 'started-ahead', 'level']);
  const state = plateauState(arch, { mean: 41.5 });
  assert.equal(state.penalty.active, true); assert.equal(state.measuredUnpromoted, 4);
  assert.deepEqual(state.levelIds, ['v0004', 'v0006']); assert.deepEqual(state.startedAheadIds, ['v0005']);
  assert.deepEqual(state.penalty.excludedParentIds, ['v0003', 'v0005']);
  // Half the draws start from the champion, the other half from a level round; never from one below or one that only started ahead.
  assert.equal(chooseParent(arch, { mean: 41.5, random: () => 0.2 }).parent.id, 'v0002');
  const built = chooseParent(arch, { mean: 41.5, random: () => 0.6 });
  assert.equal(built.parent.id, 'v0004'); assert.equal(built.policy, 'archive-exploration');
  assert.equal(chooseParent(arch, { mean: 41.5, random: () => 0.99 }).parent.id, 'v0006');
  const parents = new Set(Array.from({ length: 200 }, (_, i) => chooseParent(arch, { mean: 41.5, random: () => i / 200 }).parent.id));
  assert.deepEqual([...parents].sort(), ['v0002', 'v0004', 'v0006']);
  // The setting of a level or started-ahead round carries no penalty; the setting of a round below both does.
  const space = { keep: [1, 2, 3], evict: [2, 4], budget: [12, 20], green: [true, false], model: ['local', 'other'] };
  const penalty = Object.fromEntries(proposalChoices(arch, champ, space, { mean: 41.5 }).map(c => [Object.keys(c.change)[0], c.contextualPenalty]));
  assert.deepEqual(penalty, { evict: 0, budget: 0, green: 0, model: 0, keep: 1 });
  // Without a mean the level round at 43 is below the champion's own 44 and its setting is penalised as before.
  const before2 = Object.fromEntries(proposalChoices(arch, champ, space).map(c => [Object.keys(c.change)[0], c.contextualPenalty]));
  assert.deepEqual(before2, { budget: 0, green: 0, model: 0, keep: 1, evict: 1 });
  // A proposal for a spared setting is accepted as least-penalised; one for a penalised setting is not.
  assert.deepEqual(selectProposal(arch, champ, space, { proposed: { evict: 4 }, mean: 41.5, random: () => 0 }).change, { evict: 4 });
  assert.notDeepEqual(selectProposal(arch, champ, space, { proposed: { keep: 1 }, mean: 41.5, random: () => 0 }).change, { keep: 1 });
  console.log('PASS functional: rounds level with the champion mean or ahead at the smoke stage carry no penalty, level rounds stay parents');
}
{
  // standing() by itself: level against the champion's mean, started ahead at the smoke stage, below otherwise.
  const run = (n, passes) => ({ n, passed: passes, tokens: 100, rows: Array.from({ length: n }, (_, i) => ({ key: 't' + i, pass: i < passes })) });
  const champ = { id: 'v0002', s1: run(10, 7), s2: run(60, 44) };
  assert.equal(standing({ id: 'a', s1: run(10, 7), s2: run(60, 42) }, champ, { mean: 41.5 }), 'level');
  assert.equal(standing({ id: 'a', s1: run(10, 7), s2: run(60, 42) }, champ), 'below');
  assert.equal(standing({ id: 'a', s1: run(10, 8), s2: run(60, 30) }, champ, { mean: 41.5 }), 'started-ahead');
  assert.equal(standing({ id: 'a', s1: run(10, 7), s2: run(60, 41) }, champ, { mean: 41.5 }), 'below');
  console.log('PASS functional: standing names a round level, started ahead or below');
}

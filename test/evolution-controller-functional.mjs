import assert from 'node:assert/strict';
import {pickParent,propose} from 'file:///D:/harness-work/atlias-evolve/evolve.mjs';
const stage=passed=>({n:2,passed,tokens:100,rows:[{key:'a',pass:passed>0},{key:'b',pass:passed>1}]});
const champion={id:'v0002',born:'2026-10-10T00:00:00Z',config:{'agent.keepObservations':6},s1:stage(2),s2:stage(2)};
const losses=[3,4,5].map(n=>({id:'v000'+n,parent:champion.id,born:`2026-10-10T00:0${n}:00Z`,config:{'agent.keepObservations':n},change:{'agent.keepObservations':n},s2:stage(1),vsChampionS2:{champion:champion.id,wins:false}}));
const archive={champion:champion.id,variants:[champion,...losses],playbook:{}};
assert.equal(pickParent(archive).parent.id,champion.id);
const prior=JSON.stringify(archive),originalFetch=globalThis.fetch;
try{
 globalThis.fetch=async()=>({json:async()=>({message:{content:'CHANGE agent.keepObservations = 8'}})});
 const proposal=await propose(archive,champion);
 assert.notDeepEqual(proposal.change,{'agent.keepObservations':8});
 assert.equal(proposal.contextualPenalty,0);
 assert.equal(Object.keys(proposal.change).length,1);
 assert.equal(JSON.stringify(archive),prior);
}finally{globalThis.fetch=originalFetch;}
console.log('PASS actual next-process controller import: parent penalty and proposal enforcement connected without launch, inference or archive mutation');

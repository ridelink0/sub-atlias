import assert from 'node:assert/strict';
import {pickParent,propose} from 'file:///D:/harness-work/atlias-evolve/evolve.mjs';
const s={n:1,passed:0,tokens:10,rows:[{key:'a',pass:false}]};
const c={id:'v0002',born:'2026-10-10T00:00:00Z',config:{'agent.ollamaNumCtx':16384},s1:s,s2:s};
const a={champion:c.id,variants:[c],playbook:{}};
assert.equal(pickParent(a).diagnosis.penalty.active,false);
const originalFetch=globalThis.fetch,originalRandom=Math.random;
try{
 Math.random=()=>0;
 // A no-change reply cannot force an identical configuration.
 globalThis.fetch=async()=>({json:async()=>({message:{content:'CHANGE agent.ollamaNumCtx = 16384'}})});
 const unchanged=await propose(a,c);assert.notDeepEqual(unchanged.change,{'agent.ollamaNumCtx':16384});
 // Duplicate suggestions cannot loop forever, even if the model insists.
 const duplicate={...c,id:'v0003',config:{...c.config,'agent.ollamaNumCtx':8192}};
 globalThis.fetch=async()=>({json:async()=>({message:{content:'CHANGE agent.ollamaNumCtx = 8192'}})});
 const deduped=await propose({...a,variants:[c,duplicate]},c);assert.notDeepEqual(deduped.change,{'agent.ollamaNumCtx':8192});
 // No private commands or arbitrary setting keys pass the typed boundary.
 globalThis.fetch=async()=>({json:async()=>({message:{content:'CHANGE unsafe.command = execute'}})});
 const unsafe=await propose(a,c);assert.equal(Object.hasOwn(unsafe.change,'unsafe.command'),false);
}finally{globalThis.fetch=originalFetch;Math.random=originalRandom;}
console.log('PASS separate controller adversarial: unchanged, duplicate and untyped proposals cannot bypass enforced search; no process or model launched');

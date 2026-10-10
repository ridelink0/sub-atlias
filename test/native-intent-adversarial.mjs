import assert from 'node:assert/strict';
import {nativeAccounting,runtimeOutcome} from '../lib/opencode-agent.mjs';
const intent={kind:'dispatch-intent',runId:'run',seq:1,session:{id:'s'}};
const call={...intent,kind:'chat',dispatched:true,status:'ok',tokens:{input:8,output:2}};
const cases=[
 [intent,{...call,seq:2}],
 [intent,{...call,dispatched:false}],
 [intent,{...call,session:{id:'different'}}],
 [intent,call,call],
 [intent,intent,call],
 [call,null],
 [{...call,tokens:{input:8,output:2,invalid:['cachedInput']}}],
 [{...call,dispatched:undefined,tokens:{}}],
 [{...intent,runId:null},call],
 [intent,call,{...call,seq:undefined}],
];
for(const records of cases){const a=nativeAccounting(records);assert.equal(a.complete,false);assert.equal(a.total,null);assert.ok(a.unknown>0);}
const lost=nativeAccounting(cases[0]);assert.equal(lost.lowerBound.total,10);assert.equal(lost.interrupted,1);
assert.equal(nativeAccounting([intent,call,call]).lowerBound.total,0);
const receipt={runtime:'opencode-pinned-source',status:'completed',exit:{code:0},cli:{events:1,types:{step_finish:1},sessions:{s:{}},errors:[],unparsed:[]},reconciliation:{sessions:{s:{match:true}}},globalProfileUnchanged:true};
assert.equal(runtimeOutcome(receipt,cases[0]).executed,false);
console.log('PASS separate adversarial lost intents, refused/mismatched completions, duplicate identities, malformed/invalid counters and missing dispatch evidence remain unknown and cannot qualify execution');

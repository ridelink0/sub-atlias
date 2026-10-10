import assert from 'node:assert/strict';
import {nativeAccounting} from '../lib/opencode-agent.mjs';
const intent=(seq,id='main')=>({kind:'dispatch-intent',runId:'run',seq,session:{id}});
const call=(seq,id='main')=>({...intent(seq,id),kind:'chat',dispatched:true,status:'ok',tokens:{input:8,output:2}});
const a=nativeAccounting([intent(1),call(1),intent(2,'child'),call(2,'child')]);
assert.equal(a.complete,true);assert.equal(a.dispatched,2);assert.equal(a.total,20);assert.equal(a.interrupted,0);assert.equal(a.fullNativePeakContext,null);
console.log('PASS functional durable main/child intent matching and input+output accounting; full peak remains unknown');

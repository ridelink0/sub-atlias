import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectLive } from '../lib/live-status.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'atlias-live-adversarial-'));
const put=(f,d)=>fs.writeFileSync(path.join(root,f),JSON.stringify(d));
const now=new Date('2026-10-10T06:00:00Z');
try {
  put('HEARTBEAT.json',{pid:1,variant:'../../outside',stage:'../../secret',at:'2030-01-01T00:00:00Z'});
  put('ARCHIVE.json',{champion:'v0000',variants:[{id:'v0000',reason:'private sealed prompt',change:{'agent.ollamaModel':'C:/secret.txt'},s1:{n:1,passed:0,tokens:0,peak:0},s3:{n:1,passed:1,rows:[{key:'sealed-key',pass:true}]}},{id:'v0001',s3:{n:1,passed:1,rows:[{key:'sealed-key',pass:true},{key:'sealed-key',pass:true}]}}]});
  const b=collectLive({stateRoot:root,now,processProbe:()=>true,messages:[{visibility:'reviewed-public',at:now.toISOString(),sender:'Codex',recipient:'Claude',text:'Bearer abcdefsecret'},{visibility:'private',at:now.toISOString(),sender:'Codex',recipient:'Claude',text:'private-message'}],allowance:[{host:'claude',usedPercent:-1,observedAt:'invalid',resetsAt:'invalid',source:'guess'}]});
  assert.equal(b.status.agents[0].state,'unknown'); assert.equal(b.status.progress.variant,null); assert.equal(b.status.progress.expected,null);
  assert.equal(b.status.results[0].promptTokens,null); assert.equal(b.status.results[0].providerReportedPeak,null);
  assert.equal(b.status.allowance[0].usedPercent,null); assert.equal(b.status.allowance[0].source,'unknown');
  assert.equal(b.history.comparisons.find(c=>c.a==='v0000'&&c.b==='v0001').comparable,false);
  for(const secret of ['sealed-key','private sealed prompt','secret.txt','abcdefsecret','private-message'])assert.equal(JSON.stringify(b).includes(secret),false,secret);
  assert.equal(b.status.goals.totalNativeTokens.proved,false);
  console.log('PASS separate adversarial path traversal, future timestamps, duplicate task pairs, zero unknown costs, missing quota, secret messages and sealed-task privacy');
}finally{fs.rmSync(root,{recursive:true,force:true});}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectLive } from '../lib/live-status.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlias-live-functional-'));
const put = (file, data) => { const target=path.join(root,file); fs.mkdirSync(path.dirname(target),{recursive:true}); fs.writeFileSync(target,JSON.stringify(data)); };
const now = new Date('2026-10-10T06:00:00Z');
try {
  put('HEARTBEAT.json',{at:now.toISOString(),pid:1,variant:'v0017',stage:'s2',phase:'eval'});
  put('EVOLVE-GPU.lock',{pid:1,variant:'v0017',stage:'s2'});
  put('ARCHIVE.json',{champion:'v0002',iterations:19,variants:[{id:'v0017',born:now.toISOString(),by:'qwen3.5:9b',change:{'agent.keepObservations':4},config:{'agent.ollamaModel':'qwen3.5:9b'},s1:{n:2,passed:1,tokens:200,rows:[{key:'canitedit-lazy-a',pass:true},{key:'canitedit-lazy-b',pass:false}]}}]});
  put('variants/v0017/s2.json',{partial:true,results:[{id:'private-a',pass:true},{id:'private-b',pass:false}]});
  fs.writeFileSync(path.join(root,'evolve.log'),`${now.toISOString()} v0017 s2 start (60 tasks) {}\n`);
  const b=collectLive({stateRoot:root,now,processProbe:()=>true});
  assert.equal(b.status.agents[0].state,'running'); assert.equal(b.status.progress.expected,60); assert.equal(b.status.progress.completed,2); assert.equal(b.status.progress.passed,1);
  assert.equal(b.status.communications[0].text,'agent.keepObservations = 4');
  assert.equal(b.status.historyRuns['canitedit-lazy'][0].passed,1);
  assert.equal(b.status.resources.fullPeakRAM,null); assert.equal(b.status.resources.GPU,null);
  assert.equal(JSON.stringify(b).includes('private-a'),false);
  console.log('PASS live functional heartbeat, partial task counts, actual typed proposal, mapped suite subsets and resource scope');
} finally {fs.rmSync(root,{recursive:true,force:true});}

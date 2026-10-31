import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'atlias-relay-'));
process.env.ATLIAS_HOME=path.join(dir,'home');process.env.CLAUDE_CONFIG_DIR=path.join(dir,'claude');process.env.CODEX_HOME=path.join(dir,'codex');process.env.ATLIAS_NO_DETACH='1';
const relay = await import('../lib/relay.mjs');
// Import core and the other callers only after the isolated home is selected.
const core=await import('../lib/core.mjs'), agent=await import('../lib/agent.mjs'), loop=await import('../lib/loop.mjs'), commands=await import('../lib/commands.mjs'), mcp=await import('../mcp/tools.mjs');
assert.equal(path.resolve(core.STATE_DIR),path.resolve(process.env.ATLIAS_HOME),'Tests must fail before any write if the imported runtime does not use its isolated home');
const cwd=path.join(dir,'project');fs.mkdirSync(cwd,{recursive:true});
const now=Date.now(), at=new Date(now+600000).toISOString();let native=[];
const scheduler=(job,action)=>native.push({job:structuredClone(job),action});
const set=(agentPatch={})=>core.writeJson(path.join(core.STATE_DIR,'config.json'),{agent:{...core.DEFAULTS.agent,engine:'echo',relay:'on',...agentPatch},graph:{autoBuild:false}});
const load=id=>core.readJson(path.join(core.STATE_DIR,'relays',id+'.json'));
const write=job=>core.writeJson(path.join(core.STATE_DIR,'relays',job.id+'.json'),job);
function chat(){const s=agent.newState(cwd,'echo');s.history=[{role:'user',text:'Finish the existing authorized task.'},{role:'assistant',text:'A checkpoint.'}];agent.saveChat(s);return s;}
function schedule(s=chat(),extra={},more={}){return relay.relayAction(cwd,{action:'schedule',session:s.sid,at,next_step:'Inspect the saved check receipt, then continue the original task.',...extra},{scheduler,now,...more});}
const done={code:0,json:{stop_reason:'answered',reply:'fixture completion receipt'}};
test.beforeEach(()=>{set();native=[];for(const j of relay.relayAction(cwd).jobs)if(!['completed','failed','cancelled','held','superseded','relayed'].includes(j.status))write({...load(j.id),status:'cancelled'});});
test.after(()=>fs.rmSync(dir,{recursive:true,force:true}));

test('opt-in and permission gates run before a native schedule',()=>{
 set({relay:'off'});assert.equal(relay.relayAction(cwd).enabled,false);assert.throws(()=>schedule(),/Relay is off/);
 for(const permissions of ['read-only','plan']){set({permissions});assert.throws(()=>schedule(),/permission mode/);}
 assert.equal(native.length,0);
});
test('a fresh measured reset adds five minutes and rejects early, stale and timezone-free wakes',()=>{
 const s=chat(),reset_at=new Date(now+3600000).toISOString();
 const j=schedule(s,{at:undefined,reset_at});assert.equal(Date.parse(j.at),Date.parse(reset_at)+300000);
 relay.relayAction(cwd,{action:'cancel',id:j.id},{scheduler});
 for(const args of [{at:new Date(now+1).toISOString()},{at:new Date(now+8*86400000).toISOString()},{at:'2030-01-01T12:00:00'},{reset_at:new Date(now-1).toISOString()},{reset_at,at:reset_at}])assert.throws(()=>schedule(s,args));
});
test('an exact saved session, project, next step and one pending relay are required',()=>{
 const s=chat();assert.throws(()=>schedule(s,{session:'../escape'}));assert.throws(()=>schedule(s,{next_step:''}));
 const j=schedule(s);assert.equal(j.status,'scheduled');assert.equal(j.engine,'echo');assert.throws(()=>schedule(s),/already has a pending/);
 const other=path.join(dir,'other');fs.mkdirSync(other,{recursive:true});assert.throws(()=>relay.relayAction(other,{action:'cancel',id:j.id},{scheduler}),/belongs to this project/);
 const r=relay.relayAction(cwd,{action:'cancel',id:j.id},{scheduler});assert.equal(r.status,'cancelled');
});
test('scheduler failure is recorded as failure and never reported armed',()=>{
 const s=chat();assert.throws(()=>schedule(s,{}, {scheduler(){throw Error('registration failed');}}),/registration failed/);
 assert.equal(relay.relayAction(cwd).jobs.find(j=>j.session===s.sid).status,'failed');
});
test('the final checkpoint seals the full history and turns preparing into scheduled',()=>{
 const s=chat();s.history.unshift({role:'user',text:'Keep this earlier request exactly, including '+ 'middle '.repeat(200)});
 const j=schedule(s,{}, {state:s,save:()=>agent.saveChat(s)});assert.equal(j.status,'preparing');
 s.history.push({role:'assistant',text:'Paused for the saved continuation.'});agent.saveChat(s);
 assert.equal(load(j.id).status,'scheduled');assert.equal(load(j.id).history[0].text,s.history[0].text);assert.equal(s.relayRequested,undefined);
 relay.finalizeRelay(s);
});
test('a scheduled worker cannot arm another chain, and the configured chain bound holds',()=>{
 const s=chat();assert.throws(()=>schedule(s,{}, {state:{...s,depth:1}}),/worker cannot/);
 const first=schedule(s);write({...load(first.id),status:'running',generation:3});
 assert.throws(()=>schedule(s,{}, {state:{...s,relayExecutingJob:first.id},save:()=>agent.saveChat(s)}),/run limit/);
});
test('a not-yet-due or cancelled relay calls no model',async()=>{
 const j=schedule();let calls=0;const execute=async()=>{calls++;return done;};
 assert.match((await relay.runScheduledRelay(j.id,{scheduler,now,execute})).detail,/Not due/);
 relay.relayAction(cwd,{action:'cancel',id:j.id},{scheduler});await relay.runScheduledRelay(j.id,{scheduler,now:Date.parse(at),execute});assert.equal(calls,0);
});
test('late and changed-conversation wakes are held or superseded without inference',async()=>{
 const late=schedule();assert.equal((await relay.runScheduledRelay(late.id,{scheduler,now:Date.parse(at)+86400001})).status,'held');
 const s=chat(),j=schedule(s);s.history.push({role:'user',text:'Newer instructions take precedence.'});agent.saveChat(s);
 assert.equal((await relay.runScheduledRelay(j.id,{scheduler,now:Date.parse(at)})).status,'superseded');
});
test('connection and permission changes never silently choose another account',async()=>{
 for(const patch of [{permissions:'max'},{engine:'ollama'},{chatgptModel:'different'}]){
  set();const j=schedule();set(patch);let calls=0;
  assert.equal((await relay.runScheduledRelay(j.id,{scheduler,now:Date.parse(at),execute:async()=>{calls++;return done;}})).status,'held');assert.equal(calls,0);
 }
});
test('live or unknown owners defer; only proven dead owners can release an old lease',async()=>{
 const s=chat(),release=relay.beginRelayTurn(s);const j=schedule(s);let calls=0;
 const r=await relay.runScheduledRelay(j.id,{scheduler,now:Date.parse(at),ownerAlive:()=>null,execute:async()=>{calls++;return done;}});
 assert.equal(r.status,'scheduled');assert.equal(r.attempts,0);assert.equal(calls,0);release();
 const j2=schedule();const old=relay.beginRelayTurn(chat());
 const completed=await relay.runScheduledRelay(j2.id,{scheduler,now:Date.parse(at),ownerAlive:()=>false,execute:async()=>done});assert.equal(completed.status,'completed');old();
});
test('two concurrent wakes launch exactly one continuation',async()=>{
 const j=schedule();let calls=0,finish;const waiting=new Promise(r=>finish=r);
 const a=relay.runScheduledRelay(j.id,{scheduler,now:Date.parse(at),execute:async()=>{calls++;await waiting;return done;}});
 const b=await relay.runScheduledRelay(j.id,{scheduler,now:Date.parse(at),execute:async()=>{calls++;return done;}});
 assert.match(b.detail,/already owns/);finish();assert.equal((await a).status,'completed');assert.equal(calls,1);
 await relay.runScheduledRelay(j.id,{scheduler,now:Date.parse(at),execute:async()=>{calls++;return done;}});assert.equal(calls,1);
});
test('unknown outcomes, exceptions and interrupted work are never marked completed',async()=>{
 for(const execute of [async()=>({code:0,json:{}}),async()=>({code:0,json:{stop_reason:'interrupted'}}),async()=>{throw Error('offline fixture');}]){
  const j=schedule();assert.equal((await relay.runScheduledRelay(j.id,{scheduler,now:Date.parse(at),execute})).status,'failed');
 }
 const j=schedule();write({...load(j.id),status:'running'});assert.equal((await relay.runScheduledRelay(j.id,{scheduler,now:Date.parse(at)})).status,'held');
});
test('the real echo agent resumes saved authority, labels generated notes and writes a receipt',async()=>{
 const s=chat(),j=schedule(s);const result=await relay.runScheduledRelay(j.id,{scheduler,now:Date.parse(at)});
 assert.equal(result.status,'completed');const saved=agent.loadChat(s.sid,cwd);
 assert.equal(saved.engine,'echo');assert.equal(saved.history.filter(r=>r.role==='user').length,1);
 assert.equal(saved.history.at(-2).role,'relay');assert.match(saved.history.at(-1).text,/generated handoff, not a new user request/);
 const receipt=core.readJson(path.join(core.STATE_DIR,'relays',j.id+'.json.receipt.json'));assert.equal(receipt.exit,0);assert.equal(receipt.stopReason,'answered');
});
test('relay tool is optional, pauses the loop, and runs no later tool in that response',async()=>{
 const s=chat();s.messages=[];s.relayContext={scheduler,save:()=>agent.saveChat(s)};
 const schemas=loop.toolSchemas(true,'all',['relay']);assert.ok(schemas.some(t=>t.function.name==='relay'));assert.ok(!loop.toolSchemas().some(t=>t.function.name==='relay'));
 let calls=0;const answer=await loop.runLoop(s,'Continue the authorized task.',{interactive:true,ask:async()=> 'y',chat:async()=>{calls++;return {content:'```atlias\n'+JSON.stringify({tool:'relay',action:'schedule',at,next_step:'Continue the existing task.'})+'\n```\n```atlias\n'+JSON.stringify({tool:'write_file',path:'must-not-exist.txt',content:'late write'})+'\n```',calls:[]};}});
 assert.equal(s.stop.reason,'relay-scheduled',answer);assert.match(answer,/paused, not completed/);assert.equal(calls,1);assert.equal(fs.existsSync(path.join(cwd,'must-not-exist.txt')),false);
 s.history.push({role:'assistant',text:answer});agent.saveChat(s);assert.equal(relay.relayAction(cwd).jobs.find(j=>j.session===s.sid).status,'scheduled');
});
test('slash command and MCP expose the real relay status, not a host chat resume claim',async()=>{
 let text='';const s=chat();await commands.dispatch('/relay off',{cwd,state:s,out:s=>{text+=s;},api:agent.slashApi});assert.match(text,/Relay off/);assert.equal(core.config().agent.relay,'off');
 const result=JSON.parse(mcp.callTool('harness_relay',{action:'status',cwd}));assert.equal(result.enabled,false);
 assert.match(mcp.TOOLS.find(t=>t.name==='harness_relay').description,/not a host chat id/);
 const wire=[{jsonrpc:'2.0',id:1,method:'initialize',params:{}},{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'harness_relay',arguments:{action:'status',cwd}}}].map(JSON.stringify).join('\n')+'\n';
 const out=execFileSync(process.execPath,['mcp/server.mjs'],{input:wire,encoding:'utf8',env:process.env});assert.equal(JSON.parse(out.trim().split('\n').at(-1)).result.isError,false);
});

test('native multi-call responses keep a result for every id when a relay pauses them',async()=>{
 const s=chat();s.messages=[];s.relayContext={scheduler,save:()=>agent.saveChat(s)};
 await loop.runLoop(s,'Continue the authorized task.',{interactive:true,native:true,ask:async()=> 'y',chat:async()=>({content:'',calls:[{id:'relay-call',tool:'relay',action:'schedule',at,next_step:'Continue the same task.'},{id:'late-call',tool:'write_file',path:'never-written.txt',content:'no'}]})});
 assert.equal(s.stop.reason,'relay-scheduled');assert.equal(fs.existsSync(path.join(cwd,'never-written.txt')),false);
 const ids=s.messages.filter(m=>m.role==='tool').map(m=>m.tool_call_id);assert.deepEqual(ids,['relay-call','late-call']);
 assert.match(s.messages.find(m=>m.tool_call_id==='late-call').content,/Not run/);
 s.history.push({role:'assistant',text:'Paused.'});agent.saveChat(s);
});

test('relay limits validate before saving and unknown commands show usage',async()=>{
 for(const n of [0,21,1.5])assert.ok(core.parseSetting('agent','relayMaxRuns',String(n)).error);
 assert.equal(core.parseSetting('agent','relayMaxRuns','3').value,3);
 let text='';await commands.dispatch('/relay mistaken',{cwd,state:chat(),out:s=>{text+=s;},api:agent.slashApi});assert.match(text,/Use \/relay/);
 set({permissions:'max'});const s=chat();s.interactive=true;s.relayContext={scheduler,save:()=>agent.saveChat(s)};
 const r=await loop.runTool(s,{tool:'relay',action:'status'},null);assert.equal(JSON.parse(r).enabled,true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('the actual exec JSON stream preserves tool names after terminal display branding', async t=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'atlias-progress-'));const home=path.join(tmp,'home');fs.mkdirSync(home);fs.writeFileSync(path.join(tmp,'note.txt'),'fixture content');
  const server=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;const input=JSON.parse(body);const afterRead=input.messages.some(m=>m.role==='tool');
    const message=afterRead?{role:'assistant',content:'Read the fixture note.'}:{role:'assistant',content:'',tool_calls:[{id:'read-one',type:'function',function:{name:'read_file',arguments:JSON.stringify({path:'note.txt'})}}]};
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message,finish_reason:afterRead?'stop':'tool_calls'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(tmp,{recursive:true,force:true});});
  fs.writeFileSync(path.join(home,'config.json'),JSON.stringify({agent:{engine:'openai',openaiUrl:`http://127.0.0.1:${server.address().port}/v1`,openaiModel:'fixture',nativeTools:true,permissions:'read-only',subagents:'off',testCommand:'',maxToolRounds:3},verify:{doublePass:false}}));
  const child=spawn(process.execPath,[path.resolve(import.meta.dirname,'../bin/atlias.mjs'),'exec','Read note.txt','--engine','openai','--output-format','stream-json'],{cwd:tmp,windowsHide:true,env:{...process.env,ATLIAS_HOME:home,OPENAI_API_KEY:'fixture-local-only',ATLIAS_NO_DETACH:'1'}});
  let output='',error='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>error+=d);const [code]=await once(child,'close');
  assert.equal(code,0,error);const events=output.trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(events.some(e=>e.type==='tool_call'&&e.name==='read_file'&&e.target==='note.txt'),output);
  assert.ok(events.some(e=>e.type==='done'&&e.stop_reason==='answered'),output);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Real config loading/set/reset in a child process, with an isolated state home.
// No terminal flag override is injected: the source default must do the work.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'atlias-terminal-default-'));
let checks=0;
function inspect(sourceRoot,home,action='read'){
  const core=pathToFileURL(path.join(sourceRoot,'lib/core.mjs')).href;
  const settings=pathToFileURL(path.join(sourceRoot,'lib/settings.mjs')).href;
  const source=`import * as c from ${JSON.stringify(core)};import * as s from ${JSON.stringify(settings)};let result=null;if(${JSON.stringify(action)}==='false')result=s.set('ui.terminalEnabled','false');if(${JSON.stringify(action)}==='reset')result=s.reset('ui.terminalEnabled');console.log(JSON.stringify({enabled:c.config().ui.terminalEnabled,engine:c.config().agent.engine,default:c.DEFAULTS.ui.terminalEnabled,result}));`;
  const r=spawnSync(process.execPath,['--input-type=module','-e',source],{env:{...process.env,ATLIAS_HOME:home},encoding:'utf8',windowsHide:true});
  assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout.trim());
}
function check(name,fn){fn();checks++;console.log('PASS '+name);}
try{
  const home=path.join(scratch,'state');fs.mkdirSync(home);
  const file=path.join(home,'config.json');
  check('missing config opens composer',()=>assert.equal(inspect(root,home).enabled,true));
  fs.writeFileSync(file,JSON.stringify({ui:{},agent:{engine:'codex'},guard:{destructive:true},extra:{preserve:'kept'}}));
  check('empty UI object inherits composer default',()=>assert.equal(inspect(root,home).enabled,true));
  const before=JSON.parse(fs.readFileSync(file,'utf8'));
  check('official setter preserves explicit false',()=>assert.equal(inspect(root,home,'false').enabled,false));
  check('reading again preserves opt-out across process starts',()=>assert.equal(inspect(root,home).enabled,false));
  const after=JSON.parse(fs.readFileSync(file,'utf8'));delete after.ui.terminalEnabled;
  check('setter leaves every other stored preference unchanged',()=>assert.deepEqual(after,before));
  check('official reset restores enabled default without changing engine',()=>{const r=inspect(root,home,'reset');assert.equal(r.enabled,true);assert.equal(r.engine,'codex');});
  // Plant the old default in an isolated copy and prove the default assertion fails.
  const mutant=path.join(scratch,'mutant');fs.mkdirSync(path.join(mutant,'lib'),{recursive:true});
  for(const name of ['core.mjs','settings.mjs','usage-display.mjs','edition.mjs'])fs.copyFileSync(path.join(root,'lib',name),path.join(mutant,'lib',name));
  fs.writeFileSync(path.join(mutant,'package.json'),'{"type":"module","version":"4.0.0"}');
  const corePath=path.join(mutant,'lib/core.mjs'),original=fs.readFileSync(corePath,'utf8');
  assert.ok(original.includes('terminalEnabled: true'));fs.writeFileSync(corePath,original.replace('terminalEnabled: true','terminalEnabled: false'));
  check('old-default mutation is rejected by missing-setting expectation',()=>assert.throws(()=>assert.equal(inspect(mutant,path.join(scratch,'missing')).enabled,true),/false !== true/));
  console.log(`${checks} terminal default/config controls passed; old-default plant caught.`);
}finally{
  const resolved=path.resolve(scratch);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));
  fs.rmSync(resolved,{recursive:true,force:true});
}

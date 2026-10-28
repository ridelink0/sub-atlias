// Isolate homes before Node loads any application module, including static imports.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'atlias-suite-homes-'));
const homes=[...new Set([process.env.ATLIAS_HOME,path.join(os.homedir(),'.atlias')].filter(Boolean))];
const snapshot=homes.map(home=>{
 const file=path.resolve(home,'config.json');const bytes=fs.existsSync(file)?fs.readFileSync(file):null;
 if(bytes){const dir=path.join(path.dirname(file),'config-backups');fs.mkdirSync(dir,{recursive:true});const sha=crypto.createHash('sha256').update(bytes).digest('hex');const target=path.join(dir,sha+'.json');if(!fs.existsSync(target))fs.writeFileSync(target,bytes,{flag:'wx',mode:0o600});}
 return {file,bytes};
});
const env={...process.env,ATLIAS_HOME:path.join(temp,'atlias'),CLAUDE_CONFIG_DIR:path.join(temp,'claude'),CODEX_HOME:path.join(temp,'codex'),GEMINI_CLI_HOME:path.join(temp,'gemini')};
try{
 for(const args of [['test/run.mjs'],['--test','test/subagent-routing.test.mjs','test/relay.test.mjs','test/config-backup.test.mjs','test/edition.test.mjs','test/account-session.test.mjs']]){
  const result=spawnSync(process.execPath,args,{cwd:root,env,stdio:'inherit',windowsHide:true});
  if(result.status!==0){process.exitCode=result.status??1;break;}
 }
 for(const before of snapshot){
  const after=fs.existsSync(before.file)?fs.readFileSync(before.file):null;
  if((before.bytes===null)!==(after===null)||(before.bytes&&after&&!before.bytes.equals(after))){console.error('Live Atlias preferences changed during the test window. Preserved backups are available; no automatic overwrite was attempted.');process.exitCode=2;}
 }
}finally{
 const resolved=fs.realpathSync(temp);if(resolved.startsWith(fs.realpathSync(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('atlias-suite-homes-'))fs.rmSync(resolved,{recursive:true,force:true});
}

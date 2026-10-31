import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CLAUDE_LABEL = 'Claude Code + atlias';
const SCHEMA = 'atlias.claude-statusline.v1';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive:true }); const temp=file+'.atlias-tmp';fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n');fs.renameSync(temp,file); };
const defaults = () => ({ settings:path.join(process.env.CLAUDE_CONFIG_DIR||path.join(os.homedir(),'.claude'),'settings.json'), stateFile:path.join(process.env.ATLIAS_HOME||path.join(os.homedir(),'.atlias'),'claude-statusline.json'), runner:fileURLToPath(new URL('../bin/atlias-statusline.mjs',import.meta.url)), node:process.execPath });
const quoted = value => { const s=String(value).replaceAll('\\','/');if(/["\r\n`$%!]/.test(s))throw Error('Status-line paths cannot contain shell expansion characters. Move the installation to a plain folder first.');return '"'+s+'"'; };

export function claudeLabelText(text = '') {
  const output=String(text).trimEnd();
  if(output.includes(CLAUDE_LABEL))return output;
  if(/\bClaude Code\b/.test(output))return output.replace(/\bClaude Code\b/,CLAUDE_LABEL);
  return CLAUDE_LABEL+(output?'\n'+output:'');
}

export function installClaudeLabel(options = {}) {
  const {settings,stateFile,runner,node}={...defaults(),...options};
  const before=fs.existsSync(settings)?fs.readFileSync(settings,'utf8'):null;
  const doc=before===null?{}:JSON.parse(before.replace(/^\uFEFF/,''));
  if(!doc||typeof doc!=='object'||Array.isArray(doc))throw Error('Claude settings must be a JSON object.');
  const existing=fs.existsSync(stateFile)?read(stateFile):null;
  const command=quoted(node)+' '+quoted(runner)+' --state '+quoted(stateFile);
  if(existing?.schema===SCHEMA&&doc.statusLine?.command===existing.command){
    if(existing.command===command)return {changed:false,settings,stateFile};
    doc.statusLine=existing.hadPrevious?existing.previous:undefined;
  }
  if(doc.statusLine!==undefined&&(doc.statusLine?.type!=='command'||typeof doc.statusLine.command!=='string'))throw Error('Existing status line has an unsupported shape; it was preserved.');
  const state={schema:SCHEMA,command,hadPrevious:doc.statusLine!==undefined,previous:doc.statusLine??null};
  if((fs.existsSync(settings)?fs.readFileSync(settings,'utf8'):null)!==before)throw Error('Claude settings changed concurrently; the existing settings were preserved. Run the command again.');
  write(stateFile,state);
  doc.statusLine={...(doc.statusLine||{}),type:'command',command};write(settings,doc);
  return {changed:true,settings,stateFile};
}

export function removeClaudeLabel(options = {}) {
  const {settings,stateFile}={...defaults(),...options};
  if(!fs.existsSync(stateFile)||!fs.existsSync(settings))return {changed:false};
  const before=fs.readFileSync(settings,'utf8');
  const state=read(stateFile),doc=JSON.parse(before.replace(/^\uFEFF/,''));
  if(state.schema!==SCHEMA||doc.statusLine?.command!==state.command)return {changed:false,preservedOtherOwner:true};
  if(state.hadPrevious)doc.statusLine=state.previous;else delete doc.statusLine;
  if(fs.readFileSync(settings,'utf8')!==before)throw Error('Claude settings changed concurrently; the existing settings were preserved. Run the command again.');
  write(settings,doc);return {changed:true};
}

export async function renderClaudeLabel(input, {stateFile,...options} = {}) {
  const file=stateFile||defaults().stateFile, env=options.env||process.env;
  if(env.ATLIAS_CLAUDE_LABEL_ACTIVE==='1')return CLAUDE_LABEL;
  let state;try{state=read(file);}catch{return CLAUDE_LABEL;}
  if(state.schema!==SCHEMA||!state.hadPrevious||!state.previous?.command)return CLAUDE_LABEL;
  const command=state.previous.command;
  const text=await new Promise(resolve=>{
    let output='';let settled=false;const done=()=>{if(!settled){settled=true;resolve(output);}};
    const child=(options.spawn||spawn)(command,{shell:true,windowsHide:true,env:{...env,ATLIAS_CLAUDE_LABEL_ACTIVE:'1'},stdio:['pipe','pipe','ignore']});
    child.stdout?.on('data',chunk=>{if(output.length<65536)output+=chunk.toString().slice(0,65536-output.length);});
    child.on('error',done);child.on('close',done);child.stdin?.on('error',()=>{});child.stdin?.end(input);
  });
  return claudeLabelText(text);
}

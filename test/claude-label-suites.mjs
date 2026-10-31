import { pathToFileURL } from 'node:url';
import * as label from '../lib/claude-label.mjs';
export default async function claudeLabelSuites({suite,asyncSuite,check,TMP,fs,path,ROOT}) {
 const info={why:'Gev wants Claude Code + atlias without losing the existing status line or its owner.',fix:'Preserve the prior command and restore it only while Atlias owns the setting.'};
 const folder=path.join(TMP,'claude-label');fs.mkdirSync(folder,{recursive:true});
 const options={settings:path.join(folder,'settings.json'),stateFile:path.join(folder,'state.json'),runner:path.join(ROOT,'bin/atlias-statusline.mjs')};
 const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value));const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
 suite('Claude label expert','Claude status label keeps product names adjacent and existing details',()=>{
  check('plain prior details gain the exact adjacent names',label.claudeLabelText('usage 42%')==='Claude Code + atlias\nusage 42%',info);
  check('an existing product name gains atlias beside it',label.claudeLabelText('Claude Code | model')==='Claude Code + atlias | model',info);
  check('an existing combined name is not duplicated',label.claudeLabelText('Claude Code + atlias | model')==='Claude Code + atlias | model',info);
 });
 await asyncSuite('Claude label expert','Claude status label installation, forwarding and owner-safe removal',async()=>{
  const script=path.join(folder,'previous.mjs');fs.writeFileSync(script,"let s='';for await(const c of process.stdin)s+=c;console.log('usage '+JSON.parse(s).value);");
  const previous={type:'command',command:'"'+process.execPath+'" "'+script+'"',padding:4};
  const original={statusLine:previous,enabledPlugins:{'sample@local':true},other:{keep:true}};save(options.settings,original);
  const result=label.installClaudeLabel(options),installed=read(options.settings),state=read(options.stateFile);
  check('install preserves unrelated settings and status padding',result.changed&&installed.other.keep&&installed.enabledPlugins['sample@local']&&installed.statusLine.padding===4,info);
  check('the exact previous status line is saved without session data',JSON.stringify(state.previous)===JSON.stringify(previous)&&!('input' in state),info);
  check('a second install does not create a wrapper chain',label.installClaudeLabel(options).changed===false&&JSON.stringify(read(options.stateFile).previous)===JSON.stringify(previous),info);
  const rendered=await label.renderClaudeLabel('{"value":42}',{stateFile:options.stateFile});
  check('the previous command receives the unchanged stdin and its output remains',rendered==='Claude Code + atlias\nusage 42',info);
  label.removeClaudeLabel(options);
  check('removal restores the original status configuration',JSON.stringify(read(options.settings))===JSON.stringify(original),info);
  label.installClaudeLabel(options);const foreign={...read(options.settings),statusLine:{type:'command',command:'another owner'}};save(options.settings,foreign);
  check('removal preserves a later owner',label.removeClaudeLabel(options).preservedOtherOwner&&JSON.stringify(read(options.settings))===JSON.stringify(foreign),info);
  const invalid=path.join(folder,'invalid.json');fs.writeFileSync(invalid,'broken json');let refused=false;try{label.installClaudeLabel({...options,settings:invalid});}catch{refused=true;}
  check('malformed settings are refused without replacement',refused&&fs.readFileSync(invalid,'utf8')==='broken json',info);
  let unsafe=false;try{label.installClaudeLabel({...options,runner:'bad$(command).mjs'});}catch{unsafe=true;}
  check('unsafe shell expansion in generated paths is refused',unsafe,info);
  check('recursive invocation cannot start another prior command',(await label.renderClaudeLabel('{}',{stateFile:options.stateFile,env:{ATLIAS_CLAUDE_LABEL_ACTIVE:'1'}}))===label.CLAUDE_LABEL,info);
 });
 await asyncSuite('Claude label expert','Claude status label actual-line planted regressions',async()=>{
  const source=fs.readFileSync(path.join(ROOT,'lib/claude-label.mjs'),'utf8');
  const broken=source.replace("return CLAUDE_LABEL+(output?'\\n'+output:'');",'return output;');
  check('the presentation line was actually mutated',broken!==source,info);
  const file=path.join(folder,'mutant.mjs');fs.writeFileSync(file,broken);const mutant=await import(pathToFileURL(file).href);
  const contract=implementation=>implementation.claudeLabelText('usage 42%')==='Claude Code + atlias\nusage 42%';
  check('the same visible-label contract catches the missing-prefix regression',contract(label)&&!contract(mutant),info);
  const ownerLine="if(state.schema!==SCHEMA||doc.statusLine?.command!==state.command)return {changed:false,preservedOtherOwner:true};";
  const brokenOwner=source.replace(ownerLine,"if(state.schema!==SCHEMA)return {changed:false,preservedOtherOwner:true};");
  check('the ownership guard was actually mutated',brokenOwner!==source,info);
  const ownerFile=path.join(folder,'owner-mutant.mjs');fs.writeFileSync(ownerFile,brokenOwner);const ownerMutant=await import(pathToFileURL(ownerFile).href);
  const ownerContract=implementation=>{save(options.settings,{statusLine:{type:'command',command:'first owner'}});implementation.installClaudeLabel(options);save(options.settings,{statusLine:{type:'command',command:'later owner'}});implementation.removeClaudeLabel(options);return read(options.settings).statusLine.command==='later owner';};
  check('the same owner-preservation contract catches overwriting a later owner',ownerContract(label)&&!ownerContract(ownerMutant),info);
 });
}

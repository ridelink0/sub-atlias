// Opt-in continuations for Atlias's own saved agent sessions. Never a model swap.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {STATE_DIR, ROOT, config, readJson, writeJson, ensureDir, readProjectSettings} from './core.mjs';

const ID = /^[a-f0-9]{24}$/;
const SID = /^atlias-[a-f0-9-]{36}$/;
const terminal = new Set(['completed','relayed','cancelled','superseded','failed','held']);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const folder = () => ensureDir(path.join(STATE_DIR,'relays'));
const fileFor = id => { if (!ID.test(id || '')) throw Error('Use an exact relay id from /relay status.'); return path.join(folder(),id+'.json'); };
const chatFor = sid => { if (!SID.test(sid || '')) throw Error('An exact saved Atlias agent session id is required.'); return path.join(STATE_DIR,'sessions',sid+'.chat.json'); };
const real = cwd => fs.realpathSync(cwd);
const quote = s => "'"+String(s).replaceAll("'","''")+"'";
const taskName = job => 'Atlias Relay '+job.id;
const identity = agent => hash(JSON.stringify(Object.fromEntries(Object.entries(agent).filter(([k])=>/engine|model|url|effort|permissions|sandbox|hostEngines|relayMaxRuns/i.test(k)).sort(([a],[b])=>a.localeCompare(b)))));

function powershell(text) {
  const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from("$ErrorActionPreference='Stop';"+text,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,maxBuffer:1024*1024});
  if(r.status!==0)throw Error('Windows Task Scheduler did not confirm this operation. Inspect /relay status; no success is assumed.');
  return r.stdout.trim();
}
function nativeSchedule(job, action='register') {
  if(process.platform!=='win32')throw Error('Automatic relay currently requires Windows Task Scheduler. Use atlias resume on this platform.');
  const name=quote(taskName(job));
  if(action==='remove')return powershell(`$t=Get-ScheduledTask -TaskName ${name} -ErrorAction SilentlyContinue;if($t){Unregister-ScheduledTask -TaskName ${name} -Confirm:$false}`);
  const command='& '+[process.execPath,path.join(ROOT,'bin','relay-worker.mjs'),'--home',STATE_DIR,'--id',job.id].map(quote).join(' ')+';exit $LASTEXITCODE';
  const args='-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand '+Buffer.from(command,'utf16le').toString('base64');
  powershell(`$a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${quote(args)} -WorkingDirectory ${quote(job.cwd)};$t=New-ScheduledTaskTrigger -Once -At ([DateTimeOffset]::Parse(${quote(new Date(job.at).toISOString())}).LocalDateTime);$s=New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -MultipleInstances IgnoreNew -DisallowHardTerminate -ExecutionTimeLimit ([TimeSpan]::Zero) -Priority 7;Register-ScheduledTask -TaskName ${name} -Action $a -Trigger $t -Settings $s -Description 'Opt-in Atlias saved-session continuation' -Force|Out-Null;$v=Get-ScheduledTask -TaskName ${name};if($v.Actions.Execute -ne 'powershell.exe' -or $v.Actions.Arguments -ne ${quote(args)}){throw 'Task readback mismatch'}`);
}
function jobs(cwd) {
  return fs.readdirSync(folder()).filter(n=>/^[a-f0-9]{24}\.json$/.test(n)).map(n=>readJson(path.join(folder(),n))).filter(j=>j?.cwd===cwd).sort((a,b)=>b.created-a.created);
}
function publicJob(j) { return {id:j.id,status:j.status,at:new Date(j.at).toISOString(),session:j.session,engine:j.engine,permissions:j.permissions,detail:j.detail||'',attempts:j.attempts||0}; }
function save(job) { writeJson(fileFor(job.id),job); return job; }
function checkPermissions() { if(['read-only','plan'].includes(config().agent.permissions))throw Error('Scheduling continuations is disabled in this permission mode.'); }

export function relayAction(cwd, args={}, deps={}) {
  cwd=real(cwd); const action=args.action||'status'; const scheduler=deps.scheduler||nativeSchedule;
  if(action==='status')return {enabled:config().agent.relay==='on',scheduler:process.platform==='win32'?'Windows Task Scheduler':'unsupported',jobs:jobs(cwd).slice(0,20).map(publicJob)};
  checkPermissions();
  if(action==='cancel'){
    const job=readJson(fileFor(args.id));if(!job||job.cwd!==cwd)throw Error('No relay with that id belongs to this project.');
    if(job.status==='running')throw Error('This relay is already executing. It cannot be silently terminated; interrupt its Atlias session instead.');
    if(terminal.has(job.status))return publicJob(job);
    save({...job,status:'cancelled',detail:'Cancelled by the user or model.'});
    try{scheduler(job,'remove');}catch{ return {...publicJob(readJson(fileFor(job.id))),detail:'Cancelled; scheduler cleanup is pending. A late wake will refuse to run.'}; }
    return publicJob(readJson(fileFor(job.id)));
  }
  if(action!=='schedule')throw Error('Relay actions: status, schedule, cancel.');
  if(config().agent.relay!=='on')throw Error('Relay is off. Enable it with /relay on or atlias config set agent.relay on.');
  if(process.env.ATLIAS_NO_DETACH==='1'&&!deps.scheduler)throw Error('Native scheduling is disabled in this isolated test environment.');
  const now=deps.now??Date.now();
  const reset=args.reset_at?Date.parse(args.reset_at):null;
  if(args.reset_at&&(!Number.isFinite(reset)||reset<=now))throw Error('Supply a fresh future measured reset time; stale or guessed resets are not scheduled.');
  const at=args.at?Date.parse(args.at):reset===null?NaN:reset+300000;
  if(!Number.isFinite(at)||at<now+10000||at>now+7*86400000)throw Error('Choose an ISO time with a timezone, at least ten seconds ahead and within seven days.');
  if(!/Z$|[+-]\d\d:\d\d$/.test(args.at||args.reset_at||''))throw Error('The relay time must include Z or a timezone offset.');
  if(reset!==null&&at<reset+300000)throw Error('A usage-reset relay must be at least five minutes after the measured reset.');
  const note=String(args.next_step||'').trim();if(!note||note.length>20000)throw Error('Save a concrete next step of 1 to 20,000 characters.');
  const session=deps.state?.sid||args.session;
  if(deps.state?.depth>0)throw Error('A worker cannot schedule another unattended agent.');
  deps.save?.();
  const chat=readJson(chatFor(session));
  if(!chat||real(chat.cwd)!==cwd||chat.sid!==session)throw Error('Save this exact Atlias agent session in this project before scheduling it.');
  if(chat.authorityMissing)throw Error('The saved session has incomplete user authority. Repair its handoff before scheduling.');
  if(jobs(cwd).some(j=>!terminal.has(j.status)&&j.session===session&&j.id!==deps.state?.relayExecutingJob))throw Error('This session already has a pending relay. Inspect or cancel it before scheduling another.');
  const parent=deps.state?.relayExecutingJob?readJson(fileFor(deps.state.relayExecutingJob)):null;
  const generation=(parent?.generation||0)+1;
  const maxRuns=Math.max(1,Math.min(20,Number(config().agent.relayMaxRuns)||3));
  if(generation>maxRuns)throw Error('This relay chain reached its configured run limit. Ask the user before extending it.');
  const job={version:1,id:crypto.randomBytes(12).toString('hex'),cwd,session,engine:chat.engine,permissions:config().agent.permissions,identity:identity(config().agent),at,created:now,status:deps.state?'preparing':'scheduled',nextStep:note,generation,attempts:0,waits:0,chatHash:hash(fs.readFileSync(chatFor(session)))};
  save(job);
  try{scheduler(job,'register');}catch(error){save({...job,status:'failed',detail:error.message});throw error;}
  if(deps.state){deps.state.relayJob=job.id;deps.state.relayRequested=true;}
  return publicJob(job);
}

export function finalizeRelay(state) {
  if(!state?.relayJob)return;
  const job=readJson(fileFor(state.relayJob));
  if(!job||job.status!=='preparing')return;
  const history=Array.isArray(state.history)?state.history:[];
  if(Buffer.byteLength(JSON.stringify(history))>2*1024*1024){save({...job,status:'held',detail:'Full saved request history exceeds the relay safety bound; write a reviewed handoff.'});return;}
  save({...job,status:'scheduled',chatHash:hash(fs.readFileSync(chatFor(job.session))),history});
  delete state.relayJob;delete state.relayRequested;
}

// A foreground turn owns a project lease, including native clients whose calls
// block Node's timers. A stale timestamp alone never proves its owner exited.
const activePath=cwd=>path.join(folder(),'active-'+hash(cwd).slice(0,24)+'.json');
function ownerAlive(record) {
  if(record.pid===process.pid&&Math.abs((Date.now()-process.uptime()*1000)-record.started)<5000)return true;
  if(process.platform!=='win32')return null;
  try{
    const out=powershell(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(record.pid)}';if($p){[DateTimeOffset]$p.CreationDate|ForEach-Object{$_.ToUnixTimeMilliseconds()}}else{'absent'}`);
    if(out==='absent')return false;
    if(!/^\d{12,16}$/.test(out))return null;
    const start=Number(out);return Number.isFinite(start)?Math.abs(start-record.started)<5000:null;
  }catch{return null;}
}
function clearDeadLease(file, alive=ownerAlive) {
  const old=readJson(file);if(!old)return !fs.existsSync(file);
  if(alive(old)!==false)return false;
  fs.renameSync(file,file+'.stale-'+Date.now());return true;
}
export function beginRelayTurn(state, deps={}) {
  if(config().agent.relay!=='on'||state.depth>0)return ()=>{};
  const f=activePath(real(state.cwd));
  if(fs.existsSync(f)&&!clearDeadLease(f,deps.ownerAlive))throw Error('Another Atlias turn owns this project. Relay will wait rather than start a duplicate.');
  const token=crypto.randomBytes(16).toString('hex');
  const record={pid:process.pid,started:Date.now()-process.uptime()*1000,token,session:state.sid};
  fs.writeFileSync(f,JSON.stringify(record),{flag:'wx',mode:0o600});
  return ()=>{if(readJson(f)?.token===token)fs.unlinkSync(f);};
}

export async function runScheduledRelay(id, deps={}) {
  const f=fileFor(id), scheduler=deps.scheduler||nativeSchedule;
  let job=readJson(f);if(!job)throw Error('Relay record is missing.');
  if(terminal.has(job.status))return publicJob(job);
  const claim=f+'.claim';
  let fd;
  try{fd=fs.openSync(claim,'wx');}
  catch{
    const owner=readJson(claim), alive=owner?(deps.ownerAlive||ownerAlive)(owner):null;
    if(alive===false){fs.renameSync(claim,claim+'.stale-'+Date.now());return runScheduledRelay(id,deps);}
    return {...publicJob(job),status:alive===true?job.status:'held',detail:'A wake already owns this relay, or its outcome is unknown. No duplicate was launched.'};
  }
  fs.writeFileSync(fd,JSON.stringify({pid:process.pid,started:Date.now()-process.uptime()*1000}));
  try{
    if(job.status==='running'){job=save({...job,status:'held',detail:'A previous launch has no completion receipt. Its outcome requires review; it is not rerun.'});return publicJob(job);}
    const now=deps.now??Date.now();
    if(now<job.at)return {...publicJob(job),detail:'Not due; no model was called.'};
    if(now-job.at>86400000){job=save({...job,status:'held',detail:'This wake is over a day late. Review the task before resuming.'});return publicJob(job);}
    readProjectSettings(job.cwd);
    if(config().agent.relay!=='on'){job=save({...job,status:'cancelled',detail:'Relay was disabled before the wake.'});return publicJob(job);}
    if(identity(config().agent)!==job.identity){job=save({...job,status:'held',detail:'Connection, model or permissions changed. Reschedule under the current settings.'});return publicJob(job);}
    const active=activePath(job.cwd);
    if(job.status==='preparing'||(fs.existsSync(active)&&!clearDeadLease(active,deps.ownerAlive))){
      const waits=(job.waits||0)+1;
      job=save({...job,status:waits>10?'held':'scheduled',waits,at:now+120000,detail:'Waiting for the existing turn or saved handoff; no model called.'});
      if(job.status==='scheduled')scheduler(job,'register');return publicJob(job);
    }
    if(!fs.existsSync(chatFor(job.session))||hash(fs.readFileSync(chatFor(job.session)))!==job.chatHash){job=save({...job,status:'superseded',detail:'The saved conversation changed after scheduling. Its newer work takes precedence.'});return publicJob(job);}
    const saved=readJson(chatFor(job.session));
    if(!saved||saved.engine!==job.engine||real(saved.cwd)!==job.cwd){job=save({...job,status:'held',detail:'Saved session identity changed.'});return publicJob(job);}
    job=save({...job,status:'running',attempts:job.attempts+1,started:now});
    const execute=deps.execute|| (async job=>{
      const agent=await import('./agent.mjs');
      const previous=process.cwd();try{process.chdir(job.cwd);return await agent.runOnce({resume:job.session,relay:job});}finally{process.chdir(previous);}
    });
    try{
      const result=await execute(job);
      const reason=result?.json?.stop_reason;
      const success=result?.code===0&&['answered','relay-scheduled'].includes(reason);
      job=save({...job,status:success?(reason==='relay-scheduled'?'relayed':'completed'):'failed',finished:Date.now(),exit:result?.code??null,stopReason:reason||'unknown',detail:success?'Saved-session continuation returned a receipt.':'Continuation did not complete; inspect its receipt before retrying.'});
      writeJson(f+'.receipt.json',{exit:result?.code??null,stopReason:reason||'unknown',result:result?.json||null});
    }catch(error){job=save({...job,status:'failed',finished:Date.now(),detail:'Continuation failed: '+String(error.message).slice(0,500)});}
    return publicJob(job);
  }finally{
    if(fd!==undefined){fs.closeSync(fd);fs.unlinkSync(claim);}
    const latest=readJson(f);if(latest&&terminal.has(latest.status))try{scheduler(latest,'remove');}catch{save({...latest,cleanupPending:true});}
  }
}

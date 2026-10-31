import * as editionMod from '../lib/edition.mjs';import {bareCommand, rows as settingRows} from '../lib/settings.mjs';import {BUILTINS} from '../lib/commands.mjs';import * as onboardingMod from '../lib/onboarding.mjs';
import * as settings from '../lib/settings.mjs';import * as commands from '../lib/commands.mjs';import * as engines from '../lib/engines.mjs';import {authCommand} from '../lib/auth-command.mjs';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
export default async function editionSuites({suite,asyncSuite,check,core,agentMod,TMP,fs,path}){
 suite('private edition expert','private edition first-open defaults preserve user configuration and ordinary hosts',()=>{const root=path.join(TMP,'private-edition-contract');fs.mkdirSync(root,{recursive:true});const file=path.join(root,'DISTRIBUTION.json');const detail={happened:'edition launch did not match the validated package manifest',why:'The private friend must open the Atlias app without falling into a host-only chooser.',fix:'Read trusted edition metadata and preserve ordinary install behavior.'};check('a normal source checkout has no private override',editionMod.editionDefaults(root)===null,detail);fs.writeFileSync(file,JSON.stringify({schema:'atlias.private-distribution.v1',edition:'claude-friend',preferredEngine:'claude-plan'}));const edition=editionMod.editionDefaults(root);check('friend package selects the official SDK and keeps a separate onboarding record',edition.preferredEngine==='claude-plan'&&edition.onboardingFile==='onboarding-claude-friend.json',detail);check('legacy plugin-only mode does not hide the friend terminal UI',bareCommand('sub',true,edition)==='agent'&&bareCommand('both',true,edition)==='agent',detail);check('noninteractive and ordinary host behavior remain available',bareCommand('sub',false,edition)==='help'&&bareCommand('sub',true,null)==='status',detail);});
 suite('release edition expert','the release offers no Claude engine; the founders edition keeps it',()=>{
  const detail={happened:'the Claude engine showed in the wrong edition',why:'Gev (2026-10-29): the release has no Claude; the founders edition (Gev and his friend) has it.',fix:'Gate every Claude offer on claudeOffered(edition).'};
  const founders={name:'Founders edition',preferredEngine:'claude-plan'},found={claudePlan:true,ollama:true};
  check('only a founders edition offers Claude',editionMod.claudeOffered(null)===false&&editionMod.claudeOffered(founders)===true,detail);
  check('the release menu has no Claude row and the founders menu does',!onboardingMod.visibleChoices({hostEngines:'off'},false).some(r=>r.method==='claude-plan')&&onboardingMod.visibleChoices({hostEngines:'off'},true).some(r=>r.method==='claude-plan'),detail);
  check('the release never recommends Claude, even with a Claude sign-in on the computer',onboardingMod.recommended(found,false)==='3'&&onboardingMod.recommended({},false)==='3'&&onboardingMod.recommended(found,true)==='1',detail);
  const release=onboardingMod.welcomeText(found,{hostEngines:'off'},0,true,null,false),friend=onboardingMod.welcomeText(found,{hostEngines:'off'},0,true,null,true);
  check('the release welcome names no Claude route; the founders welcome does',!/Claude/.test(release)&&/Use my Claude plan/.test(friend)&&/your Claude sign-in/.test(friend),{...detail,happened:release});
  const lines=[];const row=onboardingMod.setupClaudePlan({edition:null,out:t=>lines.push(t)});
  check('setup claude in the release says so and installs nothing',lines[0]===editionMod.CLAUDE_FOUNDERS_ONLY&&row instanceof Promise,{...detail,happened:lines});
  const offered=()=>{const all=settingRows(),engine=all.find(r=>r.id==='agent.engine'),usage=BUILTINS.filter(c=>['auth','engine'].includes(c.name)).map(c=>c.usage).join(' ');return {plan:all.some(r=>/^agent\.claudePlan/.test(r.id)),choice:engine.choices.includes('claude-plan'),about:/claude-plan/.test(engine.about),usage:/claude-plan/.test(usage),numbered:all.every((r,i)=>r.number===i+1)};};
  const shown=offered();editionMod.offerClaudeForTests(true);let friendShown;try{friendShown=offered();}finally{editionMod.offerClaudeForTests(false);}
  check('release settings and command usage name no claude-plan; the founders edition lists all of it',!shown.plan&&!shown.choice&&!shown.about&&!shown.usage&&shown.numbered&&friendShown.plan&&friendShown.choice&&friendShown.about&&friendShown.usage&&friendShown.numbered,{...detail,happened:JSON.stringify({shown,friendShown})});
 });
 // Gev (2026-10-30): the release has no Claude at all. Three routes reach Claude: the claude-plan engine,
 // the claude host harness (Claude Code) and the anthropic API engine (ANTHROPIC_API_KEY). Each is refused at
 // every entry point in the release and offered in the founders edition. No check here sends a model request:
 // the Anthropic key is a fake, its URL points at a closed local port, and every host probe is a stub.
 await asyncSuite('release edition expert','the release refuses all three Claude routes at every entry point; the founders edition offers each',async()=>{
  const ONLY=editionMod.CLAUDE_FOUNDERS_ONLY,THREE=['claude-plan','claude','anthropic'];
  const detail=(happened)=>({happened:typeof happened==='string'?happened:JSON.stringify(happened),why:'Gev (2026-10-30): the release has no Claude at all; the founders edition keeps every Claude route.',fix:'Gate the route on engineOffered(engine) from lib/edition.mjs.'});
  const founders=async(fn)=>{editionMod.offerClaudeForTests(true);try{return await fn();}finally{editionMod.offerClaudeForTests(false);}};
  const clean=(t)=>!/claude|anthropic/i.test(String(t));
  let n=0;const tmp=(name)=>{const d=path.join(TMP,'release-claude',`${name}-${++n}`);fs.mkdirSync(d,{recursive:true});return d;};
  const cfg=()=>core.config().agent;
  const before={key:process.env.ANTHROPIC_API_KEY,engine:cfg().engine};
  const restore=(id,value,def)=>value===def?settings.reset(id):settings.set(id,typeof value==='string'?value:JSON.stringify(value));
  const keep={anthropicModel:cfg().anthropicModel,anthropicUrl:cfg().anthropicUrl,hostEngines:cfg().hostEngines};
  try{
   settings.set('agent.hostEngines','on');settings.set('agent.anthropicUrl','http://127.0.0.1:9/v1');settings.set('agent.anthropicModel','claude-test-model');process.env.ANTHROPIC_API_KEY='sk-ant-test-not-a-real-key';
   check('the edition helpers: only the founders edition offers the three Claude engines; every other engine is offered in both',THREE.every(e=>!editionMod.engineOffered(e,false)&&editionMod.engineOffered(e,true))&&['chatgpt','responses','gemini','openai','ollama','codex','echo','auto'].every(e=>editionMod.engineOffered(e,false))&&editionMod.offeredEngines(['claude-plan','chatgpt','claude','codex','anthropic'],false).join('|')==='chatgpt|codex'&&editionMod.offeredEngines(['claude-plan','chatgpt','claude','codex','anthropic'],true).join('|')==='claude-plan|chatgpt|claude|codex|anthropic',detail('engineOffered'));
   // Engine selection in lib/agent.mjs, auto-detection included.
   const have=agentMod.detectEngines({includeHosts:false});
   check('release auto-detection does not list anthropic with ANTHROPIC_API_KEY and a model set, so auto never picks it',have.anthropic===false&&have['claude-plan']===false&&engines.chooseEngine('auto',have)!=='anthropic'&&engines.chooseEngine('auto',{...have,ollama:false,openai:false,chatgpt:false,responses:false,gemini:false})===null,detail(have));
   const foundersHave=await founders(()=>agentMod.detectEngines({includeHosts:false}));
   check('founders auto-detection lists anthropic once its key and model are set',foundersHave.anthropic===true,detail(foundersHave));
   check('release pickEngine refuses all three, named or saved',THREE.every(e=>agentMod.pickEngine(e)===null),detail(THREE.map(e=>agentMod.pickEngine(e))));
   check('founders pickEngine still selects anthropic',await founders(()=>agentMod.pickEngine('anthropic'))==='anthropic',detail('founders pickEngine anthropic'));
   const routes=[];for(const e of THREE){try{await agentMod.chatRoute(e,cfg());routes.push('opened');}catch(error){routes.push(error.message);}}
   check('release chatRoute refuses all three with the founders-only text, so a worker cannot reach them either',routes.every(r=>r===ONLY),detail(routes));
   const opened=await founders(()=>agentMod.chatRoute('anthropic',cfg()));
   check('founders chatRoute opens the anthropic route without sending anything',typeof opened.chat==='function',detail(Object.keys(opened)));
   const turns=[];let spawned=0;
   for(const e of THREE)turns.push(await agentMod.turn(agentMod.newState(tmp('turn'),e),'hello',null,null,{run:()=>{spawned++;return {status:0,stdout:'x'};}}));
   check('release: a saved claude-plan, claude or anthropic session is refused at its turn and runs nothing',turns.every(r=>String(r).includes(ONLY))&&spawned===0,detail(turns));
   check('release HOST_OFF refuses the claude host and the codex text names no Claude route',agentMod.HOST_OFF('claude')===ONLY&&clean(agentMod.HOST_OFF('codex'))&&/codex host harness is off/.test(agentMod.HOST_OFF('codex')),detail([agentMod.HOST_OFF('claude'),agentMod.HOST_OFF('codex')]));
   check('founders HOST_OFF is unchanged',await founders(()=>agentMod.HOST_OFF('claude'))==="Atlias runs the model itself, so the claude host harness is off. Use /engine claude-plan for your Claude plan (Atlias's own loop), /onboarding to choose another route, or atlias config set agent.hostEngines on to allow host harnesses. Nothing was sent.",detail(await founders(()=>agentMod.HOST_OFF('claude'))));
   check('release NO_ENGINE lists no anthropic or claude route, and the founders text is unchanged',clean(agentMod.NO_ENGINE)&&/ollama for local models/.test(agentMod.NO_ENGINE)&&agentMod.noEngineText(true)==='Choose a direct engine explicitly: /engine claude-plan for your Claude plan (atlias setup claude), /engine chatgpt with /auth chatgpt login (local personal prototype), responses with OPENAI_API_KEY, anthropic with ANTHROPIC_API_KEY, gemini with GEMINI_API_KEY, openai for a compatible endpoint, or ollama for local models. API billing is separate. Auto requires exactly one configured direct engine. claude and codex are explicit host harness modes. /onboarding opens setup; --engine echo makes no model calls.',detail(agentMod.NO_ENGINE));
   // Slash commands: /engine, /agents, /auth, /connections and their usage.
   const slash=async(line,api={})=>{const out=[];const state=agentMod.newState(tmp('slash'),'echo');await commands.dispatch(line,{state,cwd:TMP,out:t=>out.push(String(t)),ask:async()=>'',api});return {text:out.join('\n'),state};};
   let picked=0;const releaseEngine=[];for(const e of THREE)releaseEngine.push(await slash(`/engine ${e}`,{pickEngine:x=>{picked++;return x;}}));
   check('release /engine refuses all three with the founders-only text and selects nothing',releaseEngine.every(r=>r.text.includes(ONLY)&&r.state.engine==='echo')&&picked===0,detail(releaseEngine.map(r=>r.text)));
   const foundersEngine=await founders(async()=>{const rows=[];for(const e of THREE)rows.push(await slash(`/engine ${e}`,{pickEngine:x=>x}));return rows;});
   check('founders /engine selects each of the three',foundersEngine.every((r,i)=>r.state.engine===THREE[i]&&!r.text.includes(ONLY)),detail(foundersEngine.map(r=>r.text)));
   const releaseAgents=[];for(const e of ['claude-plan','anthropic'])releaseAgents.push(await slash(`/agents ${e}`,{detectEngines:()=>({'claude-plan':true,anthropic:true})}));
   check('release /agents refuses claude-plan and anthropic as the worker connection and saves nothing',releaseAgents.every(r=>r.text.includes(ONLY))&&cfg().subagentEngine!=='anthropic'&&cfg().subagentEngine!=='claude-plan',detail(releaseAgents.map(r=>r.text)));
   const foundersAgents=await founders(()=>slash('/agents anthropic',{detectEngines:()=>({})}));
   check('founders /agents still takes anthropic (here: says it is not connected)',/anthropic is not connected/.test(foundersAgents.text),detail(foundersAgents.text));
   const usage=()=>commands.BUILTINS.filter(c=>['auth','engine'].includes(c.name)).map(c=>c.usage).join('\n');
   check('release /engine and /auth usage name no Claude route; the founders usage is unchanged',clean(usage())&&usage()==='/auth [chatgpt|codex] [action]\n/engine chatgpt|responses|gemini|openai|ollama|codex|echo'&&await founders(usage)==='/auth [claude-plan|chatgpt|claude|codex] [action]\n/engine claude-plan|chatgpt|responses|anthropic|gemini|openai|ollama|claude|codex|echo',detail(usage()));
   const conn=await slash('/connections'),foundersConn=await founders(()=>slash('/connections'));
   check('release /connections lists no Anthropic API; the founders list keeps it',clean(conn.text.replace(/^Current connection: echo/,''))&&/Anthropic API/.test(foundersConn.text)&&/Claude and ChatGPT subscriptions/.test(foundersConn.text),detail(conn.text));
   const auth=async(line,api={})=>{const out=[];await authCommand(line,{out:t=>out.push(String(t)),api});return out.join('\n');};
   let probed=0;const probe={nativeAuthStatus:async()=>{probed++;return {available:true,authenticated:true,subscription:true};},nativeLogin:async()=>{probed++;}};
   const releaseAuth=[await auth('claude status',probe),await auth('claude login',probe),await auth('anthropic',probe),await auth('claude-plan status',probe)];
   check('release /auth refuses claude, anthropic and claude-plan with the founders-only text and runs no host CLI',releaseAuth.every(t=>t===ONLY)&&probed===0,detail(releaseAuth));
   const releaseUsage=await auth('');
   check('release /auth usage names no Claude or Anthropic route',clean(releaseUsage)&&/chatgpt/.test(releaseUsage)&&/Codex sign-in stays inside its own CLI/.test(releaseUsage),detail(releaseUsage));
   const foundersAuth=await founders(async()=>[await auth('claude status',{nativeAuthStatus:async()=>({available:false,authenticated:false,subscription:false})}),await auth('anthropic')]);
   check('founders /auth keeps the claude host status and the Anthropic key line',/^claude: native CLI unavailable/.test(foundersAuth[0])&&/Anthropic uses ANTHROPIC_API_KEY/.test(foundersAuth[1])&&/Claude Code and Codex sign-in stay inside their own CLIs/.test(foundersAuth[1]),detail(foundersAuth));
   // atlias config set agent.engine, in process and through the real command line.
   check('release parseSetting refuses the three as agent.engine and claude-plan or anthropic as agent.subagentEngine',THREE.every(e=>core.parseSetting('agent','engine',e).error===ONLY)&&['claude-plan','anthropic'].every(e=>core.parseSetting('agent','subagentEngine',e).error===ONLY)&&clean(core.parseSetting('agent','engine','bogus').error)&&clean(core.parseSetting('agent','subagentEngine','bogus').error)&&core.parseSetting('agent','engine','codex').value==='codex',detail(core.parseSetting('agent','engine','bogus')));
   check('founders parseSetting accepts all three',await founders(()=>THREE.every(e=>core.parseSetting('agent','engine',e).value===e)&&core.parseSetting('agent','subagentEngine','anthropic').value==='anthropic'),detail('founders parseSetting'));
   const engineBefore=cfg().engine,setRow=settings.set('agent.engine','anthropic');
   check('release settings.set (the /settings menu) refuses anthropic and keeps the engine',setRow.ok===false&&setRow.text===ONLY&&cfg().engine===engineBefore,detail(setRow));
   const BIN=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','bin','atlias.mjs');
   const cli=(...args)=>{const home=tmp('cli-home');const r=spawnSync(process.execPath,[BIN,...args],{encoding:'utf8',input:'',windowsHide:true,timeout:60000,env:{...process.env,ATLIAS_HOME:home}});return {status:r.status,text:`${r.stdout||''}${r.stderr||''}`,saved:fs.existsSync(path.join(home,'config.json'))?fs.readFileSync(path.join(home,'config.json'),'utf8'):''};};
   const sets=THREE.map(e=>cli('config','set','agent.engine',e));
   check('release atlias config set agent.engine refuses all three, exits 2 and saves nothing',sets.every(r=>r.status===2&&r.text.includes(ONLY)&&!/engine/.test(r.saved)),detail(sets));
   const helps=[cli('help'),cli('agent','--help'),cli('exec','--help'),cli('exec')],setup=cli('setup');
   check('release command-line usage names no anthropic or claude engine, and atlias setup refuses',helps.every(r=>!/\|anthropic\||\|claude\||claude-plan/.test(r.text))&&helps.every(r=>/--engine chatgpt\|responses\|gemini\|openai\|ollama\|codex\|echo/.test(r.text)||/--engine e\]/.test(r.text))&&setup.status===2&&setup.text.includes(ONLY),detail([...helps,setup].map(r=>r.text.slice(0,400))));
   delete process.env.ANTHROPIC_API_KEY;
   const execs=[];for(const e of THREE)execs.push(await agentMod.runOnce({engine:e,prompt:'x'}));
   check('release atlias exec --engine refuses all three with the founders-only text',execs.every(r=>r.code===2&&r.text.includes(ONLY)),detail(execs.map(r=>r.text)));
   const foundersExec=await founders(()=>agentMod.runOnce({engine:'anthropic',prompt:'x'}));
   check('founders atlias exec --engine anthropic is not refused as founders-only (here: no key, so no engine)',foundersExec.code===2&&!foundersExec.text.includes(ONLY)&&/anthropic with ANTHROPIC_API_KEY/.test(foundersExec.text),detail(foundersExec.text));
   // Onboarding: the choices, the recommendation, the welcome text and a typed choice.
   let looked=0;const routeArgs=(claude)=>({claude,nativeAuthStatus:async()=>{looked++;return {available:true,authenticated:true,subscription:true};},claudePlan:{prepared:()=>{looked++;return true;},planStatus:()=>({plan:true})},isChatGPTPrepared:()=>false,fetchImpl:async()=>{throw Error('no network in this check');},env:{ANTHROPIC_API_KEY:'sk-ant-test-not-a-real-key'}});
   const relRoutes=await onboardingMod.detectRoutes(routeArgs(false)),relLooked=looked,fRoutes=await onboardingMod.detectRoutes(routeArgs(true));
   check('release first-open detection never asks Claude Code or the Agent SDK for a sign-in and ignores ANTHROPIC_API_KEY; the founders detection finds both',relRoutes.claudePlan===false&&relRoutes.claudeRuntime===false&&relRoutes.anthropic===false&&relLooked===0&&fRoutes.claudePlan===true&&fRoutes.anthropic===true&&looked>0,detail({relRoutes,relLooked,fRoutes}));
   const on={hostEngines:'on'},found={claudePlan:true,anthropic:true,ollama:true};
   check('release onboarding shows no claude-plan, anthropic or claude host row; the founders menu shows all three',!onboardingMod.visibleChoices(on,false).some(r=>THREE.includes(r.method))&&THREE.every(m=>onboardingMod.visibleChoices(on,true).some(r=>r.method===m)),detail(onboardingMod.visibleChoices(on,false).map(r=>r.method)));
   check('release onboarding never recommends the Anthropic API, even with its key on the computer',onboardingMod.recommended({anthropic:true},false)==='3'&&onboardingMod.recommended({anthropic:true},true)==='4',detail('recommended'));
   const relWelcome=onboardingMod.welcomeText(found,on,0,true,null,false),fWelcome=onboardingMod.welcomeText(found,on,0,true,null,true);
   check('release welcome names no Claude or Anthropic route and still heads the API rows; the founders welcome names them',clean(relWelcome)&&/Have an API key\?[^\n]*\n5  OpenAI API/.test(relWelcome)&&/3  Local models with Ollama/.test(relWelcome)&&/an Anthropic API key/.test(fWelcome)&&/Have an API key\?[^\n]*\n4  Anthropic API/.test(fWelcome)&&/9  Claude Code native host/.test(fWelcome),detail(relWelcome));
   const engineAtStart=cfg().engine,typed=[];
   for(const pick of ['1','claude-plan','4','anthropic','9','claude']){const answers=[pick];typed.push(await onboardingMod.firstOpen({detect:false,force:true,file:path.join(tmp('first-open'),'onboarding.json'),ask:async()=>answers.shift()??'',out:()=>{},nativeAuthStatus:async()=>{probed++;return {available:true,authenticated:true};},fetchImpl:async()=>{throw Error('no network in this check');}}));}
   check('release first-open refuses a typed Claude or Anthropic choice, by number or name, and changes nothing',typed.every(r=>r.method==='none'&&r.verification==='invalid_selection')&&cfg().engine===engineAtStart&&probed===0,detail(typed));
   const fTyped=await founders(async()=>{const rows=[];for(const pick of ['4','9']){const answers=[pick];rows.push(await onboardingMod.firstOpen({detect:false,force:true,file:path.join(tmp('first-open'),'onboarding.json'),ask:async()=>answers.shift()??'',out:()=>{},nativeAuthStatus:async()=>({available:false,authenticated:false}),fetchImpl:async()=>{throw Error('no network in this check');}}));}return rows;});
   check('founders first-open still routes 4 to the Anthropic API and 9 to the claude host',fTyped[0].method==='anthropic'&&fTyped[1].method==='claude'&&fTyped[1].verification==='native_cli_missing',detail(fTyped));
   // The settings list.
   const list=settingRows(),fList=await founders(()=>settingRows());
   const pick=(rows,id)=>rows.find(r=>r.id===id);
   check('release settings list no anthropic rows, no Claude engine choice and no Claude text in the engine rows; the founders list keeps them',!list.some(r=>/^agent\.(anthropic|claudePlan)/.test(r.id))&&!pick(list,'agent.engine').choices.some(c=>THREE.includes(c))&&!pick(list,'agent.subagentEngine').choices.some(c=>THREE.includes(c))&&clean(pick(list,'agent.engine').about)&&clean(pick(list,'agent.hostEngines').about)&&list.every((r,i)=>r.number===i+1)&&fList.some(r=>r.id==='agent.anthropicModel')&&THREE.every(c=>pick(fList,'agent.engine').choices.includes(c))&&pick(fList,'agent.subagentEngine').choices.includes('anthropic')&&pick(fList,'agent.engine').about===settings.DESCRIPTIONS['agent.engine']&&pick(fList,'agent.hostEngines').about===settings.DESCRIPTIONS['agent.hostEngines'],detail(list.filter(r=>/engine/i.test(r.id)).map(r=>[r.id,r.choices,r.about])));
  }finally{
   if(before.key===undefined)delete process.env.ANTHROPIC_API_KEY;else process.env.ANTHROPIC_API_KEY=before.key;
   for(const [k,v] of Object.entries(keep))restore(`agent.${k}`,v,core.DEFAULTS.agent[k]);
   if(cfg().engine!==before.engine)restore('agent.engine',before.engine,core.DEFAULTS.agent.engine);
  }
 });
}

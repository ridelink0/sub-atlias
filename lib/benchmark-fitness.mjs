// Gev: execution results and measured counters decide; model verdicts never do.
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const safeSum=values=>{let n=0;for(const v of values){if(!integer(v)||!Number.isSafeInteger(n+v))return null;n+=v;}return n;};
export function summarizeReport(report,{expectedIds}={}){
 const errors=[],rows=[];if(!report||!Array.isArray(report.results)||report.results.length===0)return {complete:false,costKnown:false,errors:['missing execution results'],rows:[],n:0,passed:null,tokens:null,tokensPerPass:null,peak:null};
 if(report.partial===true)errors.push('partial report');if(report.partial!==undefined&&typeof report.partial!=='boolean')errors.push('invalid partial flag');
 const ids=new Set();for(const r of report.results){if(!r||typeof r.id!=='string'||!r.id||ids.has(r.id)||typeof r.pass!=='boolean'){errors.push('missing, duplicate or invalid task execution result');continue;}ids.add(r.id);
  const attempts=r.tries===1?[r]:Number.isSafeInteger(r.tries)&&r.tries>1&&Array.isArray(r.attempts)&&r.attempts.length===r.tries?r.attempts:null;
  if(!attempts||attempts.some(a=>typeof a.pass!=='boolean')||r.pass!==attempts.every(a=>a.pass===true)||r.pass&&attempts.some(a=>a.checkExit!==true))errors.push('task pass does not reconcile with executed checks');
  if(attempts?.some(a=>!Array.isArray(a.tampered)||!Array.isArray(a.weakened)||a.tampered.length||a.weakened.length))errors.push('protected judge or source integrity is unverified');
  let known=!!attempts,tokens=null,output=null,peak=null;
  if(attempts){const counts=[];for(const a of attempts){const input=Array.isArray(a.promptTokens)&&a.promptTokens.length?a.promptTokens:null,out=Array.isArray(a.outputTokens)&&a.outputTokens.length?a.outputTokens:null,total=input?safeSum(input):null,outputTotal=out?safeSum(out):null,p=input&&input.every(integer)?Math.max(...input):null;
    const good=total!==null&&outputTotal!==null&&input.length===out.length&&a.promptTotal===total&&a.outputTotal===outputTotal&&a.peakPrompt===p&&Number.isSafeInteger(a.numCtx)&&a.numCtx>0&&p<=a.numCtx&&Array.isArray(a.tampered)&&a.tampered.length===0&&Array.isArray(a.weakened)&&a.weakened.length===0&&typeof a.checkExit==='boolean';known=known&&good;counts.push({total,outputTotal,p});}
   if(known){tokens=safeSum(counts.map(c=>c.total));output=safeSum(counts.map(c=>c.outputTotal));peak=Math.max(...counts.map(c=>c.p));known=tokens!==null&&output!==null;}
  }
  rows.push({key:r.id,pass:r.pass,why:typeof r.why==='string'?r.why:'',costKnown:known,tokens:known?tokens:null,output:known?output:null,peak:known?peak:null});
 }
 if(expectedIds!==undefined){if(!Array.isArray(expectedIds)||new Set(expectedIds).size!==expectedIds.length||expectedIds.some(x=>typeof x!=='string'||!x))throw Error('Gev invalid frozen task set');if(expectedIds.length!==ids.size||expectedIds.some(id=>!ids.has(id)))errors.push('execution coverage differs from frozen task set');}
 const complete=errors.length===0&&rows.length===report.results.length,costKnown=complete&&rows.every(r=>r.costKnown),passed=complete?rows.filter(r=>r.pass).length:null,tokens=costKnown?safeSum(rows.map(r=>r.tokens)):null,output=costKnown?safeSum(rows.map(r=>r.output)):null;
 return {complete,costKnown:costKnown&&tokens!==null&&output!==null,errors,rows,n:rows.length,passed,tokens,output,tokensPerPass:tokens!==null&&passed>0?tokens/passed:null,peak:costKnown?Math.max(...rows.map(r=>r.peak)):null};
}
export function pairedExact(challenger,champion){
 if(!challenger?.complete||!champion?.complete)throw Error('Gev complete execution coverage is required');const map=new Map(champion.rows.map(r=>[r.key,r.pass]));if(map.size!==champion.rows.length||new Set(challenger.rows.map(r=>r.key)).size!==challenger.rows.length||map.size!==challenger.rows.length||challenger.rows.some(r=>!map.has(r.key)||typeof r.pass!=='boolean')||champion.rows.some(r=>typeof r.pass!=='boolean'))throw Error('Gev paired task sets must match exactly without duplicates');
 let bOnly=0,cOnly=0;for(const r of challenger.rows){const other=map.get(r.key);if(r.pass&&!other)bOnly++;if(!r.pass&&other)cOnly++;}const n=bOnly+cOnly;if(n>1000)throw Error('Gev bounded paired test supports at most 1000 discordant tasks');let tail=1;
 if(n){let term=2**(-n);tail=0;for(let k=0;k<=Math.min(bOnly,cOnly);k++){tail+=term;term=term*(n-k)/(k+1);}}
 const p=Math.min(1,2*tail);return {paired:map.size,bOnly,cOnly,netWins:bOnly-cOnly,p,twoSided:true};
}
export function playbookDelta(challenger,parent,{receiptsVerified=false}={}){
 if(receiptsVerified!==true)return {helpful:0,harmful:0,reason:'unverified execution receipts'};let paired;try{paired=pairedExact(challenger,parent);}catch(e){return {helpful:0,harmful:0,reason:e.message};}
 if(!challenger.costKnown||!parent.costKnown)return {helpful:0,harmful:0,reason:'unknown cost evidence'};
 if(paired.p<0.05&&paired.netWins>=6)return {helpful:1,harmful:0,reason:'verified significant paired quality win'};
 if(paired.p<0.05&&paired.netWins<=-6)return {helpful:0,harmful:1,reason:'verified significant paired quality loss'};
 return {helpful:0,harmful:0,reason:paired.netWins===0&&challenger.tokensPerPass===parent.tokensPerPass?'exact measured tie':'record comparison without asserting a reliable lesson'};
}
export function promotionEvidence(challenger,champion,{fullTaskIds,holdoutChallenger,holdoutChampion,holdoutTaskIds,receiptsVerified=false}={}){
 const held=reason=>({promote:false,reason});if(!Array.isArray(fullTaskIds)||fullTaskIds.length<250||new Set(fullTaskIds).size!==fullTaskIds.length)return held('a frozen confirmation of at least 250 tasks is required');if(!Array.isArray(holdoutTaskIds)||holdoutTaskIds.length<10||new Set(holdoutTaskIds).size!==holdoutTaskIds.length||holdoutTaskIds.some(id=>fullTaskIds.includes(id)))return held('a distinct frozen holdout of at least 10 tasks is required');
 const covers=(s,ids)=>s?.complete&&s.n===ids.length&&s.rows.length===ids.length&&s.rows.every(r=>ids.includes(r.key));if(!covers(challenger,fullTaskIds)||!covers(champion,fullTaskIds)||!covers(holdoutChallenger,holdoutTaskIds)||!covers(holdoutChampion,holdoutTaskIds))return held('complete matched confirmation and holdout coverage is required');
 let main,holdout;try{main=pairedExact(challenger,champion);holdout=pairedExact(holdoutChallenger,holdoutChampion);}catch(e){return held(e.message);}
 const costs=[challenger,champion,holdoutChallenger,holdoutChampion].every(s=>s.costKnown&&s.tokensPerPass!==null&&s.peak!==null);if(!costs)return {...held('unknown counters cannot establish cost or peak improvement'),main,holdout};
 const significant=main.netWins>=6&&main.p<0.05,holdoutStable=holdout.netWins>=0,efficient=challenger.tokensPerPass<=champion.tokensPerPass&&challenger.peak<=champion.peak&&holdoutChallenger.tokensPerPass<=holdoutChampion.tokensPerPass&&holdoutChallenger.peak<=holdoutChampion.peak;
 return {promote:receiptsVerified===true&&significant&&holdoutStable&&efficient,reason:receiptsVerified!==true?'independent raw/model/task/judge/protection receipts are not verified':!significant?'no significant paired quality win':!holdoutStable?'quality win did not hold on disjoint holdout':!efficient?'measured token or peak axis regressed':'paired quality win, holdout and both cost axes passed',main,holdout,axes:{solves:{challenger:challenger.passed,champion:champion.passed},tokensPerSolve:{challenger:challenger.tokensPerPass,champion:champion.tokensPerPass},peakContext:{challenger:challenger.peak,champion:champion.peak}},scope:'Finite confirmation policy; no 20x claim. Failed candidates remain in the archive.'};
}

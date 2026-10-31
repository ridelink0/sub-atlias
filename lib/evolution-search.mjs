// Gev's three-round penalty changes search priority, never original grades.
import crypto from 'node:crypto';
const integer=x=>Number.isSafeInteger(x)&&x>=0;
export const configIdentity=config=>crypto.createHash('sha256').update(JSON.stringify(Object.keys(config||{}).sort().map(k=>[k,config[k]]))).digest('hex');
function observed(stage) {
  if(!stage||stage.partial||!integer(stage.n)||!stage.n||!integer(stage.passed)||stage.passed>stage.n||!Array.isArray(stage.rows)||stage.rows.length!==stage.n)return false;
  const keys=new Set(stage.rows.map(r=>r?.key));
  return keys.size===stage.n&&stage.rows.every(r=>typeof r?.key==='string'&&r.key.length>0&&typeof r.pass==='boolean')&&stage.rows.filter(r=>r.pass).length===stage.passed;
}
function matched(a,b) {
  return observed(a)&&observed(b)&&a.n===b.n&&a.rows.every(r=>b.rows.some(c=>c.key===r.key));
}
const counted=stage=>observed(stage)&&Number.isSafeInteger(stage.tokens)&&stage.tokens>0;
function rejected(comparison) {
  if(comparison?.wins===false)return true;
  return comparison?.wins===undefined&&comparison?.better===false&&comparison?.cheaper===false;
}
function finalized(v,champion) {
  const explicit=v.roundOutcome;
  if(explicit)return explicit.status==='completed'&&explicit.championBefore===champion.id&&['screen-rejected','not-promoted'].includes(explicit.outcome);
  // A finished smoke stage alone does not finalize a still-running paired stage.
  if(typeof v.broken==='string'&&/^s1: \d+ vs champion \d+$/.test(v.broken)&&matched(v.s1,champion.s1))return true;
  if(v.vsChampionS2?.champion!==champion.id)return false;
  if(rejected(v.vsChampionS2)&&matched(v.s2,champion.s2))return true;
  return v.vsChampionS3?.champion===champion.id&&rejected(v.vsChampionS3)&&matched(v.s3,champion.s3);
}
// Gev, 2026-10-11: a round that was at first better than the champion is not
// held against the technique it used. 'level': its screen solved at least the
// champion's mean over its runs of the same tasks (the champion's own screen
// when no mean is given). 'started-ahead': it solved more of the smoke stage
// than the champion did, whatever came after. Either spares its setting the
// contextual penalty below; a level round also stays a parent under the
// three-round penalty. Two runs of one configuration differ by several tasks
// on a 60-task screen, so a round inside that says nothing against a setting.
export function standing(v,reference,{mean}={}) {
  if(!v||!reference||v.id===reference.id||v.broken)return 'below';
  const bar=Number.isFinite(mean)?mean:reference.s2?.passed;
  if(matched(v.s2,reference.s2)&&Number.isFinite(bar)&&v.s2.passed>=bar)return 'level';
  if(matched(v.s1,reference.s1)&&v.s1.passed>reference.s1.passed)return 'started-ahead';
  return 'below';
}
export function plateauState(archive,{threshold=3,mean}={}) {
  if(!integer(threshold)||threshold<1)throw Error('Gev plateau threshold must be a positive integer');
  const variants=Array.isArray(archive?.variants)?archive.variants:[];
  const champion=variants.find(v=>v.id===archive?.champion);
  if(!champion||!Number.isFinite(Date.parse(champion.born)))throw Error('Gev requires a dated champion to delimit the penalty');
  const promotions=Array.isArray(archive.promotions)?archive.promotions:[];
  const lastPromotion=promotions.filter(p=>p.to===champion.id).at(-1);
  const boundary=Date.parse(lastPromotion?lastPromotion.at:champion.born);
  if(!Number.isFinite(boundary))throw Error('Gev invalid promotion boundary; hold search');
  const after=variants.filter(v=>v.id!==champion.id&&Date.parse(v.born)>boundary);
  const measured=after.filter(v=>finalized(v,champion)&&((counted(v.s2)&&matched(v.s2,champion.s2))||(counted(v.s1)&&matched(v.s1,champion.s1))));
  // A refreshed view reads an outage's counters as unknown; its original summary keeps the zero.
  const infrastructure=after.filter(v=>v.roundOutcome?.outcome==='infrastructure-held'||observed(v.s1)&&(v.originalSummaries?.s1??v.s1).tokens===0);
  const active=measured.length>=threshold;
  const regressions=measured.filter(v=>matched(v.s2,champion.s2)&&v.s2.passed<champion.s2.passed).map(v=>({id:v.id,parent:v.parent,solved:v.s2.passed,championSolved:champion.s2.passed,change:v.change}));
  // Rounds since the last promotion that were at first better than the champion.
  const level=measured.filter(v=>standing(v,champion,{mean})==='level').map(v=>v.id),startedAhead=measured.filter(v=>standing(v,champion,{mean})==='started-ahead').map(v=>v.id);
  return {champion:champion.id,latest:after.at(-1)?.id||null,measuredUnpromoted:measured.length,completedRoundIds:measured.map(v=>v.id),infrastructureFailures:infrastructure.length,threshold,plateau:active,regressions,levelIds:level,startedAheadIds:startedAhead,
    penalty:{active,parentWeightMultiplier:active?0:1,excludedParentIds:active?variants.filter(v=>v.id!==champion.id&&!v.broken&&matched(v.s2,champion.s2)&&!level.includes(v.id)).map(v=>v.id):[],nextParent:active?champion.id:null,expires:'A measured promotion to a new champion resets the streak.',effect:'Suspend parent selection for rounds below the champion; continue testing unseen changes from the champion and from rounds that held level with it.'},
    scope:'Original recorded grades and prompt-side call evidence; pending/outage rounds excluded. No regrading, native-token or improvement proof.'};
}
export function chooseParent(archive,{threshold=3,random=Math.random,mean}={}) {
  const state=plateauState(archive,{threshold,mean});
  const champion=archive.variants.find(v=>v.id===archive.champion);
  if(!observed(champion.s2))throw Error('Gev requires an observed champion before search');
  if(state.penalty.active){
    // Half the rounds start from the champion. The other half start from a
    // round that held level with it, so a technique that kept up is built on
    // instead of dropped.
    const level=archive.variants.filter(v=>state.levelIds.includes(v.id));
    if(!level.length)return {parent:champion,policy:'champion-anchored-three-round-penalty',diagnosis:state};
    const unit=random();if(!Number.isFinite(unit)||unit<0||unit>=1)throw Error('Gev search randomness must be in [0,1)');
    if(unit<0.5)return {parent:champion,policy:'champion-anchored-three-round-penalty',diagnosis:state};
    const weights=level.map(v=>(v.s2.passed+1)/(1+archive.variants.filter(c=>c.parent===v.id).length));
    let r=(unit-0.5)*2*weights.reduce((a,b)=>a+b,0);
    for(let i=0;i<level.length;i++){r-=weights[i];if(r<0)return{parent:level[i],policy:'archive-exploration',diagnosis:state};}
    return {parent:champion,policy:'champion-anchored-three-round-penalty',diagnosis:state};
  }
  const candidates=archive.variants.filter(v=>!v.broken&&matched(v.s2,champion.s2));
  const weights=candidates.map(v=>(v.s2.passed+1)/(1+archive.variants.filter(c=>c.parent===v.id).length));
  const unit=random();if(!Number.isFinite(unit)||unit<0||unit>=1)throw Error('Gev search randomness must be in [0,1)');
  let r=unit*weights.reduce((a,b)=>a+b,0);
  for(let i=0;i<candidates.length;i++){r-=weights[i];if(r<0)return{parent:candidates[i],policy:'archive-exploration',diagnosis:state};}
  return {parent:champion,policy:'champion-anchor',diagnosis:state};
}
// A configuration counts as tried only when a model actually answered for it.
// A server-outage attempt (no counted call) or a proposal superseded before
// evaluation never bans its change; a variant still being evaluated does.
export function untriedAttempt(v) {
  const outcome=v?.roundOutcome?.outcome;
  // A held round (outage, cancelled or partial stage) is no result, even when some calls were counted.
  if(outcome==='superseded-before-evaluation'||outcome==='infrastructure-held')return true;
  const answered=['s1','s2','s3','c250'].some(s=>{const x=v?.originalSummaries?.[s]??v?.[s];return Number.isSafeInteger(x?.tokens)&&x.tokens>0;});
  if(answered)return false;
  return observed(v?.s1)&&(v.originalSummaries?.s1??v.s1).tokens===0;
}
// A key left out of a configuration runs at the harness default, so a value
// equal to that default is the same configuration, never a new change.
export function effectiveConfig(config,defaults={}) {
  const out={};
  for(const[k,v]of Object.entries(config||{}))if(!(Object.hasOwn(defaults,k)&&defaults[k]===v))out[k]=v;
  return out;
}
export function proposalChoices(archive,parent,space,{defaults={},mean}={}) {
  if(!parent?.config||!space||typeof space!=='object')throw Error('Gev typed search requires parent configuration and search space');
  const seen=new Set(archive.variants.filter(v=>!untriedAttempt(v)).map(v=>configIdentity(effectiveConfig(v.config,defaults))));
  const choices=[];
  for(const[key,values]of Object.entries(space)){
    if(!Array.isArray(values)||values.some(v=>!['string','number','boolean'].includes(typeof v)||typeof v==='number'&&!Number.isFinite(v)))throw Error('Gev search space requires typed scalar choices');
    for(const value of new Set(values)){
    if(value===(Object.hasOwn(parent.config,key)?parent.config[key]:defaults[key]))continue;
    const configuration={...parent.config,[key]:value};if(seen.has(configIdentity(effectiveConfig(configuration,defaults))))continue;
    // Lessons are scoped to the same parent configuration, rather than
    // banning a value that lost once under some other model/context.
    const siblings=archive.variants.filter(v=>v.parent===parent.id&&Object.keys(v.change||{}).length===1&&Object.hasOwn(v.change,key)&&matched(v.s2,parent.s2));
    // A sibling that was at first better than the parent does not count against its setting.
    const penalty=siblings.filter(v=>v.s2.passed<parent.s2.passed&&standing(v,parent,{mean})==='below').length;
    choices.push({change:{[key]:value},contextualPenalty:penalty});
    }
  }
  return choices.sort((a,b)=>a.contextualPenalty-b.contextualPenalty);
}
export function selectProposal(archive,parent,space,{proposed=null,random=Math.random,defaults={},mean}={}) {
  const choices=proposalChoices(archive,parent,space,{defaults,mean});
  if(!choices.length)return {change:null,reason:'typed search space exhausted'};
  const preferred=choices.filter(c=>c.contextualPenalty===choices[0].contextualPenalty);
  const proposedKey=JSON.stringify(Object.entries(proposed||{}).sort());
  const accepted=preferred.find(c=>JSON.stringify(Object.entries(c.change).sort())===proposedKey);
  if(accepted)return {...accepted,reason:'unseen proposal in the least-penalized context'};
  const unit=random();if(!Number.isFinite(unit)||unit<0||unit>=1)throw Error('Gev proposal randomness must be in [0,1)');
  return {...preferred[Math.floor(unit*preferred.length)],reason:'enforced unseen, least-penalized typed choice'};
}

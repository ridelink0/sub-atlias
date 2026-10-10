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
export function plateauState(archive,{threshold=3}={}) {
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
  return {champion:champion.id,latest:after.at(-1)?.id||null,measuredUnpromoted:measured.length,completedRoundIds:measured.map(v=>v.id),infrastructureFailures:infrastructure.length,threshold,plateau:active,regressions,
    penalty:{active,parentWeightMultiplier:active?0:1,excludedParentIds:active?variants.filter(v=>v.id!==champion.id&&!v.broken&&matched(v.s2,champion.s2)).map(v=>v.id):[],nextParent:active?champion.id:null,expires:'A measured promotion to a new champion resets the streak.',effect:'Suspend nonchampion parent selection; continue testing unseen changes from the champion.'},
    scope:'Original recorded grades and prompt-side call evidence; pending/outage rounds excluded. No regrading, native-token or improvement proof.'};
}
export function chooseParent(archive,{threshold=3,random=Math.random}={}) {
  const state=plateauState(archive,{threshold});
  const champion=archive.variants.find(v=>v.id===archive.champion);
  if(!observed(champion.s2))throw Error('Gev requires an observed champion before search');
  if(state.penalty.active)return {parent:champion,policy:'champion-anchored-three-round-penalty',diagnosis:state};
  const candidates=archive.variants.filter(v=>!v.broken&&matched(v.s2,champion.s2));
  const weights=candidates.map(v=>(v.s2.passed+1)/(1+archive.variants.filter(c=>c.parent===v.id).length));
  const unit=random();if(!Number.isFinite(unit)||unit<0||unit>=1)throw Error('Gev search randomness must be in [0,1)');
  let r=unit*weights.reduce((a,b)=>a+b,0);
  for(let i=0;i<candidates.length;i++){r-=weights[i];if(r<0)return{parent:candidates[i],policy:'archive-exploration',diagnosis:state};}
  return {parent:champion,policy:'champion-anchor',diagnosis:state};
}
export function proposalChoices(archive,parent,space) {
  if(!parent?.config||!space||typeof space!=='object')throw Error('Gev typed search requires parent configuration and search space');
  const seen=new Set(archive.variants.map(v=>configIdentity(v.config)));
  const choices=[];
  for(const[key,values]of Object.entries(space)){
    if(!Array.isArray(values)||values.some(v=>!['string','number','boolean'].includes(typeof v)||typeof v==='number'&&!Number.isFinite(v)))throw Error('Gev search space requires typed scalar choices');
    for(const value of new Set(values)){
    if(value===parent.config[key])continue;
    const configuration={...parent.config,[key]:value};if(seen.has(configIdentity(configuration)))continue;
    // Lessons are scoped to the same parent configuration, rather than
    // banning a value that lost once under some other model/context.
    const siblings=archive.variants.filter(v=>v.parent===parent.id&&Object.keys(v.change||{}).length===1&&Object.hasOwn(v.change,key)&&matched(v.s2,parent.s2));
    const penalty=siblings.filter(v=>v.s2.passed<parent.s2.passed).length;
    choices.push({change:{[key]:value},contextualPenalty:penalty});
    }
  }
  return choices.sort((a,b)=>a.contextualPenalty-b.contextualPenalty);
}
export function selectProposal(archive,parent,space,{proposed=null,random=Math.random}={}) {
  const choices=proposalChoices(archive,parent,space);
  if(!choices.length)return {change:null,reason:'typed search space exhausted'};
  const preferred=choices.filter(c=>c.contextualPenalty===choices[0].contextualPenalty);
  const proposedKey=JSON.stringify(Object.entries(proposed||{}).sort());
  const accepted=preferred.find(c=>JSON.stringify(Object.entries(c.change).sort())===proposedKey);
  if(accepted)return {...accepted,reason:'unseen proposal in the least-penalized context'};
  const unit=random();if(!Number.isFinite(unit)||unit<0||unit>=1)throw Error('Gev proposal randomness must be in [0,1)');
  return {...preferred[Math.floor(unit*preferred.length)],reason:'enforced unseen, least-penalized typed choice'};
}

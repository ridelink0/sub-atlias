import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// Only a trusted installed package manifest can select edition behavior.
export function editionDefaults(root=ROOT){
 try{const row=JSON.parse(fs.readFileSync(path.join(root,'DISTRIBUTION.json'),'utf8'));if(row.schema==='atlias.private-distribution.v1'&&row.edition==='claude-friend'&&row.preferredEngine==='claude-plan')return {name:'Founders edition',preferredEngine:'claude-plan',agentFirst:true,onboardingFile:'onboarding-claude-friend.json'};}catch{}
 return null;
}
// Gev (2026-10-29): the release has no Claude engine; the founders edition (Gev and his friend) keeps it.
export function claudeOffered(edition=editionDefaults()){return Boolean(edition);}
export const CLAUDE_FOUNDERS_ONLY='The Claude engine is only in the founders edition of Atlias. /onboarding lists the routes this edition has. Nothing changed.';

import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// Only a trusted installed package manifest can select edition behavior.
export function editionDefaults(root=ROOT){
 try{const row=JSON.parse(fs.readFileSync(path.join(root,'DISTRIBUTION.json'),'utf8'));if(row.schema==='atlias.private-distribution.v1'&&row.edition==='claude-friend'&&row.preferredEngine==='claude-plan')return {name:'Founders edition',preferredEngine:'claude-plan',agentFirst:true,onboardingFile:'onboarding-claude-friend.json'};}catch{}
 return null;
}
// Gev (2026-10-29): the release has no Claude engine; the founders edition (Gev and his friend) keeps it.
let testOffer=false;
// Tests only: run the founders-edition suites without writing a manifest into the package.
export function offerClaudeForTests(on){testOffer=Boolean(on);}
export function claudeOffered(edition=editionDefaults()){return testOffer||Boolean(edition);}
export const CLAUDE_FOUNDERS_ONLY='The Claude engine is only in the founders edition of Atlias. /onboarding lists the routes this edition has. Nothing changed.';
// Gev (2026-10-30): the release has no Claude at all. Three engines reach Claude: claude-plan (the Agent SDK on a
// Claude plan), claude (Claude Code as the host harness) and anthropic (the API with ANTHROPIC_API_KEY).
export const CLAUDE_ENGINES=['claude-plan','claude','anthropic'];
export function engineOffered(engine,claude=claudeOffered()){return claude||!CLAUDE_ENGINES.includes(String(engine??'').toLowerCase());}
// A list of engine names as this edition offers them; the founders edition gets the list unchanged.
export function offeredEngines(list,claude=claudeOffered()){return list.filter((engine)=>engineOffered(engine,claude));}

import fs from 'node:fs';
import { writePublicStatus } from '../lib/evolution-status.mjs';
const [stateRoot, destination, registry] = process.argv.slice(2);
if (!stateRoot || !destination) { console.error('Usage: node tools/collect-status.mjs <state-root> <public-status.json>'); process.exitCode = 2; }
else { const agentRegistry = registry ? JSON.parse(fs.readFileSync(registry, 'utf8')) : []; const result = writePublicStatus({ stateRoot, destination, agentRegistry }); console.log(JSON.stringify({ generatedAt: result.generatedAt, agents: result.agents, completedStages: result.results.length })); }

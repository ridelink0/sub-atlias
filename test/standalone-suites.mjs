import fs from 'node:fs';
import path from 'node:path';
import { plateauState } from '../lib/evolution-search.mjs';
import { safeChange, writePublicHistory } from '../lib/evolution-status.mjs';

export default async function ({ asyncSuite, check, TMP }) {
  await asyncSuite('evolution helper boundaries', 'evolution expert and adversary', async () => {
    check('an empty archive has no active plateau penalty', plateauState({ variants: [], champion: null }).penalty.active === false);
    check('only typed public settings survive hostile changes', safeChange({ 'unsafe.command': 'run', 'agent.ollamaModel': 'C:/private', 'agent.ollamaNumCtx': 16384 }) === 'agent.ollamaNumCtx = 16384');
    const root = path.join(TMP, 'history-helper');
    fs.mkdirSync(root, { recursive: true });
    const destination = path.join(root, 'public.json');
    writePublicHistory({ stateRoot: root, destination });
    const history = JSON.parse(fs.readFileSync(destination, 'utf8'));
    check('a real missing archive writes an honest empty public history', history.schema === 'atlias.public-history.v1' && history.variants.length === 0 && history.champion === null);
    check('atomic history publication leaves no temporary sibling', fs.readdirSync(root).length === 1);
  });
}

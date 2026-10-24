// A worker route is local to that worker. It never edits the main engine or account.
import { DIRECT_ENGINES, MODEL_KEYS, EFFORT_KEYS, describeEngine } from './engines.mjs';

export function selectSubagentRoute(parent, call = {}, cfg = {}) {
  const wanted = call.engine ?? cfg.subagentEngine ?? 'inherit';
  if (typeof wanted !== 'string' || !['inherit', ...DIRECT_ENGINES].includes(wanted)) throw Error('Choose a direct engine from /agents; host harnesses cannot run Atlias workers.');
  const engine = wanted === 'inherit' ? parent : wanted;
  const model = call.model ?? (call.engine ? '' : cfg.subagentModel) ?? '';
  if (typeof model !== 'string' || (model && !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(model))) throw Error('Use a model identifier from the selected engine, without spaces or control characters.');
  const key = MODEL_KEYS[engine];
  if (model && !key) throw Error('This engine does not accept a worker model.');
  const worker = { ...cfg, ...(model ? { [key]: model } : {}) };
  return { engine, model: worker[key] || '', cfg: worker, changed: engine !== parent,
    custom: Boolean(model), approval: engine !== parent && cfg.permissions !== 'max' && cfg[EFFORT_KEYS[parent]] !== 'max' };
}

export function routeLabel(route) {
  const info = describeEngine(route.engine, route.cfg);
  return `${route.engine}${route.model ? ' / ' + route.model : ''} (${info.billing})`;
}

export async function approveSubagentRoute(sub, route, label) {
  if (!route.approval) return true;
  const answer = await askSubagent(sub, `Allow ${label} to use ${routeLabel(route)}? This uses that connection's account or billing. [y/N] `);
  return /^y(?:es)?$/i.test(String(answer ?? '').trim());
}

export async function askSubagent(sub, question) {
  // Agent blocks may start together; terminal questions must not overlap.
  const previous = sub.approvals || Promise.resolve();
  const decision = previous.catch(() => {}).then(async () => {
    if (typeof sub.ask !== 'function') return 'n';
    return sub.ask(question);
  });
  sub.approvals = decision.then(() => {}, () => {});
  return decision;
}

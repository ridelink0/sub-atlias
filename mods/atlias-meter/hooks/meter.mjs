// Pure counting for atlias-meter. No Node and no mods API in here, so the hooks
// module and atlias's own tests import the same code.
const NL = String.fromCharCode(10);

export function newTally() {
  return { kinds: {}, requests: 0, subagentRequests: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, incomplete: 0, ledger: [], resultErrors: {} };
}
// One more piece of a kind: how many there have been, and how many characters.
export function addChars(tally, kind, chars) {
  const row = tally.kinds[kind] || (tally.kinds[kind] = { count: 0, chars: 0 });
  row.count += 1;
  row.chars += Number.isFinite(chars) && chars > 0 ? chars : 0;
  return tally;
}
export function add(tally, kind, text) {
  return addChars(tally, kind, typeof text === 'string' ? text.length : 0);
}
// One request's usage, as the API reported it.
// A missing usage or a count that is not a whole non-negative number is added as 0 here, so
// tally.incomplete counts those requests and the table then calls the sums a lower bound.
export function addUsage(tally, usage, agentId) {
  const whole = (v) => Number.isSafeInteger(v) && v >= 0;
  if (!usage || typeof usage !== 'object') {
    tally.incomplete = (tally.incomplete || 0) + 1;
    return tally;
  }
  if (![usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens].every(whole)) tally.incomplete = (tally.incomplete || 0) + 1;
  const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  tally.requests += 1;
  if (agentId) tally.subagentRequests += 1;
  tally.usage.input += n(usage.input_tokens);
  tally.usage.output += n(usage.output_tokens);
  tally.usage.cacheRead += n(usage.cache_read_input_tokens);
  tally.usage.cacheWrite += n(usage.cache_creation_input_tokens);
  if (!Object.values(tally.usage).every(Number.isSafeInteger)) tally.unsafe = true;
  return tally;
}
// The exact ledger (APPROVED-PLAN-1016 E0): one row per turn.step result. Each count is a
// whole non-negative number or null when it was missing or not a count; addUsage's sums above
// read such a count as 0, this ledger never does. A tool call keeps its name and the names of
// its top-level argument keys, never their values.
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
function argKeys(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  return Object.keys(input).sort();
}
export function addStep(tally, result, agentId) {
  const u = result && result.usage && typeof result.usage === 'object' ? result.usage : null;
  const uses = result && Array.isArray(result.toolUses) ? result.toolUses : [];
  (tally.ledger || (tally.ledger = [])).push({
    role: agentId ? 'subagent' : 'main', agentId: agentId || null,
    turnId: result && typeof result.turnId === 'string' ? result.turnId : null,
    index: result && Number.isInteger(result.index) ? result.index : null,
    stopReason: result && typeof result.stopReason === 'string' ? result.stopReason : null,
    model: u && typeof u.model === 'string' ? u.model : null,
    usage: u && { input: count(u.input_tokens), output: count(u.output_tokens), cacheRead: count(u.cache_read_input_tokens), cacheWrite: count(u.cache_creation_input_tokens) },
    tools: uses.map((t) => ({ name: t && typeof t.name === 'string' ? t.name : 'unknown', keys: argKeys(t && t.input) })),
  });
  return tally;
}
const known = (u) => !!u && u.input !== null && u.output !== null && u.cacheRead !== null && u.cacheWrite !== null;
// Spend by role and over all roles. A request's tokens are its input, cache read, cache
// written and output, each counted once; peak is the largest one request. Any request without
// a usable count makes its role's figures and the overall figures null, never smaller.
export function spend(tally) {
  const out = {};
  for (const r of tally.ledger || []) for (const role of [r.role, 'all']) {
    const s = out[role] || (out[role] = { requests: 0, unknown: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, peak: 0 });
    s.requests += 1;
    if (!known(r.usage)) { s.unknown += 1; continue; }
    const u = r.usage;
    const one = u.input + u.cacheRead + u.cacheWrite + u.output;
    // A request, or a running total, past the exact integer range is not a measurement.
    if (!Number.isSafeInteger(one) || !Number.isSafeInteger(s.total + one)) { s.unknown += 1; continue; }
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) s[k] += u[k];
    s.total += one;
    s.peak = Math.max(s.peak, one);
  }
  for (const s of Object.values(out)) if (s.unknown) for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'total', 'peak']) s[k] = null;
  return out;
}
// What each request did, from metadata alone: a request that called no tool, each tool by its
// group, ToolSearch, the batch tool, and a standalone call whose only argument key is args (the
// r4 wrapped-call class). A label says what was observed, not why a task passed or what it cost.
export const BATCH_TOOL = 'mcp__atlias-transaction__batch';
export function causes(tally) {
  const out = {};
  const bump = (k) => { out[k] = (out[k] || 0) + 1; };
  for (const r of tally.ledger || []) {
    if (!r.tools.length) bump('no-tool');
    for (const t of r.tools) {
      bump('tool:' + toolGroup(t.name));
      if (t.name === 'ToolSearch') bump('search');
      if (t.name === BATCH_TOOL) bump('batch');
      else if (t.keys && t.keys.length === 1 && t.keys[0] === 'args') bump('wrapped-args');
    }
  }
  return out;
}
// Tool results the API was told were errors, by tool group.
export function resultErrors(tally, group, message) {
  let n = 0;
  for (const block of (message && Array.isArray(message.content) ? message.content : [])) if (block && block.type === 'tool_result' && block.is_error === true) n += 1;
  if (n) {
    const errors = tally.resultErrors || (tally.resultErrors = {});
    errors[group] = (errors[group] || 0) + n;
  }
  return tally;
}
// The characters of the tool results in one stored row.
export function resultChars(message) {
  let chars = 0;
  for (const block of (message && Array.isArray(message.content) ? message.content : [])) {
    if (!block || block.type !== 'tool_result') continue;
    if (typeof block.content === 'string') chars += block.content.length;
    else if (Array.isArray(block.content)) for (const part of block.content) if (part && part.type === 'text' && typeof part.text === 'string') chars += part.text.length;
  }
  return chars;
}
// mcp__server__tool is counted under its server, a built-in tool under its own name.
export function toolGroup(name) {
  const s = String(name || 'unknown');
  if (!s.startsWith('mcp__')) return s;
  return 'mcp:' + (s.slice(5).split('__')[0] || 'unknown');
}
// Every kind, largest first.
export function rows(tally) {
  return Object.entries(tally.kinds).map(([kind, v]) => ({ kind, count: v.count, chars: v.chars })).sort((a, b) => b.chars - a.chars || a.kind.localeCompare(b.kind));
}
// The totals of each family: the part of a kind before its first colon.
export function families(tally) {
  const out = {};
  for (const r of rows(tally)) {
    const name = r.kind.split(':')[0];
    const t = out[name] || (out[name] = { count: 0, chars: 0 });
    t.count += r.count;
    t.chars += r.chars;
  }
  return out;
}
// What /atlias-meter prints.
export function table(tally, top = 25) {
  const u = tally.usage;
  const lines = ['atlias-meter: what has been carried since the mod loaded. Characters are exact; nothing was changed.'];
  lines.push(`requests ${tally.requests} (${tally.subagentRequests} by subagents); tokens as the API reported them: input ${u.input}, cache read ${u.cacheRead}, cache written ${u.cacheWrite}, output ${u.output}`);
  if (tally.unsafe) lines.push('UNSAFE: the sums above passed the range a number can hold exactly, so they are not a measurement; the exact ledger below says unknown instead');
  if (tally.incomplete) lines.push(`INCOMPLETE: ${tally.incomplete} request${tally.incomplete === 1 ? '' : 's'} had no usage or a count that was not a whole number, so the sums above are a lower bound, not a total; the exact ledger below says unknown instead`);
  const fam = Object.entries(families(tally)).sort((a, b) => b[1].chars - a[1].chars || a[0].localeCompare(b[0]));
  if (!fam.length) lines.push('nothing counted yet');
  for (const [name, t] of fam) lines.push(`${name}: ${t.chars} characters in ${t.count} piece${t.count === 1 ? '' : 's'}`);
  const all = rows(tally);
  if (all.length) lines.push('largest pieces:');
  for (const r of all.slice(0, top)) lines.push(`  ${r.kind}: ${r.chars} characters, ${r.count} time${r.count === 1 ? '' : 's'}`);
  if (all.length > top) lines.push(`  and ${all.length - top} smaller ones`);
  const show = (v) => (v === null ? 'unknown' : String(v));
  for (const [role, s] of Object.entries(spend(tally))) lines.push(`exact ledger ${role}: ${s.requests} requests, ${s.unknown} without a usable count; total ${show(s.total)}, peak ${show(s.peak)}`);
  const seen = Object.entries(causes(tally)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (seen.length) lines.push('observed calls: ' + seen.map(([k, v]) => `${k} ${v}`).join(', '));
  const errs = Object.entries(tally.resultErrors || {});
  if (errs.length) lines.push('error results: ' + errs.map(([k, v]) => `${k} ${v}`).join(', '));
  return lines.join(NL);
}

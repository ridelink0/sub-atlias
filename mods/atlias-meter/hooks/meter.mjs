// Pure counting for atlias-meter. No Node and no mods API in here, so the hooks
// module and atlias's own tests import the same code.
const NL = String.fromCharCode(10);

export function newTally() {
  return { kinds: {}, requests: 0, subagentRequests: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
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
export function addUsage(tally, usage, agentId) {
  if (!usage || typeof usage !== 'object') return tally;
  const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
  tally.requests += 1;
  if (agentId) tally.subagentRequests += 1;
  tally.usage.input += n(usage.input_tokens);
  tally.usage.output += n(usage.output_tokens);
  tally.usage.cacheRead += n(usage.cache_read_input_tokens);
  tally.usage.cacheWrite += n(usage.cache_creation_input_tokens);
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
  const fam = Object.entries(families(tally)).sort((a, b) => b[1].chars - a[1].chars || a[0].localeCompare(b[0]));
  if (!fam.length) lines.push('nothing counted yet');
  for (const [name, t] of fam) lines.push(`${name}: ${t.chars} characters in ${t.count} piece${t.count === 1 ? '' : 's'}`);
  const all = rows(tally);
  if (all.length) lines.push('largest pieces:');
  for (const r of all.slice(0, top)) lines.push(`  ${r.kind}: ${r.chars} characters, ${r.count} time${r.count === 1 ? '' : 's'}`);
  if (all.length > top) lines.push(`  and ${all.length - top} smaller ones`);
  return lines.join(NL);
}

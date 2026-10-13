// RESEARCH-FIRST 0a H1, 0d, 0f: defer contracts; never shorten their instructions.
// Unsupported endpoints and every off session retain native behavior.
export const CORE = ['Bash', 'PowerShell', 'Read', 'Edit', 'Write', 'ToolSearch', 'WaitForMcpServers'];
export const DEFER = ['Agent', 'CronCreate', 'CronDelete', 'CronList', 'EnterWorktree', 'ExitWorktree', 'Glob', 'Grep', 'ListAgents', 'NotebookEdit', 'ReportFindings', 'ScheduleWakeup', 'SendMessage', 'Skill', 'TaskStop', 'WebFetch', 'WebSearch', 'Workflow'];
// The engine names only the tools it defers itself in its deferred-tool listing. Claude Code
// 2.1.296 left these out of it once this mod moved them, so the model could neither call them nor
// see their names (tools/h2h/toolsearch_probe.py, 2026-10-12). They are named in ToolSearch's
// own description instead, after its full original text.
export const ANNOUNCE = ['Agent', 'Glob', 'Grep', 'ListAgents', 'ReportFindings', 'ScheduleWakeup', 'Skill', 'Workflow'];
export const NOTE = `\n\nAlso deferred, by the atlias-efficiency mod; load one with "select:<name>" before calling it: ${ANNOUNCE.join(', ')}`;

export function placement(event, result, enabled, compatible) {
  if (!enabled || !compatible || event?.provider?.plugin !== 'engine') return result;
  if (event.tool === 'ToolSearch') return { ...result, description: result.description + NOTE };
  if (!DEFER.includes(event.tool)) return result;
  return { ...result, isDeferred: true };
}

// RESEARCH-FIRST 0d and 0f: the skill listing is re-sent on every call and was 5,961 characters of
// a 27,960-byte opening (trial-02, 2026-10-13). Every skill keeps its whole name and stays
// available; only the listing's description is cut. A skill's own instructions are never touched.
export const LISTING_CAP = 120;
export const LISTING_NOTE = '\nDescriptions above are cut short by the atlias-efficiency mod. Every skill listed is still available, and its full instructions load unchanged when it is invoked.';

export function briefListing(text, enabled) {
  if (!enabled || typeof text !== 'string') return text;
  const out = [];
  let items = 0;
  let cut = false;
  for (const line of text.split('\n')) {
    if (!line.startsWith('- ')) {
      // After the first item, a line that is not an item is the rest of a description.
      if (items) cut = true; else out.push(line);
      continue;
    }
    items++;
    const colon = line.indexOf(': ');
    if (colon < 0 || line.length <= LISTING_CAP) { out.push(line); continue; }
    const room = Math.max(colon + 1, line.lastIndexOf(' ', LISTING_CAP));
    out.push(line.slice(0, room).trimEnd() + ' ...');
    cut = true;
  }
  return cut ? out.join('\n') + LISTING_NOTE : text;
}

export function register(on, options = {}) {
  const enabled = options.enabled === true;
  const listing = enabled && options.skillListing === true;
  on('prompt.attachment', { type: 'skill_listing' }, async ($, e, next) => {
    const result = await next(e);
    if (!listing || e?.origin?.kind !== 'engine' || typeof result?.text !== 'string') return result;
    return { ...result, text: briefListing(result.text, listing) };
  }).catch(async ($, e, next) => next(e));
  on('tool.describe', async ($, e, next) => {
    const result = await next(e);
    if (!enabled) return result;
    // Explicit opt-in is also necessary on custom endpoints; do not infer compatibility.
    const compatible = (await $.env.get('ENABLE_TOOL_SEARCH')) === 'true';
    return placement(e, result, enabled, compatible);
  }).catch(async ($, e, next) => next(e));
}

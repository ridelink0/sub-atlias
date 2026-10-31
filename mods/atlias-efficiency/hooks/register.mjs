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

// `keep` (hotGlob: ['Glob']; Gev 2026-10-16) names tools this mod leaves visible and does not announce.
// The transaction mod's hotGlob cannot undo a deferral made here, so both mods take the option
// (native-lean-r3: with it set on the transaction mod alone, Glob stayed deferred).
export function placement(event, result, enabled, compatible, keep = []) {
  if (!enabled || !compatible || event?.provider?.plugin !== 'engine') return result;
  if (event.tool === 'ToolSearch') return { ...result, description: result.description + (keep.length ? noteFor(keep) : NOTE) };
  if (!DEFER.includes(event.tool) || keep.includes(event.tool)) return result;
  return { ...result, isDeferred: true };
}
export function noteFor(keep) {
  return `\n\nAlso deferred, by the atlias-efficiency mod; load one with "select:<name>" before calling it: ${ANNOUNCE.filter((n) => !keep.includes(n)).join(', ')}`;
}

// RESEARCH-FIRST 0d and 0f: the skill listing is re-sent on every call and was 5,961 characters of
// a 27,960-byte opening (trial-02, 2026-10-13). Every skill keeps its whole name and stays
// available; only the listing's description is cut. A skill's own instructions are never touched.
export const LISTING_CAP = 120;
export const LISTING_NOTE = '\nDescriptions above are cut short by the atlias-efficiency mod. Every skill listed is still available, and its full instructions load unchanged when it is invoked.';

// skillNamesOnly (Gev 2026-10-16, a step toward 8x): the listing keeps every name, in order, and no
// description. The sprint's lean request still carried ~1,800 bytes of listing on every call.
export const NAMES_NOTE = '\nOnly skill names are listed here, by the atlias-efficiency mod. Every skill is still available, and its full instructions load unchanged when it is invoked.';

export function namesListing(text, enabled) {
  if (!enabled || typeof text !== 'string') return text;
  const out = [];
  let items = 0;
  let cut = false;
  for (const line of text.split('\n')) {
    if (!line.startsWith('- ')) {
      if (items) cut = true; else out.push(line);
      continue;
    }
    items++;
    const colon = line.indexOf(': ');
    if (colon < 0) { out.push(line); continue; }
    out.push(line.slice(0, colon));
    cut = true;
  }
  return cut ? out.join('\n') + NAMES_NOTE : text;
}

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

// RESEARCH-FIRST 0f: Claude Code's own memory instructions were 2,313 of the system prompt's
// 5,861 characters (trial-02). With Atlias loaded, memory is Atlias's (harness_recall,
// harness_remember). Only a section named here is left out; any other section, known or
// future, passes through untouched.
export const OMIT_SECTIONS = ['memory'];

export function section(event, result, enabled) {
  if (!enabled || !OMIT_SECTIONS.includes(event?.name)) return result;
  return { ...result, text: null };
}

// H1: Bash, Read and ToolSearch carried 3,500 characters of description on every call
// (trial-02). The opening of each original text is kept, because it names the shell this
// build runs; the long notes after it are replaced by these, and the schema, which names
// every parameter, is never touched. A description without the expected break is left whole.
export const TOOL_TEXT = {
  Bash: { until: '\n- ', tail: '- The working directory persists between calls; shell state does not.\n- Prefer the dedicated tools over `find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk` and `echo`.\n- `timeout` is in milliseconds (default 120000, max 600000); `run_in_background` runs a command detached, with no `&`.\n- Git: no interactive flags (`-i`); commit or push only when the user asks.' },
  Read: { until: '\n- ', tail: '- `file_path` must be an absolute path.\n- Returns up to 2000 lines in cat -n format; read only the part you need with `offset` and `limit`.\n- Also reads images, PDFs (`pages`, max 20 a request) and Jupyter notebooks.\n- Do not re-read a file you just edited: Edit and Write report an error when a change fails.' },
  ToolSearch: { until: '\n\n', tail: 'Deferred tools appear by name in <system-reminder> messages and cannot be called until fetched. Query "select:Name1,Name2" for exact names, or keywords to search (up to max_results matches). A fetched tool is callable like any other.' },
};

export function compactText(event, result, enabled) {
  if (!enabled || event?.provider?.plugin !== 'engine' || !Object.hasOwn(TOOL_TEXT, event.tool) || typeof result?.description !== 'string') return result;
  const rule = TOOL_TEXT[event.tool];
  const at = result.description.indexOf(rule.until);
  if (at < 0) return result;
  const description = result.description.slice(0, at) + '\n' + rule.tail;
  return description.length < result.description.length ? { ...result, description } : result;
}

export function register(on, options = {}) {
  const enabled = options.enabled === true;
  const listing = enabled && options.skillListing === true;
  const namesOnly = enabled && options.skillNamesOnly === true;
  const noMemory = enabled && options.omitMemorySection === true;
  const compact = enabled && options.compactToolText === true;
  const keep = enabled && options.hotGlob === true ? ['Glob'] : [];
  on('prompt.section', { name: 'memory' }, async ($, e, next) => section(e, await next(e), noMemory)).catch(async ($, e, next) => next(e));
  on('prompt.attachment', { type: 'skill_listing' }, async ($, e, next) => {
    const result = await next(e);
    if (!(listing || namesOnly) || e?.origin?.kind !== 'engine' || typeof result?.text !== 'string') return result;
    return { ...result, text: namesOnly ? namesListing(result.text, true) : briefListing(result.text, listing) };
  }).catch(async ($, e, next) => next(e));
  on('tool.describe', async ($, e, next) => {
    const result = await next(e);
    if (!enabled) return result;
    // Explicit opt-in is also necessary on custom endpoints; do not infer compatibility.
    const compatible = (await $.env.get('ENABLE_TOOL_SEARCH')) === 'true';
    return placement(e, compactText(e, result, compact), enabled, compatible, keep);
  }).catch(async ($, e, next) => next(e));
}

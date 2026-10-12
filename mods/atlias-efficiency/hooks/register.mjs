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

export function register(on, options = {}) {
  const enabled = options.enabled === true;
  on('tool.describe', async ($, e, next) => {
    const result = await next(e);
    if (!enabled) return result;
    // Explicit opt-in is also necessary on custom endpoints; do not infer compatibility.
    const compatible = (await $.env.get('ENABLE_TOOL_SEARCH')) === 'true';
    return placement(e, result, enabled, compatible);
  }).catch(async ($, e, next) => next(e));
}

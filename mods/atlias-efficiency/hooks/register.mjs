// RESEARCH-FIRST 0a H1, 0d, 0f: defer contracts; never shorten their instructions.
// Unsupported endpoints and every off session retain native behavior.
export const CORE = ['Bash', 'PowerShell', 'Read', 'Edit', 'Write', 'ToolSearch', 'WaitForMcpServers'];
export const DEFER = ['Agent', 'CronCreate', 'CronDelete', 'CronList', 'EnterWorktree', 'ExitWorktree', 'Glob', 'Grep', 'ListAgents', 'NotebookEdit', 'ReportFindings', 'ScheduleWakeup', 'SendMessage', 'Skill', 'TaskStop', 'WebFetch', 'WebSearch', 'Workflow'];

export function placement(event, result, enabled, compatible) {
  if (!enabled || !compatible || event?.provider?.plugin !== 'engine' || !DEFER.includes(event.tool)) return result;
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

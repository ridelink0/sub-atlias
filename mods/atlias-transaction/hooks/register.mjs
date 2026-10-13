// RESEARCH-FIRST 0f; PLAN-1013 items 10/11: combine mechanical calls through
// the native permission path. Experimental, disabled by default, no model calls.
export const NAME = 'mcp__atlias-transaction__batch';
export const LIMIT = 8;
export const TOOLS = ['Read', 'Edit', 'Write', 'Bash', 'PowerShell'];
export const DEFERRED = ['Agent', 'Bash', 'PowerShell', 'CronCreate', 'CronDelete', 'CronList', 'Edit', 'EnterWorktree', 'ExitWorktree', 'Glob', 'Grep', 'ListAgents', 'NotebookEdit', 'Read', 'ReportFindings', 'ScheduleWakeup', 'SendMessage', 'Skill', 'TaskStop', 'WebFetch', 'WebSearch', 'Workflow', 'Write'];
export const SPEC = {
  name: 'batch',
  description: 'Run up to 8 native operations in order, stopping on refusal or tool error. Each operation uses its native argument names and permissions. Supply absolute file paths. Use a batch for independent reads, or edits followed by a visible project check. Results report execution and full diagnostics; completion does not establish that a test passed. Use native tools and ToolSearch for anything else.',
  isDeferred: false,
  inputSchema: { type: 'object', properties: { operations: { type: 'array', minItems: 1, maxItems: LIMIT, items: {
    type: 'object', properties: { tool: { type: 'string', enum: TOOLS }, args: { type: 'object' } }, required: ['tool', 'args'], additionalProperties: false,
  } } }, required: ['operations'], additionalProperties: false },
};

export function invalid(operations) {
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > LIMIT) return 'Supply between 1 and 8 operations.';
  for (const op of operations) {
    if (!op || typeof op !== 'object' || Array.isArray(op) || !TOOLS.includes(op.tool) || !op.args || typeof op.args !== 'object' || Array.isArray(op.args)) return 'Each operation needs an allowed native tool and an argument object.';
    if (Object.keys(op).some(k => k !== 'tool' && k !== 'args')) return 'Unknown operation field.';
    // These are host control fields, never model-supplied consent or identity.
    if (['tool', 'tool_use_id', 'consent', 'agentId', '__proto__', 'constructor', 'prototype'].some(k => Object.hasOwn(op.args, k))) return 'Reserved host fields cannot be supplied as tool arguments.';
  }
  return null;
}

export function state(result) {
  if (result && typeof result.deny === 'string') return 'refused';
  if (result && result.isError === true) return 'tool-error';
  if (result && Object.hasOwn(result, 'result')) return 'executed';
  return 'unknown';
}

export function register(on, options = {}) {
  const enabled = options.enabled === true;
  const defer = enabled && options.deferBuiltins === true;
  let available = null;
  on('session.start', async ($, e, next) => {
    if (enabled) {
      const names = (await $.tool.list()).map(t => t.name);
      const operations = TOOLS.filter(n => names.includes(n));
      if (operations.length) {
        await $.tool.register({ ...SPEC, inputSchema: { ...SPEC.inputSchema, properties: {
          operations: { ...SPEC.inputSchema.properties.operations, items: { ...SPEC.inputSchema.properties.operations.items, properties: {
            ...SPEC.inputSchema.properties.operations.items.properties, tool: { type: 'string', enum: operations },
          } } },
        } } });
        available = DEFERRED.filter(n => names.includes(n));
      }
    }
    return next(e);
  }).catch(async ($, e, next) => next(e));
  on('tool.describe', async ($, e, next) => {
    const result = await next(e);
    if (!defer || available === null || e?.provider?.plugin !== 'engine' || (await $.env.get('ENABLE_TOOL_SEARCH')) !== 'true') return result;
    if (e.tool === 'ToolSearch') return { ...result, description: result.description + '\nNative tools deferred by this mod: ' + available.join(', ') + '. Load one with select:<name> before calling it directly. Batch operations: ' + available.filter(n => TOOLS.includes(n)).join(', ') + '.' };
    return available.includes(e.tool) ? { ...result, isDeferred: true } : result;
  }).catch(async ($, e, next) => next(e));
  on('tool.call', { tool: 'mcp__atlias-transaction__batch' }, async ($, e, next) => {
    if (!enabled) return next(e);
    const problem = invalid(e.operations);
    if (problem) return { result: JSON.stringify({ status: 'invalid', executed: 0, error: problem }) };
    const results = [];
    let halted = null;
    // This is only a refusal preflight, never approval. Actual calls still run
    // every native permission and PreToolUse check, including later changes.
    for (const op of e.operations) {
      if (next.signal.aborted) return { result: JSON.stringify({ status: 'aborted', attempted: 0, total: e.operations.length, results }) };
      try {
        const permission = await $.tool.check({ tool: op.tool, input: op.args });
        if (permission?.decision === 'deny') return { result: JSON.stringify({ status: 'refused', attempted: 0, total: e.operations.length, reason: permission.reason || 'Native permission denied.', results }) };
        if (permission?.decision !== 'allow' && permission?.decision !== 'ask') return { result: JSON.stringify({ status: 'unknown', attempted: 0, total: e.operations.length, error: 'Native permission decision is unknown.', results }) };
      } catch {
        return { result: JSON.stringify({ status: 'invalid', attempted: 0, total: e.operations.length, error: 'Native preflight could not validate the plan.', results }) };
      }
    }
    for (const op of e.operations) {
      if (next.signal.aborted) { halted = 'aborted'; break; }
      try {
        const result = await $.tool.call({ tool: op.tool, ...op.args });
        const status = state(result);
        results.push({ index: results.length, tool: op.tool, status, native: result });
        if (status !== 'executed') { halted = status; break; }
      } catch {
        halted = next.signal.aborted ? 'aborted' : 'dispatch-error';
        results.push({ index: results.length, tool: op.tool, status: halted, effects: 'unknown' });
        break;
      }
    }
    return { result: JSON.stringify({ status: halted || 'executed', attempted: results.length, total: e.operations.length, results }) };
  }).catch(async ($, e, next) => ({ result: JSON.stringify({ status: 'unknown', error: 'Batch handler failed; inspect native effects before retrying.' }) }));
}

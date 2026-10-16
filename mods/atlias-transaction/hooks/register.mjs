// RESEARCH-FIRST 0f; PLAN-1013 items 10/11: combine mechanical calls through
// the native permission path. Experimental, disabled by default, no model calls.
import { compactTextRead } from './text-read.mjs';
export const NAME = 'mcp__atlias-transaction__batch';
export const LIMIT = 8;
export const TOOLS = ['Read', 'Edit', 'Write', 'Bash', 'PowerShell'];
export const DEFERRED = ['Agent', 'Bash', 'PowerShell', 'CronCreate', 'CronDelete', 'CronList', 'Edit', 'EnterWorktree', 'ExitWorktree', 'Glob', 'Grep', 'ListAgents', 'NotebookEdit', 'Read', 'ReportFindings', 'ScheduleWakeup', 'SendMessage', 'Skill', 'TaskStop', 'WebFetch', 'WebSearch', 'Workflow', 'Write'];
export const SPEC = {
  name: 'batch',
  description: 'Run up to 8 native operations in order, stopping on refusal or tool error. Each operation uses its native argument names and permissions. Supply absolute file paths. Batch Read supports text only; image, PDF, page or unknown Read results stop with require-native-read. Use standalone Read through ToolSearch for those inputs. Workers use standalone native tools through ToolSearch. Use a batch for independent text reads, or edits followed by a visible project check. Results report execution and text diagnostics; completion does not establish that a test passed. Use native tools and ToolSearch for anything else.',
  isDeferred: false,
  inputSchema: { type: 'object', properties: { operations: { type: 'array', minItems: 1, maxItems: LIMIT, items: {
    type: 'object', properties: { tool: { type: 'string', enum: TOOLS }, args: { type: 'object' } }, required: ['tool', 'args'], additionalProperties: false,
  } } }, required: ['operations'], additionalProperties: false },
};
// Optional hot-core placement (off by default): with deferBuiltins these stay
// natively visible and only the other available built-ins are deferred.
export const HOT_CORE = ['Read', 'Edit', 'Write', 'Bash', 'PowerShell'];
// Measured class: small models wrap a direct native call in the batch envelope.
// Say it plainly; never rewrite a guessed input.
export const ENVELOPE_NOTE = 'A standalone native call takes that tool\'s own top-level parameters, for example Read {"file_path": "..."}; only this batch uses the {tool, args} envelope.';
export const HOT_CORE_DESCRIPTION = SPEC.description
  .replace('Use standalone Read through ToolSearch for those inputs.', 'Use standalone native Read for those inputs.')
  .replace('native tools through ToolSearch.', 'native tools; load deferred ones through ToolSearch.')
  + ' ' + ENVELOPE_NOTE;

const NON_TEXT_READ_PATH = /\.(?:apng|avif|bmp|gif|heic|heif|jpe?g|pdf|png|svg|tiff?|webp)$/i;

export function unsupportedReadPlan(op) {
  if (!op || op.tool !== 'Read') return null;
  const args = op.args || {};
  const file = typeof args.file_path === 'string' ? args.file_path : typeof args.path === 'string' ? args.path : '';
  if (Object.hasOwn(args, 'pages') || Object.hasOwn(args, 'page') || NON_TEXT_READ_PATH.test(file)) {
    return 'Text-only batch Read does not support image, PDF, or page-based reads; use native Read directly.';
  }
  return null;
}

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

const READ_FILE_KEYS = new Set(['filePath', 'content', 'numLines', 'startLine', 'totalLines', 'truncatedByTokenCap']);

export function textReadResult(result) {
  if (!result || Array.isArray(result) || result.isError === true || typeof result.text !== 'string' || Object.keys(result).some(k => !['result', 'text'].includes(k))) return null;
  const body = result.result;
  if (!body || Array.isArray(body) || body.type !== 'text' || !body.file || Array.isArray(body.file) || Object.keys(body).some(k => !['type', 'file'].includes(k))) return null;
  const file = body.file;
  if (Object.keys(file).some(k => !READ_FILE_KEYS.has(k))) return null;
  if (typeof file.filePath !== 'string' || typeof file.content !== 'string'
      || !Number.isSafeInteger(file.numLines) || file.numLines < 0
      || !Number.isSafeInteger(file.startLine) || file.startLine < 1
      || !Number.isSafeInteger(file.totalLines) || file.totalLines < file.numLines
      || (Object.hasOwn(file, 'truncatedByTokenCap') && typeof file.truncatedByTokenCap !== 'boolean')) return null;
  // Exact native text, including its diagnostics and line metadata. Do not
  // silently drop malformed fields or serialize a future multimodal envelope.
  return result;
}

// Native answer to a re-read of an unchanged file (measured on 2.1.301):
// {result:{type:'file_unchanged',file:{filePath}},text}. Exact shape only: plain
// objects whose keys are exactly these own enumerable data properties, so an
// error marker, an inherited, accessor or hidden field (which JSON would drop),
// a callable or class payload, or any other key fails (Codex review of a6ee835).
function plainRecord(value) {
  return value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function exactFields(value, names) {
  return plainRecord(value) && Reflect.ownKeys(value).length === names.length
    && names.every(name => Object.hasOwn(value, name) && 'value' in Object.getOwnPropertyDescriptor(value, name)
      && Object.getOwnPropertyDescriptor(value, name).enumerable);
}

export function unchangedReadResult(result) {
  if (!exactFields(result, ['result', 'text']) || typeof result.text !== 'string') return null;
  const body = result.result;
  if (!exactFields(body, ['type', 'file']) || body.type !== 'file_unchanged') return null;
  const file = body.file;
  if (!exactFields(file, ['filePath']) || typeof file.filePath !== 'string' || !file.filePath.length) return null;
  return result;
}

export function state(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return 'unknown';
  if (Object.getPrototypeOf(result) !== Object.prototype && Object.getPrototypeOf(result) !== null) return 'unknown';
  if (Object.hasOwn(result, 'deny') && result.deny !== undefined) return typeof result.deny === 'string' ? 'refused' : 'unknown';
  if (Object.hasOwn(result, 'isError') && result.isError !== undefined) {
    if (result.isError === true) return 'tool-error';
    if (result.isError !== false) return 'unknown';
  }
  if (Reflect.ownKeys(result).some(k => !['result', 'text', 'isError', 'deny', 'ref', 'context'].includes(k))) return 'unknown';
  if (result.context !== undefined && (!Array.isArray(result.context) || result.context.some(x => typeof x !== 'string'))) return 'unknown';
  if (Object.hasOwn(result, 'text') && typeof result.text !== 'string') return 'unknown';
  if (Object.hasOwn(result, 'result') && result.result !== undefined && result.result !== null) return 'executed';
  return 'unknown';
}

export function register(on, options = {}) {
  const enabled = options.enabled === true;
  const defer = enabled && options.deferBuiltins === true;
  const compactReads = enabled && options.deduplicateTextReads === true;
  const hotCore = defer && options.hotCoreTools === true;
  // deferShell (off unless exactly true, only with hotCore): the shells' schemas (the largest hot piece, ~9 KB
  // measured on 2.1.301) wait behind ToolSearch too; a check can still run as a batch operation with no hop.
  const shells = hotCore && options.deferShell === true ? HOT_CORE.filter(n => n !== 'Bash' && n !== 'PowerShell') : HOT_CORE;
  // hotGlob (off unless exactly true, only with hotCore; Gev 2026-10-16, sprint-lean-r1): Glob stays natively visible.
  // Its schema is ~730 bytes on 2.1.301; deferred, a 9B called it three times with a guessed `query` before loading it.
  const hot = hotCore && options.hotGlob === true ? [...shells, 'Glob'] : shells;
  const unchangedReads = enabled && options.unchangedReads === true;
  // omitBatch (off unless exactly true, only with hotCore; Gev 2026-10-16): the deferral stays, the batch tool is not
  // registered. In 26 Atlias runs of sprint-lean-r1/r2b/r2c the 9B never called it, and it was ~1.4 KB of every request.
  const omitBatch = hotCore && options.omitBatch === true;
  const base = hotCore ? { ...SPEC, description: HOT_CORE_DESCRIPTION } : SPEC;
  const spec = compactReads ? { ...base, description: base.description + ' Exact numbered Read text is retained; duplicated file.content may be represented by {from:"native.text",format:"line-number-tab-v1"} (remove each numbered prefix) or format:"text-v1" (identical text). All file metadata is retained.' } : base;
  let available = null;
  on('session.start', async ($, e, next) => {
    available = null;
    if (enabled) {
      const listed = await $.tool.list();
      if (!Array.isArray(listed) || listed.some(t => !t || typeof t.name !== 'string' || !t.name.length)) return next(e);
      const names = listed.map(t => t.name);
      if (new Set(names).size !== names.length) return next(e);
      if (!names.includes('ToolSearch')) return next(e);
      const operations = TOOLS.filter(n => names.includes(n));
      if (operations.length) {
        if (!omitBatch) await $.tool.register({ ...spec, inputSchema: { ...SPEC.inputSchema, properties: {
          operations: { ...SPEC.inputSchema.properties.operations, items: { ...SPEC.inputSchema.properties.operations.items, properties: {
            ...SPEC.inputSchema.properties.operations.items.properties, tool: { type: 'string', enum: operations },
          } } },
        } } });
        if (names.includes('ToolSearch')) available = DEFERRED.filter(n => names.includes(n) && !(hotCore && hot.includes(n)));
      }
    }
    return next(e);
  }).catch(async ($, e, next) => next(e));
  on('tool.describe', async ($, e, next) => {
    const result = await next(e);
    if (!defer || available === null || e?.provider?.plugin !== 'engine' || (await $.env.get('ENABLE_TOOL_SEARCH')) !== 'true') return result;
    // An unfamiliar descriptor (a future client's shape) passes through untouched.
    if (!result || typeof result !== 'object' || Array.isArray(result) || ![Object.prototype, null].includes(Object.getPrototypeOf(result))) return result;
    if (e.tool === 'ToolSearch' && typeof result.description !== 'string') return result;
    // Hot core: name only what is actually deferred; nothing deferred, nothing added.
    if (e.tool === 'ToolSearch' && hotCore) return available.length ? { ...result, description: result.description + '\nNative tools deferred by this mod: ' + available.join(', ') + '. Load one with select:<name> before calling it directly.' + (omitBatch ? '' : ' ' + ENVELOPE_NOTE.replace('only this batch', 'only the batch')) } : result;
    if (e.tool === 'ToolSearch') return { ...result, description: result.description + '\nNative tools deferred by this mod: ' + available.join(', ') + '. Load one with select:<name> before calling it directly. Batch operations: ' + available.filter(n => TOOLS.includes(n)).join(', ') + '.' };
    return available.includes(e.tool) ? { ...result, isDeferred: true } : result;
  }).catch(async ($, e, next) => next(e));
  on('tool.call', { tool: 'mcp__atlias-transaction__batch' }, async ($, e, next) => {
    if (!enabled) return next(e);
    const problem = invalid(e.operations);
    if (problem) return { result: JSON.stringify({ status: 'invalid', executed: 0, error: problem }) };
    const results = [];
    // Current native $.tool.call loses the child's agentId for inner operations.
    // Do not attribute a worker's effects/checks to the parent. The host owns
    // this event field; model arguments cannot supply identity.
    if (e.agentId !== undefined && e.agentId !== null) return { result: JSON.stringify({ status: 'require-native-tools', attempted: 0, total: e.operations.length, reason: hotCore ? 'Worker batch actor propagation is unqualified; use standalone native tools and load deferred ones through ToolSearch.' : 'Worker batch actor propagation is unqualified; use standalone native tools through ToolSearch.', results }) };
    let halted = null;
    const unsupported = e.operations.find(unsupportedReadPlan);
    if (unsupported) return { result: JSON.stringify({ status: 'require-native-read', attempted: 0, total: e.operations.length, reason: unsupportedReadPlan(unsupported), results }) };
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
        if (op.tool === 'Read' && status === 'executed') {
          const nativeText = textReadResult(result) || (unchangedReads ? unchangedReadResult(result) : null);
          if (!nativeText) {
            results.push({ index: results.length, tool: op.tool, status: 'require-native-read' });
            halted = 'require-native-read';
            break;
          }
          results.push({ index: results.length, tool: op.tool, status, native: compactReads ? compactTextRead(nativeText) : nativeText });
        } else if (op.tool === 'Read') {
          const native = {};
          if (typeof result?.text === 'string') native.text = result.text;
          if (typeof result?.deny === 'string') native.deny = result.deny;
          if (result?.isError === true) native.isError = true;
          results.push({ index: results.length, tool: op.tool, status, native });
          if (status !== 'executed') { halted = status; break; }
        } else {
          results.push({ index: results.length, tool: op.tool, status, native: result });
          if (status !== 'executed') { halted = status; break; }
        }
      } catch {
        halted = next.signal.aborted ? 'aborted' : 'dispatch-error';
        results.push({ index: results.length, tool: op.tool, status: halted, effects: 'unknown' });
        break;
      }
    }
    return { result: JSON.stringify({ status: halted || 'executed', attempted: results.length, total: e.operations.length, results }) };
  }).catch(async ($, e, next) => ({ result: JSON.stringify({ status: 'unknown', error: 'Batch handler failed; inspect native effects before retrying.' }) }));
}

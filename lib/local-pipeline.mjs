// Local pipeline facade, shared by the normal harness and the sub-harness.
// Everything here is off unless cfg.localPipeline.enabled is exactly true. Off
// is a pass-through: the input comes back unchanged and no transport is ever
// called. On, the reviewed contract in mods/atlias-pipeline/hooks builds the
// packet and runs the calls. The wire adapter is used only when a wire option is on.
import { createHash } from 'node:crypto';
import { handle } from '../mods/atlias-pipeline/hooks/contract.mjs';
import { createPipelineRunner } from '../mods/atlias-pipeline/hooks/runner.mjs';
import { createWireAdapter } from '../mods/atlias-pipeline/hooks/wire.mjs';

// planner and reporter turn on the helper calls of lib/local-helpers.mjs, each also off unless exactly true.
// baseUrl and model name the metering Door and its model; they have no default, so nothing is guessed.
// baseUrlEnv names an environment variable holding the Door's root URL instead (a benchmark arm's Door listens on a
// port chosen per task); /v1 is added to it. reasoningEffort is sent as reasoning_effort when set.
// maxTokens is the helpers' own output cap; the Door holds it to the run's cap and says what it sent.
const DEFAULTS = { enabled: false, compactAuthority: false, aliasReceipts: false, conciseGuidance: false, planner: false, reporter: false,
  timeoutMs: 120000, maxOutputChars: 8000, maxTokens: 512, baseUrl: null, baseUrlEnv: null, model: null, reasoningEffort: null };
const BOOLEANS = ['enabled', 'compactAuthority', 'aliasReceipts', 'conciseGuidance', 'planner', 'reporter'];
const STRINGS = ['baseUrl', 'baseUrlEnv', 'model', 'reasoningEffort'];
// The runner's own ceilings. A larger value would fail later inside the runner,
// so it is refused here, when the setting is read.
const LIMITS = { timeoutMs: 120000, maxOutputChars: 12000, maxTokens: 8192 };

function integer(value, fallback, max, name) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) throw new RangeError(`localPipeline.${name} must be a whole number from 1 through ${max}.`);
  return value;
}

// Reads cfg.localPipeline. A boolean is on only when its value is exactly true.
// A number must be a whole number within the runner's ceiling: a bad value
// throws, it is never clamped. A missing setting takes its default.
export function settings(cfg) {
  const raw = cfg?.localPipeline;
  if (raw === undefined || raw === null) return Object.freeze({ ...DEFAULTS });
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('localPipeline must be an object. Set localPipeline.enabled to true to turn it on.');
  const known = [...BOOLEANS, ...STRINGS, ...Object.keys(LIMITS)];
  for (const key of Object.keys(raw)) if (!known.includes(key)) throw new TypeError(`Unknown localPipeline setting: ${key}`);
  const out = {};
  for (const key of BOOLEANS) out[key] = raw[key] === true;
  for (const key of STRINGS) {
    if (raw[key] === undefined || raw[key] === null) out[key] = null;
    else if (typeof raw[key] !== 'string' || !raw[key].trim()) throw new TypeError(`localPipeline.${key} must be a nonempty string.`);
    else out[key] = raw[key];
  }
  for (const [key, max] of Object.entries(LIMITS)) out[key] = integer(raw[key], DEFAULTS[key], max, key);
  return Object.freeze(out);
}

// The folder holding SKILL.md names the skill. Otherwise it is the file's base
// name without its extension. Both separators are accepted, since Windows hosts
// report backslashes.
function skillName(file) {
  const parts = file.split(/[\\/]+/).filter(Boolean);
  const base = parts.at(-1) ?? '';
  if (base.toLowerCase() === 'skill.md' && parts.length > 1) return parts.at(-2);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function skillVersion(body) {
  // A lone surrogate has no exact UTF-8 form, so its hash would not name the body.
  // String.prototype.isWellFormed needs Node 20; package.json allows Node 18.
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(body)) throw new TypeError('A skill body with an unpaired surrogate cannot be hashed exactly.');
  return 'sha256:' + createHash('sha256').update(body, 'utf8').digest('hex');
}

// Turns authority ledger rows into the contract's build payload. Text is taken
// exactly: never trimmed, never newline-normalised, never summarised. The first
// request is the original. Every later request is a follow-up, in order, repeats
// kept. Each skill row becomes one skill, in ledger order. No request row gives
// authority-missing, never an invented original.
export function packetPayloadFromLedger({ sessionId, actorId, scopeVersion, rows } = {}) {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array of authority ledger rows.');
  const requests = [];
  const skills = [];
  for (const row of rows) {
    if (row?.kind === 'request') {
      if (typeof row.text !== 'string') throw new TypeError('A request row needs text.');
      requests.push(row.text);
    } else if (row?.kind === 'skill') {
      if (typeof row.file !== 'string' || row.file === '' || typeof row.text !== 'string') throw new TypeError('A skill row needs a file and text.');
      const name = skillName(row.file);
      if (!name) throw new TypeError(`Cannot name the skill in ${row.file}.`);
      skills.push({ name, version: skillVersion(row.text), body: row.text });
    } else {
      throw new TypeError(`Unknown authority row kind: ${row?.kind}`);
    }
  }
  if (!requests.length) return { ok: false, reason: 'authority-missing' };
  return { ok: true, payload: { sessionId, actorId, scopeVersion, original: requests[0], followups: requests.slice(1), skills } };
}

// Off: returns input itself, so nothing is built or sent. On: returns
// { ok: true, packet } from the contract, or the authority-missing refusal.
// input is the object packetPayloadFromLedger takes.
export async function buildPacket(cfg, input) {
  if (!settings(cfg).enabled) return input;
  const built = packetPayloadFromLedger(input);
  if (!built.ok) return built;
  const { packet } = await handle({ op: 'build', enabled: true, payload: built.payload });
  return { ok: true, packet };
}

// Off: a runner that returns the packet or turn it is given, unchanged, and
// holds no transport. On, without a wire option: the contract's runner. On, with
// a wire option: the wire adapter builds and checks each request, under the same
// timeout, cap and receipt rules as the runner.
export function createRunner(cfg, transport) {
  const s = settings(cfg);
  if (!s.enabled) return createPipelineRunner({ enabled: false });
  if (!s.compactAuthority && !s.aliasReceipts && !s.conciseGuidance) {
    return createPipelineRunner({ enabled: true, transport, timeoutMs: s.timeoutMs, maxOutputChars: s.maxOutputChars });
  }
  return wireRunner(s, transport);
}

// The runner's response rules, mirrored: only text and capped keys, with text
// or capped true.
function readable(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return false;
  if (Object.keys(response).some(key => key !== 'text' && key !== 'capped')) return false;
  if (response.capped !== undefined && typeof response.capped !== 'boolean') return false;
  return response.capped === true || typeof response.text === 'string';
}

function wireRunner(s, transport) {
  if (typeof transport !== 'function') throw new TypeError('enabled runner requires an injected transport function');
  const wire = createWireAdapter({ compactAuthority: s.compactAuthority, aliasReceipts: s.aliasReceipts, conciseGuidance: s.conciseGuidance });
  const instanceId = globalThis.crypto.randomUUID();
  let sequence = 0;

  // One call: a timeout that aborts the transport, one receipt, no retry.
  // decode turns the parsed reply into the checked value.
  async function call(role, request, decode) {
    sequence += 1;
    const receipt = { id: `local-call:${instanceId}:${request.packetId.slice(0, 16)}:${role}:${sequence}`, role, packetId: request.packetId, sequence, outcome: 'transport_failure' };
    const controller = new AbortController();
    const startedAt = Date.now();
    let timer;
    const timed = new Promise(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve({ kind: 'timeout' }); }, s.timeoutMs);
    });
    const actual = Promise.resolve()
      .then(() => transport({ role, request: Object.freeze({ ...request }), signal: controller.signal, timeoutMs: s.timeoutMs, maxOutputChars: s.maxOutputChars }))
      .then(value => ({ kind: 'response', value }), () => ({ kind: 'rejected' }));
    const settled = await Promise.race([actual, timed]);
    clearTimeout(timer);
    receipt.elapsedMs = Math.max(0, Date.now() - startedAt);
    if (settled.kind === 'timeout') { receipt.outcome = 'timeout'; return { receipt }; }
    if (settled.kind === 'rejected' || !readable(settled.value)) return { receipt };
    const response = settled.value;
    if (response.capped === true || response.text.length > s.maxOutputChars) { receipt.outcome = 'capped'; return { receipt }; }
    let parsed;
    try { parsed = JSON.parse(response.text); } catch { receipt.outcome = 'invalid_json'; return { receipt }; }
    try {
      const value = await decode(parsed);
      receipt.outcome = 'ok';
      return { receipt, value };
    } catch {
      receipt.outcome = 'invalid_output';
      return { receipt };
    }
  }

  return Object.freeze({
    async runPlanner(packet) {
      const { request, binding } = await wire.plannerRequest(packet);
      const called = await call('planner', request, output => wire.validatePlannerOutput(packet, request, binding, output));
      return { enabled: true, value: called.value ?? packet, receipts: [called.receipt] };
    },
    async runReporter(packet, receipts, turn) {
      const { request, binding } = await wire.reporterRequest(packet, receipts, turn);
      const called = await call('reporter', request, output => wire.validateReporterOutput(packet, receipts, turn, request, binding, output));
      return { enabled: true, value: called.value ?? turn, receipts: [called.receipt] };
    },
  });
}

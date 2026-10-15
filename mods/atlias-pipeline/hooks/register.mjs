// atlias-pipeline: default-off collectors for the local planner and reporter.
// Nothing here calls a model, opens a connection or runs a process. The only
// change to what Claude Code sends is one constant block, and only when
// evidenceRecordStyle is exactly true. Every other event goes on through
// next(e) and its result comes back unchanged.
//
// Research the choices rest on: RESEARCH-FIRST section 9 (the claude_mods
// contract: pass prompt.submit, skill.prompt and prompt.context through
// unchanged); local-pipeline.md (the original and follow-ups are kept exactly,
// no $.model.complete or fork, a receipt is evidence only when it carries a
// numeric exit code); claude300.md findings 3 and 4 (tool events are tool.call,
// tool.check and tool.describe; there is no tool.result event, so a completed
// call is observed on tool.call's next(e)).
import { createPacket, createReceipt } from './contract.mjs';

export const STORE_KEY = 'atlias-pipeline.session';
export const EVIDENCE_BLOCK = 'atlias-evidence-style';
// Constant text: the same bytes on every call keep the prompt cache valid.
export const EVIDENCE_TEXT = 'Evidence record style: finish each reply with the shortest complete evidence record. List each file you changed, and each check you ran with its exact command, its numeric exit code and the summary line it printed. Keep narration before that record minimal. Do not call a check passed unless its command ran after your last edit and printed a pass.';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
// The person's own submissions only. A task notification, a peer message or a
// scheduled trigger is not the person's instruction, so it is not authority.
const USER_ORIGINS = new Set(['composer', 'bridge', 'sdk']);
const MAX_RECEIPTS = 200;
const MAIN = 'main';

// Strict reading of a tool.call result. Only an own, defined, non-null result
// with no refusal or error marker counts as executed.
export function completion(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return 'unknown';
  if (Object.hasOwn(result, 'deny') && result.deny !== undefined) return typeof result.deny === 'string' ? 'refused' : 'unknown';
  if (Object.hasOwn(result, 'isError') && result.isError !== undefined) {
    if (result.isError === true) return 'tool-error';
    if (result.isError !== false) return 'unknown';
  }
  if (Object.hasOwn(result, 'result') && result.result !== undefined && result.result !== null) return 'executed';
  return 'unknown';
}

const isScalar = value => value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
const actorOf = e => (e.agentId === undefined || e.agentId === null ? MAIN : 'agent:' + String(e.agentId));
const fresh = sessionId => ({ sessionId, broken: false, scope: 0, seq: 0, original: undefined, followups: [], skills: [], receipts: [], packet: null });
const build = state => createPacket({
  sessionId: state.sessionId,
  actorId: MAIN,
  scopeVersion: String(state.scope),
  original: state.original,
  followups: state.followups,
  skills: state.skills,
});

async function digest(text) {
  const hash = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return 'sha256:' + [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function sessionId($) {
  try {
    const id = await $.session.id();
    if (typeof id === 'string' && id.length > 0) return id;
  } catch { /* no id: a session of its own under a fixed name */ }
  return 'unknown-session';
}

async function restore($, sid) {
  let saved;
  try { saved = await $.store.get(STORE_KEY); } catch { return { sessionId: sid, broken: true }; }
  if (!saved || typeof saved !== 'object' || saved.sessionId !== sid) return fresh(sid);
  // A marker left when the full record could not be saved: an older copy would be missing later prompts.
  if (saved.broken === true) return { sessionId: sid, broken: true };
  // A record for this session that cannot be verified means the authority is unknown:
  // record nothing more, rather than let a later prompt become the original.
  const shape = Number.isSafeInteger(saved.scope) && Number.isSafeInteger(saved.seq)
    && (saved.original === undefined || typeof saved.original === 'string')
    && Array.isArray(saved.followups) && Array.isArray(saved.skills) && Array.isArray(saved.receipts);
  if (!shape) return { sessionId: sid, broken: true };
  const restored = { sessionId: sid, broken: false, scope: saved.scope, seq: saved.seq, original: saved.original,
    followups: saved.followups.slice(), skills: saved.skills.slice(), receipts: saved.receipts.slice(), packet: null };
  try {
    if (restored.original !== undefined) restored.packet = await build(restored);
    const expected = restored.packet ? restored.packet.packetId : null;
    const actual = saved.packet && typeof saved.packet === 'object' ? saved.packet.packetId : null;
    if (expected !== actual) return { sessionId: sid, broken: true };
  } catch {
    return { sessionId: sid, broken: true };
  }
  return restored;
}

// Returns false when this session's authority cannot be trusted; nothing is recorded then.
async function ready($, ledger) {
  const sid = await sessionId($);
  if (!ledger.state || ledger.state.sessionId !== sid) ledger.state = await restore($, sid);
  return !ledger.state.broken;
}

async function persist($, ledger) {
  const s = ledger.state;
  try {
    await $.store.set(STORE_KEY, {
      sessionId: s.sessionId, scope: s.scope, seq: s.seq, original: s.original,
      followups: s.followups, skills: s.skills, receipts: s.receipts, packet: s.packet,
    });
  } catch {
    // The full record did not save, so the copy on disk is now older than the ledger. A small marker
    // makes a restart record nothing more for this session. The in-process ledger keeps working.
    try { await $.store.set(STORE_KEY, { sessionId: s.sessionId, broken: true }); } catch { /* nothing more can be stored; a failed save never fails the event */ }
  }
}

// The packet is rebuilt before the state changes, so a value that cannot be packed changes nothing.
async function update($, ledger, mutate) {
  const current = ledger.state;
  const draft = { ...current, followups: current.followups.slice(), skills: current.skills.slice(), receipts: current.receipts.slice() };
  mutate(draft);
  draft.packet = draft.original === undefined ? null : await build(draft);
  ledger.state = draft;
  await persist($, ledger);
}

async function recordPrompt($, e, ledger) {
  if (!e || typeof e.text !== 'string' || !e.origin || !USER_ORIGINS.has(e.origin.kind)) return;
  if (!(await ready($, ledger))) return;
  await update($, ledger, d => {
    if (d.original === undefined) d.original = e.text;
    else d.followups.push(e.text);
  });
}

async function recordSkill($, e, ledger) {
  if (!e || typeof e.skill !== 'string' || e.skill.length === 0 || typeof e.text !== 'string') return;
  const version = await digest(e.text);
  if (!(await ready($, ledger))) return;
  await update($, ledger, d => { d.skills.push({ name: e.skill, version, body: e.text }); });
}

async function observeCompletion($, e, result, ledger) {
  if (!(await ready($, ledger))) return;
  const status = completion(result);
  if (EDIT_TOOLS.has(e.tool)) {
    // Any completion that is not a refusal may have written the file, so older checks stop counting.
    if (status !== 'refused') await update($, ledger, d => { d.scope += 1; });
    return;
  }
  if (!SHELL_TOOLS.has(e.tool) || !ledger.state.packet || status === 'refused') return;
  const seq = ledger.state.seq + 1;
  const packet = ledger.state.packet;
  const event = { eventKey: `${e.tool}:${seq}`, actorId: actorOf(e), kind: 'check', packetId: packet.packetId, scopeVersion: packet.scopeVersion };
  // Only a numeric exit code from a completed call is exit evidence. Stdout text never is.
  const body = result && typeof result === 'object' ? result.result : undefined;
  if (status === 'executed' && body && typeof body === 'object' && Object.hasOwn(body, 'exitCode') && isScalar(body.exitCode)) event.exitCode = body.exitCode;
  const receipt = await createReceipt(packet, event);
  await update($, ledger, d => {
    d.seq = seq;
    d.receipts.push(receipt);
    if (d.receipts.length > MAX_RECEIPTS) d.receipts.splice(0, d.receipts.length - MAX_RECEIPTS);
  });
}

export function register(on, options) {
  const opts = options && typeof options === 'object' ? options : {};
  // Off unless exactly true. Nothing below is registered when this is not true.
  if (opts.enabled !== true) return;
  const collectAuthority = opts.collectAuthority === true;
  // A receipt is bound to the packet, and the packet needs the original prompt.
  const collectReceipts = collectAuthority && opts.collectReceipts === true;
  const evidenceStyle = opts.evidenceRecordStyle === true;
  if (!collectAuthority && !evidenceStyle) return;

  // The in-process ledger. Its copy in $.store is for a restart; the in-process one wins.
  const ledger = { state: null, chain: Promise.resolve() };
  // State changes happen one at a time, so events from parallel subagents cannot interleave.
  const serial = work => {
    const run = ledger.chain.then(work).catch(() => {});
    ledger.chain = run;
    return run;
  };

  if (collectAuthority) {
    // Recorded before next(e): the prompt's turn may run tools straight away, and those receipts must bind to it.
    on('prompt.submit', async ($, e, next) => {
      await serial(() => recordPrompt($, e, ledger));
      return next(e);
    });
    on('skill.prompt', async ($, e, next) => {
      await serial(() => recordSkill($, e, ledger));
      return next(e);
    });
  }

  if (collectReceipts) {
    on('tool.call', async ($, e, next) => {
      const tool = e && e.tool;
      if (!EDIT_TOOLS.has(tool) && !SHELL_TOOLS.has(tool)) return next(e);
      let result;
      try {
        result = await next(e);
      } catch (error) {
        // The native call failed, possibly after writing a file: an edit still advances the scope.
        if (EDIT_TOOLS.has(tool)) await serial(() => observeCompletion($, e, undefined, ledger));
        throw error;
      }
      await serial(() => observeCompletion($, e, result, ledger));
      return result;
    });
  }

  if (evidenceStyle) {
    on('prompt.context', async ($, e, next) => {
      const result = await next(e);
      if (!result || !Array.isArray(result.blocks) || result.blocks.some(block => block && block.name === EVIDENCE_BLOCK)) return result;
      return { ...result, blocks: [...result.blocks, { name: EVIDENCE_BLOCK, text: EVIDENCE_TEXT }] };
    });
  }
}

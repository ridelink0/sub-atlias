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
const MAX_MESSAGES = 4096;
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
const fresh = sessionId => ({ sessionId, broken: false, scope: 0, pendingEdits: 0, seq: 0, original: undefined, followups: [], skills: [], receipts: [], packet: null });
const build = state => createPacket({
  sessionId: state.sessionId,
  actorId: MAIN,
  scopeVersion: String(state.scope) + (state.pendingEdits > 0 ? ':pending' : ''),
  original: state.original,
  followups: state.followups,
  skills: state.skills,
});

async function digest(text) {
  const hash = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return 'sha256:' + [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// The host's id for this session, or null. There is no fallback name: two sessions that both
// lost their id would otherwise share one record and merge their authority.
async function sessionId($) {
  try {
    const id = await $.session.id();
    if (typeof id === 'string' && id.length > 0) return id;
  } catch { /* no id */ }
  return null;
}

// The person's prompts as the host's own transcript holds them, oldest first, or null when the
// transcript cannot be read whole. Tool-result rows are not prompts. A long transcript answers
// only its newest MAX_MESSAGES, so a full page cannot show the first prompt.
async function hostPrompts($) {
  let messages;
  try { messages = await $.session.messages(); } catch { return null; }
  if (!Array.isArray(messages) || messages.length >= MAX_MESSAGES) return null;
  const prompts = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') return null;
    if (message.role !== 'user') continue;
    if (Array.isArray(message.toolResults) && message.toolResults.length > 0) continue;
    if (typeof message.text !== 'string') return null;
    prompts.push(message.text);
  }
  return prompts;
}

// A ledger holding these prompts carries this session's authority only when the host's transcript
// shows exactly those prompts in order; the prompt being submitted now may or may not be in the
// transcript yet. restore asks this with no prompts, to start a ledger only for a session that has
// none earlier.
async function continuous($, prompts, pending) {
  const host = await hostPrompts($);
  if (!host) return false;
  const same = list => list.length === host.length && list.every((text, i) => text === host[i]);
  return same(prompts) || (pending !== undefined && same([...prompts, pending]));
}

// Record nothing more for this session, in this process or after a restart.
async function breakSession($, sid) {
  try { await $.store.set(STORE_KEY, { sessionId: sid, broken: true }); } catch { /* the in-process state is broken either way */ }
  return { sessionId: sid, broken: true };
}

async function restore($, sid, pending) {
  let saved;
  try { saved = await $.store.get(STORE_KEY); } catch { return { sessionId: sid, broken: true }; }
  if (!saved || typeof saved !== 'object' || saved.sessionId !== sid) {
    // No record: this process may still be joining a session whose earlier prompts were never saved.
    return (await continuous($, [], pending)) ? fresh(sid) : breakSession($, sid);
  }
  // A marker left when the full record could not be saved: an older copy would be missing later prompts.
  if (saved.broken === true) return { sessionId: sid, broken: true };
  // A record an earlier process wrote for this session is never extended. Its digest can show the record
  // was not altered, and the host transcript can confirm its prompts, but nothing shows that no skill, edit
  // or check fell between its last save and the restart: a save and its marker can both fail, and a process
  // can stop between an event and its save. Extending it dropped a selected skill, and kept a check from
  // before an unrecorded edit as a pass (Codex review of 91d3e55, cases 2 and 3). So the session records
  // nothing more, and every prompt still passes through.
  return breakSession($, sid);
}

// Returns false when this session's authority cannot be trusted; nothing is recorded then.
// pending is the text of the person's prompt being submitted, when the event is one.
async function ready($, ledger, pending) {
  const sid = await sessionId($);
  if (sid === null) {
    // An event this process cannot place: whichever session it belonged to now misses it.
    ledger.identityLost = true;
    return false;
  }
  if (ledger.identityLost) {
    if (!ledger.state || ledger.state.sessionId !== sid || !ledger.state.broken) ledger.state = await breakSession($, sid);
    return false;
  }
  if (!ledger.state || ledger.state.sessionId !== sid) ledger.state = await restore($, sid, pending);
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
  if (!(await ready($, ledger, e.text))) return;
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

async function refreshPending($, ledger) {
  try { await update($, ledger, d => { d.pendingEdits = ledger.pendingEdits; }); }
  catch { ledger.state = await breakSession($, ledger.state.sessionId); }
}

async function beginCall($, e, ledger) {
  if (!(await ready($, ledger))) return null;
  const editing = EDIT_TOOLS.has(e.tool);
  if (editing) {
    ledger.editEpoch += 1;
    ledger.pendingEdits += 1;
    // Invalidate earlier passes before the write can have effects, not only when it returns.
    await refreshPending($, ledger);
    if (ledger.state.broken) {
      ledger.pendingEdits -= 1;
      ledger.identityLost = true;
      return null;
    }
  }
  return { sessionId: ledger.state.sessionId, packet: ledger.state.packet, actorId: actorOf(e),
    editing, editEpoch: ledger.editEpoch, pendingEdits: ledger.pendingEdits };
}

async function observeCompletion($, e, result, ledger, started) {
  try {
    if (!(await ready($, ledger))) return;
    if (!started || started.sessionId !== ledger.state.sessionId) {
      ledger.state = await breakSession($, ledger.state.sessionId);
      return;
    }
    const status = completion(result);
    if (EDIT_TOOLS.has(e.tool)) {
      // Any completion that is not a refusal may have written the file, so older checks stop counting.
      if (status !== 'refused') await update($, ledger, d => { d.scope += 1; });
      return;
    }
    if (!SHELL_TOOLS.has(e.tool) || !started.packet || status === 'refused') return;
    const seq = ledger.state.seq + 1;
    // A check belongs to the authority and files at invocation, never to a later edit or follow-up.
    // An overlapping edit makes its observation uncertain, even if the edit has not finished yet.
    const packet = started.packet;
    const overlap = started.pendingEdits > 0 || ledger.pendingEdits > 0 || started.editEpoch !== ledger.editEpoch;
    const event = { eventKey: `${e.tool}:${seq}`, actorId: started.actorId, kind: 'check', packetId: packet.packetId, scopeVersion: packet.scopeVersion };
    // Only a numeric exit code from a completed call is exit evidence. Stdout text never is.
    const body = result && typeof result === 'object' ? result.result : undefined;
    if (!overlap && status === 'executed' && body && typeof body === 'object' && Object.hasOwn(body, 'exitCode') && isScalar(body.exitCode)) event.exitCode = body.exitCode;
    const receipt = await createReceipt(packet, event);
    await update($, ledger, d => {
      d.seq = seq;
      d.receipts.push(receipt);
      if (d.receipts.length > MAX_RECEIPTS) d.receipts.splice(0, d.receipts.length - MAX_RECEIPTS);
    });
  } finally {
    if (started && started.editing) {
      ledger.pendingEdits -= 1;
      if (ledger.state && !ledger.state.broken) await refreshPending($, ledger);
    }
  }
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
  const ledger = { state: null, identityLost: false, chain: Promise.resolve(), editEpoch: 0, pendingEdits: 0 };
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
      const started = await serial(() => beginCall($, e, ledger));
      let result;
      try {
        result = await next(e);
      } catch (error) {
        // The native call failed, possibly after writing a file: an edit still advances the scope.
        if (EDIT_TOOLS.has(tool)) await serial(() => observeCompletion($, e, undefined, ledger, started));
        throw error;
      }
      await serial(() => observeCompletion($, e, result, ledger, started));
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

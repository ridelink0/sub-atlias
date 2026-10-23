// Checkpoints per turn and /rewind (H.A.C round two, 2026-10-22, h2, feature 1; fixes F3a and F3b from h4).
// Interactive only: the repl's send() calls checkpoint(); exec and the eval path never do. Code is restored with
// the edit undo stack that lib/loop.mjs already keeps (pushUndo, loop.undo), so lib/loop.mjs is not changed here.
//
// A checkpoint keeps the message that ended the conversation before its turn (an object reference, so a
// compaction that drops older messages is seen as a turn that is gone). /compact calls afterCompact() to
// re-point the checkpoints that survived and mark the rest stale. A saved session stores positions only;
// linkCheckpoints() re-attaches the references after a resume, before anything else reads them.
import * as loop from './loop.mjs';

export const KEEP_TURNS = 200;
export const LIST_TURNS = 20;

export function checkpoint(state, text) {
  const undo = state.undo || [];
  linkCheckpoints(state);
  state.checkpoints = state.checkpoints || [];
  state.checkpoints.push({
    at: Date.now(),
    text: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 60),
    messages: state.messages.length,
    history: state.history.length,
    asks: (state.asks || []).length,
    todo: JSON.parse(JSON.stringify(state.todo || [])),
    undoTop: undo.length ? undo[undo.length - 1] : null,
    anchor: state.messages[state.messages.length - 1] || null,
    linked: true,
    stale: null,
  });
  if (state.checkpoints.length > KEEP_TURNS) state.checkpoints.shift();
  return state.checkpoints.length;
}

// Re-attaches the references of checkpoints read back from a saved session (their message count is the position).
export function linkCheckpoints(state) {
  for (const cp of state.checkpoints || []) {
    if (cp.linked) continue;
    cp.linked = true;
    if (cp.messages > 0) {
      const anchor = state.messages[cp.messages - 1];
      if (anchor) cp.anchor = anchor;
      else cp.stale = 'the saved conversation is shorter than this turn';
    }
  }
}

// Called right after loop.compact has run: a checkpoint whose anchor survived is re-pointed; one whose anchor
// was dropped is stale, and /rewind will not go back to it.
export function afterCompact(state) {
  for (const cp of state.checkpoints || []) {
    if (cp.stale || !cp.anchor) continue;
    const at = state.messages.indexOf(cp.anchor);
    if (at === -1) cp.stale = 'compacted away by /compact';
    else cp.messages = at + 1;
  }
}

// What a saved session keeps of the checkpoints: positions and text, never references or undo positions.
export function serializeCheckpoints(state) {
  return (state.checkpoints || []).map((cp) => ({ at: cp.at, text: cp.text, messages: cp.messages, history: cp.history, asks: cp.asks, todo: cp.todo, stale: cp.stale || null }));
}

export function listTurns(state) {
  linkCheckpoints(state);
  return (state.checkpoints || []).slice(-LIST_TURNS).reverse().map((cp, i) => ({ n: i + 1, at: cp.at, text: cp.text, cp }));
}

export function formatTurns(state) {
  const turns = listTurns(state);
  if (!turns.length) return 'no turn to rewind to yet';
  return turns.map((t) => `${t.n}. ${new Date(t.at).toLocaleTimeString()}  ${t.text}${t.cp.stale ? `  (${t.cp.stale})` : ''}`).join('\n');
}

// How many edits were made after a checkpoint, or null when the undo stack no longer reaches it.
function editsAfter(state, cp) {
  const undo = state.undo || [];
  if (!cp.undoTop) return undo.length;
  const at = undo.lastIndexOf(cp.undoTop);
  return at === -1 ? null : undo.length - at - 1;
}

export function rewindTurn(state, n, { code = false } = {}) {
  const pick = listTurns(state).find((t) => t.n === Number(n));
  if (!pick) return { ok: false, text: `no turn ${n}; /rewind lists the last ${LIST_TURNS}` };
  const cp = pick.cp;
  if (cp.stale) return { ok: false, text: `turn ${n} cannot be restored: it was ${cp.stale}. /rewind goes back only to turns after the last /compact` };
  const idx = state.checkpoints.indexOf(cp);
  const notes = [];
  if (code) {
    const k = editsAfter(state, cp);
    if (k === null) notes.push('code not restored: the undo history no longer reaches this turn (it keeps 30 edits); the files are as they are');
    else {
      const back = [];
      for (let i = 0; i < k; i++) back.push(loop.undo(state));
      notes.push(`code: ${k} edit${k === 1 ? '' : 's'} undone${k ? '\n' + back.join('\n') : ''}`);
    }
  }
  state.messages = state.messages.slice(0, cp.messages);
  state.history = state.history.slice(0, cp.history);
  state.asks = (state.asks || []).slice(0, cp.asks);
  state.todo = JSON.parse(JSON.stringify(cp.todo));
  state.checkpoints = state.checkpoints.slice(0, idx);
  if (state.engine === 'claude' || state.engine === 'codex') notes.push(`${state.engine} keeps its own session history; only Atlias's copy was cut back`);
  return { ok: true, text: [`back to before "${cp.text}"`, ...notes].join('\n') };
}

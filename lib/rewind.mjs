// Checkpoints per turn and /rewind (H.A.C round two, 2026-10-22, h2, feature 1). Interactive only: the repl's
// send() calls checkpoint(); exec and the eval path never do. Code is restored with the edit undo stack that
// lib/loop.mjs already keeps (pushUndo, loop.undo), so nothing in lib/loop.mjs changes.
import * as loop from './loop.mjs';

export const KEEP_TURNS = 200;
export const LIST_TURNS = 20;

// Called before each user turn. Records what a rewind has to put back: the message and history lengths,
// the todo list, the request list and the top of the edit undo stack at that moment.
export function checkpoint(state, text) {
  const undo = state.undo || [];
  state.checkpoints = state.checkpoints || [];
  state.checkpoints.push({
    at: Date.now(),
    text: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 60),
    messages: state.messages.length,
    history: state.history.length,
    asks: (state.asks || []).length,
    todo: JSON.parse(JSON.stringify(state.todo || [])),
    undoTop: undo.length ? undo[undo.length - 1] : null,
  });
  if (state.checkpoints.length > KEEP_TURNS) state.checkpoints.shift();
  return state.checkpoints.length;
}

// The last twenty turns, most recent first. n is what /rewind takes.
export function listTurns(state) {
  return (state.checkpoints || []).slice(-LIST_TURNS).reverse().map((cp, i) => ({ n: i + 1, at: cp.at, text: cp.text, cp }));
}

export function formatTurns(state) {
  const turns = listTurns(state);
  if (!turns.length) return 'no turn to rewind to yet';
  return turns.map((t) => `${t.n}. ${new Date(t.at).toLocaleTimeString()}  ${t.text}`).join('\n');
}

// How many edits were made after a checkpoint, or null when the undo stack no longer reaches it.
function editsAfter(state, cp) {
  const undo = state.undo || [];
  if (!cp.undoTop) return undo.length;
  const at = undo.lastIndexOf(cp.undoTop);
  return at === -1 ? null : undo.length - at - 1;
}

// Goes back to before turn n. With code, the file edits made since that point are undone first, newest
// first, using loop.undo. The conversation, history, todo list and request list are cut back to the checkpoint.
export function rewindTurn(state, n, { code = false } = {}) {
  const pick = listTurns(state).find((t) => t.n === Number(n));
  if (!pick) return { ok: false, text: `no turn ${n}; /rewind lists the last ${LIST_TURNS}` };
  const cp = pick.cp;
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

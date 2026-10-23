// H.A.C council round two (2026-10-22, h2), feature 1: checkpoints per turn and /rewind. Uses real files in a
// temporary project and the edit undo stack of lib/loop.mjs. No model is called.
import fs from 'node:fs';
import path from 'node:path';
import * as rewind from '../lib/rewind.mjs';

export default async function rewindSuites({ asyncSuite, check, TMP }) {
  const dir = path.join(TMP, 'rewind-project');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'a.txt');
  const fresh = () => ({ sid: 'rewind-test', cwd: dir, engine: 'echo', messages: [{ role: 'system', content: 'system' }], history: [], todo: [], asks: [], reads: new Map(), undo: [], edited: new Set(), clock: 0, obs: 0, editedAt: 0, verifiedAt: 0 });
  // Turn one: orig -> mid. Turn two: mid -> end. The checkpoint is taken before each turn, as the repl does.
  const twoTurns = () => {
    const st = fresh();
    fs.writeFileSync(file, 'orig');
    rewind.checkpoint(st, 'first request');
    st.messages.push({ role: 'user', content: 'first request' }, { role: 'assistant', content: 'did first' });
    st.history.push({ role: 'user', text: 'first request' }, { role: 'assistant', text: 'did first' });
    fs.writeFileSync(file, 'mid');
    st.undo.push(new Map([[file, 'orig']]));
    rewind.checkpoint(st, 'second request, which is longer than sixty characters so it must be cut at sixty');
    st.messages.push({ role: 'user', content: 'second request' }, { role: 'assistant', content: 'did second' });
    st.history.push({ role: 'user', text: 'second request' }, { role: 'assistant', text: 'did second' });
    fs.writeFileSync(file, 'end');
    st.undo.push(new Map([[file, 'mid']]));
    return st;
  };
  await asyncSuite('rewind expert', 'rewind: the last turns are listed, newest first, with the first sixty characters', async () => {
    const st = twoTurns();
    const turns = rewind.listTurns(st);
    check('two turns are listed, most recent as 1', turns.length === 2 && turns[0].n === 1 && turns[1].n === 2 && turns[0].text.startsWith('second request, which is longer than sixty characters so it'), { happened: turns.map((t) => `${t.n}:${t.text}`).join(' | '), why: 'The person picks a turn by number; the list must show the newest first and cut each request at sixty characters.', fix: 'Check listTurns and checkpoint.' });
    const many = fresh();
    for (let i = 0; i < 25; i++) rewind.checkpoint(many, 'turn ' + i);
    check('only the last twenty turns are listed', rewind.listTurns(many).length === 20 && rewind.listTurns(many)[0].text === 'turn 24', { happened: String(rewind.listTurns(many).length), why: 'The list is capped at twenty; the newest must be first.', fix: 'Check LIST_TURNS.' });
  });
  await asyncSuite('rewind expert', 'rewind: back to a turn cuts the conversation; code comes back only when asked', async () => {
    const st = twoTurns();
    const cp1 = st.checkpoints[0];
    const r = rewind.rewindTurn(st, 2, { code: false });
    check('rewinding to the first turn cuts messages and history back to before it, and leaves the files', r.ok && st.messages.length === cp1.messages && st.history.length === 0 && fs.readFileSync(file, 'utf8') === 'end', { happened: `messages ${st.messages.length}, history ${st.history.length}, file ${fs.readFileSync(file, 'utf8')}`, why: 'Without code, only the conversation goes back; the edits stay.', fix: 'Check the cut in rewindTurn.' });
    const st2 = twoTurns();
    const r2 = rewind.rewindTurn(st2, 1, { code: true });
    check('rewinding one turn with code undoes only the edit made since that turn', r2.ok && fs.readFileSync(file, 'utf8') === 'mid' && st2.undo.length === 1 && st2.history.length === 2, { happened: `file ${fs.readFileSync(file, 'utf8')}, undo ${st2.undo.length}, history ${st2.history.length}`, why: 'Code undo must stop at the checkpoint, not undo edits from before it.', fix: 'Count the edits after the checkpoint with editsAfter.' });
    const st3 = twoTurns();
    rewind.rewindTurn(st3, 2, { code: true });
    check('rewinding to the first turn with code brings every edit back', fs.readFileSync(file, 'utf8') === 'orig' && st3.messages.length === 1, { happened: `file ${fs.readFileSync(file, 'utf8')}, messages ${st3.messages.length}`, why: 'The whole session can be taken back, files and conversation together.', fix: 'Undo every edit after the checkpoint.' });
  });
  await asyncSuite('rewind expert', 'rewind: a turn that is not there changes nothing; an undo stack that no longer reaches the turn says so', async () => {
    const st = twoTurns();
    const before = JSON.stringify([st.messages, st.history, fs.readFileSync(file, 'utf8')]);
    const r = rewind.rewindTurn(st, 9, { code: true });
    check('an unknown turn is refused and nothing changes', r.ok === false && JSON.stringify([st.messages, st.history, fs.readFileSync(file, 'utf8')]) === before, { happened: r.text, why: 'A wrong number must never rewind anything.', fix: 'Check the turn lookup in rewindTurn.' });
    const st2 = twoTurns();
    st2.checkpoints[1].undoTop = new Map([[file, 'gone']]);
    const r2 = rewind.rewindTurn(st2, 1, { code: true });
    check('a turn the undo stack no longer reaches leaves the files as they are, and says so', /no longer reaches/.test(r2.text) && fs.readFileSync(file, 'utf8') === 'end', { happened: r2.text + ' | file ' + fs.readFileSync(file, 'utf8'), why: 'Undoing the wrong edits would damage work; saying nothing would hide it.', fix: 'Return the note from editsAfter when it is null.' });
  });
}

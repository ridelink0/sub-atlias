// H.A.C round two, fixes F3a and F3b from h4 (review of b9cb964): /rewind after /compact, and after resume.
import * as rewind from '../lib/rewind.mjs';
import * as commands from '../lib/commands.mjs';
import * as agentMod from '../lib/agent.mjs';

export default async function rewind2Suites({ asyncSuite, check, TMP }) {
  const fresh = (sid) => ({ sid, cwd: TMP, engine: 'echo', messages: [{ role: 'system', content: 'system' }], history: [], todo: [], asks: [], edited: new Set(), reads: new Map(), undo: [], reads2: null, clock: 0, obs: 0, editedAt: 0, verifiedAt: 0 });
  const turn = (st, text) => {
    rewind.checkpoint(st, text);
    st.messages.push({ role: 'user', content: text }, { role: 'assistant', content: 'did ' + text });
    st.history.push({ role: 'user', text }, { role: 'assistant', text: 'did ' + text });
  };
  await asyncSuite('rewind round two expert', 'rewind after compaction (F3a): a turn that /compact dropped is refused; a turn it kept goes back to the right place', async () => {
    const st = fresh('rewind-compact');
    for (let i = 1; i <= 14; i++) turn(st, 'turn ' + i);
    const out = [];
    await commands.dispatch('/compact', { state: st, out: (t) => out.push(String(t)), cwd: TMP, api: agentMod.slashApi, ask: null });
    check('the compaction happened', out.some((t) => /^compacted /.test(t)), { happened: out.join(' | '), why: 'The test needs a compaction to mean anything.', fix: 'Check the compact builtin.' });
    turn(st, 'after compact');
    const oldest = rewind.listTurns(st).find((t) => t.text === 'turn 5');
    const before = JSON.stringify(st.messages);
    const refused = rewind.rewindTurn(st, oldest.n, { code: false });
    check('a turn /compact dropped is refused and nothing is cut', refused.ok === false && /compacted away/.test(refused.text) && JSON.stringify(st.messages) === before, { happened: refused.text, why: 'Cutting at a stale position removed the wrong messages (the F3a case).', fix: 'Check afterCompact and the stale test in rewindTurn.' });
    const last = rewind.listTurns(st).find((t) => t.text === 'after compact');
    const beforeLast = st.messages.length - 2;
    const ok = rewind.rewindTurn(st, last.n, { code: false });
    check('the turn after the compaction rewinds to exactly before it', ok.ok === true && st.messages.length === beforeLast && !st.messages.some((m) => m.content === 'after compact'), { happened: `messages ${st.messages.length} (want ${beforeLast})`, why: 'Turns after a compaction must still rewind to their own place.', fix: 'Check that afterCompact re-points surviving checkpoints.' });
  });
  await asyncSuite('rewind round two expert', 'rewind after compaction (F3a): a turn the compaction kept goes back to its own place, after the shift', async () => {
    const st = fresh('rewind-kept');
    for (let i = 1; i <= 14; i++) turn(st, 'turn ' + i);
    await commands.dispatch('/compact', { state: st, out: () => {}, cwd: TMP, api: agentMod.slashApi, ask: null });
    const t13 = rewind.listTurns(st).find((t) => t.text === 'turn 13');
    const r = rewind.rewindTurn(st, t13.n, { code: false });
    check('a kept turn rewinds to right after its own anchor', r.ok === true && st.messages[st.messages.length - 1].content === 'did turn 12', { happened: 'last ' + JSON.stringify(st.messages[st.messages.length - 1]) + ' of ' + st.messages.length, why: 'A checkpoint from before the compaction must follow the shift in message positions.', fix: 'Re-point surviving checkpoints in afterCompact.' });
  });
  await asyncSuite('rewind round two expert', 'rewind after resume (F3b): checkpoints are saved with the session and listed again after resume', async () => {
    const st = fresh('rewind-resume');
    turn(st, 'first saved');
    turn(st, 'second saved');
    agentMod.saveChat(st);
    const loaded = agentMod.loadChat('rewind-resume', TMP);
    const turns = rewind.listTurns(loaded);
    check('after resume /rewind lists the saved turns', turns.length === 2 && turns[0].text === 'second saved' && turns[1].text === 'first saved', { happened: turns.map((t) => t.text).join(' | '), why: 'Checkpoints were lost on resume, so /rewind said nothing to rewind to.', fix: 'Save checkpoints in saveChat and link them on load.' });
    const r = rewind.rewindTurn(loaded, 1, { code: false });
    check('a resumed checkpoint rewinds the conversation to its place', r.ok && loaded.messages.length === 3 && loaded.messages[2].content === 'did first saved', { happened: `messages ${loaded.messages.length}`, why: 'A position saved in one run must mean the same place in the next.', fix: 'Check linkCheckpoints and the saved positions.' });
  });
}

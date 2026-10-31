// H.A.C council round two (2026-10-22, h2), feature 3: /compact with a focus. Interactive only: the eval
// path never reaches lib/commands.mjs (test/slash-command-suites.mjs proves it), so no request changes.
export default async function compactFocusSuites({ asyncSuite, check, TMP, agentMod, commands }) {
  const freshState = (sid) => ({ sid, cwd: TMP, engine: 'echo', messages: [{ role: 'system', content: 'system' }], history: [], todo: [], asks: [], edited: new Set(), reads: new Map(), clock: 0, obs: 0, editedAt: 0, verifiedAt: 0 });
  const FOCUS = 'Focus for this compaction, word for word: ';
  const focus = 'keep "the" auth bug, $HOME and `code` <b> & 5%';
  const longState = (sid) => {
    const st = freshState(sid);
    for (let i = 0; i < 14; i++) st.messages.push({ role: 'user', content: 'request ' + i }, { role: 'assistant', content: 'answer ' + i });
    return st;
  };
  await asyncSuite('compact focus expert', 'compact focus: the focus is kept word for word in the note the compaction leaves', async () => {
    const printed = [];
    const st = longState('compact-focus-a');
    const ctx = { state: st, out: (t) => printed.push(String(t)), cwd: TMP, api: agentMod.slashApi, ask: null };
    await commands.dispatch('/compact ' + focus, ctx);
    const note = st.messages[1] && st.messages[1].content;
    check('a focus after /compact is written into the note, word for word', typeof note === 'string' && note.includes(FOCUS + focus), { happened: String(note).slice(-160), why: 'The person asked to keep something; a focus that is dropped with the old messages is not kept.', fix: 'Check the compact builtin in lib/commands.mjs: it must append the focus to state.messages[1] after loop.compact.' });
    check('the compaction still reports what it dropped', printed.some((p) => /^compacted \d+ earlier messages/.test(p)), { happened: printed.join(' | '), why: 'The focus must not replace the usual report of what was compacted.', fix: 'Keep out(msg) with the loop.compact result.' });
  });
  await asyncSuite('compact focus expert', 'compact focus: without a focus the note is what it was, and a short conversation gets no note', async () => {
    const st = longState('compact-focus-b');
    const ctx = { state: st, out: () => {}, cwd: TMP, api: agentMod.slashApi, ask: null };
    await commands.dispatch('/compact', ctx);
    const note = st.messages[1] && st.messages[1].content;
    check('no focus, no focus line', typeof note === 'string' && note.startsWith('atlias: ') && !note.includes(FOCUS), { happened: String(note).slice(0, 120), why: 'Without a focus the note must stay exactly as loop.compact writes it.', fix: 'Append only when a focus was given.' });
    const short = freshState('compact-focus-c');
    short.messages.push({ role: 'user', content: 'one' }, { role: 'assistant', content: 'two' });
    const before = JSON.stringify(short.messages);
    const out2 = [];
    await commands.dispatch('/compact ' + focus, { state: short, out: (t) => out2.push(String(t)), cwd: TMP, api: agentMod.slashApi, ask: null });
    check('a conversation too short to compact keeps its messages, even with a focus', JSON.stringify(short.messages) === before && out2.join('').includes('nothing to compact yet'), { happened: out2.join(' | ') + ' ' + (JSON.stringify(short.messages) === before ? 'unchanged' : 'changed'), why: 'A focus must not add a note to a conversation that was not compacted.', fix: 'Keep the /^compacted / test before the append.' });
  });
}

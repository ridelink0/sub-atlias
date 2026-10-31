// flags.guardResetOnEdit (2026-10-12). The repeat guard keeps one record of the
// identical tool calls of a run and refuses the fourth, whether or not a file
// was edited in between, and its refusal then says the call returns the same
// result each time when it no longer does. In humanevalfix-python-64 that
// refused the re-run of python check.py after the model's last fix and the task
// failed. With the flag on, an edit that lands clears the record, so identical
// calls made after it count from zero; without an edit in between the fourth is
// still refused. Every case drives runLoop with a scripted model and checks the
// same script with the flag off and unset, which must be the loop as it was.
// Loaded by test/run.mjs.
import * as loop from '../lib/loop.mjs';
import * as settings from '../lib/settings.mjs';
import * as evals from '../lib/eval.mjs';

export default async function guardResetSuites({ asyncSuite, suite, check, core, agentMod, TMP, fs, path }) {
  const NL = String.fromCharCode(10);
  const FENCE = '`'.repeat(3);
  const FLAG = 'ATLIAS_FLAG_GUARD_RESET_ON_EDIT';
  // The refusal as the loop words it today (lib/loop.mjs, the repeated branch of runLoop).
  const GUARD = 'atlias guard: this exact tool call has repeated and returns the same result each time. Change the input or the approach, or answer with what you already know.';
  // The command prints a word that is nowhere in the command itself, so finding it proves the command ran.
  const RAN = 'guard' + 'ran';
  const SHELL = `node -e "console.log('guard'+'ran')"`;
  const call = (obj) => FENCE + 'atlias' + NL + JSON.stringify(obj) + NL + FENCE;
  const READ = call({ tool: 'read_file', path: 'a.txt' });
  const SH = call({ tool: 'shell', command: SHELL });
  const EDIT = call({ tool: 'edit_file', path: 'a.txt', old_string: 'one', new_string: 'two' });
  const EDIT_AGAIN = call({ tool: 'edit_file', path: 'a.txt', old_string: 'two', new_string: 'three' });
  const EDIT_MISS = call({ tool: 'edit_file', path: 'a.txt', old_string: 'no such text anywhere', new_string: 'x' });
  const WRITE = call({ tool: 'write_file', path: 'a.txt', content: 'three' + NL });
  const PATCH_TEXT = ['*** Begin Patch', '*** Update File: a.txt', '@@', '-one', '+two', '*** End Patch'].join(NL);
  const PATCH = call({ tool: 'apply_patch', input: PATCH_TEXT });
  const PATCH_MISS = call({ tool: 'apply_patch', input: PATCH_TEXT.replace('-one', '-nothing like it') });
  const PATCH_VIA_SHELL = call({ tool: 'shell', command: 'apply_patch ' + PATCH_TEXT });
  let n = 0;
  const dir = (files) => {
    const d = path.join(TMP, 'guardreset', `p${++n}`);
    fs.mkdirSync(d, { recursive: true });
    for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(d, rel), text);
    return d;
  };
  const scripted = (replies) => async () => {
    const r = replies.shift();
    if (r === undefined) return { content: 'out of script', calls: [] };
    return typeof r === 'string' ? { content: r, calls: [] } : r;
  };
  const run = async (flag, replies, limits = { maxToolRounds: 14, maxBadReplies: 3 }) => {
    const d = dir({ 'a.txt': 'one' + NL });
    const before = process.env[FLAG];
    if (flag == null) delete process.env[FLAG]; else process.env[FLAG] = flag;
    try {
      const st = agentMod.newState(d, 'ollama');
      const reply = await loop.runLoop(st, 'fix it', { chat: scripted([...replies]), say: () => {}, ask: async () => true, limits });
      const said = st.messages.filter((m) => m.role !== 'system' && m.role !== 'assistant').map((m) => String(m.content || ''));
      return { st, reply, said, d, file: fs.readFileSync(path.join(d, 'a.txt'), 'utf8') };
    } finally { if (before == null) delete process.env[FLAG]; else process.env[FLAG] = before; }
  };
  // The results the model was handed for one tool, in order.
  const results = (r, tool) => r.said.filter((t) => t.startsWith(`Tool result for ${tool}:`));
  const refused = (t) => t.includes(GUARD);
  const brief = (r) => JSON.stringify({ stop: r.st.stop && r.st.stop.reason, resets: r.st.guardResets, file: r.file, said: r.said.map((t) => t.replace(/\s+/g, ' ').slice(0, 70)) }).slice(0, 900);
  // The script that matters: the same call three times, an edit that lands, the same call again.
  const AROUND = [READ, READ, READ, EDIT, READ, 'Done.', 'Done.'];

  suite('guard reset expert', 'guard reset: the flag is registered like every round-five flag', () => {
    const row = settings.rows().find((r) => r.id === 'flags.guardResetOnEdit');
    check('flags.guardResetOnEdit is off by default, described, and switched from the environment', core.DEFAULTS.flags.guardResetOnEdit === false && core.flagEnvName('guardResetOnEdit') === FLAG && row && row.env === FLAG && row.value === false && /repeat guard/.test(row.about) && /edit lands/.test(row.about) && /fourth identical call is still refused/.test(row.about),
      { happened: JSON.stringify(row || null), why: 'Every behaviour change lands off, behind a key the loop can set per round from the environment.', fix: 'DEFAULTS.flags in lib/core.mjs and DESCRIPTIONS in lib/settings.mjs.' });
    check('the guard threshold this suite relies on is the shipped four', core.DEFAULTS.guard.loopThreshold === 4,
      { happened: String(core.DEFAULTS.guard.loopThreshold), why: 'The scripts below repeat a call three times and expect the fourth to be the one refused.', fix: 'Change the scripts if the threshold moved.' });
  });

  await asyncSuite('guard reset expert', 'guard reset: an edit that lands in between lets the same call run again, when the flag is on', async () => {
    const on = await run('1', AROUND);
    const reads = results(on, 'read_file');
    check('three identical reads, an edit that lands, then the same read: the fourth is run, not refused, and shows the new text', on.st.stop.reason === 'answered' && reads.length === 4 && !reads.some(refused) && /\btwo\b/.test(reads[3]) && on.file === 'two' + NL && on.st.guardResets === 1,
      { happened: brief(on), why: 'humanevalfix-python-64: the re-run of check.py after the last fix was refused as the fourth repeat, and the model never saw the result of its own fix.', fix: 'runLoop: under flags.guardResetOnEdit an edit that moved state.editedAt clears the seen record.' });
    const off = await run('0', AROUND);
    const unset = await run(null, AROUND);
    const wordOk = (r) => { const rs = results(r, 'read_file'); return r.st.stop.reason === 'answered' && rs.length === 4 && !refused(rs[0]) && !refused(rs[1]) && !refused(rs[2]) && refused(rs[3]) && !/\btwo\b/.test(rs[3]) && r.file === 'two' + NL; };
    check('with the flag off or not set the fourth identical read is refused with the guard wording, edit or no edit, as before', wordOk(off) && wordOk(unset) && !off.st.guardResets && !unset.st.guardResets,
      { happened: `off ${brief(off)} || unset ${brief(unset)}`, why: 'The champion and every stored run used the loop with the flag off; off must stay byte for byte the same behaviour, refusal text included.', fix: 'The guardResetOn guard in runLoop.' });

    const one = await run('1', [READ, READ, READ, READ, 'Done.']);
    const four = results(one, 'read_file');
    check('with the flag on and no edit in between the fourth identical call is still refused', one.st.stop.reason === 'answered' && four.length === 4 && refused(four[3]) && !refused(four[2]) && !one.st.guardResets,
      { happened: brief(one), why: 'The reset is for a changed file, not a way round the guard: a model that asks the same thing four times with nothing changed is looping.', fix: 'Clear the record only when state.editedAt moved.' });

    const sh = await run('1', [SH, SH, SH, EDIT, SH, 'Done.', 'Done.']);
    const shOff = await run('0', [SH, SH, SH, EDIT, SH, 'Done.', 'Done.']);
    const shNo = await run('1', [SH, SH, SH, SH, 'Done.']);
    const ran = (r) => results(r, 'shell').filter((t) => t.includes(RAN)).length;
    check('a shell call repeated around an edit: run again with the flag on, refused with it off, and refused with it on when nothing was edited', ran(sh) === 4 && !results(sh, 'shell').some(refused) && sh.st.guardResets === 1 && ran(shOff) === 3 && refused(results(shOff, 'shell')[3]) && ran(shNo) === 3 && refused(results(shNo, 'shell')[3]) && !shNo.st.guardResets,
      { happened: `on ${brief(sh)} || off ${brief(shOff)} || on, no edit ${brief(shNo)}`, why: 'python check.py after the last fix is a shell call, and it is the call that matters most.', fix: 'The record is shared by every tool; the reset clears all of it.' });

    const block = await run('1', [[READ, READ, READ, EDIT, READ].join(NL), 'Done.', 'Done.']);
    const blockOff = await run('0', [[READ, READ, READ, EDIT, READ].join(NL), 'Done.', 'Done.']);
    check('the same holds for the blocks of one reply, which run in order', results(block, 'read_file').length === 4 && !results(block, 'read_file').some(refused) && block.st.guardResets === 1 && refused(results(blockOff, 'read_file')[3]) && !blockOff.st.guardResets,
      { happened: `on ${brief(block)} || off ${brief(blockOff)}`, why: 'A reply may carry up to five blocks; the clear has to happen between them, not only between rounds.', fix: 'The clear sits inside the per-call loop, right after runTool.' });
  });

  await asyncSuite('guard reset expert', 'guard reset: only an edit that really landed clears the record', async () => {
    const miss = await run('1', [READ, READ, READ, EDIT_MISS, READ, 'Done.']);
    const reads = results(miss, 'read_file');
    check('an edit whose old text is not found does not clear it: the fourth read is refused and the counter stays empty', /was not found/.test(results(miss, 'edit_file')[0]) && miss.file === 'one' + NL && reads.length === 4 && refused(reads[3]) && !miss.st.guardResets,
      { happened: brief(miss), why: 'Nothing changed on disk, so a repeated call really does return the same thing.', fix: 'Clear only when state.editedAt moved, not when an edit tool was called.' });
    const patchMiss = await run('1', [READ, READ, READ, PATCH_MISS, READ, 'Done.']);
    const readsP = results(patchMiss, 'read_file');
    check('a patch that does not apply does not clear it either', /not applied/.test(results(patchMiss, 'apply_patch')[0]) && patchMiss.file === 'one' + NL && readsP.length === 4 && refused(readsP[3]) && !patchMiss.st.guardResets,
      { happened: brief(patchMiss), why: 'apply_patch writes nothing unless all of it applies.', fix: 'Clear only when state.editedAt moved.' });
    const noFile = await run('1', [READ, READ, READ, call({ tool: 'edit_file', path: 'missing.txt', old_string: 'a', new_string: 'b' }), READ, 'Done.']);
    check('an edit of a file that is not there does not clear it', refused(results(noFile, 'read_file')[3]) && !noFile.st.guardResets,
      { happened: brief(noFile), why: 'Same: no change on disk.', fix: 'Clear only when state.editedAt moved.' });

    const w = await run('1', [READ, READ, READ, WRITE, READ, 'Done.', 'Done.']);
    const p = await run('1', [READ, READ, READ, PATCH, READ, 'Done.', 'Done.']);
    const viaShell = await run('1', [READ, READ, READ, PATCH_VIA_SHELL, READ, 'Done.', 'Done.']);
    const okRun = (r, text) => results(r, 'read_file').length === 4 && !results(r, 'read_file').some(refused) && r.st.guardResets === 1 && r.file === text;
    check('write_file, apply_patch, and an apply_patch sent through the shell each clear it when they land', okRun(w, 'three' + NL) && okRun(p, 'two' + NL) && okRun(viaShell, 'two' + NL),
      { happened: `write ${brief(w)} || patch ${brief(p)} || shell ${brief(viaShell)}`, why: 'The loop counts all three edit tools as edits, and so does the reset.', fix: 'Read state.editedAt, which every landing edit moves.' });
  });

  await asyncSuite('guard reset expert', 'guard reset: the counter counts clears of a record that held something', async () => {
    const first = await run('1', [EDIT, 'Done.', 'Done.']);
    check('an edit as the first call of a run finds the record empty and counts nothing', first.file === 'two' + NL && !first.st.guardResets,
      { happened: brief(first), why: 'The counter says how often the flag did something; the edit\'s own entry in the record is not something it forgot.', fix: 'Take the record\'s size before the call joins it.' });
    const second = await run('1', [READ, EDIT, EDIT_AGAIN, 'Done.', 'Done.']);
    check('a read then an edit counts one; a second edit straight after finds the record empty and counts nothing', second.file === 'three' + NL && second.st.guardResets === 1,
      { happened: brief(second), why: 'Each clear is counted once, and only when it dropped a call.', fix: 'Count when the record held something before the edit joined it.' });
    const twice = await run('1', [READ, EDIT, READ, EDIT_AGAIN, 'Done.', 'Done.']);
    check('a read, an edit, another read and another edit count two', twice.file === 'three' + NL && twice.st.guardResets === 2,
      { happened: brief(twice), why: 'The counter is per clear.', fix: 'Increment inside the clear.' });
    const off = await run('0', [READ, EDIT, READ, EDIT_AGAIN, 'Done.', 'Done.']);
    check('with the flag off the counter is never touched', !off.st.guardResets && off.file === 'three' + NL,
      { happened: brief(off), why: 'Off is the baseline; the eval row then carries a zero.', fix: 'The guardResetOn guard in runLoop.' });
  });

  await asyncSuite('guard reset expert', 'guard reset: the eval row carries guardResets', async () => {
    const TASK = { id: 'guard-reset-row', name: 'guard reset row', rounds: 14, files: { 'a.txt': 'one' + NL }, prompt: 'Change one to two.', check: ['node', '-e', 'process.exit(0)'] };
    const row = async (flag) => {
      const before = process.env[FLAG];
      if (flag == null) delete process.env[FLAG]; else process.env[FLAG] = flag;
      try {
        const chat = scripted([READ, READ, READ, EDIT, READ, 'Done.', 'Done.']);
        const r = await evals.runTask(TASK, { chat, state: {}, stamp: `guardreset-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` });
        if (r.workspace) { try { fs.rmSync(r.workspace, { recursive: true, force: true }); } catch { /* temp */ } }
        return r;
      } finally { if (before == null) delete process.env[FLAG]; else process.env[FLAG] = before; }
    };
    const on = await row('1');
    const off = await row('0');
    check('a run with the flag on writes guardResets 1 into its row, and one with it off writes 0', on.guardResets === 1 && off.guardResets === 0 && 'guardResets' in off,
      { happened: JSON.stringify({ on: on.guardResets, off: off.guardResets }), why: 'The count is how a study reads whether the flag did anything in a run.', fix: 'runTask copies st.guardResets into the row, as it does strayCalls.' });
  });
}

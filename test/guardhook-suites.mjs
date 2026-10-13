// flags.guardResetOnEdit on the hook side (lib/guard.mjs, 2026-10-13). The
// PreToolUse guard refused the fourth identical call of a session whether or not
// a file was edited in between, so a re-read or a re-run of the check after a fix
// was refused (c16 F4). With the flag on, a recorded edit clears the count; with
// no edit in between the fourth is still refused; with the flag unset the guard
// is what it was, so stored runs reproduce. Loaded by test/run.mjs.
import * as guard from '../lib/guard.mjs';

export default async function guardHookSuites({ suite, check, core }) {
  const FLAG = 'ATLIAS_FLAG_GUARD_RESET_ON_EDIT';
  const read = (sid) => guard.preTool({ session_id: sid, tool_name: 'Read', tool_input: { file_path: 'C:/p/a.py' } });
  const denied = (r) => Boolean(r && r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision === 'deny');
  const play = (flag, tag, editBetween) => {
    const before = process.env[FLAG];
    if (flag == null) delete process.env[FLAG]; else process.env[FLAG] = flag;
    try {
      const sid = `guardhook-${tag}-${process.pid}-${Date.now()}`;
      const out = [read(sid), read(sid), read(sid)];
      if (editBetween) core.recordEvent(sid, { kind: 'edit', files: ['C:/p/a.py'] });
      out.push(read(sid));
      return out;
    } finally { if (before == null) delete process.env[FLAG]; else process.env[FLAG] = before; }
  };
  suite('guard hook reset', 'the PreToolUse guard and an edit in between', () => {
    const off = play(null, 'off', true);
    check('with guardResetOnEdit unset, the fourth identical read is refused even after an edit (stored runs reproduce)', !off.slice(0, 3).some(denied) && denied(off[3]), { happened: JSON.stringify(off.map(denied)), why: 'Trials 02 to 08 ran with this guard; the flag-off path must not move.', fix: 'Reset the window only when cfg.flags.guardResetOnEdit is true.' });
    const on = play('1', 'on', true);
    check('with guardResetOnEdit, an edit clears the count, so the read after it goes through', !on.some(denied), { happened: JSON.stringify(on.map(denied)), why: 'After an edit the same read returns something new; refusing it took a run its last call in trial-02.', fix: 'Start the window after the newest edit event in lib/guard.mjs.' });
    const noEdit = play('1', 'noedit', false);
    check('with guardResetOnEdit and no edit, the fourth identical read is still refused', denied(noEdit[3]), { happened: JSON.stringify(noEdit.map(denied)), why: 'Without an edit the call is a real loop, and the guard exists to stop it.', fix: 'Only an edit event resets the window.' });
  });
}

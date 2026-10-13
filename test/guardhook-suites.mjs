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
  // Codex's audit of 2026-10-13, F4 and F5.
  const readOf = (sid, f) => guard.preTool({ session_id: sid, tool_name: 'Read', tool_input: { file_path: `C:/p/${f}.py` } });
  const alternate = (flag, tag, edit) => {
    const before = process.env[FLAG];
    if (flag == null) delete process.env[FLAG]; else process.env[FLAG] = flag;
    try {
      const sid = `guardalt-${tag}-${process.pid}-${Date.now()}`;
      const out = [readOf(sid, 'a'), readOf(sid, 'b'), readOf(sid, 'a')];
      if (edit) core.recordEvent(sid, { kind: 'edit', files: ['C:/p/a.py'], ...edit });
      out.push(readOf(sid, 'b'), readOf(sid, 'a'), readOf(sid, 'b'));
      return out;
    } finally { if (before == null) delete process.env[FLAG]; else process.env[FLAG] = before; }
  };
  suite('guard hook alternating', 'A B A, an edit, B A B (Codex F4)', () => {
    const off = alternate(null, 'off', {});
    check('with guardResetOnEdit unset, A B A edit B A B is refused on its sixth call (stored runs reproduce)', !off.slice(0, 5).some(denied) && denied(off[5]), { happened: JSON.stringify(off.map(denied)), why: 'The flag-off guard must not move.', fix: 'Reset the alternating window only under the flag.' });
    const on = alternate('1', 'on', {});
    check('with guardResetOnEdit, an edit that landed between A B A and B A B clears the alternating window', !on.some(denied), { happened: JSON.stringify(on.map(denied)), why: 'After an edit the two calls answer something new; the identical-call guard already counts from the edit.', fix: 'Start the alternating window after the newest edit event that did not fail.' });
    const failed = alternate('1', 'failed', { failed: true });
    const plain = alternate('1', 'none', null);
    check('a failed edit, or no edit, leaves the alternating guard as it was', denied(failed[5]) && denied(plain[5]), { happened: JSON.stringify([failed.map(denied), plain.map(denied)]), why: 'A failed edit changed nothing, so the calls are still a loop.', fix: 'Skip edit events marked failed.' });
  });
  suite('guard command positions', 'a search for a word is not the command it names (Codex F5)', () => {
    const kill = 'task' + 'kill';
    const search = `rg -n '${kill}' audit.mjs`;
    check('with guardCommandPositions off, a literal search for a process-kill word is still flagged (stored runs reproduce)', guard.destructiveReason(search) !== null, { happened: 'not flagged', why: 'The flag-off guard must not move.', fix: 'Use the whole-line match unless positions is true.' });
    const allowed = [search, `grep -n "${kill}" a.log`, `git grep ${kill}`, `Select-String -Pattern ${kill} -Path x.ps1`];
    check('with guardCommandPositions, searches and prints that only name the word are allowed', allowed.every((c) => guard.destructiveReason(c, true) === null), { happened: JSON.stringify(allowed.map((c) => guard.destructiveReason(c, true))), why: 'A read-only search was refused in a live session (Codex F5), costing a round trip and a workaround.', fix: 'Skip simple commands whose program only reads or prints.' });
    const refused = [`${kill} /F /PID 12`, `bash -c '${kill} /F /PID 1'`, `echo $(${kill} /PID 1)`, `grep x f | xargs rm -rf /`, `cat image.bin>/dev/sda`, `rg -n x "C:\\dir\\" && ${kill} /PID 4`, `cd x && git push origin main --force`, `C:\\Windows\\System32\\${kill}.exe /PID 4`];
    check('with guardCommandPositions, real destructive commands, substitutions, redirects and nested shells are still flagged', refused.every((c) => guard.destructiveReason(c, true) !== null), { happened: JSON.stringify(refused.map((c) => guard.destructiveReason(c, true))), why: 'The guard exists to stop these; the fix must not open them.', fix: 'Only a read-only program with no substitution or redirect is skipped.' });
    const split = guard.simpleCommands(`a 'x;y' | b "p&q \\" r"\nc && d`).map((p) => p.text.trim());
    check('simpleCommands splits a line at ; | & and new lines outside quotes only, escaped quotes included', JSON.stringify(split) === JSON.stringify([`a 'x;y'`, `b "p&q \\" r"`, 'c', 'd']), { happened: JSON.stringify(split), why: 'A separator inside quotes is text; splitting there would hand the guard pieces of one command.', fix: 'Track single and double quotes, and a backslash inside double quotes, in simpleCommands.' });
    const POS = 'ATLIAS_FLAG_GUARD_COMMAND_POSITIONS';
    const before = process.env[POS];
    let hook = 'unset';
    try {
      process.env[POS] = '1';
      hook = guard.preTool({ session_id: `guardpos-${process.pid}-${Date.now()}`, tool_name: 'Bash', tool_input: { command: search } });
    } finally { if (before == null) delete process.env[POS]; else process.env[POS] = before; }
    check('the hook reads guardCommandPositions from the settings, so the search goes through', hook === null, { happened: JSON.stringify(hook), why: 'A switch the hook does not read changes nothing in a run.', fix: 'preTool passes cfg.flags.guardCommandPositions to destructiveReason.' });
  });
}

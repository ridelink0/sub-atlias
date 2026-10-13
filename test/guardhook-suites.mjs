// flags.guardResetOnEdit on the hook side (lib/guard.mjs, 2026-10-13). The
// PreToolUse guard refused the fourth identical call of a session whether or not
// a file was edited in between, so a re-read or a re-run of the check after a fix
// was refused (c16 F4). With the flag on, a recorded edit clears the count; with
// no edit in between the fourth is still refused; with the flag unset the guard
// is what it was, so stored runs reproduce. Loaded by test/run.mjs.
import * as guard from '../lib/guard.mjs';
import * as track from '../lib/track.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
    const word = 'task' + 'kill';
    const gitSearch = [
      'git -C D:/repo grep -n ' + word + ' -- lib/guard.mjs',
      'git --no-pager -C "D:/repo with spaces" -C sub grep -n "' + word + '" -- .',
      "git -C 'D:/repo with spaces' diff --word-diff-regex=" + word,
    ];
    check('known Git global options and quoted paths preserve literal reader searches', gitSearch.every((c) => guard.destructiveReason(c, true) === null),
      { happened: JSON.stringify(gitSearch.map((c) => guard.destructiveReason(c, true))), why: 'The global -C path is not the Git subcommand; falsely denying this reader costs an extra context round.', fix: 'Tokenize quoted arguments and skip only reviewed global options before the reader subcommand.' });
    const gitDanger = [
      'git -C D:/repo reset --hard', 'git --no-pager -C "D:/repo with spaces" clean -fd',
      'git -C D:/repo push origin main --force', 'git -C ../repo checkout -- .',
      'git --git-dir=/tmp/repo-meta reset --hard', 'git --git-dir /tmp/repo-meta reset --hard',
      'git --work-tree=/tmp/repo clean -fd', 'git --work-tree /tmp/repo branch -D topic',
      'git --git-dir="D:/repo with spaces/.git" --work-tree "D:/repo with spaces" reset --hard',
      'git --bare push origin main --force', 'git --no-replace-objects push origin main -f',
      'git --namespace=private push origin main --force', 'git --exec-path=/tmp/git push origin main --force',
      'git -c core.pager=cat push origin main --force', 'git --config-env=core.pager=TASK_PAGER push origin main --force',
    ];
    check('the same global options never hide Git discard operations, with either flag setting', gitDanger.every((c) => guard.destructiveReason(c, true) && guard.destructiveReason(c, false)),
      { happened: JSON.stringify(gitDanger.map((c) => guard.destructiveReason(c, true))), why: 'Allowing global-option readers must not open destructive Git forms.', fix: 'Recognize reviewed global options in the destructive Git pattern as well.' });
    check('unknown global options and config overrides stay conservative', guard.destructiveReason('git -c core.pager=' + word + ' --paginate log', true) !== null && guard.destructiveReason('git --unknown grep ' + word, true) !== null,
      { happened: 'unknown/config option controls', why: 'Config and pager settings can introduce execution; they are not a proven literal reader.', fix: 'Do not skip unknown options or -c in readOnly.' });
    const kill = 'task' + 'kill';
    const search = `rg -n '${kill}' audit.mjs`;
    check('with guardCommandPositions off, a literal search for a process-kill word is still flagged (stored runs reproduce)', guard.destructiveReason(search) !== null, { happened: 'not flagged', why: 'The flag-off guard must not move.', fix: 'Use the whole-line match unless positions is true.' });
    const allowed = [search, `grep -n "${kill}" a.log`, `git grep ${kill}`, `Select-String -Pattern ${kill} -Path x.ps1`];
    check('with guardCommandPositions, searches and prints that only name the word are allowed', allowed.every((c) => guard.destructiveReason(c, true) === null), { happened: JSON.stringify(allowed.map((c) => guard.destructiveReason(c, true))), why: 'A read-only search was refused in a live session (Codex F5), costing a round trip and a workaround.', fix: 'Skip simple commands whose program only reads or prints.' });
    const refused = [`${kill} /F /PID 12`, `bash -c '${kill} /F /PID 1'`, `echo $(${kill} /PID 1)`, `grep x f | xargs rm -rf /`, `cat image.bin>/dev/sda`, `rg -n x "C:\\dir\\" && ${kill} /PID 4`, `cd x && git push origin main --force`, `C:\\Windows\\System32\\${kill}.exe /PID 4`];
    check('with guardCommandPositions, real destructive commands, substitutions, redirects and nested shells are still flagged', refused.every((c) => guard.destructiveReason(c, true) !== null), { happened: JSON.stringify(refused.map((c) => guard.destructiveReason(c, true))), why: 'The guard exists to stop these; the fix must not open them.', fix: 'Only a read-only program with no substitution or redirect is skipped.' });
    // Council 1013b: b06 found these allowed with the flag on (b09: no test covered them), and the
    // flag still refused searches that drop stderr.
    const del = 'r' + 'm -rf ~';
    const bypass = [`echo "${del}" | sh`, `printf '%s\\n' "${del}" | bash`, `echo "${del}" | sort | sh`, `echo \\'; ${del} ; echo \\'`, `FOO='x grep' ${del}`, `echo '${del}' | sh`, `echo $'\\'' ; ${del} ; echo $'\\''`, `r` + `m -rf \\\n~`, `rg -n 'x && ${kill} /PID 4`];
    check('with guardCommandPositions, a pipe into a shell, an escaped quote, ANSI-C quoting, a quoted assignment and a backslash-newline are still flagged', bypass.every((c) => guard.destructiveReason(c, true) !== null), { happened: JSON.stringify(bypass.map((c) => guard.destructiveReason(c, true))), why: 'Each of these runs the delete; the position reader cannot follow them, so it must fall back to the whole line.', fix: 'Keep UNREADABLE in guard.mjs covering these shapes.' });
    const quiet = [`grep -rn "${kill}" src 2>/dev/null`, `grep -rn "${kill}" src 2>&1`, `git grep -n "${kill}" -- . 2>/dev/null | head`];
    check('with guardCommandPositions, a search that drops or merges its output is still a search', quiet.every((c) => guard.destructiveReason(c, true) === null), { happened: JSON.stringify(quiet.map((c) => guard.destructiveReason(c, true))), why: 'The most common redirect on a search turned it back into a refusal (b06).', fix: 'Remove HARMLESS_REDIRECT matches before splitting.' });
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
  // Council 1013b (b03, b05, b06): with the flag on, an edit that returns a file to content an earlier
  // edit left it with is a revert and resets nothing. These scripts land real edits on a real file, so
  // track.postTool hashes what landed and the guard reads those hashes.
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlias-guardrev-'));
  const sidOf = (tag) => `guardrev-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const fresh = (tag, text) => { const dir = fs.mkdtempSync(path.join(workdir, `${tag}-`)); const file = path.join(dir, 'f.txt'); fs.writeFileSync(file, text); return { dir, file }; };
  const withFlag = (flag, fn) => {
    const before = process.env[FLAG];
    if (flag == null) delete process.env[FLAG]; else process.env[FLAG] = flag;
    try { return fn(); } finally { if (before == null) delete process.env[FLAG]; else process.env[FLAG] = before; }
  };
  // One edit as the hooks see it: PreToolUse decides, and an allowed edit lands on disk and PostToolUse records it.
  const landEdit = (sid, dir, file, old, neu) => {
    const payload = { session_id: sid, tool_name: 'Edit', tool_input: { file_path: file, old_string: old, new_string: neu }, cwd: dir };
    const decision = guard.preTool(payload);
    if (!denied(decision)) { fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(old, neu)); track.postTool({ ...payload, tool_response: {} }); }
    return decision;
  };
  const landWrite = (sid, dir, file, content) => {
    const payload = { session_id: sid, tool_name: 'Write', tool_input: { file_path: file, content }, cwd: dir };
    const decision = guard.preTool(payload);
    if (!denied(decision)) { fs.writeFileSync(file, content); track.postTool({ ...payload, tool_response: {} }); }
    return decision;
  };
  const reread = (sid, dir, file) => guard.preTool({ session_id: sid, tool_name: 'Read', tool_input: { file_path: file }, cwd: dir });
  // Returns the 1-based call the guard first refuses in one to-and-fro of Edit one->two and two->one, or 0.
  const flipFlop = (flag, tag, calls) => withFlag(flag, () => {
    const sid = sidOf(tag);
    const { dir, file } = fresh(tag, 'one\n');
    const pair = [['one', 'two'], ['two', 'one']];
    for (let k = 1; k <= calls; k++) { const [o, n] = pair[(k - 1) % 2]; if (denied(landEdit(sid, dir, file, o, n))) return k; }
    return 0;
  });
  // Edit one->two and two->three, read three times, then a Write to toContent, then the same read.
  const back = (flag, tag, toContent) => withFlag(flag, () => {
    const sid = sidOf(tag);
    const { dir, file } = fresh(tag, 'one\n');
    return [landEdit(sid, dir, file, 'one', 'two'), landEdit(sid, dir, file, 'two', 'three'), reread(sid, dir, file), reread(sid, dir, file), reread(sid, dir, file), landWrite(sid, dir, file, toContent), reread(sid, dir, file)].map(denied);
  });
  suite('guard hook revert', 'an edit that returns a file to content an earlier edit left it with resets nothing (council 1013b, b05, b06)', () => {
    const offFF = flipFlop(null, 'ff-off', 20);
    check('flip-flop (edit one to two, two to one, repeated) with guardResetOnEdit unset: refused at call 6 (stored runs reproduce)', offFF === 6, { happened: `first refusal at call ${offFF}`, why: 'The flag-off guard must not move.', fix: 'The reset clauses in lib/guard.mjs run only under the flag.' });
    const onFF = flipFlop('1', 'ff-on', 20);
    check('flip-flop with guardResetOnEdit: refused at call 8, because each reverting edit leaves the alternating record alone', onFF === 8, { happened: `first refusal at call ${onFF}`, why: 'Every landed edit used to clear the alternating record, so none of the 20 calls was refused (b05 F1).', fix: 'revertsEarlier(evs, i) in the alternating reset of lib/guard.mjs (line 119).' });
    const backOn = back('1', 'back-on', 'two\n');
    check('with guardResetOnEdit, a Write back to the content an earlier edit left (a new call key, the same hash): the fourth read is refused', backOn[6] === true && backOn.slice(2, 6).every((d) => d === false), { happened: JSON.stringify(backOn), why: 'The revert is found by content, so a key rule that only matches an identical edit would miss it.', fix: 'revertsEarlier in the identical-call reset of lib/guard.mjs (line 105); track.mjs writes after.' });
    const backOff = back(null, 'back-off', 'two\n');
    check('with guardResetOnEdit unset, the same script is refused at the fourth read as well (no reset at all)', backOff[6] === true, { happened: JSON.stringify(backOff), why: 'The flag-off guard must not move.', fix: 'The reset clauses run only under the flag.' });
    const newOn = back('1', 'new-on', 'four\n');
    check('with guardResetOnEdit, a Write to content the file never had is a real change: the fourth read goes through', newOn[6] === false, { happened: JSON.stringify(newOn), why: 'Only a return to earlier content is a revert; a real change still clears the record.', fix: 'revertsEarlier must not match new content.' });
  });
  suite('guard hook edit record', 'the stored edit event: flag off is the line before 19b92cb, the marks only under the flag (council 1013b, b03, b05)', () => {
    const { dir, file } = fresh('bytes', 'one\n');
    const failed = (sid) => ({ session_id: sid, tool_name: 'Edit', tool_input: { file_path: file, old_string: 'one', new_string: 'two' }, cwd: dir, tool_response: { is_error: true } });
    const sOff = sidOf('bytes-off');
    withFlag(null, () => track.postTool(failed(sOff)));
    const offEv = { ...core.eventsTail(sOff).find((e) => e.kind === 'edit') };
    delete offEv.t;
    const wantOff = JSON.stringify({ kind: 'edit', tool: 'Edit', files: [file] });
    check('flag off: a failed edit is stored exactly as before 19b92cb (no failed mark)', JSON.stringify(offEv) === wantOff, { happened: JSON.stringify(offEv), why: 'The log of a flag-off run must not change; the failed mark was added with no flag (b03 F1).', fix: 'track.mjs writes failed only under flags.guardResetOnEdit.' });
    const sOn = sidOf('bytes-on');
    withFlag('1', () => track.postTool(failed(sOn)));
    const onEv = core.eventsTail(sOn).find((e) => e.kind === 'edit') || {};
    check('flag on: a failed edit is marked failed and carries no content hash', onEv.failed === true && !('after' in onEv), { happened: JSON.stringify(onEv), why: 'A failed edit changed nothing, so it resets nothing and is not a revert target.', fix: 'track.mjs sets after only for a landed edit.' });
    const sOk = sidOf('bytes-ok');
    fs.writeFileSync(file, 'two\n');
    withFlag('1', () => track.postTool({ session_id: sOk, tool_name: 'Edit', tool_input: { file_path: file, old_string: 'one', new_string: 'two' }, cwd: dir, tool_response: {} }));
    const okEv = core.eventsTail(sOk).find((e) => e.kind === 'edit') || {};
    check('flag on: a landed edit carries the hash of the file it left, and no failed mark', typeof okEv.after === 'string' && okEv.after.length === 16 && !('failed' in okEv), { happened: JSON.stringify(okEv), why: 'The revert rule compares these hashes.', fix: 'track.mjs contentHash on a landed single-file edit under the flag.' });
    const sOkOff = sidOf('bytes-ok-off');
    withFlag(null, () => track.postTool({ session_id: sOkOff, tool_name: 'Edit', tool_input: { file_path: file, old_string: 'one', new_string: 'two' }, cwd: dir, tool_response: {} }));
    const okOff = { ...core.eventsTail(sOkOff).find((e) => e.kind === 'edit') };
    delete okOff.t;
    check('flag off: a landed edit is stored exactly as before 19b92cb (no hash)', JSON.stringify(okOff) === wantOff,{ happened: JSON.stringify(okOff), why: 'No hash may reach a flag-off log.', fix: 'track.mjs writes after only under the flag.' });
  });
  fs.rmSync(workdir, { recursive: true, force: true });
}

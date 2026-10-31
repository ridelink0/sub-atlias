// Permission modes (Gev, 2026-10-17): auto-accept, plan, auto and max beside workspace, ask and read-only
// (lib/permissions.mjs, the gate in lib/loop.mjs runTool, /permissions in lib/agent.mjs). Scripted calls only: no
// model, no network, nothing outside the suite's temp folder is touched. Every ask used here throws if it is called
// in a mode that must not ask. Loaded by test/run.mjs.
import os from 'node:os';
import * as loop from '../lib/loop.mjs';
import * as settings from '../lib/settings.mjs';
import * as permissions from '../lib/permissions.mjs';

export default async function permissionSuites({ asyncSuite, suite, check, core, agentMod, TMP, fs, path }) {
  const NL = String.fromCharCode(10);
  const FENCE = '`'.repeat(3);
  const blk = (o) => FENCE + 'atlias' + NL + JSON.stringify(o) + NL + FENCE;
  const WIN = process.platform === 'win32';
  let n = 0;
  const project = (files = {}) => {
    const d = path.join(TMP, 'permissions', `p${process.pid}-${++n}`);
    fs.mkdirSync(d, { recursive: true });
    for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), text); }
    return d;
  };
  const OUTSIDE_DIR = path.join(TMP, 'permissions', 'outside-area');
  fs.mkdirSync(OUTSIDE_DIR, { recursive: true });
  const OUTSIDE_FILE = path.join(OUTSIDE_DIR, 'keep.txt');
  fs.writeFileSync(OUTSIDE_FILE, 'precious');
  const asks = [];
  const noAsk = async (q) => { asks.push(q); throw new Error('asked: ' + q); };
  const yesAsk = async (q) => { asks.push(q); return 'y'; };
  const noAnswer = async (q) => { asks.push(q); return 'n'; };
  const inMode = async (mode, fn) => { settings.set('agent.permissions', mode); try { return await fn(); } finally { settings.reset('agent.permissions'); } };
  const tryRun = async (state, call, ask) => { try { return await loop.runTool(state, call, ask); } catch (e) { return 'THREW ' + e.message; } };
  const del = (f) => (WIN ? `del "${f}"` : `rm "${f}"`);

  suite('permission modes', 'permission modes: the modes are registered, described, and the default is unchanged', () => {
    const row = settings.rows().find((r) => r.id === 'agent.permissions');
    const want = ['workspace', 'ask', 'read-only', 'auto-accept', 'plan', 'auto', 'max'];
    check('agent.permissions offers all seven modes and still defaults to workspace',
      row && JSON.stringify(row.choices) === JSON.stringify(want) && core.DEFAULTS.agent.permissions === 'workspace',
      { happened: JSON.stringify(row && row.choices), why: 'The three old modes and the default must not move.', fix: 'CHOICES in lib/core.mjs.' });
    check('the settings text describes every mode', want.every((m) => row.about.includes(m)), { happened: row.about, why: 'Gev reads this list to choose.', fix: 'DESCRIPTIONS in lib/settings.mjs.' });
    check('a bad mode is refused by settings', settings.set('agent.permissions', 'yolo').ok === false, { happened: 'accepted', why: 'Only listed modes.', fix: 'CHOICES.' });
    settings.reset('agent.permissions');
  });

  await asyncSuite('permission modes', 'permission modes: workspace, auto-accept and plan', async () => {
    const d = project({ 'a.txt': 'one' });
    const st = agentMod.newState(d, 'openai');
    asks.length = 0;
    const wsEdit = await inMode('workspace', () => tryRun(st, { tool: 'write_file', path: 'w.txt', content: 'x' }, noAsk));
    check('workspace writes inside the project without asking', /written/.test(wsEdit) && fs.existsSync(path.join(d, 'w.txt')) && !asks.length, { happened: wsEdit, why: 'The default must behave as before.', fix: 'Do not touch the workspace branch.' });

    asks.length = 0;
    const aaEdit = await inMode('auto-accept', () => tryRun(st, { tool: 'write_file', path: 'aa.txt', content: 'x' }, noAsk));
    const aaPatch = await inMode('auto-accept', () => tryRun(st, { tool: 'edit_file', path: 'a.txt', old_string: 'one', new_string: 'two' }, noAsk));
    check('auto-accept runs edits and writes without asking', /written/.test(aaEdit) && /edited/.test(aaPatch) && fs.readFileSync(path.join(d, 'a.txt'), 'utf8') === 'two' && !asks.length, { happened: aaEdit + ' | ' + aaPatch, why: 'That is the mode.', fix: 'The ask condition in runTool must not list writes for auto-accept.' });
    asks.length = 0;
    const aaShellNo = await inMode('auto-accept', () => tryRun(st, { tool: 'shell', command: 'echo hi > aa-shell.txt' }, noAnswer));
    const aaShellYes = await inMode('auto-accept', () => tryRun(st, { tool: 'shell', command: 'echo hi' }, yesAsk));
    check('auto-accept still asks before a command, and runs it on yes', /refused by the user/.test(aaShellNo) && !fs.existsSync(path.join(d, 'aa-shell.txt')) && /exit 0/.test(aaShellYes) && asks.length === 2, { happened: aaShellNo + ' | ' + aaShellYes + ' | asks ' + asks.length, why: 'Only edits are pre-approved.', fix: 'Add auto-accept to the shell ask condition.' });
    asks.length = 0;
    const aaOutside = await inMode('auto-accept', () => tryRun(st, { tool: 'write_file', path: path.join(OUTSIDE_DIR, 'aa-out.txt'), content: 'x' }, noAnswer));
    check('auto-accept still asks before a write outside the project', /outside the project/.test(aaOutside) && asks.length === 1 && !fs.existsSync(path.join(OUTSIDE_DIR, 'aa-out.txt')), { happened: aaOutside, why: 'The outside-the-project guard is not an edit prompt.', fix: 'confirmOutside runs in every mode.' });

    asks.length = 0;
    const pWrite = await inMode('plan', () => tryRun(st, { tool: 'write_file', path: 'plan.txt', content: 'x' }, noAsk));
    const pEdit = await inMode('plan', () => tryRun(st, { tool: 'edit_file', path: 'a.txt', old_string: 'two', new_string: 'three' }, noAsk));
    const pPatch = await inMode('plan', () => tryRun(st, { tool: 'apply_patch', input: '*** Begin Patch\n*** Add File: pp.txt\n+x\n*** End Patch' }, noAsk));
    const pShell = await inMode('plan', () => tryRun(st, { tool: 'shell', command: 'echo hi > plan-shell.txt' }, noAsk));
    const pRead = await inMode('plan', () => tryRun(st, { tool: 'read_file', path: 'a.txt' }, noAsk));
    const pList = await inMode('plan', () => tryRun(st, { tool: 'list_dir', path: '.' }, noAsk));
    check('plan refuses writes and commands without asking, and says to present a plan', [pWrite, pEdit, pPatch, pShell].every((r) => /^plan mode: /.test(r) && /Present your plan/.test(r) && /\/permissions/.test(r)) && !asks.length
      && !fs.existsSync(path.join(d, 'plan.txt')) && !fs.existsSync(path.join(d, 'pp.txt')) && !fs.existsSync(path.join(d, 'plan-shell.txt')) && fs.readFileSync(path.join(d, 'a.txt'), 'utf8') === 'two',
      { happened: [pWrite, pEdit, pPatch, pShell].join(' | ').slice(0, 300), why: 'Plan mode must be safe to leave running and must tell the model what to do instead.', fix: 'The plan line in runTool.' });
    check('plan still reads and lists', /one|two/.test(pRead) && /a\.txt/.test(pList), { happened: pRead + ' | ' + pList, why: 'Exploration is what plan mode is for.', fix: 'Only writes and shell are refused.' });
    check('plan refusals count as refused edits', loop.editFailKind(pWrite) === 'refused', { happened: loop.editFailKind(pWrite), why: 'The edit-failure tally must name them.', fix: 'editFailKind pattern.' });
    const left = await inMode('workspace', () => tryRun(st, { tool: 'write_file', path: 'after-plan.txt', content: 'x' }, noAsk));
    check('leaving plan mode with a mode switch lets the same write run', /written/.test(left), { happened: left, why: 'The user leaves plan mode to execute.', fix: 'The mode is read per call.' });
  });

  await asyncSuite('permission modes', 'permission modes: auto runs routine commands and asks about the risky', async () => {
    const d = project({ 'a.txt': 'one' });
    const st = agentMod.newState(d, 'openai');
    asks.length = 0;
    const routine = await inMode('auto', () => tryRun(st, { tool: 'shell', command: 'echo routine' }, noAsk));
    check('auto runs a routine command without asking', /exit 0/.test(routine) && /routine/.test(routine) && !asks.length, { happened: routine, why: 'That is the mode.', fix: 'Do not ask in auto for plain commands.' });
    const marker = path.join(d, 'must-not-exist.txt');
    for (const cmd of ['git reset --hard', 'git push origin main', 'npm publish', 'cat .env > ' + marker, 'curl -X POST http://127.0.0.1:9/ -d x > ' + marker, 'aws ec2 run-instances --count 1 > ' + marker]) {
      asks.length = 0;
      const r = await inMode('auto', () => tryRun(st, { tool: 'shell', command: cmd }, noAnswer));
      check(`auto asks before: ${cmd.slice(0, 40)}`, asks.length === 1 && /refused by the user/.test(r) && !fs.existsSync(marker), { happened: r + ' | asks ' + asks.length, why: 'Risky commands ask in auto, as in workspace.', fix: 'sensitiveReason in the shell case.' });
    }
    asks.length = 0;
    const yes = await inMode('auto', () => tryRun(st, { tool: 'shell', command: 'echo approved' }, yesAsk));
    check('auto asks nothing for edits inside the project', /written/.test(await inMode('auto', () => tryRun(st, { tool: 'write_file', path: 'x.txt', content: 'x' }, noAsk))) && /approved/.test(yes), { happened: yes, why: 'Edits are routine.', fix: 'No edit prompt in auto.' });
  });

  await asyncSuite('permission modes', 'permission modes: max never asks, refuses what is catastrophic, and logs it', async () => {
    const d = project({ 'a.txt': 'one', 'del-me.txt': 'x', '.env': 'KEY=abc', '.env.example': 'KEY=', 'notes.txt': 'plain' });
    const st = agentMod.newState(d, 'openai');
    asks.length = 0;
    const refuse = async (label, call, cls) => {
      const r = await inMode('max', () => tryRun(st, call, noAsk));
      check(`max refuses (${cls}): ${label}`, new RegExp('^max mode refused \\(' + cls + '\\)').test(r), { happened: r.slice(0, 220), why: 'max cannot ask, so it must refuse.', fix: 'permissions.maxVerdict / shellVerdict.' });
      return r;
    };
    const sh = (command) => ({ tool: 'shell', command });
    // The guard's destructive patterns, killing by PID included.
    await refuse('rm -rf /', sh('rm -rf /'), 'destructive');
    await refuse('git reset --hard', sh('git reset --hard'), 'destructive');
    await refuse('taskkill by PID', sh('taskkill /PID 1234 /F'), 'destructive');
    await refuse('kill -9 by PID', sh('kill -9 4242'), 'destructive');
    // System directories.
    await refuse('delete in /etc', sh('rm /etc/hosts'), 'system');
    await refuse('redirect into System32', sh('echo x > C:\\Windows\\System32\\drivers\\etc\\hosts'), 'system');
    await refuse('write_file into /etc', { tool: 'write_file', path: '/etc/atlias-test', content: 'x' }, 'system');
    await refuse('Remove-Item in Program Files', sh('Remove-Item "C:\\Program Files\\x\\y.dll"'), 'system');
    // Outside the work area, no recoverable copy.
    await refuse('delete an outside file', sh(del(OUTSIDE_FILE)), 'outside');
    await refuse('redirect onto an outside file', sh(`echo x > "${OUTSIDE_FILE}"`), 'outside');
    await refuse('move an outside file', sh(`mv "${OUTSIDE_FILE}" x`), 'outside');
    await refuse('copy over an outside file', sh(`cp a.txt "${OUTSIDE_FILE}"`), 'outside');
    await refuse('cd outside then delete', sh('cd .. && rm -r y'), 'outside');
    await refuse('delete through a variable it cannot resolve', sh('rm -f $NOPE_NOT_SET/x'), 'outside');
    await refuse('delete inside a nested shell', sh(`bash -c "rm '${OUTSIDE_FILE}'"`), 'outside');
    await refuse('a redirect written against its target', sh(`echo x>"${OUTSIDE_FILE}"`), 'outside');
    await refuse('a redirect into /etc written against its target', sh('echo x>/etc/hosts'), 'system');
    await refuse('an assignment before the command', sh(`FOO=1 ${del(OUTSIDE_FILE)}`), 'outside');
    await refuse('a wrapper before the command', sh(`sudo ${del(OUTSIDE_FILE)}`), 'outside');
    await refuse('curl -o outside', sh(`curl -o "${OUTSIDE_FILE}" http://127.0.0.1:9/`), 'outside');
    await refuse('tar -C outside', sh(`tar -xf a.tar -C "${OUTSIDE_DIR}"`), 'outside');
    await refuse('write_file outside',{ tool: 'write_file', path: path.join(OUTSIDE_DIR, 'new.txt'), content: 'x' }, 'outside');
    await refuse('edit_file outside', { tool: 'edit_file', path: OUTSIDE_FILE, old_string: 'precious', new_string: 'gone' }, 'outside');
    await refuse('apply_patch add outside', { tool: 'apply_patch', input: `*** Begin Patch\n*** Add File: ${path.join(OUTSIDE_DIR, 'p.txt')}\n+x\n*** End Patch` }, 'outside');
    await refuse('apply_patch move to outside', { tool: 'apply_patch', input: `*** Begin Patch\n*** Update File: a.txt\n*** Move to: ${path.join(OUTSIDE_DIR, 'm.txt')}\n@@\n-one\n+two\n*** End Patch` }, 'outside');
    // Credentials, keys and secrets.
    await refuse('read_file .env', { tool: 'read_file', path: '.env' }, 'credentials');
    await refuse('cat .env', sh('cat .env'), 'credentials');
    await refuse('cat an ssh key', sh('cat ~/.ssh/id_rsa'), 'credentials');
    await refuse('grep inside .ssh', { tool: 'grep', pattern: 'x', path: path.join(os.homedir(), '.ssh') }, 'credentials');
    await refuse('write a .pem', { tool: 'write_file', path: 'server.pem', content: 'x' }, 'credentials');
    await refuse('printenv', sh('printenv'), 'credentials');
    await refuse('echo a token variable', sh('echo $GITHUB_TOKEN'), 'credentials');
    await refuse('curl with a bearer header', sh('curl -H "Authorization: Bearer abcdefghijklmnop" http://127.0.0.1:9/'), 'credentials');
    await refuse('gh auth token', sh('gh auth token'), 'credentials');
    // Money.
    await refuse('stripe', sh('stripe charges create --amount 100'), 'money');
    await refuse('aws run-instances', sh('aws ec2 run-instances --count 3'), 'money');
    await refuse('terraform apply', sh('terraform apply -auto-approve'), 'money');
    await refuse('a paid API call', sh('curl http://api.openai.com/v1/models'), 'money');
    // Publishing and sending as the user.
    await refuse('git push', sh('git push origin main'), 'publish');
    await refuse('git -C dir push', sh('git -C . push origin main'), 'publish');
    await refuse('yarn publish', sh('yarn publish'), 'publish');
    await refuse('npm publish (the guard names it)', sh('npm publish'), 'destructive');
    await refuse('gh pr create', sh('gh pr create --fill'), 'publish');
    await refuse('curl POST', sh('curl -X POST http://127.0.0.1:9/ -d x'), 'publish');
    await refuse('scp to a host', sh('scp a.txt user@host:/tmp/a.txt'), 'publish');
    await refuse('ssh', sh('ssh host ls'), 'publish');
    await refuse('sendmail', sh('sendmail someone@example.com'), 'publish');
    await refuse('vercel --prod', sh('vercel --prod'), 'publish');
    check('max asked nothing across all of those refusals', asks.length === 0, { happened: String(asks.length), why: 'A mode that never asks must not ask.', fix: 'Pass the never-answer to runToolCore.' });
    check('none of the refused commands touched the outside file or created anything', fs.readFileSync(OUTSIDE_FILE, 'utf8') === 'precious' && !fs.existsSync(path.join(OUTSIDE_DIR, 'new.txt')) && !fs.existsSync(path.join(OUTSIDE_DIR, 'p.txt')) && !fs.existsSync(path.join(OUTSIDE_DIR, 'm.txt')) && fs.existsSync(path.join(d, 'a.txt')), { happened: 'a file changed', why: 'A refusal must stop the action.', fix: 'The gate runs before runToolCore.' });

    // What max allows.
    const ok = async (label, call) => { const r = await inMode('max', () => tryRun(st, call, noAsk)); check(`max allows: ${label}`, !/^max mode refused|^THREW/.test(r), { happened: r.slice(0, 220), why: 'Routine work must run.', fix: 'The gate is too wide.' }); return r; };
    await ok('echo', sh('echo hi'));
    await ok('stderr merged and discarded', sh('echo hi 2>&1'));
    await ok('output to the null device', sh('echo hi > ' + (WIN ? 'NUL' : '/dev/null')));
    await ok('read an ordinary file', { tool: 'read_file', path: 'notes.txt' });
    await ok('read .env.example', { tool: 'read_file', path: '.env.example' });
    await ok('read a file outside the project', { tool: 'read_file', path: OUTSIDE_FILE });
    await ok('list the project', { tool: 'list_dir', path: '.' });
    await ok('git status', sh('git status'));
    await ok('write inside the project', { tool: 'write_file', path: 'sub/new.txt', content: 'x' });
    await ok('edit inside the project', { tool: 'edit_file', path: 'a.txt', old_string: 'one', new_string: 'uno' });
    await ok('redirect inside the project', sh('echo hi > out.txt'));
    await ok('delete inside the project', sh(del(path.join(d, 'del-me.txt'))));
    await ok('apply_patch inside the project', { tool: 'apply_patch', input: '*** Begin Patch\n*** Add File: patched.txt\n+x\n*** End Patch' });
    check('the allowed commands really ran', fs.existsSync(path.join(d, 'out.txt')) && !fs.existsSync(path.join(d, 'del-me.txt')) && fs.existsSync(path.join(d, 'patched.txt')) && fs.readFileSync(path.join(d, 'a.txt'), 'utf8') === 'uno', { happened: fs.readdirSync(d).join(','), why: 'Allowed means run.', fix: 'runToolCore must still run.' });
    check('a GET request and a plain program are not mistaken for sending', permissions.shellVerdict('curl http://127.0.0.1:9/', d) === null && permissions.shellVerdict('node --version', d) === null && permissions.shellVerdict('git commit -m "push the button"', d) === null, { happened: 'refused', why: 'False refusals make max useless.', fix: 'publishReason.' });

    // A question that reaches the tool layer anyway (the harness's own check call skips the gate) is answered no, logged, and never put to the user.
    asks.length = 0;
    const fromHarness = await inMode('max', () => tryRun(st, { tool: 'shell', command: 'git reset --hard', _verify: true }, noAsk));
    check('a question the tool layer would put to the user is answered no and logged, not asked', /^refused by the user/.test(fromHarness) && !asks.length && permissions.readLog(st.sid).some((r) => r.outcome === 'question-declined'), { happened: fromHarness, why: 'max never asks, even when the gate did not see the call.', fix: 'runToolCore gets the never-answer in the max wrapper.' });

    // The log.
    const rows =permissions.readLog(st.sid);
    const refused = rows.filter((r) => r.outcome === 'refused');
    const ran = rows.filter((r) => r.outcome === 'ran');
    check('every call is in the log with tool, target and outcome; refusals carry their class', rows.length >= 50 && refused.length >= 40 && ran.length >= 10 && rows.every((r) => r.tool && 'target' in r && r.outcome && r.t) && refused.every((r) => r.cls && r.detail)
      && refused.some((r) => r.cls === 'credentials') && refused.some((r) => r.cls === 'money') && refused.some((r) => r.cls === 'publish') && refused.some((r) => r.cls === 'system') && refused.some((r) => r.cls === 'outside') && refused.some((r) => r.cls === 'destructive'),
      { happened: `rows ${rows.length}, refused ${refused.length}, ran ${ran.length}`, why: 'Gev reads the log when he comes back.', fix: 'permissions.logAction in the max wrapper.' });
    check('the log is a file under the Atlias home', permissions.logPath(st.sid).startsWith(core.STATE_DIR) && fs.existsSync(permissions.logPath(st.sid)), { happened: permissions.logPath(st.sid), why: 'It must survive the run.', fix: 'logPath.' });
    check('/permissions log shows them', /refused \[(destructive|publish|money|credentials|system|outside|declined)\]/.test(permissions.command('log', { current: 'max', set: () => ({ ok: true, text: '' }), sid: st.sid })), { happened: 'missing', why: 'The user needs a way to read it.', fix: 'permissions.command.' });

    // Undo still works for what max wrote.
    const u = agentMod.newState(d, 'openai');
    await inMode('max', () => tryRun(u, { tool: 'write_file', path: 'undo-me.txt', content: 'x' }, noAsk));
    const had = fs.existsSync(path.join(d, 'undo-me.txt'));
    const back = loop.undo(u);
    check('undo takes back a write made in max mode', had && /removed undo-me\.txt/.test(back) && !fs.existsSync(path.join(d, 'undo-me.txt')), { happened: back, why: 'The existing undo must keep working.', fix: 'max runs the same tools, with the same pushUndo.' });
  });

  await asyncSuite('permission modes', 'permission modes: the computer-use hook point, the command, and the other modes leave no trace', async () => {
    const d = project({ 'a.txt': 'one' });
    const st = agentMod.newState(d, 'openai');
    const before = await inMode('max', () => tryRun(st, { tool: 'computer_click', x: 1, y: 1 }, noAsk));
    check('with no hook an unknown tool is answered as unknown, not refused by max', /^unknown tool computer_click/.test(before), { happened: before, why: 'Nothing is added to the tool list until computer use is built.', fix: 'maxVerdict returns null with no hook.' });
    permissions.hooks.computerAction = (call) => ({ cls: 'computer', why: `${call.tool} is not allowed by the test hook` });
    const hooked = await inMode('max', () => tryRun(st, { tool: 'computer_click', x: 1, y: 1 }, noAsk));
    const other = await inMode('workspace', () => tryRun(st, { tool: 'computer_click', x: 1, y: 1 }, noAsk));
    permissions.hooks.computerAction = null;
    check('a hook set by a later module judges non-built-in tools in max only', /^max mode refused \(computer\)/.test(hooked) && /^unknown tool/.test(other), { happened: hooked + ' | ' + other, why: 'That is the hook point.', fix: 'maxVerdict.' });

    settings.reset('agent.permissions');
    const cur = () => core.config().agent.permissions;
    const cmd = (a) => permissions.command(a, { current: cur(), set: (m) => settings.set('agent.permissions', m), sid: st.sid });
    const order = [cur()];
    for (let i = 0; i < 4; i++) { cmd('next'); order.push(cur()); }
    check('/permissions next cycles workspace, auto-accept, plan, auto and back', order.join(',') === 'workspace,auto-accept,plan,auto,workspace', { happened: order.join(','), why: 'The cycle key walks the safe modes.', fix: 'permissions.CYCLE.' });
    const toMax = cmd('max');
    const afterMax = cmd('next');
    check('/permissions max says what it does, and next leaves it for workspace', /not ask you anything/.test(toMax) && cur() === 'workspace' && /workspace/.test(afterMax), { happened: toMax + ' | ' + afterMax, why: 'max must be chosen by name and never cycled into.', fix: 'MAX_NOTICE, CYCLE.' });
    check('/permissions rejects a mode that does not exist and lists the modes with no argument', /one of workspace/.test(cmd('yolo')) && /auto-accept/.test(cmd('')) && /plan/.test(cmd('')), { happened: cmd('yolo'), why: 'Typos must not change the mode.', fix: 'permissions.command.' });
    settings.reset('agent.permissions');

    // The old modes leave no max log and behave as before.
    const w = agentMod.newState(d, 'openai');
    await inMode('workspace', () => tryRun(w, { tool: 'shell', command: 'echo hi' }, noAsk));
    await inMode('ask', () => tryRun(w, { tool: 'write_file', path: 'q.txt', content: 'x' }, noAnswer));
    check('workspace and ask write no max log', !fs.existsSync(permissions.logPath(w.sid)), { happened: permissions.logPath(w.sid), why: 'Only max logs; the default path stays as it was.', fix: 'The wrapper in runTool checks the mode first.' });
    const wsGuard = await inMode('workspace', () => tryRun(w, { tool: 'shell', command: 'git reset --hard' }, noAnswer));
    check('workspace still asks about a guard-flagged command', /refused by the user: git command that discards/.test(wsGuard), { happened: wsGuard, why: 'The default is byte for byte as before.', fix: 'Only perm === auto adds reasons.' });
  });

  await asyncSuite('permission modes', 'permission modes: a whole run in max and in plan', async () => {
    const d = project({ 'sum.py': 'def two():' + NL + '    return 1' + NL });
    const run = async (mode, replies) => inMode(mode, async () => {
      const script = [...replies];
      const seen = [];
      const chat = async (messages) => { seen.push(JSON.stringify(messages[messages.length - 1])); const r = script.shift(); return { content: r === undefined ? 'out of script' : r, calls: [] }; };
      const st = agentMod.newState(d, 'ollama');
      const reply = await loop.runLoop(st, 'make two() return 2', { chat, say: () => {}, ask: noAsk, limits: { maxToolRounds: 6, maxBadReplies: 3 } });
      return { st, seen, reply };
    });
    const fix = blk({ tool: 'edit_file', path: 'sum.py', old_string: 'return 1', new_string: 'return 2' });
    const plan = await run('plan', [fix, 'Plan: change line 2 of sum.py to return 2, then run the check.']);
    check('in plan the model sees the plan message and the file is untouched', plan.seen.some((s) => /plan mode: edit_file/.test(s)) && /return 1/.test(fs.readFileSync(path.join(d, 'sum.py'), 'utf8')) && /^Plan:/.test(plan.reply), { happened: plan.seen.join(' | ').slice(0, 300), why: 'The model must be told to present a plan.', fix: 'planRefusal.' });
    const bad = blk({ tool: 'shell', command: `git push origin main` });
    const max = await run('max', [bad, fix, 'Done.']);
    check('in max the model sees the refusal, goes on, and edits the file; nothing asked', max.seen.some((s) => /max mode refused \(publish\)/.test(s)) && /return 2/.test(fs.readFileSync(path.join(d, 'sum.py'), 'utf8')), { happened: max.seen.join(' | ').slice(0, 300), why: 'A refusal is an observation the model acts on.', fix: 'The refusal text.' });
    check('the run is in the max log', permissions.readLog(max.st.sid).some((r) => r.outcome === 'refused' && r.cls === 'publish') && permissions.readLog(max.st.sid).some((r) => r.tool === 'edit_file' && r.outcome === 'ran'), { happened: JSON.stringify(permissions.readLog(max.st.sid)).slice(0, 300), why: 'The log is for the run, not for a call.', fix: 'logAction.' });
  });
}

// flags.subagentsApart (2026-10-13). Claude Code sends agent_id with the hook
// events a subagent fires (the hooks reference, common input fields). Atlias
// filed those as the main session's, so a council report or scratch file a
// subagent wrote held the main session's reply at its Stop gate, and a check
// the main session never ran was asked for, turn after turn. With the flag on,
// a subagent's events are tagged and left out of the main session's turn and
// out of the git check of changed files. With it off, every event counts as it
// did before. Each case runs with the flag on and with it off; the off run is
// what stored trials reproduce. Loaded by test/run.mjs.
import * as settings from '../lib/settings.mjs';
import * as authority from '../lib/authority.mjs';
import * as progress from '../lib/progress.mjs';
import * as brief from '../lib/brief.mjs';
import * as mcp from '../mcp/tools.mjs';

export default async function subagentSuites({ suite, asyncSuite, check, skip, core, guard, track, gate, router, TMP, fs, path, spawnSync }) {
  const FLAG = 'ATLIAS_FLAG_SUBAGENTS_APART';
  const AGENT = 'agent-a1b2c3';
  const DONE = 'Done, the helper is written.';
  // Names both passes, so the second-pass rule has nothing to say and only the check is in question.
  const PASS_LINE = 'Fixed. Pass 1: left to atlias. Pass 2: re-read main.py for empty input and off-by-one, nothing found.';
  const HELPER = 'def helper():\n    return 1\n';
  const withFlag = (value, fn) => {
    const before = process.env[FLAG];
    if (value == null) delete process.env[FLAG]; else process.env[FLAG] = value;
    try { return fn(); } finally { if (before == null) delete process.env[FLAG]; else process.env[FLAG] = before; }
  };
  let n = 0;
  const project = () => {
    const dir = path.join(TMP, 'subagents', `p${++n}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const session = (dir) => {
    const s = `subagents-${process.pid}-${++n}`;
    router.prompt({ session_id: s, cwd: dir, prompt: 'write the helper and its report' });
    return s;
  };
  // A Write the way PostToolUse sees it. Only a subagent's payload carries agent_id.
  const writeTool = (dir, s, rel, text, agent) => {
    const full = path.join(dir, rel);
    fs.writeFileSync(full, text);
    track.postTool({ session_id: s, cwd: dir, tool_name: 'Write', tool_input: { file_path: full, content: text }, ...(agent ? { agent_id: agent, agent_type: 'general-purpose' } : {}) });
    return full;
  };
  const stop = (dir, s, last = DONE) => gate.stop({ session_id: s, cwd: dir, last_assistant_message: last }, 'claude');
  const blocked = (out) => Boolean(out && out.decision === 'block');
  // The shape of a council turn: the main session edits nothing, a subagent writes helper.py.
  const councilTurn = (flag) => withFlag(flag, () => {
    const dir = project();
    const s = session(dir);
    writeTool(dir, s, 'helper.py', HELPER, AGENT);
    return { dir, s, out: stop(dir, s) };
  });

  suite('subagents apart expert', 'subagents apart: the tag is added only with the flag on and a real agent id', () => {
    const on = { flags: { subagentsApart: true } };
    const off = { flags: { subagentsApart: false } };
    const got = [core.subagentTag({ agent_id: AGENT }, on), core.subagentTag({ agent_id: AGENT }, off), core.subagentTag({}, on), core.subagentTag({ agent_id: '' }, on)];
    check('subagentTag tags a payload with an agent id only when the flag is on', JSON.stringify(got) === JSON.stringify([{ subagent: AGENT }, {}, {}, {}]),
      { happened: JSON.stringify(got), why: 'A main-session payload and a flag-off run must add nothing, so the stored events keep their old bytes.', fix: 'subagentTag in lib/core.mjs.' });
  });

  suite('subagents apart expert', 'subagents apart: a main shell change to a file a subagent also edited is still held', () => {
    const since = 100000;
    const full = path.join(TMP, 'clock-edge.py');
    const status = () => ({ stdout: '?? clock-edge.py\n' });
    const why = { happened: 'filesystem and event clocks disagreed', why: 'On Windows a fresh write can appear milliseconds older than its prompt boundary.', fix: 'Apply the bounded Windows mtime tolerance while excluding old dirt.' };
    check('shellChangedFiles tolerates a Windows filesystem tick without pulling in old dirt', gate.shellChangedFiles(TMP, since, { run: status, mtime: () => since - 16 }).includes(full) === (process.platform === 'win32') && gate.shellChangedFiles(TMP, since, { run: status, mtime: () => since - 10000 }).length === 0, why);
    const probe = spawnSync('git', ['--version'], { encoding: 'utf8' });
    if (probe.status !== 0) { skip('a main shell change is still held', 'git is not on PATH'); return; }
    // The main session changes a.py through the shell (no edit event), then a subagent edits the same file.
    // Git lists a.py once; only the main session's own change is the reason to hold the reply.
    const shared = (flag) => withFlag(flag, () => {
      const dir = project();
      const initialized = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
      const s = session(dir);
      fs.writeFileSync(path.join(dir, 'a.py'), 'def a():\n    return 1\n');
      track.postTool({ session_id: s, cwd: dir, tool_name: 'Bash', tool_input: { command: 'echo x >> a.py' }, tool_response: { stdout: '', exit_code: 0 } });
      writeTool(dir, s, 'a.py', 'def a():\n    return 2\n', AGENT);
      const out = stop(dir, s);
      return { out, diagnostic: { initialized: initialized.status, turn: gate.turnEvents(s), mtime: fs.statSync(path.join(dir, 'a.py')).mtimeMs, status: core.gitStatusShort(dir) } };
    });
    const on = shared('1');
    const off = shared(null);
    check('with subagentsApart on, a main shell change to a file a subagent also edited is still held', blocked(on.out),
      { happened: JSON.stringify(on), why: 'If the subagent\'s edit hides the file from git, a shell edit of the main session goes unchecked (the false negative f3 found).', fix: 'turnEvents: apart is empty when the main session ran a shell command this turn.' });
    check('with subagentsApart off, the same script is held, as before', blocked(off.out),
      { happened: JSON.stringify(off), why: 'Off must stay the gate as it was.', fix: 'Keep the apart filter behind the flag.' });
  });

  suite('subagents apart expert', 'subagents apart: a subagent edit does not hold the main reply', () => {
    const row = settings.rows().find((r) => r.id === 'flags.subagentsApart');
    check('flags.subagentsApart is off by default, described, and switched from the environment', core.DEFAULTS.flags.subagentsApart === false && core.flagEnvName('subagentsApart') === FLAG && row && row.env === FLAG && row.value === false && /subagent/.test(row.about),
      { happened: JSON.stringify(row || null), why: 'Every behaviour change lands off, behind a key the loop can set per round from the environment.', fix: 'DEFAULTS.flags in lib/core.mjs and DESCRIPTIONS in lib/settings.mjs.' });
    const on = councilTurn('1');
    const off = councilTurn(null);
    check('with subagentsApart on, a reply that ends after a subagent wrote a file with no check is not held', on.out === null,
      { happened: JSON.stringify(on.out), why: 'A council report or scratch file a subagent wrote is not the main session\'s work; holding the main reply for a check of it is the loop Claude saw 14 times in one day.', fix: 'turnEvents in lib/gate.mjs must drop the events a subagent fired when flags.subagentsApart is on.' });
    check('with subagentsApart off, the same script is held, as before', blocked(off.out),
      { happened: JSON.stringify(off.out), why: 'Off must stay the gate as it was, so the stored runs reproduce.', fix: 'Gate the turnEvents filter on the flag.' });
  });

  suite('subagents apart expert', 'subagents apart: the main session\'s own edit is still held', () => {
    const r = withFlag('1', () => {
      const dir = project();
      const s = session(dir);
      writeTool(dir, s, 'main.py', 'def f():\n    return 1\n');
      writeTool(dir, s, 'helper.py', HELPER, AGENT);
      return { out: stop(dir, s), edits: core.events(s).filter((e) => e.kind === 'edit') };
    });
    check('a main edit with no check is still held when a subagent also edited', blocked(r.out),
      { happened: JSON.stringify(r.out), why: 'The flag removes a subagent\'s files from the main session\'s work, not the main session\'s own files.', fix: 'Only tagged events may leave the turn.' });
    check('the subagent\'s edit carries its agent id and the main edit carries none', r.edits.length === 2 && r.edits.filter((e) => e.subagent === AGENT).length === 1 && r.edits.filter((e) => !e.subagent).length === 1,
      { happened: JSON.stringify(r.edits.map((e) => ({ files: e.files, subagent: e.subagent || null }))), why: 'The tag is what the gate reads to tell the two apart.', fix: 'postTool: the edit event spreads subagentTag(payload, cfg).' });
  });

  suite('subagents apart expert', 'subagents apart: flag off stores the edit the old way', () => {
    const edit = (flag) => withFlag(flag, () => {
      const dir = project();
      const s = session(dir);
      writeTool(dir, s, 'helper.py', HELPER, AGENT);
      return core.events(s).filter((e) => e.kind === 'edit');
    });
    const off = edit(null);
    const on = edit('1');
    check('flag off: a subagent edit has no subagent key, the same keys as before', off.length === 1 && !('subagent' in off[0]) && Object.keys(off[0]).sort().join(',') === 'files,kind,t,tool',
      { happened: JSON.stringify(off), why: 'Off must write the same bytes the stored runs wrote.', fix: 'subagentTag in lib/core.mjs returns {} when the flag is off.' });
    check('flag on: the same edit is tagged with the agent id', on.length === 1 && on[0].subagent === AGENT,
      { happened: JSON.stringify(on), why: 'The tag is the only thing that lets the gate leave the subagent out.', fix: 'postTool in lib/track.mjs must spread subagentTag into the edit event.' });
  });

  suite('subagents apart expert', 'subagents apart: the guard tags a subagent\'s calls, refusals and failed checks', () => {
    withFlag('1', () => {
      const dir = project();
      const s = session(dir);
      guard.preTool({ session_id: s, cwd: dir, tool_name: 'Read', tool_input: { file_path: 'a.py' } });
      const sub = { session_id: s, cwd: dir, tool_name: 'Read', tool_input: { file_path: 'b.py' }, agent_id: AGENT };
      for (let i = 0; i < 4; i++) guard.preTool(sub);
      track.postToolFailure({ session_id: s, cwd: dir, tool_name: 'Bash', tool_input: { command: 'python check.py' }, error: 'exit 1', agent_id: AGENT });
      const evs = core.events(s);
      const tools = evs.filter((e) => e.kind === 'tool');
      const denies = evs.filter((e) => e.kind === 'deny');
      const failed = evs.filter((e) => e.kind === 'shell');
      check('a subagent\'s calls are recorded with its id and the main call without one', tools.length === 5 && tools[0].subagent === undefined && tools.slice(1).every((e) => e.subagent === AGENT),
        { happened: JSON.stringify(tools.map((e) => e.subagent || null)), why: 'The tag is how the gate tells a subagent\'s call from the main session\'s.', fix: 'preTool in lib/guard.mjs spreads the tag into the tool event.' });
      check('a subagent\'s refusal is tagged, and the main turn does not see it', denies.length === 1 && denies[0].subagent === AGENT && !gate.turnEvents(s).turn.some((e) => e.kind === 'deny'),
        { happened: JSON.stringify(denies), why: 'A refusal of a subagent is not a refusal of the main session.', fix: 'The deny recordEvent calls in preTool spread the tag.' });
      check('a failed check a subagent ran is tagged and left out of the main turn', failed.length === 1 && failed[0].subagent === AGENT && !gate.turnEvents(s).turn.some((e) => e.kind === 'shell'),
        { happened: JSON.stringify(failed), why: 'A check a subagent ran is not the main session\'s check.', fix: 'postToolFailure in lib/track.mjs spreads subagentTag.' });
    });
  });

  suite('subagents apart expert', 'subagents apart: git does not hand back a subagent\'s file as the main session\'s', () => {
    const probe = spawnSync('git', ['--version'], { encoding: 'utf8' });
    if (probe.status !== 0) { skip('git does not hand back a subagent\'s file', 'git is not on PATH'); return; }
    // The main session reads a file first, so the turn starts before the subagent's write; git then lists that
    // new file, and only a file the subagent edited can keep it out of the main session's git check.
    const gitTurn = (flag) => withFlag(flag, () => {
      const dir = project();
      spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
      const s = session(dir);
      guard.preTool({ session_id: s, cwd: dir, tool_name: 'Read', tool_input: { file_path: 'notes.txt' } });
      writeTool(dir, s, 'helper.py', HELPER, AGENT);
      return stop(dir, s);
    });
    const on = gitTurn('1');
    const off = gitTurn(null);
    check('with subagentsApart on, git listing a subagent\'s new file does not hold the main reply', on === null,
      { happened: JSON.stringify(on), why: 'The git check looks at every changed file, so a subagent\'s file came back as the main session\'s unseen change.', fix: 'gate.stop must drop the subagent\'s edited files from unseen.' });
    check('with subagentsApart off, the same script is held, as before', blocked(off),
      { happened: JSON.stringify(off), why: 'Off must stay the gate as it was.', fix: 'Keep the apart filter behind the flag.' });
  });

  suite('subagents apart expert', 'subagents apart: a subagent\'s check is not the main session\'s check', () => {
    const script = (flag) => withFlag(flag, () => {
      const dir = project();
      const s = session(dir);
      writeTool(dir, s, 'main.py', 'def f():\n    return 1\n');
      track.postTool({ session_id: s, cwd: dir, tool_name: 'Bash', tool_input: { command: 'python check.py' }, tool_response: { stdout: 'all good', exit_code: 0 }, agent_id: AGENT });
      return stop(dir, s, PASS_LINE);
    });
    const on = script('1');
    const off = script(null);
    check('with subagentsApart on, a passing check a subagent ran does not satisfy the main session\'s edit', blocked(on),
      { happened: JSON.stringify(on), why: 'The main session edited main.py and never ran a check of its own; the subagent\'s run is not evidence for the main reply.', fix: 'turnEvents drops the subagent\'s shell event, so lastVerificationAfterEdit does not see it.' });
    check('with subagentsApart off, the subagent\'s passing check counts for the session, as before', !blocked(off),
      { happened: JSON.stringify(off), why: 'Off must stay the gate as it was.', fix: 'Keep the apart filter behind the flag.' });
  });

  suite('subagents apart expert', 'subagents apart: parallel guards and oversized events retain their actor', () => {
    const before = core.config().guard.loopThreshold;
    const why = { happened: 'actors shared a guard boundary', why: 'Parallel workers must not manufacture each other\'s repeat or alternating loop.', fix: 'Filter each guard window to its actor before reading resets and patterns.' };
    try {
      settings.set('guard.loopThreshold', 10);
      const run = (flag) => withFlag(flag, () => {
        const sid = session(project());
        return Array.from({ length: 6 }, (_, i) => guard.preTool({ session_id: sid, agent_id: `parallel-${i}`, tool_name: 'Read', tool_input: { file_path: i % 2 ? 'b.py' : 'a.py' } }, 'claude'));
      });
      check('six distinct workers cannot form a shared alternating loop', run('1').every((r) => !r), why);
      check('off retains the pooled alternating guard for stored comparisons', run('0').some((r) => r?.hookSpecificOutput?.permissionDecision === 'deny'), why);
      settings.set('guard.loopThreshold', 3);
      withFlag('1', () => {
        const sid = session(project());
        const call = (actor) => guard.preTool({ session_id: sid, ...(actor ? { agent_id: actor } : {}), tool_name: 'Read', tool_input: { file_path: 'same.py' } }, 'claude');
        const oneEach = [call(), call(AGENT), call('worker-b')];
        const own = [call(AGENT), call(AGENT)];
        check('same-input calls from three actors are separate; a real repeat still denies its worker', oneEach.every((r) => !r) && !own[0] && own[1]?.hookSpecificOutput?.permissionDecision === 'deny', why);
      });
      const large = core.trimEvent({ kind: 'edit', files: ['x'.repeat(6000)], subagent: AGENT });
      check('an oversized event stays a subagent event after trimming', large.oversized && large.subagent === AGENT, why);
    } finally { settings.set('guard.loopThreshold', before); }
  });

  suite('subagents apart expert', 'subagents apart: recovered checks, handoffs and companion hints stay with their actor', () => withFlag('1', () => {
    const dir = project();
    const sid = session(dir);
    const parent = { session_id: sid, cwd: dir, prompt: 'PARENT_HANDOFF_ONLY', source: 'resume' };
    const worker = { ...parent, agent_id: AGENT, prompt: 'WORKER_HANDOFF_ONLY' };
    const why = { happened: 'worker details entered the parent state', why: 'Recovered checks, notes and one-time guidance must retain their actor.', fix: 'Tag recovery and scope note paths, event filters and metadata.' };
    router.prompt(parent); router.prompt(worker);
    const file = writeTool(dir, sid, 'worker-only.py', HELPER, AGENT);
    const transcript = path.join(dir, 'worker.jsonl');
    const rows = [
      { type: 'user', message: { role: 'user', content: worker.prompt } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'edit', name: 'Edit', input: { file_path: file } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'edit', content: 'updated' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'check', name: 'Bash', input: { command: 'python check.py' } }] } },
      { type: 'user', toolUseResult: { stdout: 'all tests passed', stderr: '', exit_code: 0 }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'check', content: 'all tests passed', is_error: false }] } },
    ];
    fs.writeFileSync(transcript, rows.map((r, i) => JSON.stringify({ ...r, timestamp: new Date(Date.now() + 60000 + i).toISOString() })).join('\n') + '\n');
    const turn = gate.turnEvents(sid, AGENT).turn;
    const recovered = track.recoverChecks({ ...worker, transcript_path: transcript }, turn);
    check('transcript-recovered checks are worker-tagged in return values, in-memory turns and persisted events', recovered.length === 1 && recovered[0].subagent === AGENT && turn.some((e) => e.from === 'transcript' && e.subagent === AGENT) && !gate.turnEvents(sid).turn.some((e) => e.from === 'transcript'), why);
    progress.preCompact(parent); progress.preCompact(worker);
    const a = progress.read(dir), b = progress.read(dir, AGENT);
    check('worker PreCompact cannot overwrite or mix the parent handoff', a.includes(parent.prompt) && !a.includes(worker.prompt) && !a.includes(file) && b.includes(worker.prompt) && b.includes(file) && !b.includes(parent.prompt) && progress.notePath(dir) !== progress.notePath(dir, AGENT), why);
    check('startup and compact inject only the actor handoff', !brief.build(parent, 'claude').includes(worker.prompt) && progress.postCompact(parent) === null && !brief.build({ ...parent, source: 'compact' }, 'claude').includes(worker.prompt) && brief.build(worker, 'claude').includes(worker.prompt), why);
    const hintSid = session(dir);
    const frontend = { session_id: hintSid, cwd: dir, prompt: 'Please redesign the website hero section' };
    const hintA = router.prompt({ ...frontend, agent_id: AGENT });
    const hintB = router.prompt(frontend);
    check('each actor receives its own first frontend hint', hintA?.hookSpecificOutput && hintB?.hookSpecificOutput && router.prompt(frontend) === null, why);
    brief.sessionStart({ ...frontend, agent_id: AGENT }, 'claude');
    check('worker SessionStart metadata leaves parent source unchanged', core.sessionMeta(core.actorSession({ ...frontend, agent_id: AGENT })).source === 'startup' && !core.sessionMeta(hintSid).source, why);
    withFlag('0', () => {
      check('off mode keeps the original shared progress path and mixed events', progress.notePath(dir, AGENT) === progress.notePath(dir) && progress.build(dir, sid, null, AGENT).includes(parent.prompt), why);
    });
  }));

  await asyncSuite('subagents apart expert', 'subagents apart: MCP progress explicitly retains shared project scope', async () => {
    const before = process.env[FLAG]; process.env[FLAG] = '1';
    try {
      const dir = project(); const sid = session(dir);
      router.prompt({ session_id: sid, cwd: dir, prompt: 'PARENT_PROJECT_OBJECTIVE' });
      progress.update(dir, sid, 'PARENT_PROJECT_REPLY');
      const worker = { session_id: sid, cwd: dir, agent_id: AGENT, prompt: 'PRIVATE_WORKER_OBJECTIVE' };
      router.prompt(worker); progress.preCompact(worker);
      const priorWorker = progress.read(dir, AGENT);
      await mcp.callTool('harness_progress', { action: 'set', cwd: dir, text: 'SHARED_PROJECT_NEXT' });
      const got = await mcp.callTool('harness_progress', { action: 'get', cwd: dir });
      const why = { happened: 'MCP progress scope was mislabeled', why: 'MCP supplies no trusted actor identity; callers must know this tool shares project state.', fix: 'Document shared scope and keep hook notes separate; do not claim tool privacy.' };
      check('the public progress tool names its shared scope and reads the parent project note', /Shared project handoff/.test(mcp.TOOLS.find((t) => t.name === 'harness_progress').description) && got.includes('PARENT_PROJECT_OBJECTIVE') && got.includes('SHARED_PROJECT_NEXT'), why);
      check('shared MCP steering preserves the private worker hook note and exact scope distinction', progress.read(dir, AGENT) === priorWorker && !got.includes(worker.prompt) && progress.build(dir, sid, null, AGENT).includes('SHARED_PROJECT_NEXT'), why);
    } finally { if (before === undefined) delete process.env[FLAG]; else process.env[FLAG] = before; }
  });

  suite('subagents apart expert', 'subagents apart: prompt boundaries, checks and exact authority are separate', () => withFlag('1', () => {
    const authFlag = 'ATLIAS_FLAG_AUTHORITY_LEDGER';
    const previous = process.env[authFlag];
    process.env[authFlag] = '1';
    const why = { happened: 'authority or evidence crossed actors', why: 'A worker\'s request, skill or passing check cannot become the parent\'s authority or proof.', fix: 'Keep actor-scoped ledgers, prompt boundaries and verification state.' };
    try {
      const dir = project();
      const sid = `actor-authority-${++n}`;
      const parent = { session_id: sid, cwd: dir, prompt_id: 'parent-boundary', prompt: 'PARENT_REQUEST_82' };
      const worker = { ...parent, agent_id: AGENT, prompt_id: 'worker-boundary', prompt: 'WORKER_REQUEST_93' };
      router.prompt(parent);
      writeTool(dir, sid, 'parent.py', HELPER);
      router.prompt(worker);
      writeTool(dir, sid, 'worker.py', HELPER, AGENT);
      check('a worker prompt cannot move the parent turn boundary or erase its edit', gate.turnEvents(sid).promptId === parent.prompt_id && gate.turnEvents(sid).turn.some((e) => e.kind === 'edit') && gate.turnEvents(sid, AGENT).promptId === worker.prompt_id, why);
      check('implicit interpreter checks use only the actor\'s edited files', track.isCheck('python worker.py', sid, null, AGENT) && !track.isCheck('python worker.py', sid) && track.isCheck('python parent.py', sid), why);
      const skillFile = path.join(dir, 'SKILL.md');
      fs.writeFileSync(skillFile, 'WORKER_SKILL_FULL_74\r\nKeep every line.');
      track.postTool({ ...worker, tool_name: 'Read', tool_input: { file_path: skillFile }, tool_response: { content: 'WORKER_SKILL_FULL_74' } });
      const parentText = brief.build({ ...parent, source: 'compact' }, 'claude');
      const workerText = brief.build({ ...worker, source: 'compact' }, 'claude');
      check('resume carries each actor\'s full requests and skill text without crossing to the parent', parentText.includes(parent.prompt) && !parentText.includes(worker.prompt) && !parentText.includes('WORKER_SKILL_FULL_74') && workerText.includes(worker.prompt) && workerText.includes('WORKER_SKILL_FULL_74\r\nKeep every line.') && !workerText.includes(parent.prompt), why);
      check('long parent ids cannot truncate the worker namespace into a collision', core.actorSession({ session_id: 's'.repeat(200), agent_id: AGENT }) !== core.actorSession({ session_id: 's'.repeat(200), agent_id: 'worker-b' }) && core.actorSession(parent) === sid, why);
      const workerStop = gate.stop({ ...worker, last_assistant_message: DONE }, 'claude');
      const parentStop = gate.stop({ ...parent, last_assistant_message: DONE }, 'claude');
      check('a worker gate decision cannot consume the parent\'s one-shot check reminder', blocked(workerStop) && blocked(parentStop) && core.sessionMeta(core.actorSession(worker)).gate && core.sessionMeta(sid).gate, why);
    } finally { if (previous === undefined) delete process.env[authFlag]; else process.env[authFlag] = previous; }
  }));
}

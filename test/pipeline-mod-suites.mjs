// atlias-pipeline (2026-10-15): the default-off collectors in mods/atlias-pipeline.
// These checks drive register() with a fake on, $ and next, the way the meter
// and text-read suites do, and hold it to four promises: off registers nothing
// and every event passes through identical; the original and follow-up prompts
// and the selected skills are kept exactly and in order; a check counts as pass
// or fail only on a numeric exit code, and an edit makes earlier checks stale;
// the evidence block is one constant, appended and never removing anything.
// Loaded by test/run.mjs.
import { register, STORE_KEY, EVIDENCE_BLOCK, EVIDENCE_TEXT, completion } from '../mods/atlias-pipeline/hooks/register.mjs';
import { verifyPacket, validateReporter, PROTOCOL } from '../mods/atlias-pipeline/hooks/contract.mjs';

const SID = 'test-session-pipeline-mod';

// The fake host. Each registered hook is found by its event and optional matcher;
// run() gives it the event and a next that answers with reply (or throws it).
// transcript is the host's own record of the session, shared across a restart like the store;
// the host adds each submitted prompt to it after prompt.submit (or before, with appendFirst).
// id answers $.session.id; messages answers $.session.messages.
function harness(options, { store = new Map(), failStore = false, limit = { bytes: Infinity }, transcript = [], appendFirst = false,
  id = async () => SID, messages = async () => transcript.map(m => ({ ...m })) } = {}) {
  const registrations = [];
  const on = (event, matcher, handler) => {
    if (typeof matcher === 'function') { handler = matcher; matcher = null; }
    registrations.push({ event, matcher, handler });
    return { catch() { return this; } };
  };
  register(on, options);
  const api = {
    session: { id, messages },
    store: {
      get: async key => {
        if (failStore) throw new Error('store is offline');
        return store.has(key) ? JSON.parse(JSON.stringify(store.get(key))) : undefined;
      },
      set: async (key, value) => {
        if (failStore) throw new Error('store is offline');
        if (JSON.stringify(value).length > limit.bytes) throw new Error('store record is over its size limit');
        store.set(key, JSON.parse(JSON.stringify(value)));
      },
    },
  };
  async function run(event, e, reply) {
    const hook = registrations.find(r => r.event === event && (!r.matcher || r.matcher.tool === (e && e.tool)));
    const submitted = event === 'prompt.submit' && e && typeof e.text === 'string';
    if (submitted && appendFirst) transcript.push({ role: 'user', text: e.text, toolUses: [] });
    if (!hook) {
      if (submitted && !appendFirst) transcript.push({ role: 'user', text: e.text, toolUses: [] });
      return { hooked: false, out: reply, seen: undefined };
    }
    const seen = [];
    const next = async x => { seen.push(x); if (reply instanceof Error) throw reply; return typeof reply === 'function' ? reply(x) : reply; };
    const out = await hook.handler(api, e, next);
    if (submitted && !appendFirst) transcript.push({ role: 'user', text: e.text, toolUses: [] });
    return { hooked: true, out, seen: seen[0] };
  }
  return { registrations, store, transcript, run };
}

const ALL = { enabled: true, collectAuthority: true, collectReceipts: true, evidenceRecordStyle: true };
const prompt = (text, kind = 'composer') => ({ text, wait: false, origin: { kind } });
const promptReply = e => ({ text: e.text, wait: false, origin: e.origin });
const skillEvent = (skill, text) => ({ skill, text });
const done = (result, text = '') => ({ ref: 'msg-1', result, text });
const shell = (tool, body, extra = {}) => ({ tool, tool_use_id: 'toolu_' + tool.toLowerCase(), command: 'node check.js', ...extra });
const shellReply = (body, extra = {}) => ({ ref: 'msg-2', result: body, text: 'stdout text is never exit evidence', ...extra });
const edit = tool => ({ tool, tool_use_id: 'toolu_' + tool.toLowerCase(), file_path: 'D:/fixture/a.txt' });
const editReply = () => done({ filePath: 'D:/fixture/a.txt', updated: true }, 'edited');

async function receiptStatuses(store, text = 'x') {
  const stored = store.get(STORE_KEY);
  if (!stored || !stored.packet) return null;
  const { evidence } = await validateReporter(stored.packet, stored.receipts, { text, receiptIds: [] });
  return evidence.map(row => row.status);
}

export default async function addSuites({ suite, asyncSuite, check, ROOT, fs, path }) {
  await asyncSuite('pipeline mod expert', 'pipeline mod: off registers nothing, so every event passes through identical', async () => {
    const offs = [undefined, null, {}, { enabled: false, collectAuthority: true, collectReceipts: true, evidenceRecordStyle: true },
      { enabled: 'true', collectAuthority: true, collectReceipts: true }, { enabled: 1, evidenceRecordStyle: true },
      { enabled: true }, { enabled: true, collectAuthority: 'true', collectReceipts: 1, evidenceRecordStyle: 'yes' },
      { collectAuthority: true, collectReceipts: true, evidenceRecordStyle: true }];
    for (const options of offs) {
      const store = new Map();
      const h = harness(options, { store });
      check(`no handler is registered for ${JSON.stringify(options)}`, h.registrations.length === 0,
        { happened: `${h.registrations.length} handler(s): ${h.registrations.map(r => r.event).join(', ')}`, why: 'Off must be the old behaviour, byte for byte. A handler that is registered but does nothing still runs for every event.', fix: 'Return from register() before any on() call unless enabled is exactly true and an option below it is exactly true.' });
      check(`nothing is written to the store for ${JSON.stringify(options)}`, store.size === 0,
        { happened: `store keys: ${[...store.keys()].join(', ')}`, why: 'An off mod must leave no trace in the session store.', fix: 'Do not touch $.store on any path while off.' });
    }
    // Enabled with every feature on, an event the mod does not watch still passes through unchanged.
    const h = harness(ALL);
    const watched = ['prompt.submit', 'skill.prompt', 'tool.call', 'prompt.context'];
    const unwatched = ['session.start', 'prompt.attachment', 'turn.complete', 'turn.step', 'tool.describe', 'session.append'];
    const bad = [];
    for (const event of unwatched) {
      const e = { probe: event };
      const reply = { from: event };
      const r = await h.run(event, e, reply);
      if (r.hooked || r.out !== reply) bad.push(event);
    }
    check('events the mod does not watch are not hooked, so they pass through identical', bad.length === 0 && watched.every(event => h.registrations.some(r => r.event === event)),
      { happened: `hooked or changed: ${bad.join(', ') || 'none'}`, why: 'The mod watches four events only; anything else must reach the host untouched.', fix: 'Register handlers only for the four events the README names.' });
    const readEvent = { tool: 'Read', tool_use_id: 'toolu_read', file_path: 'D:/fixture/a.txt' };
    const readReply = done({ file: { content: 'x' } }, 'read');
    const read = await h.run('tool.call', readEvent, readReply);
    check('a Read call passes through the tool.call hook as the same event and the same result', read.out === readReply && read.seen === readEvent,
      { happened: `same result: ${read.out === readReply}, same event: ${read.seen === readEvent}`, why: 'Only Bash, PowerShell and edit tools are observed; any other tool result must be the host result itself.', fix: 'tool.call returns next(e) untouched for every other tool.' });
    check('the Read call wrote nothing to the store', h.store.size === 0,
      { happened: `store keys: ${[...h.store.keys()].join(', ')}`, why: 'Recording a Read would be a side effect no test planned for.', fix: 'Observe only the tools the README names.' });
  });

  await asyncSuite('pipeline mod expert', 'pipeline mod: the original and follow-ups are kept exactly, in order, with repeats', async () => {
    const texts = ['Fix the parser.\r\nKeep the public API.\r\n', 'Caf\u00e9 \u96ea \u{1D11E} tab\there  ', 'Fix the parser.\r\nKeep the public API.\r\n', '', 'Last: no new dependencies; run the check.'];
    const store = new Map();
    const h = harness({ enabled: true, collectAuthority: true }, { store });
    for (const text of texts) {
      const e = prompt(text);
      const reply = promptReply(e);
      const r = await h.run('prompt.submit', e, reply);
      check(`prompt ${JSON.stringify(text)} reaches next as the same event with its text unchanged`, r.out === reply && r.seen === e && e.text === text,
        { happened: `same reply: ${r.out === reply}, same event: ${r.seen === e}, text kept: ${e.text === text}`, why: 'A rewrite of the prompt changes what the person asked, and the reporter would then check the wrong words.', fix: 'prompt.submit returns next(e) and never builds a new event.' });
    }
    const stored = store.get(STORE_KEY);
    check('the stored packet holds the first prompt as the original, exactly as typed', !!stored && stored.packet && stored.packet.authority.original.text === texts[0],
      { happened: stored && stored.packet ? JSON.stringify(stored.packet.authority.original.text) : 'no packet stored', why: 'The original is the one text the planner must never see changed.', fix: 'The first recorded prompt becomes authority.original.' });
    const followups = stored.packet.authority.followups.map(item => item.text);
    check('the later prompts are follow-ups in order, with the repeat and the empty prompt kept', JSON.stringify(followups) === JSON.stringify(texts.slice(1))
      && stored.packet.authority.followups.every((item, index) => item.ordinal === index),
      { happened: JSON.stringify(followups), why: 'A dropped or reordered follow-up is a dropped instruction.', fix: 'Append every recorded prompt in arrival order; do not de-duplicate.' });
    check('the packet verifies under the shared contract and names this session', await verifyPacket(stored.packet) === true && stored.packet.protocol === PROTOCOL && stored.packet.sessionId === SID && stored.packet.localPlanner.trusted === false,
      { happened: `protocol ${stored.packet.protocol}, session ${stored.packet.sessionId}`, why: 'The planner and reporter read the packet through the shared contract; an unverifiable packet is refused.', fix: 'Build the packet with createPacket and never edit its fields.' });
    const note = prompt('Background job finished: all tests passed', 'task-notification');
    const noteReply = promptReply(note);
    const after = await h.run('prompt.submit', note, noteReply);
    check('a task notification passes through and is not recorded as the person\'s follow-up', after.out === noteReply && after.seen === note
      && store.get(STORE_KEY).packet.authority.followups.length === texts.length - 1,
      { happened: `follow-ups now ${store.get(STORE_KEY).packet.authority.followups.length}`, why: 'A scheduled or peer message is not the person\'s instruction and must not become authority.', fix: 'Record only composer, bridge and sdk origins.' });
  });

  await asyncSuite('pipeline mod expert', 'pipeline mod: each selected skill keeps its exact name and body', async () => {
    const store = new Map();
    const h = harness({ enabled: true, collectAuthority: true }, { store });
    await h.run('prompt.submit', prompt('use the skill'), promptReply(prompt('use the skill')));
    const body = 'Step one.\r\n\r\n  indented caf\u00e9 \u96ea \u{1D11E}\n';
    const first = skillEvent('commit', body);
    const firstReply = { text: 'expanded' };
    const r = await h.run('skill.prompt', first, firstReply);
    check('the skill event passes through as the same event and returns next\'s answer', r.out === firstReply && r.seen === first && first.text === body,
      { happened: `same reply: ${r.out === firstReply}, text kept: ${first.text === body}`, why: 'A skill body rewritten by the mod changes how the skill behaves.', fix: 'skill.prompt returns next(e) and never edits e.text.' });
    const changed = skillEvent('commit', body + 'changed');
    await h.run('skill.prompt', changed, { text: 'expanded again' });
    const stored = store.get(STORE_KEY).packet.authority.skills;
    check('both skill expansions are kept in order, with their exact bodies', stored.length === 2 && stored[0].name === 'commit' && stored[0].body === body && stored[1].body === body + 'changed',
      { happened: JSON.stringify(stored.map(s => [s.name, s.body])), why: 'The selected skill version is authority; a changed or dropped body is a silent change of instructions.', fix: 'Store skill.prompt text verbatim, one entry per expansion.' });
    check('each skill version carries its own digest, and a changed body has a different one', stored[0].version.startsWith('sha256:') && stored[0].version !== stored[1].version,
      { happened: JSON.stringify(stored.map(s => s.version)), why: 'The version names the exact text the planner was given.', fix: 'Version a skill by the SHA-256 of its body.' });
    check('the packet still verifies with the skills in it', await verifyPacket(store.get(STORE_KEY).packet) === true,
      { happened: 'verifyPacket rejected the packet', why: 'A skill entry the contract rejects would make the whole packet unusable.', fix: 'Keep the skill entries to name, version and body.' });
  });

  await asyncSuite('pipeline mod expert', 'pipeline mod: a check passes only on a numeric exit code of 0', async () => {
    const store = new Map();
    const h = harness({ enabled: true, collectAuthority: true, collectReceipts: true }, { store });
    await h.run('prompt.submit', prompt('check it'), promptReply(prompt('check it')));
    const cases = [
      ['Bash exit 0 is pass', 'Bash', { stdout: 'ok', stderr: '', interrupted: false, exitCode: 0 }, 'pass'],
      ['Bash exit 1 is fail', 'Bash', { stdout: 'FAILED', stderr: '', interrupted: false, exitCode: 1 }, 'fail'],
      ['no exit code with "all tests passed" on stdout is unknown', 'Bash', { stdout: 'all tests passed', stderr: '', interrupted: false }, 'unknown:missing_exit_code'],
      ['exit code as text is unknown', 'Bash', { stdout: 'all tests passed', stderr: '', interrupted: false, exitCode: '0' }, 'unknown:non_numeric_exit_code'],
      ['exit code null is unknown', 'Bash', { stdout: 'all tests passed', stderr: '', interrupted: false, exitCode: null }, 'unknown:non_numeric_exit_code'],
      ['a tool error with exit 0 is not pass', 'Bash', { stdout: 'x', stderr: '', interrupted: false, exitCode: 0 }, 'unknown:missing_exit_code', { isError: true }],
      ['PowerShell exit 0 is pass', 'PowerShell', { stdout: '', stderr: '', interrupted: false, exitCode: 0 }, 'pass'],
    ];
    for (const [name, tool, body, want, extra] of cases) {
      const e = shell(tool, body);
      const reply = shellReply(body, extra);
      const r = await h.run('tool.call', e, reply);
      check(`${name}: the call's result passes through untouched`, r.out === reply && r.seen === e,
        { happened: `same reply: ${r.out === reply}`, why: 'The receipt observes the call; it must not change its result.', fix: 'tool.call returns the result next(e) gave it.' });
      const got = (await receiptStatuses(store)).at(-1);
      check(`${name}`, got === want,
        { happened: `receipt status ${got}, expected ${want}`, why: 'A pass on stdout text, or on a missing exit code, lets an unchecked claim read as verified.', fix: 'Take the exit code only from result.result.exitCode when it is a scalar on an executed call.' });
    }
    const refused = await h.run('tool.call', shell('Bash', {}), { deny: 'permission denied' });
    check('a refused shell call is not recorded, since nothing ran', refused.out.deny === 'permission denied' && (await receiptStatuses(store)).length === cases.length,
      { happened: `receipts ${(await receiptStatuses(store)).length}`, why: 'A call that never ran has no evidence to record.', fix: 'Skip refused completions when recording a receipt.' });
    const sub = await h.run('tool.call', shell('Bash', {}, { agentId: 'sub-1' }), shellReply({ stdout: 'ok', stderr: '', interrupted: false, exitCode: 0 }));
    const subStatus = (await receiptStatuses(store)).at(-1);
    check('a subagent check is never pass for the main session', sub.out && subStatus === 'unknown:wrong_actor',
      { happened: `status ${subStatus}`, why: 'A worker\'s exit code is not the main session\'s verification.', fix: 'Record actorId agent:<id> from tool.call agentId and let the contract mark the wrong actor.' });
  });

  await asyncSuite('pipeline mod expert', 'pipeline mod: an edit after a pass makes that pass stale; a refused edit does not', async () => {
    const store = new Map();
    const h = harness(ALL, { store });
    await h.run('prompt.submit', prompt('fix it'), promptReply(prompt('fix it')));
    await h.run('tool.call', shell('Bash', {}), shellReply({ stdout: 'ok', stderr: '', interrupted: false, exitCode: 0 }));
    check('before any edit the pass is current', (await receiptStatuses(store)).join(',') === 'pass' && store.get(STORE_KEY).packet.scopeVersion === '0',
      { happened: `${(await receiptStatuses(store)).join(',')} at scope ${store.get(STORE_KEY).packet.scopeVersion}`, why: 'The baseline must be a pass before the stale check means anything.', fix: 'Record a Bash exit 0 as pass at scope 0.' });
    const e1 = edit('Edit');
    const r1 = await h.run('tool.call', e1, editReply());
    check('a successful Edit passes through and advances the scope', r1.seen === e1 && store.get(STORE_KEY).packet.scopeVersion === '1',
      { happened: `scope ${store.get(STORE_KEY).packet.scopeVersion}`, why: 'Without the advance an older check counts as fresh after the file changed.', fix: 'An edit completion that is not a refusal increments scope and rebuilds the packet.' });
    check('the pass from before the edit is now stale', (await receiptStatuses(store)).join(',') === 'unknown:stale_packet',
      { happened: `${(await receiptStatuses(store)).join(',')}`, why: 'A check run before an edit does not show the edited code works.', fix: 'The receipt keeps its scope version; the contract reports stale_scope against the new packet.' });
    await h.run('tool.call', shell('Bash', {}), shellReply({ stdout: 'ok', stderr: '', interrupted: false, exitCode: 0 }));
    check('a check run after the edit is pass at the new scope', (await receiptStatuses(store)).join(',') === 'unknown:stale_packet,pass',
      { happened: `${(await receiptStatuses(store)).join(',')}`, why: 'A fresh check must count again once it follows the edit.', fix: 'New receipts take the current packet id and scope.' });
    await h.run('tool.call', edit('Edit'), { deny: 'permission denied' });
    check('a refused edit changes nothing, so the scope and the pass stay as they were', store.get(STORE_KEY).packet.scopeVersion === '1' && (await receiptStatuses(store)).join(',') === 'unknown:stale_packet,pass',
      { happened: `scope ${store.get(STORE_KEY).packet.scopeVersion}, ${(await receiptStatuses(store)).join(',')}`, why: 'A refused call wrote nothing, so no check needs to be run again.', fix: 'Skip the scope advance when the completion is a refusal.' });
    for (const tool of ['Write', 'MultiEdit', 'NotebookEdit']) await h.run('tool.call', edit(tool), editReply());
    check('Write, MultiEdit and NotebookEdit each advance the scope too', store.get(STORE_KEY).packet.scopeVersion === '4',
      { happened: `scope ${store.get(STORE_KEY).packet.scopeVersion}`, why: 'Every file-writing tool named in the README must invalidate older checks.', fix: 'EDIT_TOOLS lists Edit, Write, MultiEdit and NotebookEdit.' });
    const boom = new Error('native call failed after it may have written');
    let thrown = null;
    try { await h.run('tool.call', edit('Edit'), boom); } catch (err) { thrown = err; }
    check('an edit that throws rethrows the same error and still advances the scope', thrown === boom && store.get(STORE_KEY).packet.scopeVersion === '5',
      { happened: `same error: ${thrown === boom}, scope ${store.get(STORE_KEY).packet.scopeVersion}`, why: 'A failed native call may have written the file; the mod must not hide the error or keep the old scope.', fix: 'Catch, advance the scope as unknown, and rethrow the error object unchanged.' });
    const errored = { ref: 'msg-3', result: { filePath: 'D:/fixture/a.txt' }, text: 'string not found', isError: true };
    const errReply = await h.run('tool.call', edit('Edit'), errored);
    check('an Edit that reports an error still advances the scope', errReply.out === errored && store.get(STORE_KEY).packet.scopeVersion === '6',
      { happened: `scope ${store.get(STORE_KEY).packet.scopeVersion}`, why: 'An errored edit may have changed part of the file.', fix: 'Treat tool-error as a non-refusal completion.' });
  });

  await asyncSuite('pipeline mod expert', 'pipeline mod: the evidence record block is one constant, appended, and absent when off', async () => {
    const h = harness({ enabled: true, evidenceRecordStyle: true });
    const blocks = [{ name: 'claudeMd', text: 'rules A' }, { name: 'currentDate', text: '2026-10-15' }];
    const e1 = { blocks };
    const reply1 = { blocks };
    const r1 = await h.run('prompt.context', e1, reply1);
    check('the existing blocks are kept in order and are the same objects', r1.out.blocks.length === 3 && r1.out.blocks[0] === blocks[0] && r1.out.blocks[1] === blocks[1],
      { happened: JSON.stringify(r1.out.blocks.map(b => b.name)), why: 'A dropped or rewritten context block removes instructions the model was given.', fix: 'Append the evidence block to a copy of the blocks; never filter them.' });
    check('the new block is named and worded as the constant', r1.out.blocks[2].name === EVIDENCE_BLOCK && r1.out.blocks[2].text === EVIDENCE_TEXT,
      { happened: JSON.stringify(r1.out.blocks[2]), why: 'The block is the one thing the mod adds.', fix: 'Use EVIDENCE_BLOCK and EVIDENCE_TEXT.' });
    const other = [{ name: 'claudeMd', text: 'different rules' }, { name: 'userEmail', text: 'someone' }];
    const r2 = await h.run('prompt.context', { blocks: other }, { blocks: other });
    check('the block is byte-identical on a second conversation, so the prompt cache stays valid', JSON.stringify(r2.out.blocks[2]) === JSON.stringify(r1.out.blocks[2]),
      { happened: `${JSON.stringify(r2.out.blocks[2]).length} vs ${JSON.stringify(r1.out.blocks[2]).length} characters`, why: 'Text that changes between requests invalidates the prompt cache (claude-code-mods-2026-10-12.md section 3).', fix: 'EVIDENCE_TEXT is a constant; never add a counter or a time to it.' });
    check('the text is plain ASCII and asks for the evidence record', /^[\x20-\x7e]+$/.test(EVIDENCE_TEXT) && EVIDENCE_TEXT.includes('evidence record') && EVIDENCE_TEXT.includes('exit code'),
      { happened: EVIDENCE_TEXT, why: 'The instruction must be plain, stable, and ask for the record the reporter reads.', fix: 'Edit EVIDENCE_TEXT only with a reviewed reason; keep it ASCII.' });
    const withFiles = { blocks: [], instructionFiles: [{ path: 'D:/fixture/CLAUDE.md' }] };
    const r3 = await h.run('prompt.context', { blocks: [] }, withFiles);
    check('instructionFiles pass through unchanged', r3.out.instructionFiles === withFiles.instructionFiles,
      { happened: 'instructionFiles were replaced', why: 'The engine reads instructionFiles with the claudeMd text; replacing them desynchronises the two.', fix: 'Spread the result and set only blocks.' });
    const twice = { blocks: [{ name: EVIDENCE_BLOCK, text: EVIDENCE_TEXT }] };
    const r4 = await h.run('prompt.context', { blocks: twice.blocks }, twice);
    check('a block already carrying the name is not added a second time', r4.out.blocks.length === 1,
      { happened: `${r4.out.blocks.length} blocks`, why: 'A duplicated instruction costs tokens on every conversation that receives it.', fix: 'Skip the append when a block with EVIDENCE_BLOCK is present.' });
    for (const options of [{ enabled: true }, { enabled: true, evidenceRecordStyle: 'true' }, { enabled: false, evidenceRecordStyle: true }]) {
      const off = harness(options);
      check(`no prompt.context handler is registered for ${JSON.stringify(options)}`, !off.registrations.some(r => r.event === 'prompt.context'),
        { happened: JSON.stringify(off.registrations.map(r => r.event)), why: 'The evidence instruction is off unless its option is exactly true.', fix: 'Register prompt.context only when evidenceRecordStyle === true.' });
    }
  });

  await asyncSuite('pipeline mod expert', 'pipeline mod: a failing store never changes an event', async () => {
    const h = harness(ALL, { failStore: true });
    const e = prompt('still delivered');
    const reply = promptReply(e);
    const r = await h.run('prompt.submit', e, reply);
    check('a prompt whose save fails still reaches next as the same event', r.out === reply && r.seen === e,
      { happened: `same reply: ${r.out === reply}`, why: 'The mod must never be the reason a prompt is not delivered.', fix: 'Wrap every store call in a try and keep the in-process ledger.' });
    const shellReplyObject = shellReply({ stdout: 'ok', stderr: '', interrupted: false, exitCode: 0 });
    const s = await h.run('tool.call', shell('Bash', {}), shellReplyObject);
    check('a shell result whose save fails still passes through', s.out === shellReplyObject,
      { happened: 'result was replaced', why: 'A failed receipt must not change the result the model is given.', fix: 'Return the result after the try block.' });
    const c = await h.run('prompt.context', { blocks: [] }, { blocks: [] });
    check('the evidence block is still added when the store is offline (it does not use the store)', c.out.blocks.length === 1 && c.out.blocks[0].name === EVIDENCE_BLOCK,
      { happened: JSON.stringify(c.out.blocks), why: 'The evidence style is independent of the store.', fix: 'Keep the prompt.context handler free of store calls.' });
  });

  await asyncSuite('pipeline mod expert', 'pipeline mod: overlapping checks never acquire the scope of a later edit', async () => {
    const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
    {
      const h = harness(ALL);
      await h.run('prompt.submit', prompt('Original request.'), promptReply(prompt('Original request.')));
      await h.run('tool.call', shell('Bash', {}), shellReply({ exitCode: 0 }));
      const editing = deferred(), finish = deferred();
      const writing = h.run('tool.call', edit('Edit'), async () => { editing.resolve(); await finish.promise; return editReply(); });
      await editing.promise;
      const pending = await receiptStatuses(h.store);
      check('an earlier pass is already stale while a write is in flight', !pending.includes('pass'), {
        happened: JSON.stringify(pending), why: 'A writer may have changed the files before its native result returns.', fix: 'Expose a pending-write scope before forwarding the edit, and clear it only after completion.' });
      finish.resolve();
      await writing;
    }
    for (const editEndsFirst of [true, false]) {
      const h = harness(ALL);
      await h.run('prompt.submit', prompt('Check after the last edit.'), promptReply(prompt('Check after the last edit.')));
      const read = deferred(), endCheck = deferred(), editing = deferred(), endEdit = deferred();
      const running = h.run('tool.call', shell('Bash', {}), async () => { read.resolve(); await endCheck.promise; return shellReply({ exitCode: 0 }); });
      await read.promise;
      const writing = h.run('tool.call', edit('Edit'), async () => { editing.resolve(); await endEdit.promise; return editReply(); });
      await editing.promise;
      if (editEndsFirst) { endEdit.resolve(); await writing; }
      endCheck.resolve();
      await running;
      const during = await receiptStatuses(h.store);
      check(`a check that read before an edit is unknown when the edit ${editEndsFirst ? 'finished first' : 'is still running'}`, during.length === 1 && during[0].startsWith('unknown:'), {
        happened: JSON.stringify(during), why: 'Completing a check after an edit does not show it read the edited files.', fix: 'Bind at invocation and refuse numeric evidence across an edit epoch or pending edit.' });
      if (!editEndsFirst) { endEdit.resolve(); await writing; }
      await h.run('tool.call', shell('Bash', {}), shellReply({ exitCode: 0 }));
      const after = await receiptStatuses(h.store);
      check('a new check after all writes complete is still usable', after.at(-1) === 'pass' && !after.slice(0, -1).includes('pass'), {
        happened: JSON.stringify(after), why: 'Overlap invalidation must not permanently disable fresh checks.', fix: 'Release the pending edit in a finally block and snapshot each new check separately.' });
    }
    {
      const h = harness(ALL);
      await h.run('prompt.submit', prompt('Original request.'), promptReply(prompt('Original request.')));
      const editing = deferred(), endEdit = deferred(), read = deferred(), endCheck = deferred();
      const writing = h.run('tool.call', edit('Edit'), async () => { editing.resolve(); await endEdit.promise; return editReply(); });
      await editing.promise;
      const running = h.run('tool.call', shell('Bash', {}), async () => { read.resolve(); await endCheck.promise; return shellReply({ exitCode: 0 }); });
      await read.promise;
      endEdit.resolve();
      await writing;
      endCheck.resolve();
      await running;
      check('an edit already running when a check starts cannot make that check current by finishing first', (await receiptStatuses(h.store))[0].startsWith('unknown:'), {
        happened: JSON.stringify(await receiptStatuses(h.store)), why: 'The edit epoch does not change after this check begins, but its read still overlaps a write.', fix: 'Remember pending edits at invocation, as well as later epoch changes.' });
    }
    for (const throwing of [false, true]) {
      const h = harness(ALL);
      await h.run('prompt.submit', prompt('Original request.'), promptReply(prompt('Original request.')));
      const read = deferred(), finish = deferred();
      const running = h.run('tool.call', shell('Bash', {}), async () => { read.resolve(); await finish.promise; return shellReply({ exitCode: 0 }); });
      await read.promise;
      const boom = new Error('native edit failed');
      let thrown;
      try { await h.run('tool.call', edit('Edit'), throwing ? boom : { deny: 'not allowed' }); } catch (e) { thrown = e; }
      finish.resolve();
      await running;
      const overlap = await receiptStatuses(h.store);
      check(`a ${throwing ? 'throwing' : 'refused'} overlapping edit cannot promote a running check`, overlap.length === 1 && overlap[0].startsWith('unknown:') && (!throwing || thrown === boom), {
        happened: JSON.stringify({ overlap, sameError: thrown === boom }), why: 'A failed edit may have written files; the host result and error must still pass through.', fix: 'Keep invocation uncertainty and unwind pending edits on every completion path.' });
      await h.run('tool.call', shell('Bash', {}), shellReply({ exitCode: 0 }));
      check('checks after refused or throwing edits are not stuck behind pending state', (await receiptStatuses(h.store)).at(-1) === 'pass', {
        happened: JSON.stringify(await receiptStatuses(h.store)), why: 'A leaked pending edit would make every later check unknown.', fix: 'Decrement pending edits even for refusal or exceptions.' });
    }
    const h = harness(ALL);
    await h.run('prompt.submit', prompt('Original request.'), promptReply(prompt('Original request.')));
    const read = deferred(), finish = deferred();
    const running = h.run('tool.call', shell('Bash', {}), async () => { read.resolve(); await finish.promise; return shellReply({ exitCode: 0 }); });
    await read.promise;
    await h.run('prompt.submit', prompt('Follow-up: new requirements.'), promptReply(prompt('Follow-up: new requirements.')));
    finish.resolve();
    await running;
    check('a check from before a follow-up is not rebound to its new authority packet', (await receiptStatuses(h.store))[0].startsWith('unknown:'), {
      happened: JSON.stringify(await receiptStatuses(h.store)), why: 'A completion after a new request cannot verify that new request.', fix: 'Keep the invocation packet for each check.' });
  });

  await asyncSuite('pipeline mod expert', 'pipeline mod: a restarted session never extends an earlier record, and every prompt still passes through', async () => {
    const opts = { enabled: true, collectAuthority: true, collectReceipts: true };
    for (const tamper of [false, true]) {
      const store = new Map();
      const transcript = [];
      const first = harness(opts, { store, transcript });
      await first.run('prompt.submit', prompt('A: the original'), promptReply(prompt('A: the original')));
      await first.run('prompt.submit', prompt('B: follow-up'), promptReply(prompt('B: follow-up')));
      if (tamper) {
        const record = store.get(STORE_KEY);
        record.packet.packetId = 'tampered';
        store.set(STORE_KEY, record);
      }
      const second = harness(opts, { store, transcript });
      const late = prompt('C: after restart');
      const r = await second.run('prompt.submit', late, promptReply(late));
      await second.run('tool.call', shell('Bash', {}), shellReply({ stdout: 'ok', stderr: '', interrupted: false, exitCode: 0 }));
      check(`a ${tamper ? 'tampered' : 'valid, transcript-confirmed'} earlier record is replaced by the broken marker, the later prompt and check are recorded nowhere, and the prompt reaches next`, r.seen === late && r.out.text === late.text && JSON.stringify(store.get(STORE_KEY)) === JSON.stringify({ sessionId: SID, broken: true }),
        { happened: JSON.stringify(store.get(STORE_KEY)).slice(0, 160), why: 'A restart cannot show that no skill, edit or check fell between the last save and the restart; extending the record dropped a skill and kept a pre-edit pass (Codex review of 91d3e55).', fix: 'restore breaks the session for any earlier record of it.' });
    }
  });

  await asyncSuite('pipeline mod expert', 'pipeline mod: a missing session id records nothing, never under an invented name', async () => {
    const store = new Map();
    const opts = { enabled: true, collectAuthority: true, collectReceipts: true };
    const lost = async () => { throw new Error('session ID unavailable'); };
    const one = harness(opts, { store, id: lost });
    const two = harness(opts, { store, id: lost });
    const e1 = prompt('FIRST SESSION REQUEST');
    const e2 = prompt('SECOND SESSION REQUEST');
    const r1 = await one.run('prompt.submit', e1, promptReply(e1));
    const r2 = await two.run('prompt.submit', e2, promptReply(e2));
    check('both prompts still reach next as the same events', r1.seen === e1 && r2.seen === e2 && r1.out.text === e1.text && r2.out.text === e2.text,
      { happened: `seen ${r1.seen === e1}/${r2.seen === e2}`, why: 'A missing id must never cost the person a prompt.', fix: 'Call next(e) whatever the ledger does.' });
    check('nothing is stored for two instances that both lost their id, so their authority cannot merge', store.size === 0,
      { happened: JSON.stringify([...store.values()]).slice(0, 200), why: 'A fixed fallback name made two sessions one record: the second request became the first one\'s follow-up (Codex review 1015, finding 1).', fix: 'Return null from sessionId and record nothing when it is null.' });
    for (const bad of [async () => '', async () => 42, async () => null]) {
      const s = new Map();
      await harness(opts, { store: s, id: bad }).run('prompt.submit', prompt('X'), promptReply(prompt('X')));
      check(`an id that is not a nonempty string (${String(bad)}) records nothing`, s.size === 0,
        { happened: JSON.stringify([...s.values()]), why: 'Only the host\'s own id names a session.', fix: 'Treat any other value as missing.' });
    }
    let available = false;
    const flaky = harness(opts, { store, id: async () => { if (!available) throw new Error('not yet'); return SID; } });
    await flaky.run('prompt.submit', prompt('lost while the id was missing'), promptReply(prompt('lost while the id was missing')));
    available = true;
    const later = prompt('arrives once the id is back');
    const r3 = await flaky.run('prompt.submit', later, promptReply(later));
    check('a prompt that arrives after the id comes back is not made the original of a session that missed one', r3.seen === later && JSON.stringify(store.get(STORE_KEY)) === JSON.stringify({ sessionId: SID, broken: true }),
      { happened: JSON.stringify(store.get(STORE_KEY)).slice(0, 200), why: 'The process saw a prompt it could not place; whichever session it was, that session now misses it.', fix: 'Once an event loses its id, break every session the process later sees.' });
    const known = harness(opts, { store: new Map() });
    await known.run('prompt.submit', prompt('A'), promptReply(prompt('A')));
    let gone = false;
    const switching = harness(opts, { store: known.store, transcript: known.transcript, id: async () => { if (gone) throw new Error('lost'); return SID; } });
    await switching.run('prompt.submit', prompt('B'), promptReply(prompt('B')));
    gone = true;
    await switching.run('tool.call', edit('Edit'), editReply());
    gone = false;
    await switching.run('tool.call', shell('Bash', {}), shellReply({ stdout: 'ok', stderr: '', interrupted: false, exitCode: 0 }));
    check('an edit seen while the id was missing breaks the session, so a later check cannot look current', JSON.stringify(known.store.get(STORE_KEY)) === JSON.stringify({ sessionId: SID, broken: true }),
      { happened: JSON.stringify(known.store.get(STORE_KEY)).slice(0, 200), why: 'A missed edit leaves the scope behind, and a check before it would read as a pass after it.', fix: 'Break the session on the first event that cannot be placed.' });
  });

  await asyncSuite('pipeline mod expert', 'pipeline mod: a restart restores only what the host transcript confirms', async () => {
    const opts = { enabled: true, collectAuthority: true };
    // Codex review 1015, finding 2: the full save and its marker both fail, then the process restarts.
    const store = new Map();
    const transcript = [];
    const first = harness(opts, { store, transcript });
    await first.run('prompt.submit', prompt('ORIGINAL'), promptReply(prompt('ORIGINAL')));
    const frozen = JSON.stringify(store.get(STORE_KEY));
    // The store now refuses the full save and the marker: the prompt reaches the transcript, the store keeps ORIGINAL only.
    const offline = harness(opts, { store, transcript, failStore: true });
    await offline.run('prompt.submit', prompt('FOLLOWUP THAT MUST SURVIVE'), promptReply(prompt('FOLLOWUP THAT MUST SURVIVE')));
    check('setup: the store still holds the older complete-looking record', JSON.stringify(store.get(STORE_KEY)) === frozen && await verifyPacket(store.get(STORE_KEY).packet) === true,
      { happened: JSON.stringify(store.get(STORE_KEY)).slice(0, 160), why: 'This is the state the review reproduced.', fix: 'n/a: setup' });
    const restarted = harness(opts, { store, transcript });
    const after = prompt('AFTER RESTART');
    const r = await restarted.run('prompt.submit', after, promptReply(after));
    check('the prompt after the restart still reaches next unchanged', r.seen === after && r.out.text === after.text,
      { happened: `seen ${r.seen === after}`, why: 'Recovery must never cost the person a prompt.', fix: 'Call next(e) whatever restore decides.' });
    check('the older record is not extended: the session is marked broken, so no packet without the middle follow-up exists', JSON.stringify(store.get(STORE_KEY)) === JSON.stringify({ sessionId: SID, broken: true }),
      { happened: JSON.stringify(store.get(STORE_KEY)).slice(0, 200), why: 'A valid digest proves integrity, not completeness; extending the old record silently dropped FOLLOWUP THAT MUST SURVIVE.', fix: 'Restore only when $.session.messages shows exactly the stored prompts.' });

    // No record at all, but the transcript already has prompts: the first save never landed.
    const empty = new Map();
    const t2 = [{ role: 'user', text: 'EARLIER PROMPT', toolUses: [] }, { role: 'assistant', text: 'ok', toolUses: [] }];
    await harness(opts, { store: empty, transcript: t2 }).run('prompt.submit', prompt('NEXT'), promptReply(prompt('NEXT')));
    check('with no record and earlier prompts in the transcript, the new prompt is not made the original', JSON.stringify(empty.get(STORE_KEY)) === JSON.stringify({ sessionId: SID, broken: true }),
      { happened: JSON.stringify(empty.get(STORE_KEY)).slice(0, 200), why: 'The real original is in the transcript and missing from the store.', fix: 'A fresh ledger needs a transcript with no earlier prompt.' });

    // Tool results and assistant turns are not prompts; the prompt being submitted may already be in the transcript.
    for (const appendFirst of [false, true]) {
      const s = new Map();
      const t = [];
      const a = harness(opts, { store: s, transcript: t, appendFirst });
      await a.run('prompt.submit', prompt('P1'), promptReply(prompt('P1')));
      t.push({ role: 'assistant', text: 'working', toolUses: [{ name: 'Bash' }] }, { role: 'user', text: '', toolUses: [], toolResults: [{ id: 'x' }] });
      await a.run('prompt.submit', prompt('P2'), promptReply(prompt('P2')));
      const got = s.get(STORE_KEY);
      check(`within one process, tool rows are not prompts (host adds the prompt ${appendFirst ? 'before' : 'after'} the hook)`, got && got.packet && got.packet.authority.original.text === 'P1' && JSON.stringify(got.packet.authority.followups.map(x => x.text)) === JSON.stringify(['P2']),
        { happened: JSON.stringify(got).slice(0, 200), why: 'The in-process ledger is the authority; a tool row taken as a prompt would add an instruction the person never gave.', fix: 'Skip user rows that carry toolResults.' });
      const b = harness(opts, { store: s, transcript: t, appendFirst });
      await b.run('prompt.submit', prompt('P3'), promptReply(prompt('P3')));
      check(`a transcript-confirmed restart still records nothing more (host adds the prompt ${appendFirst ? 'before' : 'after'} the hook)`, JSON.stringify(s.get(STORE_KEY)) === JSON.stringify({ sessionId: SID, broken: true }),
        { happened: JSON.stringify(s.get(STORE_KEY)).slice(0, 200), why: 'Prompt equality does not show that no skill or edit was lost before the restart (Codex review of 91d3e55, cases 2 and 3).', fix: 'restore breaks the session for any earlier record of it.' });
    }

    // Codex review of 91d3e55, cases 2 and 3: a skill or an edit observed while both writes fail, then a restart.
    for (const kind of ['skill', 'edit']) {
      for (const failWrites of [false, true]) {
        const s = new Map();
        const t = [];
        // bytes 0 refuses every write, the full record and the marker alike; reads still work.
        const limit = { bytes: Infinity };
        const full = { enabled: true, collectAuthority: true, collectReceipts: true };
        const a = harness(full, { store: s, transcript: t, limit });
        await a.run('prompt.submit', prompt('ORIGINAL'), promptReply(prompt('ORIGINAL')));
        if (kind === 'edit') await a.run('tool.call', shell('Bash', {}), shellReply({ stdout: 'ok', stderr: '', interrupted: false, exitCode: 0 }));
        if (failWrites) limit.bytes = 0;
        if (kind === 'skill') await a.run('skill.prompt', skillEvent('required-skill', 'Full required skill body.'), skillEvent('required-skill', 'Full required skill body.'));
        else await a.run('tool.call', edit('Edit'), editReply());
        limit.bytes = Infinity;
        const b = harness(full, { store: s, transcript: t });
        if (kind === 'skill') await b.run('prompt.submit', prompt('FOLLOWUP'), promptReply(prompt('FOLLOWUP')));
        else await b.run('tool.call', shell('Bash', {}), shellReply({ stdout: 'no numeric exit', stderr: '', interrupted: false }));
        const after = s.get(STORE_KEY);
        const statuses = await receiptStatuses(s);
        check(`restart after a ${kind} with ${failWrites ? 'both writes failing' : 'writes working'}: the session is broken, so no record lacks the skill or keeps a pre-edit pass`, JSON.stringify(after) === JSON.stringify({ sessionId: SID, broken: true }) && statuses === null,
          { happened: JSON.stringify(after).slice(0, 200), why: 'A packet without the selected skill, or a pass from before an unrecorded edit, would look complete and be wrong.', fix: 'restore breaks the session for any earlier record of it.' });
      }
    }

    // A transcript that cannot be read whole fails closed.
    const unreadable = [
      ['messages throws', async () => { throw new Error('no transcript'); }],
      ['messages is not an array', async () => ({})],
      ['a user row without text', async () => [{ role: 'user', toolUses: [] }]],
      ['a page of 4096 entries', async () => Array.from({ length: 4096 }, () => ({ role: 'assistant', text: '', toolUses: [] }))],
    ];
    for (const [name, messages] of unreadable) {
      const s = new Map();
      await harness(opts, { store: s, messages }).run('prompt.submit', prompt('Q'), promptReply(prompt('Q')));
      check(`${name}: nothing is recorded as authority`, JSON.stringify(s.get(STORE_KEY)) === JSON.stringify({ sessionId: SID, broken: true }),
        { happened: JSON.stringify(s.get(STORE_KEY)).slice(0, 160), why: 'Without the host\'s whole list of prompts, completeness cannot be established.', fix: 'Return null from hostPrompts and break the session.' });
    }
  });

  await asyncSuite('pipeline mod expert', 'pipeline mod: a record too large to save is replaced by a marker, so a restart never restores half of it', async () => {
    const store = new Map();
    const limit = { bytes: Infinity };
    const opts = { enabled: true, collectAuthority: true };
    const first = harness(opts, { store, limit });
    await first.run('prompt.submit', prompt('A: fits'), promptReply(prompt('A: fits')));
    limit.bytes = JSON.stringify(store.get(STORE_KEY)).length + 5;
    const big = prompt('B: the record now grows past the limit');
    const r = await first.run('prompt.submit', big, promptReply(big));
    check('the save that fails does not fail the prompt', r.out.text === big.text && r.out.origin.kind === 'composer',
      { happened: 'the prompt reply changed or was lost', why: 'A save failure must never be the reason a prompt is not delivered.', fix: 'Keep the save inside try and the prompt path outside it.' });
    check('the full record is replaced by a marker that says the session is not recorded any more', JSON.stringify(store.get(STORE_KEY)) === JSON.stringify({ sessionId: SID, broken: true }),
      { happened: JSON.stringify(store.get(STORE_KEY)).slice(0, 160), why: 'An older copy on disk would omit later prompts, and a restart would then plan from an incomplete original.', fix: 'On a failed save, write { sessionId, broken: true } instead.' });
    const restarted = harness(opts, { store });
    const late = prompt('C: after the restart');
    const after = await restarted.run('prompt.submit', late, promptReply(late));
    check('after a restart the marked session records nothing further, and the prompt passes through', after.out.text === late.text && JSON.stringify(store.get(STORE_KEY)) === JSON.stringify({ sessionId: SID, broken: true }),
      { happened: JSON.stringify(store.get(STORE_KEY)).slice(0, 160), why: 'Recording on top of an incomplete authority would look complete and would not be.', fix: 'restore returns broken for a record with broken: true.' });
  });

  await asyncSuite('pipeline mod expert', 'pipeline mod: receipts need the original, and a session with no recorded prompt has no receipt', async () => {
    const withoutAuthority = harness({ enabled: true, collectReceipts: true });
    check('collectReceipts alone registers no tool.call hook', !withoutAuthority.registrations.some(r => r.event === 'tool.call'),
      { happened: JSON.stringify(withoutAuthority.registrations.map(r => r.event)), why: 'A receipt is bound to a packet, and the packet needs the original prompt.', fix: 'collectReceipts is effective only with collectAuthority.' });
    const store = new Map();
    const h = harness({ enabled: true, collectAuthority: true, collectReceipts: true }, { store });
    await h.run('prompt.submit', prompt('from a peer', 'peer'), promptReply(prompt('from a peer', 'peer')));
    await h.run('tool.call', shell('Bash', {}), shellReply({ stdout: 'ok', stderr: '', interrupted: false, exitCode: 0 }));
    const stored = store.get(STORE_KEY);
    check('with no recorded prompt, a shell result leaves no receipt', !stored || (stored.receipts || []).length === 0,
      { happened: stored ? `receipts ${(stored.receipts || []).length}, broken ${stored.broken === true}` : 'no record', why: 'A receipt without a bound packet cannot be checked against the authority, so it must not exist.', fix: 'observeCompletion returns when there is no packet.' });
  });

  suite('pipeline mod expert', 'pipeline mod: a result is executed only when every control field is clean', () => {
    const cases = [
      [null, 'unknown'], [[], 'unknown'], ['text', 'unknown'], [{ result: {} }, 'executed'], [{ result: {}, isError: false }, 'executed'],
      [{ result: {}, isError: true }, 'tool-error'], [{ result: {}, isError: 'true' }, 'unknown'], [{ result: {}, isError: null }, 'unknown'],
      [{ result: {}, deny: 'why' }, 'refused'], [{ result: {}, deny: null }, 'unknown'], [{ result: undefined }, 'unknown'],
      [{ result: null }, 'unknown'], [{}, 'unknown'],
    ];
    for (const [value, want] of cases) {
      const got = completion(value);
      check(`completion(${JSON.stringify(value)}) is ${want}`, got === want,
        { happened: `got ${got}`, why: 'Only a clean result counts as executed; anything else must not let a later step or a pass be recorded.', fix: 'Check own control fields first, then result.' });
    }
  });

  suite('pipeline mod expert', 'pipeline mod: the hooks module makes only the literal calls it may make', () => {
    const dir = path.join(ROOT, 'mods', 'atlias-pipeline');
    const raw = fs.readFileSync(path.join(dir, 'hooks', 'register.mjs'), 'utf8');
    const source = raw.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
    check('no dynamic $ lookup such as $[x] or $.tool[name] in the code', !source.includes('$[') && !/\$\.[A-Za-z]+\[/.test(source),
      { happened: 'a dynamic lookup was found', why: 'The native compiler accepts only literal $.noun.method(...) calls; a dynamic lookup fails it (handoff, R8).', fix: 'Write the call out literally.' });
    const calls = [...new Set([...source.matchAll(/\$\.[A-Za-z]+\.[A-Za-z]+\(/g)].map(m => m[0]))].sort();
    check('the only $ calls are $.session.id, $.session.messages, $.store.get and $.store.set', JSON.stringify(calls) === JSON.stringify(['$.session.id(', '$.session.messages(', '$.store.get(', '$.store.set(']),
      { happened: JSON.stringify(calls), why: 'The mod may read the session id, the host transcript (to confirm a restore) and its own store. Any other call (a model, a fork, HTTP, a file) is outside what this mod may do.', fix: 'Remove the call; this mod never calls a model, the network or the file system.' });
    const imports = source.split('\n').filter(line => line.startsWith('import '));
    check('one import, and it is a plain file of this plugin', imports.length === 1 && imports[0].includes("from './contract.mjs'"),
      { happened: JSON.stringify(imports), why: 'A hooks module has no Node and may import only files of its own plugin.', fix: 'Import only ./contract.mjs.' });
    check('no Node module, no require, no process, no fetch, no model, HTTP or file call', !/node:|require\(|\bprocess\.|\bfetch\(|\$\.model\.|\$\.http\.|\$\.fs\.|\$\.process\./.test(source),
      { happened: 'a forbidden reference was found', why: 'The mod must reach the machine only through the documented $ API it is allowed to use.', fix: 'Remove the reference.' });
  });

  suite('pipeline mod expert', 'pipeline mod: the plugin is declared the way Claude Code reads a mod', () => {
    const dir = path.join(ROOT, 'mods', 'atlias-pipeline');
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8'));
    const declared = JSON.parse(fs.readFileSync(path.join(dir, 'hooks', 'hooks.json'), 'utf8'));
    const keys = Object.keys(manifest.userConfig || {}).sort();
    check('the manifest names the mod, and each of its four options is a boolean that defaults to false', manifest.name === 'atlias-pipeline'
      && JSON.stringify(keys) === JSON.stringify(['collectAuthority', 'collectReceipts', 'enabled', 'evidenceRecordStyle'])
      && keys.every(key => manifest.userConfig[key].type === 'boolean' && manifest.userConfig[key].default === false),
      { happened: JSON.stringify(keys), why: 'Every option is off until someone turns it on; a default of true would change every session.', fix: 'Set each userConfig entry to type boolean and default false.' });
    check('hooks.json points at the hooks module and nothing else', JSON.stringify(declared) === JSON.stringify({ modules: ['./register.mjs'] }),
      { happened: JSON.stringify(declared), why: 'A mod is found through the modules key of its hooks.json.', fix: 'Keep hooks.json to the modules key.' });
    check('the main atlias plugin does not declare this module', !('modules' in JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'))),
      { happened: 'checked hooks/hooks.json', why: 'A Claude Code older than 2.1.287 is not known to handle modules; the main plugin must not be exposed to that.', fix: 'Keep this mod in its own plugin folder.' });
  });
}

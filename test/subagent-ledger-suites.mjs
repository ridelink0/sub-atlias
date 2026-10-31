// Sub-agent ledger (for Gev, 2026-10-30): ids, statuses, per-sub-agent counts and
// events for Atlias Max, cancelling one sub-agent, and four opt-in settings
// (concurrency cap, token budget, typed hand-back, check gate). With every setting
// at its default, what the parent model reads must be what it read before.
import * as loop from '../lib/loop.mjs';
import * as ledger from '../lib/subagent-ledger.mjs';

export default async function subagentLedgerSuites({ asyncSuite, check, core, agentMod, TMP, fs, path }) {
  let n = 0;
  const work = () => { const d = path.join(TMP, 'subagent-ledger', `w${++n}`); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'a.txt'), 'alpha\n'); return d; };
  const block = (o) => '```atlias\n' + JSON.stringify(o) + '\n```';
  const usage = { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 };
  // A scripted engine: a sub-agent is known by its brief, and `child(task, k)` gives its k-th reply.
  function engine(parentReplies, child, delay = 30) {
    const live = { now: 0, max: 0, calls: 0 };
    const chat = async (messages) => {
      const first = messages.find((m) => m.role === 'user');
      if (/a sub-agent of atlias/.test(String(first && first.content))) {
        const task = /Task: (.*)$/m.exec(first.content)[1];
        const k = messages.filter((m) => m.role === 'assistant').length;
        live.now++; live.max = Math.max(live.max, live.now); live.calls++;
        await new Promise((r) => setTimeout(r, typeof delay === 'function' ? delay(task) : delay));
        live.now--;
        return { content: child(task, k), calls: [], usage, requestUsages: [usage] };
      }
      return { content: parentReplies.shift() || 'all done', calls: [], usage, requestUsages: [usage] };
    };
    return { chat, live };
  }
  const two = () => `Two parts.\n${block({ tool: 'agent', task: 'list the callers of parse', name: 'finder' })}\n${block({ tool: 'agent', task: 'read the tests for parse' })}`;
  const results = (st) => st.messages.filter((m) => m.role === 'user' && /finished|sub-agent sa-|cancelled before/.test(String(m.content))).map((m) => String(m.content)).join('\n');
  const withCfg = async (agent, fn) => { core.setRunOverride({ agent }); try { return await fn(); } finally { core.setRunOverride(null); } };

  await asyncSuite('sub-agent ledger', 'sub-agents: ids, statuses and counts per sub-agent; defaults leave the parent\'s view unchanged', async () => {
    const { chat } = engine([two()], (task) => `found ${task}`);
    const st = agentMod.newState(work(), 'echo');
    const evs = [];
    st.onSubagent = (e) => evs.push(e);
    const answer = await loop.runLoop(st, 'look into parse', { chat, native: false, subagents: true });
    const r = results(st);
    check('with every setting at its default the parent reads the same text as before', answer === 'all done' && r.includes('finder finished (answered):\nfound list the callers of parse') && r.includes('sub-agent 2 finished (answered):\nfound read the tests for parse') && !/not accepted|sub-agent sa-/.test(r),
      { happened: r.slice(0, 400), why: 'RESEARCH-FIRST 0c: what a model is sent changes only behind a switch, after a measurement.', fix: 'Keep the text hand-back byte for byte when subagentHandback is text and subagentVerify is off.' });
    const all = loop.listSubagents(st);
    check('each sub-agent has an id, a final status and its own counts', all.length === 2 && all[0].id === 'sa-1' && all[1].id === 'sa-2' && all.every((x) => x.status === 'done' && x.stop === 'answered' && x.turns === 1 && x.tokens.prompt === 15 && x.tokens.output === 2 && x.tokens.cached === 5 && x.endedAt >= x.startedAt),
      { happened: JSON.stringify(all), why: 'Atlias Max shows one row per sub-agent with its tokens (RESEARCH-FIRST 0g).', fix: 'Open a record in runSubagent and set its final state from child.cache and child.stop.' });
    const seq = evs.filter((e) => e.id === 'sa-1').map((e) => e.status);
    check('events go queued, running, then a final status, and never back', seq[0] === 'queued' && seq.includes('running') && seq[seq.length - 1] === 'done' && seq.indexOf('running') < seq.lastIndexOf('done') && evs.every((e) => e.type === 'subagent' && !('answer' in e)),
      { happened: seq.join(' > '), why: 'A final stage that changes again would show a finished row as running.', fix: 'ledger.update refuses a record whose status is final.' });
    const journal = core.events(st.sid).filter((e) => e.kind === 'subagent');
    check('the session journal holds each sub-agent\'s status changes', journal.some((e) => e.id === 'sa-1' && e.status === 'done') && journal.some((e) => e.id === 'sa-2' && e.status === 'running'),
      { happened: JSON.stringify(journal.map((e) => [e.id, e.status])), why: 'The app reads the journal after a turn to show what ran.', fix: 'recordEvent kind subagent at each status change.' });
  });

  await asyncSuite('sub-agent ledger', 'sub-agents: one can be cancelled while its sibling finishes', async () => {
    const { chat } = engine([two()], (task) => `found ${task}`, (task) => (/callers/.test(task) ? 400 : 20));
    const st = agentMod.newState(work(), 'echo');
    let asked = false;
    st.onSubagent = (e) => { if (e.id === 'sa-1' && e.status === 'running' && !asked) { asked = true; setTimeout(() => loop.cancelSubagent(st, 'sa-1'), 30); } };
    const answer = await loop.runLoop(st, 'look into parse', { chat, native: false, subagents: true });
    const all = loop.listSubagents(st);
    check('the cancelled one ends cancelled, its sibling done, and the parent answers', answer === 'all done' && all[0].status === 'cancelled' && all[0].reason === 'cancelled by the person' && all[1].status === 'done' && /finder finished \(interrupted\)/.test(results(st)),
      { happened: JSON.stringify(all.map((x) => [x.id, x.status, x.stop, x.reason])), why: 'RESEARCH-FIRST H4: say whether a run stopped or completed; one stop must not end the turn.', fix: 'Give each sub-agent its own AbortController and pass its signal to the child loop.' });
    check('a finished sub-agent cannot be cancelled again', loop.cancelSubagent(st, 'sa-2') === false && loop.cancelSubagent(st, 'sa-9') === false,
      { happened: 'cancel returned true', why: 'Final statuses never change.', fix: 'cancel returns false for a final or unknown record.' });
  });

  await asyncSuite('sub-agent ledger', 'sub-agents: agent.subagentConcurrency and agent.subagentTokenBudget (off by default)', async () => {
    const one = engine([two()], (task) => `found ${task}`);
    const st = agentMod.newState(work(), 'echo');
    await withCfg({ subagentConcurrency: 1 }, () => loop.runLoop(st, 'look into parse', { chat: one.chat, native: false, subagents: true }));
    check('a cap of one runs the two sub-agents one after the other, and both finish', one.live.max === 1 && loop.listSubagents(st).every((x) => x.status === 'done'),
      { happened: `at most ${one.live.max} at once`, why: 'RESEARCH-FIRST section 4 and H8: more agents is not better; spend must be bounded.', fix: 'acquire a slot in runSubagent before the child starts.' });
    const reader = engine([block({ tool: 'agent', task: 'keep reading', name: 'reader' })], () => block({ tool: 'read_file', path: 'a.txt' }), 5);
    const st2 = agentMod.newState(work(), 'echo');
    await withCfg({ subagentTokenBudget: 20 }, () => loop.runLoop(st2, 'read it', { chat: reader.chat, native: false, subagents: true }));
    const r = loop.listSubagents(st2)[0];
    check('a budget of 20 tokens stops the sub-agent at the first call past it (17 tokens a call)', reader.live.calls === 2 && r.status === 'failed' && r.stop === 'token-budget' && /reader finished \(token-budget\)/.test(results(st2)),
      { happened: JSON.stringify({ calls: reader.live.calls, r }), why: 'A per-sub-agent budget must stop that sub-agent, not the parent.', fix: 'Check the record\'s tokens before each child call.' });
  });

  await asyncSuite('sub-agent ledger', 'sub-agents: agent.subagentHandback typed and agent.subagentVerify check (off by default)', async () => {
    const editor = (task, k) => (k === 0 ? block({ tool: 'edit_file', path: 'a.txt', old_string: 'alpha', new_string: 'beta' }) : `changed a.txt for ${task}`);
    const { chat } = engine([block({ tool: 'agent', task: 'rename alpha', name: 'editor' })], editor, 5);
    const st = agentMod.newState(work(), 'echo');
    await withCfg({ subagentHandback: 'typed', subagentVerify: 'check' }, () => loop.runLoop(st, 'rename', { chat, native: false, subagents: true }));
    const r = results(st);
    const rec = loop.listSubagents(st)[0];
    check('typed: the harness writes status, counts, files and check, and the answer is one field', /^sub-agent sa-1 "editor": unverified \(answered\)$/m.test(r) && r.includes(`turns ${rec.turns}, tool calls ${rec.steps}, tokens ${15 * rec.turns} in / ${2 * rec.turns} out`) && rec.turns >= 2 && rec.steps === 1 && /files changed: .*a\.txt/.test(r) && /check after its edits: none ran after its edits/.test(r) && /\nanswer:\nchanged a\.txt for rename alpha/.test(r),
      { happened: r.slice(0, 500), why: 'RESEARCH-FIRST section 7: let the controller extract the structure; never ask the model for a format.', fix: 'ledger.handback builds it from the record.' });
    check('check: files changed with no passing check after them is not accepted', rec.status === 'unverified' && /not accepted: it changed files/.test(r) && rec.check.outcome === 'none',
      { happened: JSON.stringify(rec), why: 'RESEARCH-FIRST H5: what can be checked is enforced by mechanism, not by the model saying it is done.', fix: 'checkAfterEdits reads child.lastCheck against child.editedAt.' });
    const plain = engine([block({ tool: 'agent', task: 'rename alpha', name: 'editor' })], editor, 5);
    const st2 = agentMod.newState(work(), 'echo');
    await loop.runLoop(st2, 'rename', { chat: plain.chat, native: false, subagents: true });
    check('by default the same edit is accepted as before, with no gate line', loop.listSubagents(st2)[0].status === 'done' && !/not accepted/.test(results(st2)) && /editor finished \(answered\):\nchanged a\.txt/.test(results(st2)),
      { happened: results(st2).slice(0, 300), why: 'The gate changes what the parent reads, so it is off until measured (0c).', fix: 'Only subagentVerify check sets unverified.' });
  });

  await asyncSuite('sub-agent ledger', 'sub-agents: ledger rules and the settings\' bounds', async () => {
    const st = {};
    const a = ledger.open(st, { name: 'x', task: 'y'.repeat(500) });
    ledger.update(st, a, { status: 'done' });
    check('a final record never changes and a long task is cut', ledger.update(st, a, { status: 'running' }) === null && ledger.get(st, a.id).status === 'done' && a.task.length === ledger.TASK_CHARS,
      { happened: JSON.stringify(ledger.view(a)), why: 'Receipts that move backwards mislead the app.', fix: 'update returns null on a final record.' });
    let threw = false; try { ledger.update(st, ledger.open(st, {}), { status: 'bogus' }); } catch { threw = true; }
    check('an unknown status is refused', threw, { happened: 'no error', why: 'The app switches on these names.', fix: 'Check against STATUSES.' });
    const s2 = {};
    const b = ledger.open(s2, {}), c = ledger.open(s2, {}), d = ledger.open(s2, {});
    await ledger.acquire(s2, b, 1);
    const cWait = ledger.acquire(s2, c, 1), dWait = ledger.acquire(s2, d, 1);
    ledger.cancel(s2, c.id);
    ledger.release(s2);
    const [cGot, dGot] = await Promise.all([cWait, dWait]);
    check('a cancelled waiter never takes the free slot from the next one', cGot === false && dGot === true,
      { happened: JSON.stringify({ cGot, dGot }), why: 'A stale waiter would leave the queue stuck.', fix: 'A waiter removes itself from the list when it wakes.' });
    const s3 = {}; let calls = 0;
    s3.onSubagent = () => { calls++; throw Error('listener broke'); };
    // list, countReply and checkAfterEdits, each called by name (coverage expert).
    const s4 = {}; const r4 = ledger.open(s4, { name: 'counter', task: 't' });
    ledger.countReply(r4, { content: 'x', calls: [{}, {}], usage: { input_tokens: 100, output_tokens: 7 } }, null, () => ({ prompt: 100, cached: 40 }));
    ledger.countReply(r4, { error: 'interrupted' }, null, () => ({ prompt: 999, cached: 0 }));
    const listed = ledger.list(s4);
    check('countReply counts a turn, its tool calls and reported tokens, and skips an error; list shows the record without its controller', r4.turns === 1 && r4.steps === 2 && r4.tokens.prompt === 100 && r4.tokens.cached === 40 && r4.tokens.output === 7 && listed.length === 1 && listed[0].id === r4.id && !('controller' in listed[0]),
      { happened: JSON.stringify({ turns: r4.turns, steps: r4.steps, tokens: r4.tokens, listed }), why: 'The app row shows these numbers; an error reply is not a turn.', fix: 'countReply returns early on res.error; list maps view.' });
    const none = ledger.checkAfterEdits({ edited: new Set(), lastCheck: null, editedAt: 0 });
    const stale = ledger.checkAfterEdits({ edited: new Set(['a.mjs']), lastCheck: { at: 3, outcome: 'pass' }, editedAt: 5 });
    const fresh = ledger.checkAfterEdits({ edited: ['a.mjs'], lastCheck: { at: 6, outcome: 'fail', excerpt: '1 failing' }, editedAt: 5 });
    check('checkAfterEdits counts only a check that ran after the last edit, and reports its own outcome', none.ran === false && none.outcome === 'none' && stale.ran === false && stale.outcome === 'none' && stale.files[0] === 'a.mjs' && fresh.ran === true && fresh.outcome === 'fail' && fresh.excerpt === '1 failing',
      { happened: JSON.stringify({ none, stale, fresh }), why: 'RESEARCH-FIRST H5: a check from before the edit proves nothing about the edit.', fix: 'Compare lastCheck.at with editedAt.' });
    const e = ledger.open(s3, {});
    check('a listener that throws never stops a record', calls === 1 && e.status === 'queued' && ledger.update(s3, e, { status: 'running' }) !== null,
      { happened: `calls ${calls}`, why: 'Display never stops a run.', fix: 'emit catches listener errors.' });
    const bad = core.parseSetting('agent', 'subagentConcurrency', '21'), ok = core.parseSetting('agent', 'subagentConcurrency', '0');
    const rounds = core.parseSetting('agent', 'subagentRounds', '0'), budget = core.parseSetting('agent', 'subagentTokenBudget', '2.5');
    const d0 = core.config().agent;
    check('defaults are off, and out-of-range values are refused', d0.subagentConcurrency === 0 && d0.subagentRounds === loop.SUBAGENT_ROUNDS && d0.subagentTokenBudget === 0 && d0.subagentHandback === 'text' && d0.subagentVerify === 'off' && bad.error && ok.value === 0 && rounds.error && budget.error,
      { happened: JSON.stringify({ bad, ok, rounds, budget }), why: 'Each switch is off until measured (RESEARCH-FIRST 0c).', fix: 'DEFAULTS and parseSetting in core.mjs.' });
  });
}

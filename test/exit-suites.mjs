// How a run ends, and the two failures that are not the round budget.
//
// Two things the field does and atlias did not. mini-swe-agent counts
// consecutive malformed model output on a counter of its own, separate from the
// step budget, and leaves with a typed status - so a comparison between
// harnesses can tell a model that ran out of room from one that could never send
// a usable action. And pi-mono and Aider both read finish_reason before running
// anything, because a reply the provider cut off at its output limit can still
// hold JSON that parses: a path cut short or a patch missing its end arrives
// looking perfectly well formed.
//
// Loaded by test/run.mjs, which owns suite(), asyncSuite() and check().
import * as loop from '../lib/loop.mjs';

export default async function exitSuites({ suite, asyncSuite, check, core, agentMod, TMP, fs, path }) {
  const W = path.join(TMP, 'exit-work');
  fs.mkdirSync(W, { recursive: true });
  const NL = String.fromCharCode(10);
  const FENCE = '`'.repeat(3);
  const blk = (o) => FENCE + 'atlias' + NL + JSON.stringify(o) + NL + FENCE;
  const fresh = () => agentMod.newState(W, 'ollama');
  const scripted = (replies) => async () => {
    const r = replies.shift();
    if (r === undefined) return { content: 'out of script', calls: [] };
    return typeof r === 'string' ? { content: r, calls: [] } : r;
  };
  // A tool block holding prose: the fence is there, so the model plainly meant
  // to call a tool, and nothing parses out of it. Checked against parseToolCall
  // rather than assumed - a block cut off mid-JSON does NOT belong here,
  // because repairJson mends it into a real call, which is the whole point of
  // repairJson.
  const brokenBlock = FENCE + 'atlias' + NL + 'I think I should read the file called app.js next.' + NL + FENCE;

  suite('exit reason expert', 'every way out of a run names itself', () => {
    check('the reasons are a closed list', loop.STOP_REASONS.length === 7 && loop.STOP_REASONS.includes('context-full') && loop.STOP_REASONS.every((r) => typeof r === 'string' && /^[a-z-]+$/.test(r)) && loop.STOP_REASONS.includes('answered') && loop.STOP_REASONS.includes('rounds-exhausted'), { happened: JSON.stringify(loop.STOP_REASONS), why: 'An eval harness can only match on a reason that is one of a known set; free prose is what it had before, and it could not be matched at all.', fix: 'Keep STOP_REASONS and the strings passed to stopWith in step.' });
    const st = fresh();
    check('stopWith records the reason beside the text it returns', loop.stopWith(st, 'answered', 'the reply', 'some detail') === 'the reply' && st.stop.reason === 'answered' && st.stop.detail === 'some detail', { happened: JSON.stringify(st.stop), why: 'The reply is for the person and the reason is for the harness; returning one while dropping the other is how this went unmeasured before.', fix: 'Check stopWith.' });
    check('a detail longer than the field is clipped, not stored whole', loop.stopWith(fresh(), 'model-error', 'x', 'd'.repeat(900)).length === 1 && true, { happened: 'stopWith changed the text it was given', why: 'The reason travels in an eval report; an unbounded detail would put a whole stack trace in a scoreboard row.', fix: 'Keep the clip in stopWith.' });
    const longDetail = fresh();
    loop.stopWith(longDetail, 'model-error', 'x', 'd'.repeat(900));
    check('and the clip is the one the field says it is', longDetail.stop.detail.length <= 300, { happened: longDetail.stop.detail.length + ' characters', why: 'Same reason; this is the check that the number is real.', fix: 'Keep clip(detail, 300) in stopWith.' });
    check('all truncations is a diagnosis of its own', loop.stallReason(['truncated', 'truncated']) === 'truncated-output' && loop.stallReason(['truncated', 'parse']) === 'malformed-output' && loop.stallReason(['edit']) === 'malformed-output' && loop.stallReason([]) === 'malformed-output', { happened: [loop.stallReason(['truncated', 'truncated']), loop.stallReason(['truncated', 'parse']), loop.stallReason(['edit'])].join(','), why: 'A model hitting its output limit needs a shorter reply or a bigger limit; a model that cannot format an action needs a different model. Folding the two together would name the wrong fix.', fix: 'Check stallReason.' });
    const text = loop.stallText(['parse', 'parse', 'edit']);
    check('the text says how many of what, and that it is not the round budget', /3 model replies in a row/.test(text) && /2 tool blocks that did not parse/.test(text) && /1 edit that did not apply/.test(text) && /not the round budget/.test(text) && /agent\.maxBadReplies/.test(text), { happened: text, why: 'The two stops look identical from outside - no answer came back - and the whole value of counting them apart is lost if the message does not say which happened.', fix: 'Check stallText and BAD_REPLY.' });
    check('it counts in words that agree with the number', /^atlias stopped: 1 model reply in a row/.test(loop.stallText(['parse'])) && /1 tool block that did not parse/.test(loop.stallText(['parse'])) && /3 replies the provider cut off/.test(loop.stallText(['truncated', 'truncated', 'truncated'])), { happened: loop.stallText(['parse']) + ' || ' + loop.stallText(['truncated', 'truncated', 'truncated']), why: 'This line is the last thing a failed run says; "1 tool blocks" is the harness sounding careless at the moment it is reporting a failure.', fix: 'Check the one/many pair in BAD_REPLY.' });
    const cut = loop.stallText(['truncated', 'truncated', 'truncated']);
    check('a run of nothing but cut-off replies is told the right fix', /output limit/.test(cut) && /shorter replies/.test(cut) && !/stronger model/.test(cut) && /stronger model/.test(loop.stallText(['parse', 'parse', 'parse'])), { happened: cut, why: 'A model cut off at its output limit is not a model that needs replacing, and a bigger output limit does nothing for a model that cannot format an action. Naming the wrong fix sends the user after the wrong thing, which is worse than naming none.', fix: 'Check the branch on stallReason in stallText.' });
    check('every kind of bad reply has words of its own, in both numbers', Object.keys(loop.BAD_REPLY).length === 3 && Object.values(loop.BAD_REPLY).every((v) => v && v.one.length > 10 && v.many.length > 10 && v.one !== v.many), { happened: JSON.stringify(loop.BAD_REPLY), why: 'A kind with no wording would print its own variable name at the user.', fix: 'Keep BAD_REPLY in step with what runLoop pushes onto bad.' });
    check('the edit tools are named once for both the permission check and the counter', loop.EDIT_TOOLS.has('edit_file') && loop.EDIT_TOOLS.has('write_file') && loop.EDIT_TOOLS.has('apply_patch') && !loop.EDIT_TOOLS.has('shell') && !loop.EDIT_TOOLS.has('read_file'), { happened: [...loop.EDIT_TOOLS].join(','), why: 'Two lists of the edit tools drift, and then a tool is guarded in one place and counted in the other.', fix: 'Keep EDIT_TOOLS as the one list.' });
  });

  suite('truncation expert', 'a reply the provider cut off is not run', () => {
    check('the field is read, and only the spellings that exist', loop.isTruncated('length') && loop.isTruncated('max_tokens') && loop.isTruncated('MAX_TOKENS') && !loop.isTruncated('stop') && !loop.isTruncated('tool_calls') && !loop.isTruncated('') && !loop.isTruncated(null) && !loop.isTruncated(undefined), { happened: ['length', 'stop', 'tool_calls', ''].map((r) => r + '=' + loop.isTruncated(r)).join(' '), why: 'Treating a normal stop as a truncation would refuse every tool call the model ever makes.', fix: 'Check isTruncated and TRUNCATED_FINISH.' });
    check('the spellings are the three that are real, not a guess', loop.TRUNCATED_FINISH.length === 3 && loop.TRUNCATED_FINISH.includes('length') && loop.TRUNCATED_FINISH.includes('max_tokens') && loop.TRUNCATED_FINISH.includes('MAX_TOKENS'), { happened: loop.TRUNCATED_FINISH.join(','), why: 'A made-up finish reason in this list is a value no provider sends, which reads as coverage and is not.', fix: 'Only add a spelling that was seen from a real endpoint.' });
  });

  await asyncSuite('stall expert', 'replies that produce nothing are counted apart from the rounds', async () => {
    // Three broken blocks in a row, with plenty of rounds left: the run has to
    // stop on the counter, not on the budget.
    const st = fresh();
    const reply = await loop.runLoop(st, 'read something', { chat: scripted([brokenBlock, brokenBlock, brokenBlock, 'never reached']) });
    check('three unparsable replies in a row stop the run with a typed reason', st.stop && st.stop.reason === 'malformed-output' && /3 model replies in a row/.test(reply), { happened: JSON.stringify(st.stop) + ' | ' + reply.slice(0, 120), why: 'Without this the run burned all 25 rounds on a model that could not format a call, and then reported the round budget - naming the wrong cause of the failure.', fix: 'Check the bad counter and tooMany in runLoop.' });
    check('and it stopped well before the round budget', st.messages.filter((m) => m.role === 'assistant').length === 3, { happened: st.messages.filter((m) => m.role === 'assistant').length + ' model replies', why: 'The whole point of a separate counter is that it fires long before the step limit does.', fix: 'The counter is checked on each bad reply, not at the end.' });

    // One good move in between clears the count, the way mini-swe-agent resets
    // on any clean step.
    fs.writeFileSync(path.join(W, 'notes.md'), 'a line' + NL);
    const st2 = fresh();
    const reply2 = await loop.runLoop(st2, 'look then answer', { chat: scripted([brokenBlock, brokenBlock, blk({ tool: 'list_dir', path: '.' }), brokenBlock, brokenBlock, 'I looked and here is the answer.']) });
    check('a round that did something clears the count', st2.stop && st2.stop.reason === 'answered' && reply2 === 'I looked and here is the answer.', { happened: JSON.stringify(st2.stop) + ' | ' + reply2.slice(0, 80), why: 'Counting without resetting would kill a long run that stumbled twice early and then worked perfectly, which is most real runs.', fix: 'Check that produced clears bad in runLoop.' });

    // Edits that do not apply are the other way a reply produces nothing: the
    // model keeps sending an old_string that is not in the file.
    const st3 = fresh();
    const miss = blk({ tool: 'edit_file', path: 'notes.md', old_string: 'a line that is not in the file', new_string: 'x' });
    const reply3 = await loop.runLoop(st3, 'change the note', { chat: scripted([miss, miss, miss, 'never reached']) });
    check('three edits in a row that do not apply stop the run too', st3.stop && st3.stop.reason === 'malformed-output' && /3 edits that did not apply/.test(reply3) && st3.stop.detail.includes('did not apply'), { happened: JSON.stringify(st3.stop) + ' | ' + reply3.slice(0, 140), why: 'A weak model that cannot match old_string will send the same failing edit until the rounds run out, and the report blamed the budget.', fix: 'Check deadEdits in runLoop; a failed edit is one that did not move state.editedAt.' });
    check('the file it failed to edit was left alone', fs.readFileSync(path.join(W, 'notes.md'), 'utf8').trim() === 'a line', { happened: fs.readFileSync(path.join(W, 'notes.md'), 'utf8'), why: 'Counting a failed edit must not be confused with letting one through.', fix: 'edit_file returns without writing when old_string is not found.' });

    // An edit that applies is a round that produced something, so the counter
    // must not treat a working edit as a failure.
    const st4 = fresh();
    // Three replies, not two: after an edit with no check the loop asks once
    // more before it lets the answer stand, which is the auto-check nudge doing
    // its job.
    const reply4 = await loop.runLoop(st4, 'change the note', { chat: scripted([blk({ tool: 'edit_file', path: 'notes.md', old_string: 'a line', new_string: 'two lines' }), 'Changed it.', 'There is no check to run in this folder.']) });
    check('an edit that applies is not counted as a failure', st4.stop && st4.stop.reason === 'answered' && /no check to run/.test(reply4) && fs.readFileSync(path.join(W, 'notes.md'), 'utf8').includes('two lines'), { happened: JSON.stringify(st4.stop) + ' | ' + reply4.slice(0, 80), why: 'Reading success from the wording of the result would break the moment the wording changed; this reads the clock the harness already keeps.', fix: 'Check the state.editedAt comparison in runLoop.' });

    // The truncation path, end to end: the provider says length, and the tool
    // call in that reply is refused rather than run.
    const st5 = fresh();
    const cut = { content: '', calls: [{ id: 'call_1', tool: 'write_file', path: 'should-not-exist.txt', content: 'x' }], message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '{"path":"should-not-exist.txt","content":"x"' } }] }, finish: 'length', truncated: true };
    const reply5 = await loop.runLoop(st5, 'write a file', { chat: scripted([cut, 'I will keep it shorter.']) });
    const refusal = st5.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'call_1');
    check('a tool call from a cut-off reply is refused, not run', !fs.existsSync(path.join(W, 'should-not-exist.txt')) && refusal && /refused to run/.test(refusal.content) && /finish reason length/.test(refusal.content), { happened: (refusal ? refusal.content.slice(0, 160) : 'no refusal message') + ' | file exists: ' + fs.existsSync(path.join(W, 'should-not-exist.txt')), why: 'Truncated JSON still parses, so the arguments can be quietly wrong - a path cut short writes to the wrong file and the run looks like it worked. pi-mono fails the whole batch for this reason.', fix: 'Check the res.truncated branch in runLoop.' });
    check('the refused call is still answered, so the next request is valid', refusal && refusal.role === 'tool' && refusal.tool_call_id === 'call_1' && reply5 === 'I will keep it shorter.', { happened: JSON.stringify(refusal && { role: refusal.role, id: refusal.tool_call_id }) + ' | ' + reply5, why: 'An unanswered tool_call id makes the whole conversation invalid on the next call, so refusing by silence would end the run with a provider error instead of a retry.', fix: 'Push one tool message per refused call id.' });

    const st6 = fresh();
    await loop.runLoop(st6, 'write a file', { chat: scripted([{ ...cut }, { ...cut }, { ...cut }, 'never reached']) });
    check('three cut-off replies in a row stop the run as a truncation, not as bad formatting', st6.stop && st6.stop.reason === 'truncated-output' && st6.stop.detail === 'finish reason length', { happened: JSON.stringify(st6.stop), why: 'This is the case where the fix is a shorter reply or a bigger output limit, and calling it malformed output would send the user after the wrong thing.', fix: 'Check stallReason where every kind is truncated.' });

    const st7 = fresh();
    const reply7 = await loop.runLoop(st7, 'say hello', { chat: async () => ({ error: 'connection refused' }) });
    check('a failed model call is typed too', st7.stop && st7.stop.reason === 'model-error' && st7.stop.detail === 'connection refused' && /the model call failed/.test(reply7), { happened: JSON.stringify(st7.stop), why: 'An eval row that failed because nothing answered is not a row about the model\'s ability, and a scoreboard that cannot tell them apart is misleading.', fix: 'Check the res.error branch in runLoop.' });

    const st8 = fresh();
    core.config();
    const spin = [];
    for (let i = 0; i < 40; i++) spin.push(blk({ tool: 'list_dir', path: i % 2 ? '.' : 'nowhere-' + i }));
    const reply8 = await loop.runLoop(st8, 'look forever', { chat: scripted(spin) });
    check('running out of rounds is its own reason, distinct from a stall', st8.stop && st8.stop.reason === 'rounds-exhausted' && /tool rounds without a final answer/.test(reply8), { happened: JSON.stringify(st8.stop) + ' | ' + reply8.slice(0, 100), why: 'A model working steadily that simply needs more rounds is the one case where raising maxToolRounds is the right answer, and it has to be distinguishable from the model that sent nothing usable.', fix: 'Check the final return of runLoop.' });

    const st9 = fresh();
    await loop.runLoop(st9, 'say hello', { chat: scripted(['Hello.']) });
    check('a plain answer is a reason as well, so no run is left untyped', st9.stop && st9.stop.reason === 'answered' && loop.STOP_REASONS.includes(st9.stop.reason), { happened: JSON.stringify(st9.stop), why: 'A missing reason on the success path is the one that silently reads as unknown in every passing eval row.', fix: 'Check the answer return in runLoop.' });
  });

  await asyncSuite('eval stop expert', 'the scoreboard carries the reason', async () => {
    const evalMod = await import('../lib/eval.mjs');
    const task = { id: 'stop-reason-probe', name: 'a task the model never acts on', files: { 'x.txt': 'x' + NL }, prompt: 'do nothing usable', check: [process.execPath, '-e', 'process.exit(1)'] };
    const r = await evalMod.runTask(task, { chat: scripted([brokenBlock, brokenBlock, brokenBlock]), state: agentMod.newState(W, 'ollama') });
    check('a failed task says why the agent stopped, in the closed set', r.pass === false && r.stop === 'malformed-output' && loop.STOP_REASONS.includes(r.stop), { happened: JSON.stringify({ pass: r.pass, stop: r.stop, detail: r.stopDetail }), why: 'This is the whole reason for typing the exit: an eval row that fails tells you nothing unless it says whether the model could not act, ran out of rounds, or was cut off.', fix: 'Check runTask in lib/eval.mjs.' });
    check('and the report line shows it', /stopped: malformed-output/.test(evalMod.format({ results: [r], passed: 0, total: 1, ms: 10 })), { happened: evalMod.format({ results: [r], passed: 0, total: 1, ms: 10 }).split(NL)[0], why: 'A field no report prints is a field nobody reads.', fix: 'Check format in lib/eval.mjs.' });
    if (r.workspace) { try { fs.rmSync(r.workspace, { recursive: true, force: true }); } catch { /* left behind on purpose by runTask when a task fails */ } }
  });

  // Two things the field measured and atlias was not doing: telling the model
  // how much budget is left, and counting the edits that never landed.
  await asyncSuite('budget and edit expert', 'the run says what is left and what did not apply', async () => {
    check('the line names the round and what remains', /round 1 of 5, 4 left/.test(loop.budgetLine(0, 5)) && /round 4 of 5, 1 left\. Finish/.test(loop.budgetLine(3, 5)), { happened: loop.budgetLine(0, 5) + ' || ' + loop.budgetLine(3, 5), why: 'A model that cannot see the wall spends its last rounds exploring; a disclosed remaining budget was measured at +18.6 points on a fixed call budget for well under a cent, which is a larger effect than most loop changes being argued about.', fix: 'Check budgetLine in lib/loop.mjs.' });
    check('and the last round says it is the last', /This is the last round/.test(loop.budgetLine(4, 5)) && loop.budgetLine(0, 1) === '', { happened: loop.budgetLine(4, 5) + ' || ' + JSON.stringify(loop.budgetLine(0, 1)), why: 'The round where the answer has to be given is the one round the model must not spend on a new file read; and a one-round run has nothing to disclose, so the line would be pure cost.', fix: 'Check the two edges of budgetLine.' });

    const st = { sid: 'budget-probe', cwd: W, messages: [], engine: 'ollama' };
    const seenByModel = [];
    const watch = async (messages) => {
      seenByModel.push(String((messages[messages.length - 1] || {}).content || ''));
      return { content: blk({ tool: 'list_dir', path: '.' }) };
    };
    await loop.runLoop(st, 'look around', { chat: watch, limits: { maxToolRounds: 3 } });
    const second = seenByModel[1] || '';
    check('a real run carries the budget on the newest tool result', /round 1 of 3, 2 left/.test(second), { happened: second.slice(-140) || `no tool result reached the model (${seenByModel.length} calls)`, why: 'A mechanism that only exists in a helper function is not in the loop; and it has to ride on the newest message, because writing it anywhere earlier would rewrite the cached prefix every round.', fix: 'Check where budgetLine is appended in runLoop.' });

    const st2 = { sid: 'edit-probe', cwd: W, messages: [], engine: 'ollama' };
    fs.writeFileSync(path.join(W, 'target.js'), 'export const a = 1;' + NL);
    await loop.runLoop(st2, 'fix it', {
      chat: scripted([
        blk({ tool: 'edit_file', path: 'target.js', old_string: 'export const zzz = 9;', new_string: 'export const a = 2;' }),
        blk({ tool: 'edit_file', path: 'target.js', old_string: 'export const a = 1;', new_string: 'export const a = 2;' }),
        'Done.',
      ]),
    });
    check('the harness counts the edits that did not apply', st2.editTries === 2 && st2.editFails === 1, { happened: `tries=${st2.editTries} fails=${st2.editFails}`, why: 'The largest single harness effect measured anywhere in the field is the share of edits that fail to apply - one adapter moved a model from 19.1 to 73.4 per cent on the same benchmark by fixing only that - and a rate nobody records is a rate nobody can improve.', fix: 'Check the isEdit branch in runLoop and prep.' });
    const evalMod2 = await import('../lib/eval.mjs');
    const text = evalMod2.format({ results: [{ name: 'a', pass: true, rounds: 2, ms: 10, editTries: 4, editFails: 2 }], passed: 1, total: 1, ms: 10, editTries: 4, editFails: 2, chars: 40000 });
    // The rate says there is a problem; only the causes say which problem. The
    // ladder moved the measured rate from 32 to 29 per cent, which is how we
    // learned most failures are not near-misses at all.
    const kinds = ['there is no x.js. Use write_file to create a new file.', 'old_string was not found in a.js, exactly or with its whitespace ignored.', 'old_string matches 3 places in a.js (lines 1, 2, 3).', 'refused: that edit would leave a.js unable to parse (x).', 'old_string is empty. Copy the exact lines', 'something nobody wrote a branch for'].map((t) => loop.editFailKind(t));
    check('each kind of edit failure is named from the refusal itself', JSON.stringify(kinds) === JSON.stringify(['no-file', 'not-found', 'ambiguous', 'would-not-parse', 'empty-old', 'other']), { happened: kinds.join(' '), why: 'A harness whose failures are mostly a missing file has a different problem from one whose failures are mostly a stale old_string, and the two fixes have nothing in common; a single rate cannot tell them apart.', fix: 'Check editFailKind in lib/loop.mjs.' });
    check('and every name it can return is in the published list', ['no-file', 'not-found', 'ambiguous', 'would-not-parse', 'empty-old', 'same-text', 'no-path', 'other'].every((k) => loop.EDIT_FAILS.includes(k)), { happened: loop.EDIT_FAILS.join(', '), why: 'A cause that appears in a report and not in the list is a cause nobody knows how to read.', fix: 'Keep EDIT_FAILS and editFailKind in step.' });

    // The refusals themselves, produced by runTool rather than typed here, for
    // all three edit tools. A hand-copied string passes forever after the tool
    // rewords its message; this breaks the day they drift apart.
    const RW = path.join(W, 'refusals');
    fs.mkdirSync(RW, { recursive: true });
    fs.writeFileSync(path.join(RW, 'r.mjs'), ['export const a = 1;', 'export const twin = 0;', 'export const twin2 = 0;', '// a  note', '//  a note'].join(NL) + NL);
    const rst = { sid: 'edit-refusals', cwd: RW, messages: [] };
    const outsideFile = path.join(path.dirname(TMP), `atlias-outside-${process.pid}.js`);
    const cases = [
      [{ tool: 'edit_file', old_string: 'a', new_string: 'b' }, 'no-path'],
      [{ tool: 'write_file', content: 'x' }, 'no-path'],
      [{ tool: 'edit_file', path: 'missing.js', old_string: 'a', new_string: 'b' }, 'no-file'],
      [{ tool: 'edit_file', path: outsideFile, old_string: 'a', new_string: 'b' }, 'outside-workspace'],
      [{ tool: 'edit_file', path: 'r.mjs', old_string: '', new_string: 'b' }, 'empty-old'],
      [{ tool: 'edit_file', path: 'r.mjs', old_string: 'export const a = 1;', new_string: 'export const a = 1;' }, 'same-text'],
      [{ tool: 'edit_file', path: 'r.mjs', old_string: 'export const nothing = 41;', new_string: 'x' }, 'not-found'],
      [{ tool: 'edit_file', path: 'r.mjs', old_string: ' = 0;', new_string: ' = 5;' }, 'ambiguous'],
      [{ tool: 'edit_file', path: 'r.mjs', old_string: '// a note', new_string: '// the note' }, 'ambiguous'],
      [{ tool: 'edit_file', path: 'r.mjs', old_string: 'export const a = 1;', new_string: 'export const a = ;' }, 'would-not-parse'],
      [{ tool: 'write_file', path: 'r.mjs', content: 'export const = ;' + NL }, 'would-not-parse'],
      [{ tool: 'apply_patch', input: 'no patch here' }, 'bad-patch'],
      [{ tool: 'apply_patch', input: ['*** Begin Patch', '*** Update File: missing.js', '-a', '+b', '*** End Patch'].join(NL) }, 'no-file'],
      [{ tool: 'apply_patch', input: ['*** Begin Patch', '*** Update File: r.mjs', '-export const zzz = 9;', '+export const zzz = 8;', '*** End Patch'].join(NL) }, 'not-found'],
      [{ tool: 'apply_patch', input: ['*** Begin Patch', '*** Update File: r.mjs', '-export const a = 1;', '+export const a = ;', '*** End Patch'].join(NL) }, 'would-not-parse'],
      [{ tool: 'edit_file', _badArgs: '{"path": "r.js", old_string' }, 'bad-args'],
    ];
    const misread = [];
    for (const [call, want] of cases) {
      const said = await loop.runTool(rst, call, async () => 'n');
      const got = loop.editFailKind(said);
      if (got !== want) misread.push(`${call.tool} wanted ${want}, got ${got}: ${String(said).slice(0, 120)}`);
    }
    const untouched = fs.readFileSync(path.join(RW, 'r.mjs'), 'utf8').startsWith('export const a = 1;') && !fs.existsSync(outsideFile);
    check('every refusal the three edit tools really return is named, none as other', misread.length === 0 && untouched, { happened: misread.join(' || ') || `a refusal changed a file (untouched=${untouched})`, why: 'write_file and apply_patch count as edits too, and a malformed patch or arguments that are not JSON are the failures a weak model makes most; filed under other, they are invisible in exactly the report meant to find them.', fix: 'Anchor editFailKind on the wording runTool returns for that case.' });
    // The two refusals that come from the loop and the permission setting rather
    // than from the tool, in the loop's own words.
    const outer = ['atlias guard: this exact tool call has repeated and returns the same result each time.', 'read-only mode: edit_file is not allowed here and nothing was changed.', 'refused by the user: edit_file r.js. Nothing was changed.'].map((t) => loop.editFailKind(t));
    check('and a refusal from the guard or the permission setting is named apart from the tool', JSON.stringify(outer) === JSON.stringify(['repeated', 'refused', 'refused']) && [...cases.map((c) => c[1]), ...outer].every((k) => loop.EDIT_FAILS.includes(k)), { happened: outer.join(' '), why: 'An edit the loop guard swallowed or the user declined is not a model that cannot copy text, and a fix aimed at matching would do nothing for it.', fix: 'Check the first branches of editFailKind and EDIT_FAILS.' });

    const st3 = { sid: 'edit-why', cwd: W, messages: [], engine: 'ollama' };
    await loop.runLoop(st3, 'fix it', {
      chat: scripted([
        blk({ tool: 'edit_file', path: 'nowhere-at-all.js', old_string: 'a', new_string: 'b' }),
        blk({ tool: 'edit_file', path: 'target.js', old_string: 'export const nothing = 41;', new_string: 'export const nothing = 42;' }),
        'Done.',
      ]),
    });
    check('a run tallies its edit failures by cause', st3.editWhy && st3.editWhy['no-file'] === 1 && st3.editWhy['not-found'] === 1, { happened: JSON.stringify(st3.editWhy), why: 'The distribution is the thing that decides the next fix; without it the only available move is to guess.', fix: 'Check the isEdit branch in runLoop.' });
    const whyText = evalMod2.format({ results: [{ name: 'a', pass: false, why: 'the check exited 1', rounds: 2, ms: 10 }], passed: 0, total: 1, ms: 10, editTries: 5, editFails: 3, editWhy: { 'not-found': 2, 'no-file': 1 } });
    check('and the report prints the causes worst first', /why: not-found 2, no-file 1/.test(whyText), { happened: whyText.split(NL).filter((l) => /why:/.test(l)).join(' | ') || whyText.slice(-160), why: 'A tally nobody prints is a tally nobody acts on.', fix: 'Check the why line in format.' });

    check('and the report prints the rate beside the score', /edits: 4 attempted, 2 did not apply \(50%\)/.test(text) && /context moved: 40k characters/.test(text), { happened: text.split(NL).slice(-3).join(' | '), why: 'Two harnesses can sit inside the noise on pass rate and forty-fold apart on what the score cost; a report with no cost on it cannot tell them apart.', fix: 'Check the tail of format in lib/eval.mjs.' });
  });

  // NEXTGEN-4 item 4. poly-B's largest failure cause was would-not-parse, and
  // the mechanisms are indentation, not code. Each fixture is one of them, in
  // Python, where indentation is syntax; the last three are edits that must
  // still be refused, because the repair may never make a broken edit land.
  await asyncSuite('edit repair expert', 'an edit that fails only on its indentation is re-based, not refused', async () => {
    const RP = path.join(W, 'reindent');
    fs.mkdirSync(RP, { recursive: true });
    const st = { sid: 'edit-repair', cwd: RP, messages: [] };
    const put = (name, text) => fs.writeFileSync(path.join(RP, name), text);
    const got = (name) => fs.readFileSync(path.join(RP, name), 'utf8');
    const edit = (p, old_string, new_string) => loop.runTool(st, { tool: 'edit_file', path: p, old_string, new_string }, async () => 'y');

    put('a.py', 'def encode(text):\n    pass\n');
    const r1 = await edit('a.py', 'pass', "    out = []\n    for c in text:\n        out.append(c)\n    return ''.join(out)");
    check('old_string "pass" with a new_string that carries the full indentation again applies and parses', got('a.py') === "def encode(text):\n    out = []\n    for c in text:\n        out.append(c)\n    return ''.join(out)\n" && /^edited a\.py\. As written it would not have parsed, so new_string was re-indented/.test(r1) && st.editRepaired === 1, { happened: JSON.stringify(got('a.py')) + ' || ' + r1.slice(0, 200) + ' || repaired=' + st.editRepaired, why: 'Inserted after the four spaces already in front of "pass", the first line lands at eight columns and the rest at four, which Python refuses; the code itself was right.', fix: 'Check reindentCandidates and writeOrRepair in lib/loop.mjs.' });

    put('b.py', 'class Tree:\n    def build(self):\n        pass\n');
    await edit('b.py', '    def build(self):\n        pass', 'def build(self):\n    return 1');
    check('a method written at column zero is re-based on the line it replaces', got('b.py') === 'class Tree:\n    def build(self):\n        return 1\n', { happened: JSON.stringify(got('b.py')), why: 'A small model writes a method as if it were a module function; placed as written it ends the class body and the file does not parse.', fix: 'The indentation comes from the first line of the widened span in the file.' });

    put('c.py', 'def build_tree(records):\n    pass\n');
    await edit('c.py', 'build_tree(records):\n    pass', 'def build_tree(records):\n    return records');
    check('a doubled prefix ("def " + "def build_tree") replaces the whole line', got('c.py') === 'def build_tree(records):\n    return records\n', { happened: JSON.stringify(got('c.py')), why: 'old_string started after "def ", new_string starts with "def" again, and "def def build_tree" is a syntax error the model did not mean.', fix: 'Widen the span to the line when what precedes it is repeated at the start of new_string.' });

    put('c2.py', 'def build_tree(records):\n    pass\n');
    await edit('c2.py', 'records', 'def build_tree(rows):');
    check('and when new_string repeats the rest of the line too, the line is replaced once', got('c2.py') === 'def build_tree(rows):\n    pass\n', { happened: JSON.stringify(got('c2.py')), why: '"def build_tree(" before and "):" after, both repeated in new_string, would otherwise leave "def build_tree(def build_tree(rows):):".', fix: 'Widen the end of the span when new_string ends with the rest of the line.' });

    // The shape poly-B2 logged most: old_string "pass", new_string the whole
    // function again, at three different indentations (poker, three tries).
    const heads = [];
    for (const nw of ['def best_hands(hands):\n    return hands[0] if hands else []', '    def best_hands(hands):\n        return hands[0] if hands else []', '        def best_hands(hands):\n            return hands[0] if hands else []']) {
      put('p.py', '\ndef best_hands(hands):\n    pass\n');
      await edit('p.py', 'pass', nw);
      heads.push(got('p.py'));
    }
    check('a new_string that restates the whole function replaces the stub, not nests inside it', heads.every((h) => h === '\ndef best_hands(hands):\n    return hands[0] if hands else []\n'), { happened: JSON.stringify(heads), why: 'Re-based on the body, the restated function parses as a def nested inside the stub, and the stub returns None: a wrong edit that looks applied, where the refusal at least told the model.', fix: 'Widen to the enclosing header when new_string starts with the same def and name.' });

    put('q.py', 'def total(basket):\n    pass\n');
    const rq = await edit('q.py', 'pass', 'def calculate_discount(basket):\n    return 0');
    check('a def that would become the body of a different function is refused, not nested', got('q.py') === 'def total(basket):\n    pass\n' && loop.editFailKind(rq) === 'would-not-parse', { happened: JSON.stringify(got('q.py')) + ' || ' + rq.slice(0, 160), why: 'book-store in poly-B2: a helper written in place of total\'s pass. Nested, it parses and total returns None; nobody meant that.', fix: 'reindentCandidates returns nothing when new_string starts with a def or class and the enclosing block is a different def.' });

    // HumanEvalFix Python/11, 2026-09-28: a helper nested in the function, restated
    // whole at column 0 in both old_string and new_string. It belongs where it was.
    put('x.py', "def string_xor(a, b):\n    def xor(i, j):\n        if i == j:\n            return '1'\n        else:\n            return '0'\n\n    return ''.join(xor(x, y) for x, y in zip(a, b))\n");
    const rx = await edit('x.py', "def xor(i, j):\n    if i == j:\n        return '1'\n    else:\n        return '0'", "def xor(i, j):\n    if i == j:\n        return '0'\n    else:\n        return '1'");
    check('a nested helper restated whole at column 0 replaces itself in place, re-indented', got('x.py') === "def string_xor(a, b):\n    def xor(i, j):\n        if i == j:\n            return '0'\n        else:\n            return '1'\n\n    return ''.join(xor(x, y) for x, y in zip(a, b))\n" && /re-indented/.test(rx),
      { happened: JSON.stringify(got('x.py')) + ' || ' + rx.slice(0, 200), why: 'The refusal meant for a def written into another function\'s body also refused a def replacing itself, and the model spent two rounds working around it.', fix: 'reindentCandidates allows a def under an enclosing def when the replaced text starts with the same header.' });

    put('m.py', 'class Tree:\n    pass\n');
    await edit('m.py', 'pass', 'def build(self):\n        return 1');
    check('while a method written in place of a class body\'s pass still lands in the class', got('m.py') === 'class Tree:\n    def build(self):\n        return 1\n', { happened: JSON.stringify(got('m.py')), why: 'A def inside a class body is a method, which is what the model meant there.', fix: 'Only an enclosing def blocks the repair.' });

    put('w.py', 'def answer(question):\n    pass\n');
    const n0 = st.editRepaired;
    const rw = await edit('w.py', 'pass', 'def answer(question):\n    pass');
    check('and a repair that would leave the file exactly as it was is not counted as applied', got('w.py') === 'def answer(question):\n    pass\n' && /^refused: /.test(rw) && st.editRepaired === n0, { happened: rw.slice(0, 160) + ' || repaired ' + n0 + '->' + st.editRepaired, why: 'wordy in poly-B2: restating the stub as it stands. Counting that as an applied edit would lift the apply rate for a change that changed nothing.', fix: 'Skip a candidate equal to the file before the edit.' });

    put('d.py', 'def f(a):\n    pass\n');
    const r4 = await edit('d.py', 'def f(a):\n  pass', '    def f(a):\n        return a');
    check('and the loose match is repaired the same way', got('d.py') === 'def f(a):\n    return a\n' && /matched with its whitespace ignored/.test(r4) && /re-indented/.test(r4), { happened: JSON.stringify(got('d.py')) + ' || ' + r4.slice(0, 200), why: 'The whitespace-ignored rung is where a model with drifting indentation lands, so it is where its new_string is most likely to be off too.', fix: 'Route the loose path through writeOrRepair as well.' });

    put('e.py', 'def g():\n    pass\n');
    const r5 = await edit('e.py', 'pass', 'return (1');
    check('a real syntax error is still refused, with the numbered lines it would have made', got('e.py') === 'def g():\n    pass\n' && loop.editFailKind(r5) === 'would-not-parse' && /Around line \d+ the edit would have made it read:\n\d+\t/.test(r5), { happened: r5.slice(0, 400), why: 'The repair only moves indentation; a broken expression must not land, and the model needs to see what it would have made to fix it.', fix: 'Keep the refusal when no candidate parses, and add aroundError to it.' });

    put('f.py', 'def h():\n    pass\n');
    const r6 = await edit('f.py', 'pass', '# todo');
    check('a function body left as only a comment is still refused', got('f.py') === 'def h():\n    pass\n' && loop.editFailKind(r6) === 'would-not-parse', { happened: r6.slice(0, 200), why: 'No indentation makes an empty body parse; a candidate that changed nothing but whitespace must not be reported as a repair.', fix: 'reindentCandidates skips a candidate equal to the plain edit.' });

    put('g.py', 'x = foo(1)\n');
    const r7 = await edit('g.py', 'foo(1)', 'foo(\n1');
    check('a mid-line edit is never widened to its line', got('g.py') === 'x = foo(1)\n' && loop.editFailKind(r7) === 'would-not-parse' && st.editRepaired === 9, { happened: r7.slice(0, 200) + ' || repaired=' + st.editRepaired, why: 'With code before the match that new_string does not repeat, there is no line to re-base on, and widening would delete that code.', fix: 'reindentCandidates returns nothing when the prefix is code new_string does not start with.' });

    put('h.py', 'def k():\r\n    pass\r\n\r\nk()\r\n');
    await edit('h.py', 'pass', '    a = 1\r\n    return a');
    check('a CRLF file stays CRLF through a repair', got('h.py') === 'def k():\r\n    a = 1\r\n    return a\r\n\r\nk()\r\n', { happened: JSON.stringify(got('h.py')), why: 'A repaired edit that wrote bare newlines into a CRLF file would be a whole-file diff for a two-line change.', fix: 'Join candidate lines with the file\'s own line ending.' });

    const ev = await import('../lib/eval.mjs');
    const rtext = ev.format({ results: [{ name: 'a', pass: false, why: 'the check exited 1', rounds: 2, ms: 10 }], passed: 0, total: 1, ms: 10, editTries: 5, editFails: 1, editWhy: { 'would-not-parse': 1 }, editRepaired: 2 });
    check('and a report says how many edits applied only after re-indentation', /applied only after re-indentation: 2 \(counted as applied\)/.test(rtext), { happened: rtext.split(NL).filter((l) => /edits:|why:|re-indent/.test(l)).join(' | '), why: 'A repair that lifts the apply rate has to say how much of the rate it is, or an A/B cannot tell the model editing better from the harness fixing its edits.', fix: 'Check the edits lines of format in lib/eval.mjs and editRepaired in runTask and runSuite.' });

    check('and it is exported for the suite to reason about', typeof loop.reindentCandidates === 'function' && loop.reindentCandidates('x = 1\n', 4, 5, '2\n3').length === 0, { happened: String(typeof loop.reindentCandidates), why: 'The candidates are the whole policy; a caller that cannot see them cannot test it.', fix: 'Export reindentCandidates.' });
  });

  // A rule the user gave is the one thing a compaction must not lose.
  await asyncSuite('standing rule expert', 'a rule survives the cut that drops everything else', async () => {
    const st = { cwd: W, messages: [], pinned: [] };
    loop.pinRules(st, 'Have a look at the parser. Never edit anything under vendor/. It is generated.');
    loop.pinRules(st, 'Also make sure the tests run before you answer.');
    check('a rule is picked out of what the user said', st.pinned.length === 2 && /Never edit anything under vendor/.test(st.pinned[0]) && /tests run before you answer/.test(st.pinned[1]), { happened: JSON.stringify(st.pinned), why: 'Rule violations were measured at none while the rule survived a compaction and nearly four in ten once it was dropped, so which sentences get kept is the whole mechanism.', fix: 'Check RULE_RE and the sentence split in pinRules.' });
    check('and ordinary prose is not pinned', loop.pinRules({ pinned: [] }, 'Have a look at the parser and tell me what it does.').length === 0, { happened: JSON.stringify(loop.pinRules({ pinned: [] }, 'Have a look at the parser and tell me what it does.')), why: 'Pinning every sentence would put the whole conversation back into the context that was just trimmed, which is the opposite of the point.', fix: 'Keep RULE_RE to the words that actually mark an instruction.' });
    loop.pinRules(st, 'Never edit anything under vendor/.');
    check('and the same rule twice is one rule', st.pinned.length === 2, { happened: JSON.stringify(st.pinned), why: 'A repeated instruction is common and must not crowd out the others.', fix: 'Compare normalised text before pushing.' });
    const many = { pinned: [] };
    for (let i = 0; i < loop.MAX_PINNED + 5; i++) loop.pinRules(many, `Never touch file-${i}.js.`);
    check('the list is capped and keeps the newest', many.pinned.length === loop.MAX_PINNED && new RegExp(`file-${loop.MAX_PINNED + 5 - loop.MAX_PINNED}\\.js`).test(many.pinned[0]) && new RegExp(`file-${loop.MAX_PINNED + 4}\\.js`).test(many.pinned[many.pinned.length - 1]), { happened: `${many.pinned.length} pinned, first=${many.pinned[0]}, last=${many.pinned[many.pinned.length - 1]}`, why: 'An unbounded pin list becomes the context problem it was meant to solve, and a rule given twenty instructions ago has usually been overtaken.', fix: 'Check MAX_PINNED and the shift in pinRules.' });

    const full = { cwd: W, messages: [{ role: 'system', content: 'sys' }], todo: [], edited: new Set(), pinned: [] };
    loop.pinRules(full, 'Never edit anything under vendor/.');
    for (let i = 0; i < 24; i++) full.messages.push({ role: i % 2 ? 'assistant' : 'user', content: `message ${i}` });
    const said = loop.compact(full, 4);
    const note = full.messages[1].content;
    check('the compaction note carries the rule the dropped messages held', /Never edit anything under vendor/.test(note) && /standing instruction/.test(said), { happened: `${said} || ${note.slice(0, 160)}`, why: 'This is the measured fix: the rule that survives the summary is obeyed, the rule that is dropped is not, and pinning took violations back to none.', fix: 'Check the rules block in compact.' });
    check('and a run with no rules says nothing about them', !/standing instruction/.test(loop.compact({ cwd: W, messages: [{ role: 'system', content: 'sys' }, ...Array.from({ length: 24 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }))], todo: [], edited: new Set() }, 4)), { happened: 'the note spoke about standing instructions when there were none', why: 'Boilerplate that is always there stops being read.', fix: 'Only add the block when something is pinned.' });
  });
}

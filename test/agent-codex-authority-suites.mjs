// The normal harness's codex wrapper with flags.authorityLedger: what codex is
// sent for the session's exact requests, selected skills and gate notes, and
// proof that with the flag off the prompt is the same string it always was.
// codex is faked through the deps.run injection point, so no codex CLI runs
// and no model is called. Loaded by test/run.mjs, which owns suite(),
// asyncSuite() and check().
import * as authority from '../lib/authority.mjs';

export default async function agentCodexAuthoritySuites({ suite, asyncSuite, check, core, agentMod, TMP, fs, path }) {
  const NL = String.fromCharCode(10);
  const CR = String.fromCharCode(13);
  const ELLIPSIS = String.fromCharCode(0x2026);
  const KEY = 'ATLIAS_FLAG_AUTHORITY_LEDGER';
  const W = path.join(TMP, 'codex-authority-work');
  fs.mkdirSync(W, { recursive: true });
  const work = (name) => { const d = path.join(W, name); fs.mkdirSync(d, { recursive: true }); return d; };

  // Runs fn with the flag set on or off, and puts the environment back after.
  async function withFlag(on, fn) {
    const before = process.env[KEY];
    if (on) process.env[KEY] = '1'; else delete process.env[KEY];
    try { return await fn(); } finally { if (before === undefined) delete process.env[KEY]; else process.env[KEY] = before; }
  }
  // A codex stand-in: records every prompt it is given, answers from a script.
  function fakeCodex(seen, replies = [], onCall = null) {
    return (cmd, args, input, cwd) => {
      seen.push({ cmd, args: [...args], input: String(input), cwd });
      if (onCall) onCall(seen.length);
      return { status: 0, stdout: replies.length ? replies.shift() : 'noted', stderr: '', error: undefined };
    };
  }
  // The clip the old wrapper applied: 1200 characters, the last one a mark.
  const oldClip = (s, n) => (s.length > n ? s.slice(0, n - 1) + ELLIPSIS : s);

  await asyncSuite('codex authority expert', 'codex authority: a saved and resumed codex session is not marked incomplete', async () => {
    await withFlag(true, async () => {
      const st = agentMod.newState(work('resume-complete'), 'codex');
      authority.record(st.sid, 'first exact request');
      agentMod.saveChat(st);
      const saved = JSON.parse(fs.readFileSync(agentMod.chatPath(st.sid), 'utf8'));
      check('flag on: saving a codex session whose requests are in the ledger does not mark authority missing', saved.authorityMissing === false, {
        happened: 'authorityMissing ' + saved.authorityMissing,
        why: 'codex never fills state.asks; marking it missing made every resumed codex turn claim its exact history was incomplete.',
        fix: 'In saveChat, do not treat absent state.asks as missing authority for the codex engine.' });
      const loop = agentMod.newState(work('resume-loop'), 'ollama');
      agentMod.saveChat(loop);
      const savedLoop = JSON.parse(fs.readFileSync(agentMod.chatPath(loop.sid), 'utf8'));
      check('flag on: a loop session with no recorded asks is still marked missing', savedLoop.authorityMissing === true, {
        happened: 'authorityMissing ' + savedLoop.authorityMissing,
        why: 'The loop engines carry exact requests in state.asks; without them the saved authority is incomplete.',
        fix: 'Keep the missing-asks rule for every engine except codex.' });
    });
  });

  await asyncSuite('codex authority expert', 'codex authority: flag off sends the exact old prompt and never touches the ledger', async () => {
    await withFlag(false, async () => {
      const st = agentMod.newState(work('off-exact'), 'codex');
      // A ledger that cannot be parsed. Flag off must neither read it nor fail.
      fs.writeFileSync(authority.ledgerPath(st.sid), '{not json');
      const long = 'turn three ' + 'L'.repeat(1500);
      st.history.push({ role: 'user', text: 'turn one' }, { role: 'assistant', text: 'answer one' },
        { role: 'user', text: 'turn two' }, { role: 'assistant', text: 'answer two' },
        { role: 'user', text: long }, { role: 'assistant', text: 'answer three' },
        { role: 'user', text: 'turn four' }, { role: 'assistant', text: 'answer four' });
      const seen = [];
      const reply = agentMod.codexTurn(st, 'NEW REQUEST', { run: fakeCodex(seen) });
      const expected = ['Earlier in this session:',
        'User: ' + oldClip('turn two', 1200), 'Assistant: answer two',
        'User: ' + oldClip(long, 1200), 'Assistant: answer three',
        'User: turn four', 'Assistant: answer four', '',
        'Now the user says:', 'NEW REQUEST'].join(NL);
      check('flag off: the prompt codex receives is byte-for-byte the old string (last six turns, each clipped to 1200 characters)', seen.length === 1 && seen[0].input === expected, {
        happened: seen.length ? JSON.stringify(seen[0].input.slice(0, 300)) : 'codex was never called',
        why: 'The default must not change: stored runs and the golden comparisons are only valid while the prompt is the same string.',
        fix: 'Restore the old history line and the "Earlier in this session" / "Now the user says:" wrapper in codexTurn when the flag is off.' });
      check('flag off: codex is called with the old arguments, and the ledger is neither rewritten nor read', seen.length === 1 && seen[0].args.join(' ') === 'exec -' && seen[0].cwd === st.cwd && reply === 'noted'
        && fs.readFileSync(authority.ledgerPath(st.sid), 'utf8') === '{not json', {
        happened: JSON.stringify(seen.map((s) => s.args)) + ' reply ' + reply,
        why: 'With the flag off, the exact ledger must not be a dependency of any codex call.',
        fix: 'Read the ledger only when flags.authorityLedger is on.' });
      const empty = agentMod.newState(work('off-empty'), 'codex');
      const seenEmpty = [];
      agentMod.codexTurn(empty, 'ONLY THE REQUEST', { run: fakeCodex(seenEmpty) });
      check('flag off with no history: the prompt is the request alone', seenEmpty.length === 1 && seenEmpty[0].input === 'ONLY THE REQUEST', {
        happened: seenEmpty.length ? JSON.stringify(seenEmpty[0].input) : 'codex was never called',
        why: 'A first turn must not gain any header when the flag is off.',
        fix: 'Keep the bare prompt when there is no history and the flag is off.' });
    });
  });

  await asyncSuite('codex authority expert', 'codex authority: flag on carries every request verbatim, in order, never clipped', async () => {
    await withFlag(true, async () => {
      const st = agentMod.newState(work('on-requests'), 'codex');
      const body = 'the quick brown fox jumps over the lazy dog. '.repeat(120);
      const long = ('LONGSTART ' + body).slice(0, 4992) + ' LONGEND';
      const requests = [
        'Build the config parser. ORIGINAL_REQUEST_MARK: keep the public API stable.',
        'Also keep the error messages exact and in English.',
        'MIDDLE_FOLLOW_UP_MARK: keep the old flag names, even the misspelled ones.',
        'Use CRLF line endings.' + CR + NL + 'Do not touch the tests folder.' + CR + NL,
        'Keep these labels exactly: Resume, cafe, na\u00efve, \u6771\u4eac, \u03a9mega (Unicode, not ASCII).',
        long,
        'Seventh follow-up, after the long one.',
        'Eighth follow-up, short.',
        'FINAL_REQUEST_MARK: now summarise what changed.',
      ];
      check('the long follow-up is at least 5000 characters', long.length >= 5000, { happened: long.length + ' characters', why: 'The test must exercise a follow-up past the 1200-character clip.', fix: 'Lengthen the fixture.' });
      const seen = [];
      for (const text of requests) await agentMod.turn(st, text, null, null, { run: fakeCodex(seen) });
      const last = seen[seen.length - 1].input;
      const ledger = authority.read(st.sid).filter((r) => r.kind === 'request').map((r) => r.text);
      check('the ledger holds every request exactly, in order, one row each', JSON.stringify(ledger) === JSON.stringify(requests), {
        happened: `${ledger.length} rows against ${requests.length} requests`,
        why: 'The prompt can only be exact if the ledger it is built from is exact.',
        fix: 'Check authority.record and the router call in turn().' });
      const missing = requests.filter((t) => !last.includes(t));
      check('every request of the session is in the last prompt, verbatim, including the 5000-character one, the CRLF one and the Unicode one', missing.length === 0, {
        happened: missing.length ? 'missing: ' + missing.map((t) => JSON.stringify(t.slice(0, 40))).join('; ') : 'all present',
        why: 'Codex is one shot: a request left out is a request the model never sees. In the old wrapper only six turns survived, each clipped to 1200 characters.',
        fix: 'Build the exact block from every request row in codexTurn; never clip it.' });
      const at = requests.map((t) => last.indexOf(t));
      check('the requests appear in the order the user made them', at.every((p, i) => p >= 0 && (i === 0 || p > at[i - 1])), {
        happened: JSON.stringify(at),
        why: 'Later amendments govern earlier requests; reordering them changes what was asked.',
        fix: 'Keep ledger order in the exact block.' });
      check('the request count is stated', last.includes('User request 1 of 9:') && last.includes('User request 9 of 9:'), {
        happened: 'count line missing', why: 'The model is told how many requests exist, so a missing one shows.', fix: 'Number the rows in exactAuthorityText.' });
      const cut = Array.from({ length: 25 }, (_, i) => 'Numbered request ' + (i + 1) + ' keeps its exact wording.');
      const many = agentMod.newState(work('on-many'), 'codex');
      for (const text of cut) authority.record(many.sid, text);
      const seenMany = [];
      agentMod.codexTurn(many, 'NOW', { run: fakeCodex(seenMany) });
      check('no request cap applies: 25 requests all reach codex, including the ones the old 20-request ledger dropped', seenMany.length === 1 && cut.every((t) => seenMany[0].input.includes(t)), {
        happened: 'missing: ' + cut.filter((t) => !(seenMany[0] && seenMany[0].input.includes(t))).slice(0, 3).join(' | '),
        why: 'Codex found the middle follow-ups dropped above 20 requests (audit F3). Dropping them loses requirements.',
        fix: 'Do not cap authority rows in codexTurn.' });
    });
  });

  await asyncSuite('codex authority expert', 'codex authority: flag on carries the exact text of every selected skill', async () => {
    await withFlag(true, async () => {
      const cwd = work('on-skill');
      const dir = path.join(cwd, '.claude', 'skills', 'exactskill');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'SKILL.md');
      const bodyText = '---' + NL + 'name: exactskill' + NL + 'description: a test skill' + NL + '---' + NL + 'SKILL_MARK: always write CRLF.' + CR + NL + 'Keep the Unicode: Omega \u03a9, cafe, \u6771\u4eac.' + NL + 'Final rule: never clip this body.' + NL;
      fs.writeFileSync(file, bodyText);
      const st = agentMod.newState(cwd, 'codex');
      const seen = [];
      await agentMod.turn(st, 'Use $exactskill to fix the parser.', null, null, { run: fakeCodex(seen) });
      const input = seen.length ? seen[0].input : '';
      const rows = authority.read(st.sid).filter((r) => r.kind === 'skill');
      check('the selected skill is recorded in the ledger with its exact text', rows.length === 1 && rows[0].text === bodyText, {
        happened: `${rows.length} skill rows`, why: 'Selection goes through router.prompt and authority.selected; a skill the prompt names must be found.', fix: 'Check authority.selected for the cwd skill folder.' });
      check('the skill body reaches codex verbatim, with its CRLF and Unicode, under its own heading', input.includes(bodyText) && input.includes('Selected skill 1 of 1 (' + file + '):' + NL + bodyText), {
        happened: input.includes(bodyText) ? 'body present, heading not in the expected form' : 'body absent from the prompt',
        why: 'A skill selected by name must act as written; a summary or a clipped copy changes what it asks for.',
        fix: 'Render every skill row in exactAuthorityText with its full text.' });
    });
  });

  await asyncSuite('codex authority expert', 'codex authority: a gate re-prompt is labelled as Atlias-generated and is never a user request', async () => {
    // The first codex answer claims a pass while a check ran and failed in this
    // turn, so the gate holds it and re-prompts codex with its own reason.
    const gateRun = async (on) => withFlag(on, async () => {
      const st = agentMod.newState(work(on ? 'gate-on' : 'gate-off'), 'codex');
      const seen = [];
      const replies = ['All tests pass now; the bug is fixed.', 'Correction: the check failed, so it is not fixed.'];
      const reply = await agentMod.turn(st, 'Fix the widget parser now.', null, null, {
        run: fakeCodex(seen, replies, (n) => { if (n === 1) core.recordEvent(st.sid, { kind: 'shell', command: 'node --check parser.mjs', verify: true, outcome: 'fail', excerpt: 'SyntaxError: Unexpected token' }); }),
      });
      return { st, seen, reply };
    });

    const on = await gateRun(true);
    check('the gate holds the first answer in the flag-on run (precondition for the rest)', on.seen.length === 2 && on.reply.includes('[atlias held the answer above:'), {
      happened: `${on.seen.length} codex calls; reply starts ${JSON.stringify(on.reply.slice(0, 60))}`,
      why: 'Without a held answer there is no re-prompt to label, so nothing below would test anything.',
      fix: 'Replay the failing check and the pass claim as the held-answer test does.' });
    const gateText = on.st.history[2] ? on.st.history[2].text : '';
    check('flag on: the gate text is recorded under its own role, not as a user line', on.st.history[2] && on.st.history[2].role === 'gate' && gateText.length > 0 && on.st.history[0].role === 'user', {
      happened: JSON.stringify(on.st.history.map((h) => h.role)), why: 'Role decides how the line is read later; a gate line marked user reads as the user having said it.', fix: 'Push the gate reason with role gate under flags.authorityLedger.' });
    const second = on.seen.length > 1 ? on.seen[1].input : '';
    const beforeRecent = second.split('Earlier in this session')[0];
    check('flag on: codex is told the re-prompt was generated by Atlias, not by the user', second.includes('Now Atlias says (generated by Atlias, not by the user') && !second.includes('Now the user says:' + NL + gateText), {
      happened: second.slice(second.indexOf('Now '), second.indexOf('Now ') + 120),
      why: 'Codex read the gate text as an instruction from the user in the live runs; the label is what keeps it from being obeyed as one.',
      fix: 'Pass generated gate to codexTurn and use the Atlias label in the current-request line.' });
    check('flag on: the gate text is not in the exact authority section, and it is not a request row', gateText.length > 0 && !beforeRecent.includes(gateText) && !beforeRecent.includes(gateText.split(NL)[0]) && authority.read(on.st.sid).filter((r) => r.kind === 'request').map((r) => r.text).join('|') === 'Fix the widget parser now.', {
      happened: 'requests: ' + JSON.stringify(authority.read(on.st.sid).filter((r) => r.kind === 'request').map((r) => r.text.slice(0, 50))),
      why: 'The user requests are the only exact authority. A generated line recorded as one is a fabricated instruction.',
      fix: 'Keep gate text out of authority.record; do not record generated prompts.' });

    const off = await gateRun(false);
    const gateOff = off.st.history[2] ? off.st.history[2].text : '';
    check('flag off: the gate text is recorded as a user line and the second prompt is the old string', off.seen.length === 2 && off.st.history[2].role === 'user' && off.seen[1].input === 'Earlier in this session:' + NL + 'User: Fix the widget parser now.' + NL + 'Assistant: All tests pass now; the bug is fixed.' + NL + NL + 'Now the user says:' + NL + gateOff, {
      happened: off.seen.length > 1 ? JSON.stringify(off.seen[1].input.slice(0, 200)) : 'no second call',
      why: 'Off is today: stored baselines count these exact bytes. The flag is the only switch that may change them.',
      fix: 'Keep the user role and the old wrapper when the flag is off.' });
  });

  await asyncSuite('codex authority expert', 'codex authority: missing or unreadable authority is said in one explicit line', async () => {
    await withFlag(true, async () => {
      const st = agentMod.newState(work('turn-lost-ledger'), 'codex'), seen = [];
      const original = 'Original ' + 'preserve '.repeat(250) + 'TURN_AUTHORITY_TAIL';
      await agentMod.turn(st, original, null, null, { run: fakeCodex(seen) });
      fs.unlinkSync(authority.ledgerPath(st.sid));
      await agentMod.turn(st, 'Follow-up after loss.', null, null, { run: fakeCodex(seen) });
      check('normal turn detects ledger loss before recording the next follow-up', seen[0].input.includes('TURN_AUTHORITY_TAIL') && seen[1].input.includes('exact request history is incomplete') && !seen[1].input.includes('the exact requests above are complete') && st.authorityMissing === true, {
        happened: seen[1].input.slice(0, 200), why: 'The router can recreate a missing ledger with only the newest request; that cannot restore the original.', fix: 'Inspect existing authority before router.prompt and retain the missing marker.' });
      agentMod.saveChat(st);
      check('the detected missing-authority marker survives save and resume', agentMod.loadChat(st.sid, st.cwd).authorityMissing === true, {
        happened: 'saved incomplete state', why: 'A restart must not qualify the recreated one-row ledger as complete.', fix: 'Keep authorityMissing in saved exact state.' });
    });
    await withFlag(true, async () => {
      const file = path.join(process.env.ATLIAS_HOME, 'config.json');
      const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
      try {
        fs.writeFileSync(file, JSON.stringify({ agent: { hostEngines: 'on' }, localPipeline: { enabled: true, planner: true, reporter: true, baseUrl: 'http://127.0.0.1:18999/v1', model: 'fixture' } }));
        const st = agentMod.newState(work('incomplete-helpers'), 'codex'), seen = [];
        authority.record(st.sid, 'Only the retained follow-up.'); st.authorityMissing = true;
        let calls = 0;
        await agentMod.turn(st, 'Next.', null, null, { run: fakeCodex(seen), fetchImpl: async () => { calls++; throw Error('incomplete authority must not reach a helper'); } });
        check('known incomplete authority refuses both optional helpers before any request', calls === 0 && seen.length === 1 && seen[0].input.includes('exact request history is incomplete'), {
          happened: calls + ' helper calls', why: 'A helper must receive every original instruction; a plausible partial packet is insufficient.', fix: 'Skip planner and reporter when the normal session marks authority missing.' });
      } finally { if (before === null) fs.unlinkSync(file); else fs.writeFileSync(file, before); }
    });
    await withFlag(true, async () => {
      const st = agentMod.newState(work('lost-ledger'), 'codex');
      const original = 'Original ' + 'exact '.repeat(300) + 'AUTHORITY_TAIL_SENTINEL';
      authority.record(st.sid, original);
      st.history.push({ role: 'user', text: original }, { role: 'assistant', text: 'noted' });
      fs.unlinkSync(authority.ledgerPath(st.sid));
      const seen = [];
      agentMod.codexTurn(st, 'Next.', { run: fakeCodex(seen) });
      const input = seen[0]?.input || '';
      check('a lost ledger never calls clipped recent history complete', seen.length === 1 && input.includes('exact request history is incomplete') && !input.includes('exact requests above are complete') && !input.includes('AUTHORITY_TAIL_SENTINEL'), {
        happened: input.slice(0, 200), why: 'A missing file returns no rows, which cannot certify retained instructions.', fix: 'Require at least one retained request before claiming complete history.' });
      fs.writeFileSync(authority.ledgerPath(st.sid), '[]');
      const empty = [];
      agentMod.codexTurn(st, 'Next.', { run: fakeCodex(empty) });
      check('an empty ledger also reports missing authority instead of an exact-history claim', empty[0].input.includes('no request rows are available') && !empty[0].input.includes('exact requests above are complete'), {
        happened: empty[0].input.slice(0, 200), why: 'A valid JSON array can still contain none of the required instruction history.', fix: 'Treat absent request rows as incomplete, whether the file is absent or empty.' });
    });
    await withFlag(true, async () => {
      const st = agentMod.newState(work('missing-state'), 'codex');
      authority.record(st.sid, 'The only recorded request.');
      st.authorityMissing = true;
      st.history.push({ role: 'user', text: 'The only recorded request.' }, { role: 'assistant', text: 'noted' });
      const seen = [];
      agentMod.codexTurn(st, 'Next.', { run: fakeCodex(seen) });
      const input = seen.length ? seen[0].input : '';
      const lines = input.split(NL).filter((l) => l.includes('exact request history is incomplete'));
      check('a state that marks history missing says so in exactly one line, and still lists the exact requests it has', lines.length === 1 && input.includes('The only recorded request.') && !input.includes('exact requests above are complete'), {
        happened: `${lines.length} incomplete lines; complete claim ${input.includes('exact requests above are complete')}`,
        why: 'An incomplete history must not look complete; one line names the gap without hiding the exact requests that are known.',
        fix: 'Write the incomplete line from exactAuthorityText when state.authorityMissing is set.' });
    });
    await withFlag(true, async () => {
      const st = agentMod.newState(work('unreadable'), 'codex');
      fs.writeFileSync(authority.ledgerPath(st.sid), '{not json');
      const seen = [];
      const reply = agentMod.codexTurn(st, 'Next.', { run: fakeCodex(seen) });
      const input = seen.length ? seen[0].input : '';
      const lines = input.split(NL).filter((l) => l.includes('exact request authority is unavailable'));
      check('an unreadable ledger is said in one explicit line; codex still runs once and no request is invented', lines.length === 1 && seen.length === 1 && reply === 'noted' && !input.includes('Every request of this session') && input.endsWith('Now the user says:' + NL + 'Next.'), {
        happened: `${lines.length} unavailable lines; ${seen.length} calls; reply ${reply}`,
        why: 'Silent fallback to recent turns would look like full authority. The model has to be told what it lacks.',
        fix: 'Catch the authority.read error in exactAuthorityText and return the explicit line.' });
    });
    await withFlag(true, async () => {
      const st = agentMod.newState(work('clean'), 'codex');
      authority.record(st.sid, 'A clean request.');
      st.history.push({ role: 'user', text: 'A clean request.' }, { role: 'assistant', text: 'noted' });
      const seen = [];
      agentMod.codexTurn(st, 'Next.', { run: fakeCodex(seen) });
      const input = seen.length ? seen[0].input : '';
      check('a complete, readable ledger adds no missing or unavailable line, and says the requests above are complete', seen.length === 1 && !/is unavailable|is incomplete/.test(input) && input.includes('A clean request.') && input.includes('exact requests above are complete'), {
        happened: JSON.stringify(input.slice(0, 160)),
        why: 'A warning that always appears is one the model learns to ignore.',
        fix: 'Only write the missing or unavailable lines when they are true.' });
    });
  });

  await asyncSuite('codex authority expert', 'codex authority: a /review prompt is Atlias-generated and never a user request (lane P3 finding F4)', async () => {
    const reviewText = 'Review the uncommitted changes below as a reviewer.' + NL + 'diff --git a/x b/x';
    const on = await withFlag(true, async () => {
      const st = agentMod.newState(work('review-on'), 'codex');
      const seen = [];
      await agentMod.turn(st, 'Fix the widget parser now.', null, null, { run: fakeCodex(seen) });
      await agentMod.turn(st, reviewText, null, null, { run: fakeCodex(seen), generated: 'review' });
      return { st, seen, requests: authority.read(st.sid).filter((r) => r.kind === 'request').map((r) => r.text) };
    });
    check('flag on: the review prompt is not recorded as a request; the person\'s request still is', JSON.stringify(on.requests) === JSON.stringify(['Fix the widget parser now.']), {
      happened: JSON.stringify(on.requests.map((t) => t.slice(0, 50))), why: 'A generated prompt recorded as the user\'s request becomes authority the planner and codex obey.', fix: 'Pass atlias_generated to router.prompt and skip authority.record for it.' });
    const second = on.seen.length > 1 ? on.seen[1].input : '';
    check('flag on: codex is told the review prompt was generated by Atlias, and the history keeps it under role review', second.includes('Now Atlias asks for a review (generated by Atlias') && !second.includes('Now the user says:' + NL + reviewText) && on.st.history[2] && on.st.history[2].role === 'review', {
      happened: second.slice(second.lastIndexOf('Now '), second.lastIndexOf('Now ') + 100) + ' / ' + JSON.stringify(on.st.history.map((h) => h.role)),
      why: 'The label is what keeps codex from reading Atlias\'s own text as the user\'s instruction.', fix: 'Use REVIEW_NOW and push role review under the flag.' });
    const off = await withFlag(false, async () => {
      const st = agentMod.newState(work('review-off'), 'codex');
      const seen = [];
      await agentMod.turn(st, reviewText, null, null, { run: fakeCodex(seen), generated: 'review' });
      return { st, seen };
    });
    check('flag off: a review turn is the old user turn, byte for byte', off.seen[0] && off.seen[0].input === reviewText && off.st.history[0].role === 'user', {
      happened: JSON.stringify(off.seen[0] && off.seen[0].input.slice(0, 80)), why: 'Off must be the old behaviour.', fix: 'Ignore deps.generated unless flags.authorityLedger is on.' });
  });
}

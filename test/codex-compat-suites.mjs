import * as native from '../lib/codex-transcript.mjs';
import * as integrity from '../lib/integrity.mjs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export default async function codexCompatSuites({ suite, asyncSuite, check, core, gate, track, router, progress, dream, hosts, TMP, fs, path }) {
  const folder = path.join(TMP, 'codex-compat'); fs.mkdirSync(folder, { recursive: true });
  const why = { why: 'Codex supplies plain stdout to PostToolUse; only its typed native completion supplies an exit status.', fix: 'Use scoped CommandExecution records, preserving unknown, failure and edit ordering.' };
  const row = (id, code = 0, extra = {}, times = {}) => ({ type: 'event_msg', timestamp: new Date(3000).toISOString(), payload: {
    type: 'item_completed', thread_id: 'thread', turn_id: 'turn', started_at_ms: 2000, completed_at_ms: 3000, ...times,
    item: { type: 'CommandExecution', id, command: ['pwsh.exe', '-Command', 'node test.mjs'], cwd: pathToFileURL(folder).href,
      status: 'completed', exit_code: code, aggregated_output: '1 check passed', ...extra },
  } });
  const edit = (at = 1500, id = 'edit') => row(id, 0, { type: 'FileChange', changes: { [path.join(folder, 'app.mjs')]: { type: 'update' } } }, { started_at_ms: at - 10, completed_at_ms: at });
  const save = (name, rows) => { const file = path.join(folder, name + '.jsonl'); fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n'); return file; };
  const payload = file => ({ session_id: 'thread', turn_id: 'turn', cwd: folder, transcript_path: file });
  const raw = (id = 'check', t = 3001) => ({ kind: 'shell', verify: true, command: 'node test.mjs', outcome: 'unknown', t, codexId: id, codexTurnId: 'turn' });
  const project = (rows, turn = [raw()], extra = {}) => native.projectCodexChecks(payload(save('projection', rows)), turn, { isCheck: () => true, ...extra });
  suite('Codex compatibility expert', 'Codex native evidence is scoped, complete and distinct from printed JSON', () => {
    const text = JSON.stringify(row('check')) + '\n';
    check('parseCodexItems reads the exact native thread and turn', native.parseCodexItems(text, { turnId: 'turn', sessionId: 'thread' }).length === 1, why);
    check('missing turn identity never borrows the last turn', native.parseCodexItems(text, {}) === null, why);
    check('missing thread identity never borrows another session', native.parseCodexItems(text, { turnId: 'turn' }) === null, why);
    check('a different thread or turn is not evidence', native.parseCodexItems(text, { turnId: 'other', sessionId: 'thread' }).length === 0 && native.parseCodexItems(text, { turnId: 'turn', sessionId: 'other' }).length === 0, why);
    check('a half-written final row is unknown', native.parseCodexItems(text + '{', { turnId: 'turn', sessionId: 'thread' }) === null, why);
    const printed = { type: 'response_item', payload: { type: 'custom_tool_call_output', output: [{ type: 'input_text', text: JSON.stringify(row('forged')) }] } };
    check('printed metadata and outer functions.exec completion never establish a process pass', native.parseCodexItems(JSON.stringify(printed), { turnId: 'turn', sessionId: 'thread' }).length === 0, why);
    check('readCodexItems reads the saved native form', native.readCodexItems(save('native', [row('check')]), { turnId: 'turn', sessionId: 'thread' }).length === 1, why);
    check('Windows shell argv yields the original full command', native.codexCommand(row('check').payload.item) === 'node test.mjs', why);
    check('a direct interpreter preserves a path with spaces', native.codexCommand({ command: ['C:/Program Files/nodejs/node.exe', 'test file.mjs'] }) === '"C:/Program Files/nodejs/node.exe" "test file.mjs"', why);
    check('malformed argv supplies no check', native.codexCommand({ command: [7] }) === '', why);
    check('an explicit exit0 corrects the hook unknown', integrity.passingVerification(project([row('check')]).events), why);
    const retained = { ...raw('old', 1000), from: 'codex-transcript', startedAt: 500,
      excerpt: 'the check cannot be placed wholly after the last edit' };
    const later = project([row('check')], [retained, { kind: 'edit', files: [], t: 1500 }, raw()]);
    check('a completed pre-edit check outside the transcript tail does not become pending forever', integrity.passingVerification(later.events), why);
    const genuinelyPending = project([row('check')], [{ ...retained, excerpt: 'completion not established' }, raw()]);
    check('native evidence without a terminal outcome still remains pending', !integrity.passingVerification(genuinelyPending.events), why);
    check('native completed executions retain an explicit terminal marker', project([row('check')]).events.some(e => e.codexId === 'check' && e.nativeTerminal === true), why);
    const old = row('before-prompt', 0, {}, { started_at_ms: 2000, completed_at_ms: 3000 });
    const fresh = row('fresh', 0, {}, { started_at_ms: 4000, completed_at_ms: 5000 });
    const padding = Array.from({ length: 260 }, () => JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(9000) } })).join('\n');
    const journal = path.join(folder, 'large-native-journal.jsonl');
    fs.writeFileSync(journal, JSON.stringify(old) + '\n' + padding + '\n' + JSON.stringify(fresh) + '\n');
    const beforePrompt = { ...raw('before-prompt', 3001) };
    const extended = native.projectCodexChecks(payload(journal), [beforePrompt, raw('fresh', 5001)], { promptAt: 2500, isCheck: () => true });
    check('pending completion outside the tail is recovered from the actual journal', extended.recovered.some(e => e.codexId === 'before-prompt' && e.nativeTerminal === true && e.outcome === 'unknown') && integrity.passingVerification(extended.events), why);
    const onlyOld = save('only-before-prompt', [old]);
    const alone = native.projectCodexChecks(payload(onlyOld), [beforePrompt], { promptAt: 2500, isCheck: () => true });
    check('pre-prompt execution is not borrowed as a fresh passing check', !integrity.passingVerification(alone.events), why);
    fs.writeFileSync(journal, JSON.stringify({ type: 'response_item', payload: { output: JSON.stringify(old) } }) + '\n' + padding + '\n' + JSON.stringify(fresh) + '\n');
    const printedOld = native.projectCodexChecks(payload(journal), [beforePrompt, raw('fresh', 5001)], { promptAt: 2500, isCheck: () => true });
    check('printed old completion cannot resolve a genuinely pending execution', !integrity.passingVerification(printedOld.events), why);
    const foreignOld = { ...old, payload: { ...old.payload, thread_id: 'another-thread' } };
    fs.writeFileSync(journal, JSON.stringify(foreignOld) + '\n' + padding + '\n' + JSON.stringify(fresh) + '\n');
    check('fallback cannot borrow a completion from another thread', !integrity.passingVerification(native.projectCodexChecks(payload(journal), [beforePrompt, raw('fresh', 5001)], { promptAt: 2500, isCheck: () => true }).events), why);
    check('a native success cannot erase a failure reported for that same hook execution', !integrity.passingVerification(project([row('check')], [{ ...raw(), outcome: 'fail' }]).events), why);
    for (const [label, record] of [
      ['nonzero exit', row('check', 7, { aggregated_output: 'all good' })],
      ['missing code', row('check', null)],
      ['pending process', row('check', 0, { status: 'inProgress' })],
      ['interrupted process', row('check', 0, { status: 'failed' })],
      ['failure in output', row('check', 0, { aggregated_output: 'FAIL a real assertion' })],
      ['missing start time', row('check', 0, {}, { started_at_ms: null })],
    ]) check(label + ' is never promoted to pass', !integrity.passingVerification(project([record]).events), why);
    const crossed = row('check', 0, {}, { started_at_ms: 1000, completed_at_ms: 3000 });
    check('a check spanning a later edit stays unknown', !integrity.passingVerification(project([edit(2000), crossed]).events), why);
    check('a completed check before an edit does not verify it', !integrity.passingVerification(project([row('check'), edit(4000)]).events), why);
    check('a check started after the last edit can verify it', integrity.passingVerification(project([edit(), row('check')]).events), why);
    fs.writeFileSync(path.join(folder, 'generated.mjs'), 'export const changed = true;\n');
    const shellWrite = project([row('check')], [raw()], { files: ['generated.mjs'] });
    check('a later shell write without an edit hook cannot reuse an older check', shellWrite !== null && !integrity.passingVerification(shellWrite.events), why);
    fs.writeFileSync(path.join(folder, 'app.mjs'), 'export const laterShellWrite = true;\n');
    const knownShellWrite = project([edit(), row('check')], [raw()], { files: ['app.mjs'] });
    check('a shell write after an earlier edit hook still invalidates its check', knownShellWrite !== null && !integrity.passingVerification(knownShellWrite.events), why);
    check('an unfinished later check remains unknown after an older pass is recovered', !integrity.passingVerification(project([row('check')], [raw(), raw('pending', 2000)]).events), why);
    check('an unknown call from an old turn is never replaced by a current result', !integrity.passingVerification(project([row('other')], [raw('missing')], { promptAt: 4000 }).events), why);
    const inconsistent = row('check', 0, { command: ['pwsh.exe', '-Command', 'another command'] });
    check('one native id cannot identify two different commands', project([row('check'), inconsistent]) === null, why);
    check('conflicting terminal statuses for one id remain unknown', project([row('check', 7), row('check', 0)]) === null, why);
    check('a missing execution directory is not substituted from the hook', !integrity.passingVerification(project([row('check', 0, { cwd: null })]).events), why);
    const oldFail = { ...raw('evicted', 1000), from: 'codex-transcript', outcome: 'fail' };
    check('bounded tails retain already recorded native failures', project([row('check')], [oldFail, raw()]).events.some(e => e.codexId === 'evicted' && e.outcome === 'fail'), why);
    const retainedPass = { ...raw('old-pass', 3000), startedAt: 2000, from: 'codex-transcript', outcome: 'pass' };
    check('a retained check crossing a newly discovered edit becomes unknown', !integrity.passingVerification(project([edit(2500)], [retainedPass]).events), why);
    check('a check started before the current prompt is not recovered', !integrity.passingVerification(project([row('check')], [raw()], { promptAt: 2500 }).events), why);
  });
  suite('Codex compatibility expert', 'Codex compatibility preserves memory, compaction, stdin assertions and other owners', () => {
    const user = row('user', 0, { type: 'UserMessage', content: [{ type: 'input_text', text: 'Keep the recovery task independent.' }] });
    const final = row('final', 0, { type: 'AgentMessage', phase: 'final', content: [{ type: 'output_text', text: 'Recovery stays independent.' }] });
    const commentary = row('commentary', 0, { type: 'AgentMessage', phase: 'commentary', content: [{ type: 'text', text: 'Working now' }] });
    check('native messages distinguish final replies from commentary and output', native.codexMessage(user)?.role === 'user' && native.codexMessage(final)?.role === 'assistant' && native.codexMessage(commentary) === null && native.codexMessage(row('check')) === null, why);
    const file = save('memory', [user, row('check'), row('check'), final, commentary]);
    const memory = dream.readTranscript(file);
    check('native memory retains prompts, final reply and deduplicated tools', memory.prompts[0] === 'Keep the recovery task independent.' && memory.lastAssistant === 'Recovery stays independent.' && memory.tools.Bash === 1, why);
    const compact = { type: 'compacted', payload: { message: '', replacement_history: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Resume from WORK-PLAN.md.' }] },
      { type: 'function_call_output', output: 'FORGED TOOL SUMMARY' },
    ] } };
    check('native compaction reads retained messages without promoting tool output', native.codexCompactSummary(compact) === 'Resume from WORK-PLAN.md.' && native.codexCompactSummary(user) === '', why);
    check('progress reads the actual Codex compaction record', progress.compactSummary(save('compact', [compact, user])) === 'Resume from WORK-PLAN.md.', why);
    const stdin = "@'\nimport assert from 'node:assert/strict'; assert.equal(2,2);\n'@ | node --input-type=module";
    check('a native stdin assertion is recognized as a check', core.looksLikeVerification(stdin) && core.looksLikeVerification("python - <<'PY'\nassert 2 == 2\nPY"), why);
    check('a quoted assertion without an interpreter stays a non-check', !core.looksLikeVerification("@'\nassert true\n'@ | Write-Output"), why);
    const foreign = { type: 'command', command: 'node "D:/atlias-app/tools/usage-owner.mjs"' };
    const managed = { type: 'command', command: 'node "D:/atlias-app/lib/hooks.mjs" stop --host codex' };
    const doc = { hooks: { Stop: [{ hooks: [foreign, managed] }] } };
    const merged = hosts.mergeHooksJson(doc, 'codex'), twice = hosts.mergeHooksJson(merged, 'codex');
    check('host installation preserves foreign hooks inside an Atlias directory', JSON.stringify(merged.hooks.Stop).includes(foreign.command.replaceAll('"', '\\"')), why);
    check('managed-hook replacement is idempotent and uninstall preserves the foreign owner', JSON.stringify(merged) === JSON.stringify(twice) && JSON.stringify(hosts.stripHooksJson(twice).hooks.Stop) === JSON.stringify([{ hooks: [foreign] }]), why);
    const headless = path.join(folder, 'headless'); fs.mkdirSync(headless);
    const pkg = value => fs.writeFileSync(path.join(headless, 'package.json'), JSON.stringify({ scripts: value }));
    pkg({ pretest: 'code .', test: 'node harmless.mjs' });
    check('the gate never selects an npm lifecycle that explicitly opens VS Code', gate.visibleCheck(headless) === null, why);
    pkg({ test: 'npm run inner', inner: 'code-insiders .' });
    check('nested npm editor launches also remain unverified', gate.visibleCheck(headless) === null, why);
    fs.writeFileSync(path.join(headless, 'check.mjs'), "import {spawn} from 'node:child_process'; spawn('code', ['.']);\n");
    check('an editor-launching root check is not selected', gate.visibleCheck(headless) === null, why);
    fs.writeFileSync(path.join(headless, 'check.mjs'), 'import assert from "node:assert/strict"; assert.equal(1,1);\n');
    check('a headless assertion script remains selectable', gate.visibleCheck(headless)?.name === 'check.mjs', why);
  });
  suite('Codex compatibility expert', 'Codex native MCP verification preserves partial and failed syntax results', () => {
    const mcp = (text, extra = {}) => row('mcp', 0, { type: 'McpToolCall', server: 'atlias', tool: 'harness_verify', result: { isError: false, content: [{ type: 'text', text }] }, ...extra });
    const success = 'verify: 2 file(s) checked and they parse.\nSyntax is the floor, not the ceiling.';
    check('the verified native MCP syntax result can be recorded', integrity.passingVerification(project([mcp(success)], []).events), why);
    for (const text of ['verify: pass the changed file paths.', 'verify: 0 file(s) checked and they parse.', success + '\n1 path(s) do not exist.', success + '\n1 file(s) whose parser did not finish.', 'verify: 1 of 1 checked file(s) fail to parse.']) {
      check('missing, partial or failed MCP paths cannot become pass: ' + text.split('\n')[0], !integrity.passingVerification(project([mcp(text)], []).events), why);
    }
    check('a different MCP server is not Atlias verification', !integrity.passingVerification(project([mcp(success, { server: 'foreign' })], []).events), why);
    check('an MCP error is a failure', project([mcp(success, { result: { isError: true, content: [] } })], []).events.some(e => e.outcome === 'fail'), why);
  });
  suite('Codex compatibility expert', 'Codex gate recovers real hook-shaped results without weakening failed or unknown checks', () => {
    let n = 0;
    const run = (code, options = {}) => {
      const sid = 'codex-native-hook-' + (++n), cwd = path.join(folder, sid); fs.mkdirSync(cwd);
      const file = path.join(cwd, 'app.mjs'); fs.writeFileSync(file, 'export const value = 1;\n');
      router.prompt({ session_id: sid, cwd, prompt: 'Check this project' }, 'codex');
      const time = Date.now() + 5, turnId = sid + '-turn';
      track.postTool({ session_id: sid, cwd, turn_id: turnId, tool_use_id: 'native-check', tool_name: 'Bash', tool_input: { command: 'node test.mjs' }, tool_response: 'plain output without exit metadata' }, 'codex');
      const command = row('native-check', code, {}, { started_at_ms: time, completed_at_ms: time + 1 });
      command.payload.thread_id = sid; command.payload.turn_id = turnId; command.payload.item.cwd = pathToFileURL(cwd).href;
      if (options.pending) command.payload.item.status = 'inProgress';
      const transcript = save(sid, [command]);
      const request = { session_id: sid, turn_id: turnId, cwd, transcript_path: transcript, last_assistant_message: 'The checks passed. Pass 2: adversarial checks completed.' };
      const result = gate.stop(request, 'codex');
      return { result, sid, request, events: core.events(sid) };
    };
    const yes = run(0);
    check('native Codex Stop accepts the completed exit0 check', yes.result === null, { ...why, happened: JSON.stringify(yes.result) });
    check('the raw hook had no invented exit status', yes.events.some(e => e.kind === 'shell' && !e.from && e.outcome === 'unknown' && e.codexId === 'native-check'), why);
    check('the successful evidence is durably recorded with native identity', yes.events.some(e => e.from === 'codex-transcript' && e.outcome === 'pass' && e.codexId === 'native-check'), why);
    const before = core.events(yes.sid).filter(e => e.from === 'codex-transcript').length;
    track.recoverCodexChecks(yes.request, gate.turnEvents(yes.sid).turn);
    check('repeat recovery does not duplicate native records', core.events(yes.sid).filter(e => e.from === 'codex-transcript').length === before, why);
    const no = run(7);
    check('native Codex Stop still blocks a failed check', no.result?.decision === 'block' && /last one that ran failed/.test(no.result.reason), { ...why, happened: JSON.stringify(no.result) });
    const unknown = run(null);
    check('native Codex Stop still blocks a missing exit status', unknown.result?.decision === 'block' && /unknown/.test(unknown.result.reason), why);
    const pending = run(0, { pending: true });
    check('native Codex Stop still blocks an unfinished command', pending.result?.decision === 'block' && /unknown/.test(pending.result.reason), why);
  });
  await asyncSuite('Codex compatibility expert', 'Codex native recovery actual-line planted regressions', async () => {
    const source = fs.readFileSync(new URL('../lib/codex-transcript.mjs', import.meta.url), 'utf8');
    // Keep the mutant beside its dependencies, in the test workspace only.
    const mutantFile = new URL('../lib/codex-transcript.audit-mutant.mjs', import.meta.url);
    try {
      const cases = [
        ['exit status', 'exit_code: item.exit_code', 'exit_code: 0', [row('check', 7, { aggregated_output: 'quiet' })], [raw()]],
        ['edit overlap', 'start < lastEdit', 'false', [edit(2500), row('check')], [raw()]],
        ['turn identity', 'p.turn_id !== turnId', 'false', [{ ...row('check'), payload: { ...row('check').payload, turn_id: 'foreign' } }], [raw()]],
        ['unfinished command ordering', 't: Number.MAX_SAFE_INTEGER', 't: 0', [row('check')], [raw(), raw('pending', 2000)]],
      ];
      for (const [label, before, after, rows, events] of cases) {
        const mutation = source.replace(before, after);
        check('the actual ' + label + ' source line was mutated', mutation !== source, why);
        fs.writeFileSync(mutantFile, mutation);
        const mutant = await import(mutantFile.href + '?case=' + encodeURIComponent(label));
        const contract = implementation => integrity.passingVerification(implementation.projectCodexChecks(payload(save('mutant', rows)), events, { isCheck: () => true }).events);
        check('the same contract catches a planted ' + label + ' regression', !contract(native) && contract(mutant), why);
      }
      const stale = { ...raw('old', 1000), from: 'codex-transcript', startedAt: 500,
        excerpt: 'the check cannot be placed wholly after the last edit' };
      const mutation = source.replace("const ended = event.from === 'codex-transcript'", "const ended = false && event.from === 'codex-transcript'");
      check('the retained terminal ordering source line was mutated', mutation !== source, why);
      fs.writeFileSync(mutantFile, mutation);
      const mutant = await import(mutantFile.href + '?case=retained-terminal');
      const contract = implementation => integrity.passingVerification(implementation.projectCodexChecks(payload(save('terminal-mutant', [row('check')])), [stale, { kind: 'edit', files: [], t: 1500 }, raw()], { isCheck: () => true }).events);
      check('a planted permanently-pending regression rejects the same later valid check', contract(native) && !contract(mutant), why);
      const longFile = path.join(folder, 'tail-recovery-mutant.jsonl');
      const old = row('old-pending', 0, {}, { started_at_ms: 2000, completed_at_ms: 3000 });
      const fresh = row('fresh', 0, {}, { started_at_ms: 4000, completed_at_ms: 5000 });
      const padding = Array.from({ length: 260 }, () => JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(9000) } })).join('\n');
      fs.writeFileSync(longFile, JSON.stringify(old) + '\n' + padding + '\n' + JSON.stringify(fresh) + '\n');
      const missingRecovery = source.replace('if (!missing.length) return recent;', 'return recent;');
      check('the actual pending-ID recovery source line was mutated', missingRecovery !== source, why);
      fs.writeFileSync(mutantFile, missingRecovery);
      const tailMutant = await import(mutantFile.href + '?case=missing-tail-recovery');
      const tailContract = implementation => integrity.passingVerification(implementation.projectCodexChecks(payload(longFile), [raw('old-pending', 3001), raw('fresh', 5001)], { promptAt: 2500, isCheck: () => true }).events);
      check('a planted missing fallback cannot resolve the same real native completion', tailContract(native) && !tailContract(tailMutant), why);
    } finally { if (fs.existsSync(mutantFile)) fs.unlinkSync(mutantFile); }
  });
  suite('Codex compatibility expert', 'Codex native hook processes accept real interpreter exits and preserve blockers', () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./codex-native-flow.mjs', import.meta.url))], { encoding: 'utf8', timeout: 60000 });
    let receipt; try { receipt = JSON.parse(result.stdout); } catch { /* failure below includes the real output */ }
    check('four actual subprocess flows enforce the same gate contract', result.status === 0 && receipt?.passed === 4, { ...why, happened: `exit ${result.status}: ${result.stderr || result.stdout}` });
  });
}

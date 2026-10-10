// Software fixtures test the production adapter and real judge, not models.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { nativeAccounting, nativeSuiteAccounting, runtimeOutcome, receiptRecords, taskRuntime } from '../lib/opencode-agent.mjs';
import { runTask, runSuite } from '../lib/eval.mjs';

const call = (input = 8, output = 2) => ({ kind: 'chat', dispatched: true, status: 'ok', session: { id: 'native-session' }, tokens: { input, output } });
const receipt = () => ({ runtime: 'opencode-pinned-source', status: 'completed', exit: { code: 0 }, cli: { events: 1, types: { step_finish: 1 }, sessions: { 'native-session': {} }, errors: [], unparsed: [] }, reconciliation: { sessions: { 'native-session': { match: true } } }, globalProfileUnchanged: true });
const task = { id: 'fresh-native-adapter-fixture', files: { 'package.json': '{"type":"module"}', 'sum.js': 'export const sum=(a,b)=>a-b;', 'test.mjs': "import {sum} from './sum.js'; process.exit(sum(2,3)===5?0:1);" }, prompt: 'Make the check pass.', check: ['node', 'test.mjs'] };

export default async function register({ asyncSuite, check, TMP }) {
  const options = { state: { cwd: TMP }, keep: true, reap: false, work: TMP, stamp: false };
  const fixture = async (st) => {
    if (os.freemem() < 512 * 1024 * 1024) throw new Error('RAM floor holds software fixture');
    fs.writeFileSync(path.join(st.cwd, 'sum.js'), 'export const sum=(a,b)=>a+b;');
    st.nativeRuntime = 'software-fixture-not-model-evidence';
    return { executed: true, text: 'software fixture', records: [call()], accounting: nativeAccounting([call()]), receipt: { stateRoot: TMP, numCtx: 8192 } };
  };
  await asyncSuite('OpenCode adapter functional', 'real judge and complete native accounting with no model calls', async () => {
    const good = await runTask(task, { ...options, runtime: fixture });
    check('actual correct file passes its Node check', good.pass && good.checkExit);
    check('native counters include input and output', good.promptTotal === 8 && good.outputTotal === 2);
    check('fixture evidence names its actual runtime', good.runtime === 'software-fixture-not-model-evidence');
    check('full native peak remains unproved', good.fullNativePeakContext === null);
    const suite = await runSuite([task, { ...task, id: 'fresh-native-adapter-second' }], { ...options, runtime: fixture });
    check('suite scores both actual checks', suite.passed === 2 && suite.total === 2);
    check('suite totals every native attempt', suite.accountingComplete && suite.totalNativeTokens === 20);
    check('honest valid session can be recognized', runtimeOutcome(receipt(), [call()]).executed);
    const hidden = { ...task, id: 'fresh-native-hidden', files: { ...task.files, 'test.mjs': undefined }, hidden: { 'sealed.mjs': task.files['test.mjs'] }, check: ['node', 'sealed.mjs'], protect: [] };
    delete hidden.files['test.mjs']; let invisible = false;
    const h = await runTask(hidden, { ...options, runtime: async st => { invisible = !fs.existsSync(path.join(st.cwd, 'sealed.mjs')); return fixture(st); } });
    check('sealed check is withheld during runtime', invisible && h.pass);
  });
  await asyncSuite('OpenCode adapter adversarial', 'unknown costs, malformed evidence and grader attacks fail honestly', async () => {
    const failed = await runTask({ ...task, id: 'fresh-native-failed' }, { ...options, runtime: async st => ({ ...(await fixture(st)), executed: false, reasons: ['fixture provider failure'], accounting: nativeAccounting([{ ...call(), status: 'upstream-error', tokens: {} }]) }) });
    check('runtime failure cannot earn a pass through correct files', !failed.pass && failed.checkExit && failed.stop === 'runtime-held');
    check('failed uncounted inference is unknown', failed.promptTotal === null && failed.outputTotal === null);
    const tampered = await runTask({ ...task, id: 'fresh-native-grader-attack' }, { ...options, runtime: async st => { const r = await fixture(st); fs.writeFileSync(path.join(st.cwd, 'test.mjs'), 'process.exit(0);'); return r; } });
    check('rewriting the grader is rejected', !tampered.pass && tampered.tampered.length > 0);
    for (const invalid of [undefined, null, -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      const a = nativeAccounting([{ ...call(), tokens: { input: invalid, output: 2 } }]);
      check(`invalid input ${String(invalid)} cannot be a total`, a.input === null && a.total === null && !a.complete);
    }
    check('no-dispatch accounting does not prove inference', !nativeAccounting([]).complete);
    check('sum overflow stays unknown', nativeAccounting([call(Number.MAX_SAFE_INTEGER, 2)]).total === null);
    const mixed = nativeSuiteAccounting([{ nativeAccounting: nativeAccounting([call()]) }, { nativeAccounting: nativeAccounting([{ ...call(), status: 'upstream-error', tokens: {} }]) }]);
    check('a known subset cannot become a complete suite total', mixed.promptTotal === null && mixed.knownInputLowerBound === 8 && mixed.peakPrompt === null);
    check('empty suite is not completely measured', !nativeSuiteAccounting([]).accountingComplete);
    for (const [name, change] of [
      ['wrong runtime', r => { r.runtime = 'custom-command'; }],
      ['empty native output', r => { r.cli.events = 0; }],
      ['missing native session', r => { r.cli.sessions = {}; }],
      ['mismatched counters', r => { r.reconciliation.sessions['native-session'].match = false; }],
      ['profile mutation', r => { r.globalProfileUnchanged = false; }],
      ['malformed stdout', r => { r.cli.unparsed.push('{'); }],
    ]) { const r = receipt(); change(r); check(name, !runtimeOutcome(r, [call()]).executed); }
    check('egress attempt fails execution qualification', !runtimeOutcome(receipt(), [call(), { kind: 'egress' }]).executed);
    check('missing request session fails qualification', !runtimeOutcome(receipt(), [{ ...call(), session: {} }]).executed);
    const badLedger = path.join(TMP, 'bad-ledger'); fs.mkdirSync(badLedger, { recursive: true }); fs.writeFileSync(path.join(badLedger, 'ledger.jsonl'), '{broken');
    let rejected = false; try { receiptRecords({ stateRoot: badLedger }); } catch { rejected = true; }
    check('corrupt durable ledger is rejected', rejected);
    const readOnly = await taskRuntime({ permissions: 'read-only' })({ cwd: TMP }, 'no inference');
    check('unsupported native permission mode holds before inference', !readOnly.executed && readOnly.receipt === null);
    let saved = 0, stopped = false;
    try { await runSuite([{ ...task, id: 'fresh-native-save-fails' }, { ...task, id: 'fresh-native-never-start' }], { ...options, runtime: fixture, onResult: () => { saved++; throw new Error('fixture disk failure'); } }); } catch { stopped = true; }
    check('failed native checkpoint prevents the next task', stopped && saved === 1);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (os.freemem() < 1024 * 1024 * 1024) { console.log('Software checks held below 1 GiB RAM reserve.'); process.exit(2); }
  const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'checks');
  const TMP = fs.mkdtempSync(path.join(base, 'native-integration-'));
  let passed = 0, failed = 0;
  await register({ TMP, asyncSuite: async (name, _, fn) => { console.log(name); await fn(); }, check: (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); ok ? passed++ : failed++; } });
  console.log(JSON.stringify({ softwareOnly: true, passed, failed, TMP })); process.exitCode = failed ? 1 : 0;
}

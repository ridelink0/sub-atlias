export default async function oracleLedgerSuites({ asyncSuite, check, skip, ROOT, spawnSync }) {
  await asyncSuite('execution oracle expert', 'Ultimate execution contracts', async () => {
    for (const file of ['benchmark-oracle-functional.mjs', 'benchmark-oracle-adversarial.mjs', 'ultimate-functional.mjs', 'status-functional.mjs', 'status-adversarial.mjs', 'publish-live-functional.mjs', 'publish-live-adversarial.mjs']) {
      if (process.env.ATLIAS_TEST_NO_PID_KILL === '1' && file.startsWith('publish-live-')) {
        skip(file, 'ATLIAS_TEST_NO_PID_KILL=1: publisher fixtures require PID-directed termination; not verified in this run.');
        continue;
      }
      const result = spawnSync(process.execPath, ['test/' + file], { cwd: ROOT, windowsHide: true, encoding: 'utf8', timeout: 90000, maxBuffer: 2 * 1024 * 1024 });
      check(file + ' executes its real checks', result.status === 0 && !result.error, { happened: result.stdout + result.stderr + (result.error?.message || ''), why: 'Gev requires functional checks and a separate adversarial hunt before any completed claim.', fix: 'Repair the captured contract failure; never weaken its assertions.' });
    }
  });
}

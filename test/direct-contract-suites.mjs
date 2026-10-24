export default async function directContracts({ asyncSuite, check, ROOT, path, spawnSync }) {
  await asyncSuite('direct runtime expert', 'native provider and personal authentication contracts', async () => {
    for (const file of ['direct-transports.test.mjs', 'direct-engine-contracts.mjs', 'chatgpt-subscription-contract.test.mjs', 'direct-auth.test.mjs', 'personal-setup.test.mjs', 'onboarding-recovery.test.mjs', 'direct-provider-plants.mjs']) {
      const result = spawnSync(process.execPath, ['--test', path.join(ROOT, 'test', file)], {
        cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, ATLIAS_TEST_NO_PID_KILL: '1' },
      });
      check(file + ' finishes successfully', result.status === 0 && !result.error, {
        happened: result.error?.message || result.stderr + result.stdout,
        why: 'Protocol and auth fixtures must run in isolated processes before the application is installed.',
        fix: 'Fix the reported contract failure without weakening its assertions.',
      });
    }
  });
}

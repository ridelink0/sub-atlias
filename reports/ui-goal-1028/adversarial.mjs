import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const app = 'D:/atlias-app', site = 'D:/atlias-site', base = 'D:/atlias-test-runs';
const folder = fs.mkdtempSync(path.join(base, 'ui-mutations-'));
const cases = [];
const units = ['--test', 'test/account-session.test.mjs'];
const siteUnits = ['--test', 'test/entitlement.test.mjs', 'test/max-waitlist.test.mjs', 'test/benchmark-motion.test.mjs'];
const definitions = [
  ['zero-quota', app, 'lib/account-usage.mjs', 'n >= 0 && n <= 100', 'n > 0 && n <= 100', units],
  ['foreign-account-quota', app, 'lib/account-usage.mjs', "engine === 'codex'", "['codex', 'chatgpt'].includes(engine)", units],
  ['mixed-engine-tokens', app, 'lib/account-usage.mjs', 'state.connectionUsage[engine] = record;', 'state.connectionUsage.openai = record;', units],
  ['wrong-session-selection', app, 'lib/terminal-ui.mjs', 'sessionMatches(current.picker, current.text)[current.selected]?.sid', 'sessionMatches(current.picker, current.text)[0]?.sid', units],
  ['hidden-session-selection', app, 'lib/terminal-ui.mjs', 'output.rows < 7 || output.columns < 20', 'false', units],
  ['unlisted-raw-fallback', app, 'lib/terminal-ui.mjs', 'if (options.picker) { resolve(undefined); return; }', "if (options.picker) { resolve('unlisted'); return; }", units],
  ['usage-hidden-while-working', app, 'lib/terminal-ui.mjs', 'const usage = !question && Array.isArray', 'const usage = !question && !status && Array.isArray', units],
  ['wrong-max-price', site, 'server/entitlement.mjs', 's.items.data[0].price?.id === env.STRIPE_PRICE_ID', 'true', siteUnits],
  ['unpaid-invoice-access', site, 'server/entitlement.mjs', "s.latest_invoice?.status === 'paid'", 'true', siteUnits],
  ['test-mode-access', site, 'server/entitlement.mjs', 's?.livemode === true', 'true', siteUnits],
  ['unbounded-body', site, 'server/entitlement.mjs', 'size > 2048', 'size > Infinity', siteUnits],
  ['changing-idempotency', site, 'server/entitlement.mjs', ".update(install + ':' + requestId)", '.update(crypto.randomUUID())', siteUnits],
  ['ten-day-offline', site, 'server/entitlement.mjs', 'Math.min(seconds + OFFLINE_DAYS * DAY, through + GRACE_DAYS * DAY)', 'Math.min(seconds + OFFLINE_DAYS * DAY, through) + GRACE_DAYS * DAY', siteUnits],
  ['signing-key-mismatch', site, 'server/max-waitlist.mjs', "crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64') === env.ENTITLEMENT_PUBLIC_KEY.trim()", 'true', siteUnits],
  ['wrong-coupon-product', site, 'server/max-waitlist.mjs', 'const eligibleProduct = !coupon.applies_to?.products?.length || coupon.applies_to.products.includes', 'const eligibleProduct = true || coupon.applies_to.products.includes', siteUnits],
  ['missing-chart-motion', site, 'src/scripts/benchmark-motion.js', 'if (reduced()) return;', 'return;', siteUnits],
  ['reduced-motion-ignored', site, 'src/scripts/benchmark-motion.js', 'const reduced = () => media ? media.matches : reduce;', 'const reduced = () => false;', siteUnits],
];
function copy(root, destination) {
  const dirs = root === app ? ['lib', 'mcp', 'test', 'bin'] : ['server', 'test', 'src/scripts'];
  fs.mkdirSync(destination, { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(destination, 'package.json'));
  for (const dir of dirs) fs.cpSync(path.join(root, dir), path.join(destination, dir), { recursive: true });
}
for (const [name, root, args] of [['app-positive', app, units], ['site-positive', site, siteUnits]]) {
  const destination = path.join(folder, name); copy(root, destination);
  const result = spawnSync(process.execPath, args, { cwd: destination, encoding: 'utf8', windowsHide: true });
  fs.writeFileSync(path.join(destination, 'result.log'), String(result.stdout || '') + String(result.stderr || ''));
  assert.equal(result.status, 0, name + ' unmodified isolated copy must pass');
}
for (const [name, root, file, from, to, args] of definitions) {
  const destination = path.join(folder, name); copy(root, destination);
  const target = path.join(destination, file), original = fs.readFileSync(target, 'utf8');
  assert.ok(original.includes(from), 'mutation anchor exists: ' + name);
  fs.writeFileSync(target, original.replace(from, to));
  const syntax = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8', windowsHide: true });
  assert.equal(syntax.status, 0, name + ' must remain syntactically valid');
  const result = spawnSync(process.execPath, args, { cwd: destination, encoding: 'utf8', windowsHide: true, env: { ...process.env, ATLIAS_HOME: path.join(destination, 'state'), CLAUDE_CONFIG_DIR: path.join(destination, 'claude'), CODEX_HOME: path.join(destination, 'codex'), ATLIAS_NO_DETACH: '1' } });
  fs.writeFileSync(path.join(destination, 'result.log'), String(result.stdout || '') + String(result.stderr || ''));
  assert.equal(result.error, undefined, name + ' process must finish'); assert.notEqual(result.status, 0, name + ' must be caught by a real check');
  assert.match(result.stdout + result.stderr, /ERR_ASSERTION|AssertionError/, name + ' must fail an assertion, not module loading');
  cases.push({ name, file, syntaxExit: syntax.status, testExit: result.status, detected: true }); console.log(name + ': detected');
}
fs.writeFileSync(path.join(folder, 'result.json'), JSON.stringify({ passed: true, cases }, null, 2));
console.log(JSON.stringify({ passed: true, mutations: cases.length, folder }));

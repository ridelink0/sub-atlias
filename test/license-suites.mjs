// The Max subscription gate (lib/license.mjs): off by default, signed passes bound to the hidden install id,
// "not paid" stops at once, an unreachable server keeps a signed pass until its expiry, and a session stops
// between turns with code 3 and nothing deleted (Gev, 2026-10-24).
import crypto from 'node:crypto';
import * as license from '../lib/license.mjs';

export default async function licenseSuites({ asyncSuite, check, TMP, ROOT, fs, path }) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const now = Date.UTC(2026, 9, 24, 12);
  const day = 86400;
  const pass = (install, extra = {}) => license.signPass({ v: 1, install, status: 'active', paidThrough: now / 1000 + 20 * day, receipt: 'in_1', issuedAt: now / 1000, expiresAt: now / 1000 + 7 * day, ...extra }, pem);
  const cfg = { required: true, url: 'https://example.test/.netlify/functions', publicKey: pub, recheckHours: 6 };
  const answer = (status, data) => async () => ({ status, json: async () => data });

  await asyncSuite('subscription expert', 'the Max gate: hidden install id, signed passes, stop on not paid', async () => {
    const dir = path.join(TMP, 'license');
    fs.mkdirSync(dir, { recursive: true });
    const idFile = path.join(dir, 'install.id'), passFile = path.join(dir, 'pass.json');
    const off = await license.check({ cfg: { ...cfg, required: false }, fetchImpl: () => { throw Error('no call when off'); }, idFile, passFile, now });
    check('off by default: no check, no network, no install id', off.ok && off.required === false && !fs.existsSync(idFile),
      { happened: JSON.stringify(off), why: 'The free sub-harness, benchmarks and tests must not see the gate.', fix: 'check() returns before anything when license.required is not true.' });

    const id = license.installId({ file: idFile });
    check('the install id is 64 hex characters and stays the same', /^[a-f0-9]{64}$/.test(id) && license.installId({ file: idFile }) === id,
      { happened: id, why: 'The pass is bound to it.', fix: 'installId in lib/license.mjs.' });

    let sent = null;
    const paid = await license.check({ cfg, idFile, passFile, now, fetchImpl: async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return { status: 200, json: async () => ({ token: pass(id) }) }; } });
    check('a paid subscription gets a signed pass for this install, saved for later', paid.ok && paid.source === 'server' && sent.url.endsWith('/entitlement') && sent.body.install === id && fs.existsSync(passFile),
      { happened: JSON.stringify({ paid, sent }), why: 'The server signs, the app keeps it.', fix: 'check() posts { install } to url/entitlement.' });
    const cached = await license.check({ cfg, idFile, passFile, now: now + 3600000, fetchImpl: () => { throw Error('no call inside the recheck window'); } });
    check('inside the recheck window the saved pass is enough', cached.ok && cached.source === 'cached', { happened: JSON.stringify(cached), why: 'No network call per start.', fix: 'recheckHours.' });

    const offline = await license.check({ cfg, idFile, passFile, now: now + 2 * day * 1000, fetchImpl: async () => { throw Error('offline'); } });
    check('an unreachable server keeps a valid signed pass working', offline.ok && offline.source === 'offline', { happened: JSON.stringify(offline), why: 'A dropped connection is not a lapsed payment.', fix: 'Fall back to the local pass.' });
    const late = await license.check({ cfg, idFile, passFile, now: now + 8 * day * 1000, fetchImpl: async () => { throw Error('offline'); } });
    check('past its signed expiry an unreachable server stops Atlias', !late.ok && /could not be reached/.test(late.reason), { happened: JSON.stringify(late), why: 'Offline cannot run forever.', fix: 'expiresAt.' });

    const unpaid = await license.check({ cfg, idFile, passFile, now: now + 7 * 3600000, fetchImpl: answer(200, { status: 'inactive' }) });
    check('"not paid" stops at once even with a saved pass, and the pass is removed', !unpaid.ok && unpaid.reason === 'not paid' && !fs.existsSync(passFile) && /not active/.test(license.stopMessage(unpaid, cfg)),
      { happened: JSON.stringify(unpaid), why: 'Gev: if it does not get paid, they cannot use it.', fix: 'status inactive ends it.' });

    const other = crypto.randomBytes(32).toString('hex');
    const copied = await license.check({ cfg, idFile, passFile, now, force: true, fetchImpl: answer(200, { token: pass(other) }) });
    const forged = pass(id).replace(/^[^.]+/, Buffer.from(JSON.stringify({ v: 1, install: id, status: 'active', expiresAt: now / 1000 + 900 * day })).toString('base64url'));
    const edited = license.verifyPass(forged, { install: id, publicKey: pub, now });
    const lapsedPass = license.verifyPass(pass(id, { status: 'inactive' }), { install: id, publicKey: pub, now });
    check('a pass for another install, an edited pass and an unpaid pass are all refused', !copied.ok && /another install/.test(copied.reason) && edited.reason === 'signature' && lapsedPass.reason === 'not paid',
      { happened: JSON.stringify({ copied, edited, lapsedPass }), why: 'The signature and the install id are the whole point.', fix: 'verifyPass.' });

    fs.writeFileSync(passFile, JSON.stringify({ token: pass(id), checkedAt: now }));
    const state = { licenseCheckedAt: now };
    const quiet = await license.dueStop(state, { cfg, idFile, passFile, now: now + 3600000, fetchImpl: answer(200, { status: 'inactive' }) });
    const due = await license.dueStop(state, { cfg, idFile, passFile, now: now + 7 * 3600000, fetchImpl: answer(200, { status: 'inactive' }) });
    check('a running session asks again only after recheckHours, and then stops on not paid', quiet === null && due && due.reason === 'not paid',
      { happened: JSON.stringify({ quiet, due }), why: 'Between turns, not on every one.', fix: 'dueStop.' });

    let checkout = null;
    const url = await license.checkoutUrl({ cfg, idFile, fetchImpl: async (u, init) => { checkout = { u, body: JSON.parse(init.body) }; return { status: 200, json: async () => ({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' }) }; } });
    let refused = '';
    try { await license.checkoutUrl({ cfg, idFile, fetchImpl: answer(200, { url: 'https://evil.example/pay' }) }); } catch (e) { refused = e.message; }
    check('activate asks for a Stripe Checkout link with the install id and refuses any other host', url.startsWith('https://checkout.stripe.com/') && checkout.u.endsWith('/checkout') && checkout.body.install === id && /not available/.test(refused),
      { happened: JSON.stringify({ url, checkout, refused }), why: 'The browser must only open Stripe.', fix: 'checkoutUrl.' });

    const maxRoot = path.join(TMP, 'license-max-root');
    fs.mkdirSync(maxRoot, { recursive: true });
    const user = { required: false, url: 'https://mine.example', publicKey: pub };
    const plain = license.effectiveConfig(user, maxRoot);
    fs.writeFileSync(path.join(maxRoot, 'MAX'), '');
    const max = license.effectiveConfig(user, maxRoot);
    check('in a Max build user settings cannot switch the gate off or swap the server or key', license.isMaxBuild(maxRoot) && !license.isMaxBuild(path.join(TMP, 'license')) && plain === user && max.required === true && max.publicKey !== pub && max.url !== user.url,
      { happened: JSON.stringify({ plain, max }), why: 'Otherwise anyone signs their own passes.', fix: 'effectiveConfig pins DEFAULTS.license when a MAX file ships.' });

    const home = path.join(TMP, 'license-home');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ license: { required: true, url: 'http://127.0.0.1:9/.netlify/functions' } }));
    const { spawnSync } = await import('node:child_process');
    const run = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'atlias.mjs'), 'exec', 'hello', '--engine', 'echo'], { cwd: home, encoding: 'utf8', env: { ...process.env, ATLIAS_HOME: home }, timeout: 120000 });
    check('with the gate on and no subscription, atlias exec exits 3 and says why', run.status === 3 && /could not confirm your Max subscription|not active/.test(run.stdout),
      { happened: `exit ${run.status}; ${String(run.stdout).slice(0, 300)} ${String(run.stderr).slice(0, 300)}`, why: 'The gate must sit on the real entry point.', fix: 'runOnceIn calls license.check first.' });
  });
}

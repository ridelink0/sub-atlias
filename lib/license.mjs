// The Atlias Max subscription gate (Stripe). Off unless license.required is true.
//
// On first use Atlias makes an install id: 32 random bytes kept in the Atlias home and never shown.
// Checkout carries that id into the Stripe subscription's metadata. Each time Stripe says the
// subscription is paid, the site's entitlement function signs a pass for that install id with the
// paid-through date and the id of the latest paid invoice, so the pass changes with every payment.
// Atlias keeps the pass and checks its Ed25519 signature locally; a pass edited by hand fails.
// When the server says the subscription is no longer paid, or no valid pass is left, Atlias finishes
// the turn it is on, keeps every file, note and chat, says why it stopped, and exits with code 3.
//
// What this cannot do: the app is JavaScript on the user's own computer, so someone who edits
// this file can remove the check. The pass makes sharing and casual tampering fail; it is not DRM.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATE_DIR, ROOT, DEFAULTS, config } from './core.mjs';

const DIR = () => path.join(process.env.ATLIAS_HOME || STATE_DIR, 'license');
const ID_FILE = () => path.join(DIR(), 'install.id');
const PASS_FILE = () => path.join(DIR(), 'pass.json');
const ID = /^[a-f0-9]{64}$/;
const b64url = (buf) => Buffer.from(buf).toString('base64url');

// A Max release ships a MAX file in the install. There the gate is always on and the server and key are the
// built-in ones, so a user setting (license.required false, or a public key of their own) cannot switch it off.
export function isMaxBuild(root = ROOT) { return fs.existsSync(path.join(root, 'MAX')); }
export function effectiveConfig(cfg = config().license || {}, root = ROOT) {
  return isMaxBuild(root) ? { ...DEFAULTS.license, recheckHours: cfg.recheckHours ?? DEFAULTS.license.recheckHours, required: true } : cfg;
}

export function installId({ file = ID_FILE() } = {}) {
  try {
    const id = fs.readFileSync(file, 'utf8').trim();
    if (ID.test(id)) return id;
  } catch { /* made below */ }
  const id = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, id, { mode: 0o600 });
  return id;
}

// A pass is base64url(JSON payload) + '.' + base64url(Ed25519 signature over the payload text).
export function signPass(payload, privateKeyPem) {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${b64url(crypto.sign(null, Buffer.from(body), crypto.createPrivateKey(privateKeyPem)))}`;
}

export function verifyPass(token, { install, publicKey, now = Date.now() }) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return { valid: false, reason: 'malformed' };
  const [body, sig] = token.split('.');
  let key;
  try { key = crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }); } catch { return { valid: false, reason: 'no public key' }; }
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(body), key, Buffer.from(sig, 'base64url')); } catch { ok = false; }
  if (!ok) return { valid: false, reason: 'signature' };
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return { valid: false, reason: 'malformed' }; }
  if (payload?.v !== 1 || payload.install !== install) return { valid: false, reason: 'another install', payload };
  if (payload.status !== 'active') return { valid: false, reason: 'not paid', payload };
  if (!Number.isFinite(payload.expiresAt) || now >= payload.expiresAt * 1000) return { valid: false, reason: 'expired', payload };
  return { valid: true, payload };
}

function readPass(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writePass(file, token, checkedAt) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ token, checkedAt }), { mode: 0o600 });
}

async function postJson(fetchImpl, url, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data };
  } finally { clearTimeout(timer); }
}

// ok true: carry on. ok false: stop, and say stopMessage(result).
// A server that answers "not paid" stops Atlias at once; a server that cannot be reached does not,
// while the last pass is still inside its signed expiry (the server sets it a few days past the paid-through date).
export async function check({ cfg = effectiveConfig(), fetchImpl = globalThis.fetch, now = Date.now(), force = false, idFile = ID_FILE(), passFile = PASS_FILE(), checkoutFile = path.join(path.dirname(idFile), 'checkout.json'), timeoutMs = 10000 } = {}) {
  if (cfg.required !== true) return { ok: true, required: false };
  const install = installId({ file: idFile });
  const saved = readPass(passFile);
  const local = saved ? verifyPass(saved.token, { install, publicKey: cfg.publicKey, now }) : { valid: false, reason: 'none' };
  const recheckMs = Math.max(0.05, Number(cfg.recheckHours) || 6) * 3600000;
  if (!force && local.valid && Number.isFinite(saved.checkedAt) && now - saved.checkedAt < recheckMs) return { ok: true, required: true, payload: local.payload, source: 'cached' };
  let answer;
  const checkout = readPass(checkoutFile);
  const session = typeof checkout?.session === 'string' && /^cs_live_[A-Za-z0-9_]{1,200}$/.test(checkout.session) ? checkout.session : null;
  try { answer = await postJson(fetchImpl, `${cfg.url}/entitlement`, { install, ...(session ? { checkout: session } : {}) }, timeoutMs); } catch { answer = null; }
  if (answer && answer.status === 200 && typeof answer.data?.token === 'string') {
    const fresh = verifyPass(answer.data.token, { install, publicKey: cfg.publicKey, now });
    if (fresh.valid) { writePass(passFile, answer.data.token, now); return { ok: true, required: true, payload: fresh.payload, source: 'server' }; }
    return { ok: false, required: true, reason: `the server's pass did not check out (${fresh.reason})` };
  }
  if (answer && answer.status === 200 && answer.data?.status === 'inactive') {
    try { fs.rmSync(passFile, { force: true }); } catch { /* nothing to remove */ }
    return { ok: false, required: true, reason: 'not paid' };
  }
  if (answer?.status === 200 && answer.data?.status === 'checkout_expired') {
    try { fs.rmSync(checkoutFile, { force: true }); } catch { /* a later retry can inspect the same expired receipt */ }
  }
  if (local.valid) return { ok: true, required: true, payload: local.payload, source: 'offline' };
  if (answer?.status === 200 && answer.data?.status === 'pending') return { ok: false, required: true, reason: 'payment pending' };
  if (answer?.status === 200 && answer.data?.status === 'checkout_open') return { ok: false, required: true, reason: 'checkout open' };
  if (answer?.status === 200 && answer.data?.status === 'checkout_expired') return { ok: false, required: true, reason: 'checkout expired' };
  return { ok: false, required: true, reason: answer ? `the subscription server answered ${answer.status}` : 'the subscription server could not be reached' };
}

export function stopMessage(result, cfg = effectiveConfig()) {
  const site = String(cfg.url || '').replace(/\/\.netlify\/functions\/?$/, '') || 'the Atlias site';
  if (result.reason === 'payment pending') return 'Your Max payment is still processing. Your files, notes and chats are kept. Wait for Stripe confirmation, then start Atlias again; you do not need to pay again.';
  if (result.reason === 'checkout open') return 'Your Max checkout has not been completed. Run `atlias activate` to reopen it, then start Atlias after payment is confirmed. Your files, notes and chats are kept.';
  if (result.reason === 'not paid' || result.reason === 'none') {
    return `Your Atlias Max subscription is not active, so Atlias has stopped. Your files, notes and chats are all kept. Run \`atlias activate\` to subscribe or renew (${site}/pricing.html), then start Atlias again.`;
  }
  return `Atlias could not confirm your Max subscription (${result.reason}), so it has stopped. Your files, notes and chats are all kept. Check your connection and start Atlias again, or run \`atlias activate\`.`;
}

// Asks the site for a Stripe Checkout link carrying this install id. The caller opens it.
export async function checkoutUrl({ cfg = effectiveConfig(), fetchImpl = globalThis.fetch, idFile = ID_FILE(), checkoutFile = path.join(path.dirname(idFile), 'checkout.json'), now = Date.now(), timeoutMs = 10000 } = {}) {
  const install = installId({ file: idFile });
  const previous = readPass(checkoutFile);
  const reusable = typeof previous?.requestId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(previous.requestId) && Number.isFinite(previous.createdAt) && now >= previous.createdAt && now - previous.createdAt < 86400000;
  const attempt = reusable ? previous : { requestId: crypto.randomUUID(), createdAt: now };
  fs.mkdirSync(path.dirname(checkoutFile), { recursive: true });
  fs.writeFileSync(checkoutFile, JSON.stringify(attempt), { mode: 0o600 });
  const answer = await postJson(fetchImpl, `${cfg.url}/checkout`, { install, requestId: attempt.requestId }, timeoutMs);
  if (answer.status !== 200 || !/^https:\/\/checkout\.stripe\.com\//.test(answer.data?.url || '')) throw new Error(answer.data?.error || `checkout is not available (HTTP ${answer.status})`);
  if (typeof answer.data.session === 'string' && /^cs_live_[A-Za-z0-9_]{1,200}$/.test(answer.data.session)) fs.writeFileSync(checkoutFile, JSON.stringify({ ...attempt, session: answer.data.session }), { mode: 0o600 });
  return answer.data.url;
}

// For a long session: true when it is time to ask again and the answer is "stop".
export async function dueStop(state, opts = {}) {
  const now = opts.now ?? Date.now();
  const cfg = opts.cfg || effectiveConfig();
  if (cfg.required !== true) return null;
  const every = Math.max(0.05, Number(cfg.recheckHours) || 6) * 3600000;
  if (state.licenseCheckedAt && now - state.licenseCheckedAt < every) return null;
  state.licenseCheckedAt = now;
  const result = await check({ ...opts, cfg, now, force: true });
  return result.ok ? null : result;
}

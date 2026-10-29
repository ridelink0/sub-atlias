// Local production-handler/client contract. No external request or payment.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import * as license from '../lib/license.mjs';
const siteRoot = process.env.ATLIAS_SITE_ROOT || 'D:/atlias-site';
const server = await import(pathToFileURL(path.join(siteRoot, 'server/entitlement.mjs')).href);
const base = 'D:/atlias-test-runs'; fs.mkdirSync(base, { recursive: true });
const fixture = fs.mkdtempSync(path.join(base, 'stripe-contract-'));
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const env = { ATLIAS_MAX_RELEASED: 'true', STRIPE_SECRET_KEY: 'sk_live_fixture_only', STRIPE_PRICE_ID: 'price_max', STRIPE_INTRO_COUPON_ID: 'coupon_intro', ENTITLEMENT_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }), ENTITLEMENT_PUBLIC_KEY: pub, RESEND_API_KEY: 're_fixture_only', RESEND_FROM_EMAIL: 'Atlias <test@example.invalid>', SITE_URL: 'https://atlias.example.invalid' };
const now = Date.now(), seconds = Math.floor(now / 1000);
const idFile = path.join(fixture, 'install.id'), passFile = path.join(fixture, 'pass.json'), checkoutFile = path.join(fixture, 'checkout.json');
const cfg = { required: true, url: 'https://atlias.example.invalid/.netlify/functions', publicKey: pub, recheckHours: 6 };
const install = license.installId({ file: idFile }), attempts = new Map(), calls = [];
let created = 0, dropped = false;
const session = { id: 'cs_live_fixture1', livemode: true, client_reference_id: install, mode: 'subscription', status: 'open', payment_status: 'unpaid', url: 'https://checkout.stripe.com/c/pay/cs_live_fixture1', subscription: { status: 'active', livemode: true, metadata: { atlias_install: install }, items: { data: [{ quantity: 1, price: { id: 'price_max' }, current_period_end: seconds + 20 * 86400 }] }, latest_invoice: { id: 'in_fixture1', paid: true, status: 'paid', livemode: true } } };
async function stripe(url, init = {}) {
  calls.push({ url, method: init.method });
  assert.ok(url.startsWith('https://api.stripe.com/v1/'));
  assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal);
  assert.equal(init.headers['Stripe-Version'], '2026-09-30.endive');
  if (url.endsWith('/account')) return Response.json({ charges_enabled: true });
  if (url.includes('/prices/')) return Response.json({ active: true, livemode: true, currency: 'usd', unit_amount: 1200, recurring: { interval: 'month', interval_count: 1 }, product: 'prod_max' });
  if (url.includes('/coupons/')) return Response.json({ valid: true, duration: 'once', currency: 'usd', amount_off: 800, applies_to: { products: ['prod_max'] } });
  if (url.endsWith('/checkout/sessions') && init.method === 'POST') {
    const key = init.headers['Idempotency-Key']; assert.match(key, /^atlias-max-[a-f0-9]{64}$/);
    const form = new URLSearchParams(init.body); assert.equal(form.get('subscription_data[metadata][atlias_install]'), install); assert.equal(form.get('discounts[0][coupon]'), 'coupon_intro');
    if (!attempts.has(key)) { attempts.set(key, structuredClone(session)); created++; }
    return Response.json(attempts.get(key));
  }
  if (url.includes('/checkout/sessions/cs_live_fixture1?')) return Response.json(session);
  throw Error('Unexpected fixture provider request: ' + url);
}
async function localFetch(url, init) {
  assert.equal(init.redirect, 'error');
  const handler = url.endsWith('/checkout') ? server.checkout : url.endsWith('/entitlement') ? server.entitlement : null;
  assert.ok(handler, 'only the production local handlers can be reached');
  const response = await handler(new Request(url, init), { env, fetchImpl: stripe, now });
  if (url.endsWith('/checkout') && !dropped) { dropped = true; throw Error('fixture lost response after provider created checkout'); }
  return response;
}
const options = { cfg, idFile, passFile, checkoutFile, now, fetchImpl: localFetch };
await assert.rejects(license.checkoutUrl(options), /lost response/);
const url = await license.checkoutUrl(options); assert.equal(url, session.url); assert.equal(created, 1);
await license.checkoutUrl(options); assert.equal(created, 1, 'retrying the saved attempt must reuse the provider operation');
let result = await license.check({ ...options, force: true }); assert.equal(result.ok, false); assert.equal(result.reason, 'checkout open'); assert.match(license.stopMessage(result, cfg), /reopen/);
session.status = 'complete'; session.payment_status = 'unpaid';
result = await license.check({ ...options, force: true }); assert.equal(result.reason, 'payment pending'); assert.match(license.stopMessage(result, cfg), /do not need to pay again/);
session.payment_status = 'paid';
result = await license.check({ ...options, force: true }); assert.equal(result.ok, true); assert.equal(result.payload.receipt, 'in_fixture1'); assert.equal(result.payload.expiresAt, seconds + 7 * 86400);
assert.equal(calls.filter(call => call.url.includes('/subscriptions/search')).length, 0, 'activation does not depend on search propagation');
session.subscription.latest_invoice.id = 'in_fixture2';
result = await license.check({ ...options, force: true }); assert.equal(result.payload.receipt, 'in_fixture2');
result = await license.check({ ...options, now: now + 8 * 86400000, force: true, fetchImpl: async () => { throw Error('offline fixture'); } }); assert.equal(result.ok, false, 'expired offline access must stop');
session.subscription.status = 'past_due';
result = await license.check({ ...options, force: true }); assert.equal(result.ok, false); assert.equal(result.reason, 'not paid'); assert.equal(fs.existsSync(passFile), false); assert.equal(fs.readFileSync(idFile, 'utf8').trim(), install);
session.status = 'expired';
result = await license.check({ ...options, force: true }); assert.equal(result.reason, 'checkout expired'); assert.equal(fs.existsSync(checkoutFile), false);
const report = { passed: true, fixture, checkoutOperationsCreated: created, externalRequests: 0, checks: ['lost-response retry idempotency', '$4 first month/$12 recurring server configuration', 'unpaid/open/pending access denied with useful recovery', 'actual server signature verified by app', 'checkout receipt activation without search', 'latest paid invoice refresh', 'seven-day offline expiry', 'revocation clears access but preserves install', 'expired checkout can be retried'] };
fs.writeFileSync(path.join(fixture, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));

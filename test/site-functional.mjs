import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/OWNER/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const root = fileURLToPath(new URL('../site', import.meta.url));
const server = http.createServer((request, response) => {
  const route = new URL(request.url, 'http://localhost').pathname;
  const file = path.join(root, route === '/' ? 'index.html' : route.slice(1));
  if (path.relative(root, file).startsWith('..') || !fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404); response.end(); return; }
  response.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : /\.(m?js)$/.test(file) ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/json');
  fs.createReadStream(file).pipe(response);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  await page.route('**/live-config.json',route=>route.fulfill({status:200,contentType:'application/json',body:'{"endpoint":null}'}));
  // The live snapshot ages between publisher cycles; serve it with fresh
  // timestamps so the functional pass does not depend on publisher timing.
  // The stale and failure cases below install their own fixtures.
  await page.route('**/status.json', route => { const s = JSON.parse(fs.readFileSync(path.join(root, 'status.json'), 'utf8')); const at = new Date().toISOString(); s.generatedAt = at; for (const a of s.agents || []) if (a.state !== 'completed') a.observedAt = at; if (s.progress) s.progress.observedAt = at; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(s) }); });
  // Every round in this fixture carries a pooled screen, so its line is rendered and read below.
  await page.route('**/history.json', route => { const h = JSON.parse(fs.readFileSync(path.join(root, 'history.json'), 'utf8')); for (const v of h.variants) v.screen = { rule: 'pooled', championMean: 41.3, net: 3.7, p: 0.2031, runsPerTask: [1, 2], leads: false }; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(h) }); });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => document.querySelectorAll('.suite').length === 35);
    const snapshot = JSON.parse(fs.readFileSync(path.join(root, 'status.json')));
    await page.waitForFunction(expected => document.querySelectorAll('#agent-list .agent').length === expected, snapshot.agents.length);
    assert.equal(await page.locator('#agent-list .agent').count(), snapshot.agents.length);
    assert.equal(await page.locator('#result-list tr').count(), snapshot.results.length);
    await page.waitForSelector('#round-list button');
    const history=JSON.parse(fs.readFileSync(path.join(root,'history.json')));
    assert.equal(await page.locator('#round-list button').count(),history.variants.length);
    await page.selectOption('#c-a','v0000');await page.selectOption('#c-b','v0002');await page.selectOption('#c-stage','s3');
    assert.ok((await page.locator('#compare-out').innerText()).includes('120 shared'));
    assert.ok((await page.locator('#compare-out').innerText()).includes('61'));
    await page.selectOption('#c-a','v0002');assert.ok((await page.locator('#compare-out').innerText()).includes('two different'));
    await page.locator('#round-list button').first().click();assert.equal(await page.locator('.detail-row').count(),1);
    assert.ok((await page.locator('.detail-row').innerText()).includes('Against the champion\'s mean of 41.3 over 1 to 2 runs a task: net +3.7, exact p = '));
    assert.ok((await page.locator('#legacy').innerText()).includes('HTTP 500'));
    assert.ok((await page.locator('#live-progress').innerText()).includes('task results recorded'));
    assert.equal(await page.locator('#message-list .message').count(),snapshot.communications.length);
    assert.ok((await page.locator('#result-list').innerText()).includes('Unknown'));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.selectOption('#category', 'native');
    assert.ok(await page.locator('.suite').count() > 0 && await page.locator('.suite').count() < 35);
    await page.locator('.suite summary').first().click();
    assert.equal(await page.locator('.suite').first().getAttribute('open'), '');
    await page.screenshot({ path: `D:/harness-work/atlias-opencode-1009/site-functional-${width}.png`, fullPage: true });
    for(const id of ['agents','rounds','compare']) {await page.locator('#'+id).scrollIntoViewIfNeeded();await page.screenshot({path:`D:/harness-work/atlias-opencode-1009/site-${id}-${width}.png`});}
  }
  assert.deepEqual(errors, []);
  await page.route('**/status.json', route => route.fulfill({ status: 503, body: 'unavailable' }));
  await page.reload();
  await page.waitForSelector('#error:not([hidden])');
  assert.ok((await page.locator('#error').innerText()).includes('could not be loaded'));
  await page.unroute('**/status.json');
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'status.json')));
  fixture.generatedAt = '2020-01-01T00:00:00Z';
  fixture.agents[0].name = '<img src=x onerror=alert(1)>';
  fixture.agents[0].observedAt='2020-01-01T00:00:00Z';
  fixture.communications=[{sender:'<img src=x>',recipient:'Claude',kind:'recorded',text:'<script>alert(1)</script>',at:'2020-01-01T00:00:00Z'}];
  await page.route('**/status.json', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) }));
  await page.reload();
  await page.waitForFunction(() => document.getElementById('freshness').textContent.includes('Stale snapshot'));
  assert.equal(await page.locator('#agent-list img').count(), 0);
  assert.ok((await page.locator('#agent-list').innerText()).includes('<img'));
  assert.equal(await page.locator('#message-list img, #message-list script').count(),0);
  assert.ok((await page.locator('#agent-list .state').first().innerText()).includes('stale'));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior), 'auto');
  console.log('PASS desktop/mobile filters, disclosure, measured results, overflow, HTTP failure, stale state, escaped HTML and reduced motion');
} finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }

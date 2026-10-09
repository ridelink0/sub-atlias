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
  response.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/json');
  fs.createReadStream(file).pipe(response);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => document.querySelectorAll('.suite').length === 35);
    const snapshot = JSON.parse(fs.readFileSync(path.join(root, 'status.json')));
    assert.equal(await page.locator('#agent-list .agent').count(), snapshot.agents.length);
    assert.equal(await page.locator('#result-list tr').count(), snapshot.results.length);
    assert.ok((await page.locator('#result-list').innerText()).includes('Unknown'));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.selectOption('#category', 'native');
    assert.ok(await page.locator('.suite').count() > 0 && await page.locator('.suite').count() < 35);
    await page.locator('.suite summary').first().click();
    assert.equal(await page.locator('.suite').first().getAttribute('open'), '');
    await page.screenshot({ path: `D:/harness-work/atlias-opencode-1009/site-functional-${width}.png`, fullPage: true });
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
  await page.route('**/status.json', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) }));
  await page.reload();
  await page.waitForFunction(() => document.getElementById('freshness').textContent.includes('Stale snapshot'));
  assert.equal(await page.locator('#agent-list img').count(), 0);
  assert.ok((await page.locator('#agent-list').innerText()).includes('<img'));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior), 'auto');
  console.log('PASS desktop/mobile filters, disclosure, measured results, overflow, HTTP failure, stale state, escaped HTML and reduced motion');
} finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }

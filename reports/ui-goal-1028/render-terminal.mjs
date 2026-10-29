import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { withBrowser, load, screenshot, sleep } from 'file:///D:/atlias-site/research/benchmark-redesign-1027/idr-safe/browser.mjs';
const fixture = path.resolve(process.argv[2]);
const out = path.resolve(import.meta.dirname, 'terminal'); fs.mkdirSync(out, { recursive: true });
const xterm = 'D:/harness-work/atlias-ui-review-1024/node_modules/@xterm/xterm';
const names = ['footer', 'picker', 'picker-search', 'help', 'settings', 'session-recovered', 'narrow'];
for (const name of names) assert.ok(fs.existsSync(path.join(fixture, name + '.json')));
const server = http.createServer((req, res) => {
  if (req.url === '/xterm.js') { res.setHeader('content-type', 'text/javascript'); res.end(fs.readFileSync(path.join(xterm, 'lib/xterm.js'))); }
  else if (req.url === '/xterm.css') { res.setHeader('content-type', 'text/css'); res.end(fs.readFileSync(path.join(xterm, 'css/xterm.css'))); }
  else if (names.some(name => req.url === '/replay/' + name)) { res.setHeader('content-type', 'application/json'); res.end(fs.readFileSync(path.join(fixture, req.url.slice('/replay/'.length) + '.json'))); }
  else { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/xterm.css"><style>body{margin:0;padding:24px;background:#101116}#terminal{width:max-content}</style><div id="terminal"></div><script src="/xterm.js"></script><script>var term=new Terminal({cols:110,rows:30,fontSize:16,lineHeight:1.15,fontFamily:"Consolas,monospace",cursorBlink:false,theme:{background:"#101116",foreground:"#e9edf5"}});term.open(document.getElementById("terminal"))</script>'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const cases = [];
try {
  await withBrowser(async s => {
    await load(s, `http://127.0.0.1:${server.address().port}`, { width: 1160, height: 680, wait: 50 });
    for (const name of names) {
      const size = name === 'narrow' ? { width: 520, height: 390 } : { width: 1160, height: 680 };
      await s.send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 1, mobile: false });
      await s.evaluate(`(async()=>{term.reset();term.resize(110,30);for(const e of await (await fetch('/replay/${name}')).json()){if(e.data)await new Promise(resolve=>term.write(e.data,resolve));else term.resize(e.cols,e.rows)}return true})()`, { awaitPromise: true });
      await sleep(50);
      const text = await s.evaluate("(()=>{let a=[];for(let i=0;i<term.rows;i++)a.push(term.buffer.active.getLine(term.buffer.active.viewportY+i)?.translateToString(true)||'');return a.join('\\n')})()");
      if (name === 'footer') assert.match(text, /Claude plan: 5h 0% used \/ week 99% used/);
      if (name === 'picker') assert.match(text, /Resume session/);
      if (name === 'picker-search') { assert.match(text, /Resume session \(1 of 1\)/); assert.match(text, /Search: Project 39/); }
      fs.writeFileSync(path.join(out, name + '.png'), await screenshot(s)); cases.push({ name, ...size, text });
    }
  });
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ passed: true, actualConPTYBytes: true, fixture, cases }, null, 2));
  console.log(JSON.stringify({ passed: true, screens: cases.length, out }));
} finally { await new Promise(resolve => server.close(resolve)); }

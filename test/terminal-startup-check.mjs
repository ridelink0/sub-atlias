import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Exercises the real agent startup and clean slash-command exit. The stream rig
// complements the manual installed PTY check; it never sends a model request.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlias-startup-'));
const agentPath = path.join(root, 'lib/agent.mjs');
function boot(modulePath) {
  const home = fs.mkdtempSync(path.join(scratch, 'state-'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ update: { autoPrompt: false } }));
  const probe = `
    import { PassThrough } from 'node:stream';
    const input = new PassThrough(), output = new PassThrough(); let painted = '';
    input.isTTY = output.isTTY = true; output.columns = 96; output.rows = 30;
    input.setRawMode = (on) => { input.isRaw = on; };
    output.on('data', chunk => { painted += chunk.toString(); });
    const originalIn = process.stdin, originalOut = process.stdout;
    Object.defineProperty(process, 'stdin', { value: input, configurable: true });
    Object.defineProperty(process, 'stdout', { value: output, configurable: true });
    const timer = setInterval(() => { if (painted.includes('Message Atlias') && input.isRaw) { clearInterval(timer); input.emit('data', '/exit'); input.emit('data', '\\r'); } }, 10);
    try {
      const agent = await import(${JSON.stringify(pathToFileURL(modulePath).href)});
      const code = await agent.repl({ engine: 'echo', sandbox: false });
      originalOut.write(JSON.stringify({ code, welcome: painted.includes('ATLIAS 4.0.0'), composer: painted.includes('Message Atlias'), rawRestored: !input.isRaw }) + '\\n');
    } finally { clearInterval(timer); Object.defineProperty(process, 'stdin', { value: originalIn }); Object.defineProperty(process, 'stdout', { value: originalOut }); }
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: scratch, env: { ...process.env, TERM: 'xterm-256color', ATLIAS_HOME: home, ATLIAS_NO_IMPORT_OFFER: '1' },
    encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
}
try {
  const good = boot(agentPath);
  assert.equal(good.status, 0, good.stderr || String(good.error));
  assert.deepEqual(JSON.parse(good.stdout.trim()), { code: 0, welcome: true, composer: true, rawRestored: true });
  console.log('PASS real agent startup reaches the default composer and /exit restores raw input');
  let mutant = fs.readFileSync(agentPath, 'utf8');
  assert.ok(mutant.includes('import { VERSION, config,'));
  mutant = mutant.replace('import { VERSION, config,', 'import { config,');
  mutant = mutant.replace(/(from\s+|import\()(['"])(\.{1,2}\/[^'"]+)\2/g,
    (_, prefix, quote, rel) => prefix + quote + pathToFileURL(path.resolve(path.dirname(agentPath), rel)).href + quote);
  const mutantPath = path.join(scratch, 'agent-mutant.mjs'); fs.writeFileSync(mutantPath, mutant);
  const bad = boot(mutantPath);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /ReferenceError: VERSION is not defined/);
  console.log('PASS removed-version-import mutation fails at actual composer startup');
} finally {
  assert.ok(path.resolve(scratch).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(scratch, { recursive: true, force: true });
}

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const app = 'D:/atlias-max-app';
const evidence = path.resolve(import.meta.dirname, '../ui-goal-1028');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const cases = [
  ['app-unit-node-final', 29, 'unit'],
  ['app-windows-node-final-dev', 29, 'window'],
  ['app-windows-package-node-final', null, 'package'],
  ['app-windows-node-final-packaged', 29, 'window'],
  ['app-linux-node-final-unit', 29, 'unit'],
  ['app-linux-node-final-e2e', 28, 'window'],
];
const results = [];
let linuxBundleMapping;
for (const [name, count, type] of cases) {
  const r = json(path.join(evidence, name, 'receipt.json'));
  const log = fs.readFileSync(path.join(evidence, name, 'output.log'), 'utf8');
  assert.equal(r.exit, 0, name);
  assert.equal(r.sourceUnchanged, true, name);
  assert.deepEqual(r.before, r.after, name);
  for (const [file, hash] of Object.entries(r.after)) {
    const current = fs.readFileSync(path.join(app, file));
    if (name.startsWith('app-linux-') && file === 'dist/renderer/app.js') {
      const linux = execFileSync('wsl', ['-d', 'Ubuntu', '--', 'cat', `${r.cwd}/${file}`], { maxBuffer: 8 * 1024 * 1024, windowsHide: true });
      assert.equal(sha(linux), hash, `${name}: original Linux bundle`);
      // esbuild resolves the read-only dependency symlink to its existing Linux CI location.
      // Only module labels differ; require every byte to match after that one exact prefix mapping.
      const normalized = Buffer.from(linux.toString('utf8').replaceAll('../atlias-max-ci/app/node_modules/', 'node_modules/'));
      assert.ok(normalized.equals(current), `${name}: normalized Linux bundle`);
      linuxBundleMapping = { rawSha256: hash, normalizedSha256: sha(normalized), mapping: '../atlias-max-ci/app/node_modules/ -> node_modules/' };
    } else assert.equal(sha(current), hash, `${name}: current ${file}`);
  }
  if (type === 'unit') {
    assert.match(log, new RegExp(`^# pass ${count}$`, 'm'), name);
    for (const key of ['fail', 'skipped', 'cancelled']) assert.match(log, new RegExp(`^# ${key} 0$`, 'm'), name);
  }
  if (type === 'window') {
    assert.equal((log.match(/^PASS /gm) || []).length, count, name);
    assert.equal((log.match(/^FAIL /gm) || []).length, 0, name);
  }
  results.push({ name, count, type, exit: r.exit, sourceFilesUnchanged: Object.keys(r.before).length, finished: r.finished });
}
const terminal = json(path.join(evidence, 'app-terminal-adversarial/receipt.json'));
assert.equal(terminal.intendedFailure, true);
assert.equal(terminal.restored, true);
assert.equal(terminal.restoredSha256, sha(fs.readFileSync(path.join(app, 'dist/renderer/app.js'))));
const updater = json(path.join(evidence, 'app-updater-adversarial/receipt.json'));
assert.equal(updater.positive.status, 0);
assert.equal(updater.rejectedForIntendedReason, true);
assert.equal(updater.sourceUnchanged, true);
const contrast = {};
for (const dir of ['codex-windows-node-final-dev-1029', 'codex-windows-node-final-packaged-1029', 'codex-linux-node-final-e2e-1029']) {
  const samples = json(path.join(app, 'reports', dir, 'terminal-contrast.json'));
  assert.equal(samples.length, 32, dir);
  assert.equal(new Set(samples.map(s => `${s.mode}:${s.ansi}`)).size, 32, dir);
  assert.ok(samples.every(s => Number.isFinite(s.ratio) && s.ratio >= 4.5), dir);
  contrast[dir] = { samples: samples.length, minimum: Math.min(...samples.map(s => s.ratio)) };
}
const resources = 'D:/atlias-test-runs/codex-app-node-final-1029/Atlias Max-win32-x64/resources';
const require = createRequire(path.join(app, 'package.json'));
const asar = require('@electron/asar');
const packaged = {};
for (const file of ['src/main/main.mjs', 'src/main/updates.mjs', 'dist/renderer/app.js']) {
  const bytes = asar.extractFile(path.join(resources, 'app.asar'), path.normalize(file));
  assert.ok(bytes.equals(fs.readFileSync(path.join(app, file))), file);
  packaged[file] = sha(bytes);
}
const runtime = fs.readFileSync(path.join(resources, 'node/win32-x64/node.exe'));
assert.ok(runtime.equals(fs.readFileSync(path.join(app, 'vendor/node/win32-x64/node.exe'))));
packaged.consoleNodeSha256 = sha(runtime);
const vendor = json(path.join(app, 'VENDOR.json'));
assert.ok(JSON.stringify(vendor).includes('1cb3b18e42fbefb144f5fecab3fc234426d2993b'));
const report = { checkedAt: new Date().toISOString(), results, contrast, packaged, linuxBundleMapping, adversarial: { terminal, updater }, fullAppComplete: false, macOSNativeVerified: false, linuxRealDesktopVerified: false, liveBillingVerified: false };
fs.writeFileSync(path.join(evidence, 'app-local-qualification-1029.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

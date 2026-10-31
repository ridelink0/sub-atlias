import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'atlias-provider-plants-'));
function absoluteImports(code, origin) {
  return code.replace(/from '(\.[^']+)'/g, (_, relative) => `from '${new URL(relative, origin).href}'`)
    .replace(/import\('(\.[^']+)'\)/g, (_, relative) => `import('${new URL(relative, origin).href}')`)
    .replace(/new URL\('(\.[^']+)', import.meta.url\)/g, (_, relative) => `new URL('${new URL(relative, origin).href}')`)
    .replaceAll('import.meta.dirname', JSON.stringify(path.dirname(fileURLToPath(origin))));
}
const receipt = { checkedAt: new Date().toISOString(), plants: [] };
const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;
try {
  for (const plant of [
    { name: 'failed-response-tools', module: 'direct-transports.mjs', test: 'direct-transports.test.mjs',
      anchor: "if (response.status !== 'completed' && response.status !== 'incomplete')", replacement: 'if (false)' },
    { name: 'oversized-tool-arguments', module: 'direct-transports.mjs', test: 'direct-transports.test.mjs',
      anchor: 'if (depth > 64) return false;', replacement: 'if (depth > 64) return true;' },
    { name: 'personal-license-marker', module: 'chatgpt.mjs', test: 'direct-auth.test.mjs',
      anchor: 'm.commit === SDK_PIN && m.personalOnly === true', replacement: 'm.commit === SDK_PIN' },
    { name: 'incomplete-install-readiness', module: 'chatgpt.mjs', test: 'direct-auth.test.mjs',
      anchor: ' && m.installComplete === true', replacement: '' },
    { name: 'no-plaintext-fallback', module: 'credential-protection.mjs', test: 'direct-auth.test.mjs',
      anchor: "if (platform !== 'win32')", replacement: 'if (false)' },
    { name: 'failed-install-publication', directory: 'scripts', module: 'setup-chatgpt-personal.mjs', test: 'personal-setup.test.mjs',
      anchor: "if (r.status !== 0) throw Error('Personal SDK dependencies were not installed.');", replacement: '/* planted missing dependency failure guard */' },
    { name: 'native-cli-auth-wiring', directory: 'bin', module: 'atlias.mjs', test: 'direct-auth.test.mjs',
      anchor: ', api: agent.slashApi', replacement: '' },
  ]) {
    const modulePath = path.join(root, plant.directory || 'lib', plant.module);
    const original = fs.readFileSync(modulePath, 'utf8');
    assert.ok(original.includes(plant.anchor), plant.name + ' source anchor');
    const mutatedPath = path.join(scratch, plant.module);
    fs.writeFileSync(mutatedPath, absoluteImports(original.replace(plant.anchor, plant.replacement), pathToFileURL(modulePath)));
    const syntax = spawnSync(process.execPath, ['--check', mutatedPath], { encoding: 'utf8', windowsHide: true });
    assert.equal(syntax.status, 0, plant.name + ' remains valid code');
    const testPath = path.join(root, 'test', plant.test);
    const testSource = absoluteImports(fs.readFileSync(testPath, 'utf8'), pathToFileURL(testPath));
    const baselineTest = path.join(scratch, 'baseline-' + plant.name + '.mjs');
    fs.writeFileSync(baselineTest, testSource);
    const baseline = spawnSync(process.execPath, ['--test', baselineTest], { env: childEnv, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(baseline.status, 0, plant.name + ' relocated unmodified check must pass: ' + baseline.stdout + baseline.stderr);
    const originalURL = pathToFileURL(modulePath).href;
    assert.ok(testSource.includes(originalURL), plant.name + ' test imports the module');
    const mutantTest = path.join(scratch, 'check-' + plant.name + '.mjs');
    fs.writeFileSync(mutantTest, testSource.replaceAll(originalURL, pathToFileURL(mutatedPath).href));
    const result = spawnSync(process.execPath, ['--test', mutantTest], { env: childEnv, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.status, 1, plant.name + ' regression must fail');
    assert.match(result.stderr + result.stdout, /ERR_ASSERTION|AssertionError/, plant.name + ' fails an assertion, not setup');
    receipt.plants.push({ name: plant.name, sourceSHA256: createHash('sha256').update(original).digest('hex'), baselineExitCode: baseline.status, syntaxExitCode: syntax.status, testExitCode: result.status, caught: true });
  }
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  assert.ok(path.resolve(scratch).startsWith(path.resolve(os.tmpdir()) + path.sep));
  assert.ok(path.basename(scratch).startsWith('atlias-provider-plants-'));
  fs.rmSync(scratch, { recursive: true, force: true });
}

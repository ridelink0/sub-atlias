// Gev: all installer effects below are confined to a separate child home.
export default function hostConfigSuites({ suite, check, TMP, ROOT, fs, path, spawnSync }) {
  suite('host config expert', 'host config: installation preserves unreadable or malformed existing JSON', () => {
    const script = path.join(TMP, 'host-config-child.mjs');
    fs.writeFileSync(script, `
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [root, target, mode] = process.argv.slice(2);
const core = await import(pathToFileURL(path.join(root, 'lib/core.mjs')));
const hosts = await import(pathToFileURL(path.join(root, 'lib/hosts.mjs')));
const taskHome = os.homedir();
for (const p of [core.CODEX_DIR, core.GEMINI_DIR, core.STATE_DIR]) {
  if (!path.resolve(p).startsWith(path.resolve(taskHome) + path.sep)) throw new Error('fixture isolation failed');
}
const routes = {
  codex: [path.join(core.CODEX_DIR, 'hooks.json'), () => hosts.installCodex()],
  gemini: [path.join(core.GEMINI_DIR, 'settings.json'), () => hosts.installGemini(false)],
  antigravity: [path.join(core.GEMINI_DIR, 'config', 'mcp_config.json'), () => hosts.installAntigravity()],
};
const [file, install] = routes[target];
fs.mkdirSync(path.dirname(file), { recursive: true });
const texts = { valid: '{"unrelated":{"retain":true}}', bom: '\\uFEFF{"unrelated":{"retain":true}}', malformed: 'PRIVATE_CONFIG_SENTINEL=unfinished', array: '[{"retain":true}]', null: 'null', denied: '{"unrelated":{"retain":true}}' };
const original = texts[mode];
if (original !== undefined) fs.writeFileSync(file, original);
const read = fs.readFileSync;
if (mode === 'denied') fs.readFileSync = function(p, ...args) {
  if (String(p) === file) { const error = new Error('synthetic read refusal'); error.code = 'EACCES'; throw error; }
  return read.call(this, p, ...args);
};
let error = null;
try { install(); } catch (e) { error = String(e.message); }
finally { fs.readFileSync = read; }
const after = fs.readFileSync(file, 'utf8');
const refused = ['malformed', 'array', 'null', 'denied'].includes(mode);
const preserved = refused ? after === original : (mode === 'missing' || JSON.parse(after).unrelated?.retain === true);
console.log(JSON.stringify({ refused: error !== null, preserved, error, expectedRefusal: refused }));
`);
    for (const target of ['codex', 'gemini', 'antigravity']) {
      for (const mode of ['valid', 'bom', 'missing', 'malformed', 'array', 'null', 'denied']) {
        const taskHome = fs.mkdtempSync(path.join(TMP, 'host-json-'));
        const env = { ...process.env, HOME: taskHome, USERPROFILE: taskHome, CODEX_HOME: path.join(taskHome, '.codex'), CLAUDE_CONFIG_DIR: path.join(taskHome, '.claude'), ATLIAS_HOME: path.join(taskHome, '.atlias'), ATLIAS_NO_DETACH: '1' };
        const run = spawnSync(process.execPath, [script, ROOT, target, mode], { encoding: 'utf8', env, timeout: 10000, windowsHide: true });
        let result;
        try { result = JSON.parse(run.stdout); } catch { result = null; }
        const ok = run.status === 0 && result && result.refused === result.expectedRefusal && result.preserved === true;
        check(`${target} ${mode}: refuse unsafe reads and preserve unrelated data`, ok, { happened: result ? JSON.stringify(result) : String(run.stderr), why: 'An unreadable or unfinished existing config is not an empty config; replacing it loses the user settings.', fix: 'Read existing JSON strictly before any installer write; allow only a missing file as empty.' });
        if (result?.error) check(`${target} ${mode}: diagnostics keep configuration contents private`, !result.error.includes('PRIVATE'), { happened: 'error inspected for the fixture secret', why: 'JSON parser errors can include configuration secrets.', fix: 'Report the path and error class without the JSON contents.' });
      }
    }
  });
}

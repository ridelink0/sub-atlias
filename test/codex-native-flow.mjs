// Real hook processes and interpreter exits, using Codex's observed native
// journal schema. No model, editor, host configuration write or API call.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlias-codex-flow-'));
const env = { ...process.env, ATLIAS_HOME: path.join(tmp, 'state'), CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'), CODEX_HOME: path.join(tmp, 'codex'), ATLIAS_NO_DETACH: '1' };
const hookFile = path.join(root, 'lib/hooks.mjs');
const receipts = [];
try {
  for (const scenario of ['pass', 'failed', 'pending', 'edited-after-check']) {
    const cwd = path.join(tmp, scenario); fs.mkdirSync(cwd, { recursive: true });
    const sid = 'native-' + scenario, turn = sid + '-turn';
    const base = { session_id: sid, turn_id: turn, cwd };
    const hook = (name, payload) => {
      const result = spawnSync(process.execPath, [hookFile, name, '--host', 'codex'], { cwd, env, input: JSON.stringify({ ...base, ...payload }), encoding: 'utf8', timeout: 20000 });
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
      return result.stdout.trim() ? JSON.parse(result.stdout) : null;
    };
    hook('prompt', { prompt: 'Implement and check this small change.' });
    const file = path.join(cwd, 'app.mjs'); fs.writeFileSync(file, 'export const value = 1;\n');
    const editAt = Date.now();
    hook('post-tool', { tool_name: 'apply_patch', tool_use_id: 'patch', tool_input: { patch: `*** Begin Patch\n*** Add File: ${file}\n+export const value = 1;\n*** End Patch` }, tool_response: 'Success. Updated the following files.' });
    const program = `const assert=require('node:assert/strict'); assert.equal(1,${scenario === 'failed' ? 2 : 1}); console.log('native-flow');`;
    const command = `node -e ${JSON.stringify(program)}`, started = Date.now();
    const run = spawnSync(process.execPath, ['-e', program], { cwd, env, encoding: 'utf8', timeout: 10000 });
    const completed = Date.now(); assert.equal(run.status, scenario === 'failed' ? 1 : 0);
    hook('post-tool', { tool_name: 'Bash', tool_use_id: 'exec-native', tool_input: { command }, tool_response: run.stdout + run.stderr });
    const native = (item, start, end) => ({ type: 'event_msg', payload: { type: 'item_completed', thread_id: sid, turn_id: turn, started_at_ms: start, completed_at_ms: end, item } });
    const rows = [native({ type: 'FileChange', id: 'patch', status: 'completed', changes: { [file]: { type: 'add' } } }, editAt, editAt)];
    if (scenario !== 'pending') rows.push(native({ type: 'CommandExecution', id: 'exec-native', command: [process.execPath, '-e', program], cwd: pathToFileURL(cwd).href, status: 'completed', exit_code: run.status, aggregated_output: run.stdout + run.stderr }, started, completed));
    if (scenario === 'edited-after-check') {
      fs.appendFileSync(file, 'export const later = true;\n');
      rows.push(native({ type: 'FileChange', id: 'later', status: 'completed', changes: { [file]: { type: 'update' } } }, completed + 1, completed + 2));
    }
    const transcript = path.join(cwd, 'native.jsonl'); fs.writeFileSync(transcript, rows.map(JSON.stringify).join('\n') + '\n');
    const result = hook('stop', { transcript_path: transcript, last_assistant_message: 'The checks passed. Done. Pass 1: assertions passed. Pass 2: adversarial read completed.' });
    assert.equal(result?.decision === 'block', scenario !== 'pass', `${scenario}: ${JSON.stringify(result)}`);
    if (scenario === 'failed') assert.match(result.reason, /fail|unsuccessful/);
    if (scenario === 'pending') assert.match(result.reason, /unknown/);
    receipts.push({ scenario, actualExit: run.status, gate: result?.decision || 'quiet', reason: result?.reason || null });
  }
  console.log(JSON.stringify({ passed: receipts.length, receipts }, null, 2));
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }

import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validate, tokens } from '../lib/provider.mjs';
import { nativeOptions, usageReader } from '../lib/subharness.mjs';
import { resolveCommand } from '../lib/resolve-command.mjs';
import { VERSION } from '../lib/core.mjs';
import { TOOLS } from '../mcp/tools.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(packageJson.name, 'sub-atlias');
assert.equal(VERSION, packageJson.version);
assert.equal(packageJson.bin['atlias'], 'bin/atlias.mjs');
for (const privatePath of ['lib/agent.mjs', 'lib/loop.mjs', 'lib/eval.mjs', 'lib/bench.mjs', 'evals']) {
  assert.equal(fs.existsSync(path.join(root, privatePath)), false, `${privatePath} must not be present in the public subharness tree`);
}
assert.equal(fs.existsSync(path.join(root, 'lib/usage.mjs')), false, 'the Usage Limits plugin reader must not ship');
// The Claude plan route (Claude Agent SDK on a person's own Claude login) is founder-only until Anthropic approves offering it in a product (Gev, 2026-10-22).
assert.equal(fs.existsSync(path.join(root, 'lib/claude-plan.mjs')), false, 'the founder-only Claude plan engine must not ship in the public package');
for (const rel of ['bin/atlias.mjs', 'package.json', ...fs.readdirSync(path.join(root, 'lib')).map((f) => 'lib/' + f)]) assert.doesNotMatch(fs.readFileSync(path.join(root, rel), 'utf8'), /claude-agent-sdk|claude-plan/i, rel + ' must not reference the founder-only Claude plan route');
for (const sourcePath of ['lib/brief.mjs', 'lib/settings.mjs', 'lib/core.mjs']) {
  const source = fs.readFileSync(path.join(root, sourcePath), 'utf8');
  assert.doesNotMatch(source, /usage-limits|usageLimits|usage\.show|usage-limits-live\.json/i, `${sourcePath} must not wire the Usage Limits plugin into Atlias`);
}
const briefSource = fs.readFileSync(path.join(root, 'lib/brief.mjs'), 'utf8');
assert.match(briefSource, /import \* as graph from '\.\/graph\.mjs'/, 'normal brief integrations must remain intact');
const settingsSource = fs.readFileSync(path.join(root, 'lib/settings.mjs'), 'utf8');
assert.match(settingsSource, /agent\.engine/, 'normal settings must remain available');

const profile = validate({ protocol: 'responses', baseUrl: 'http://127.0.0.1:11435/v1', model: 'local-test', keyEnv: 'TEST_TOKEN' });
assert.equal(profile.baseUrl, 'http://127.0.0.1:11435/v1');
assert.throws(() => validate({ protocol: 'responses', baseUrl: 'http://api.example.test/v1', model: 'm' }), /HTTPS/);
assert.deepEqual(tokens({ input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 3 } }, 'responses'), {
  input: 7, output: 2, cacheRead: 3, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, totalInput: 10, total: 12,
});

const request = nativeOptions('codex', { protocol: 'responses', model: 'm' }, { base: 'http://127.0.0.1:1234', token: 'local-only' }, ['exec', 'resume', 'session-id']);
assert.deepEqual(request.args.slice(0, 2), ['exec', 'resume']);
assert.ok(request.args.includes('model_providers.atlias_api.base_url="http://127.0.0.1:1234/v1"'));
assert.equal(request.env.ATLIAS_GATEWAY_TOKEN, 'local-only');
assert.throws(() => nativeOptions('unknown', { protocol: 'responses' }, { base: 'http://127.0.0.1:1', token: 'local' }), /--host must be claude or codex/);
const winShim = resolveCommand('claude', ['--version'], {
  platform: 'win32', env: { PATH: 'C:\\npm' },
  read: () => '"%dp0%\\node_modules\\claude\\cli.js" %*',
});
assert.equal(winShim.file, process.execPath);
assert.deepEqual(winShim.args, ['C:\\npm\\node_modules\\claude\\cli.js', '--version']);

const reader = usageReader('responses', true);
reader.push('data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":2}}}\n');
assert.deepEqual(reader.finish().tokens, { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, totalInput: 10, total: 12 });

const toolNames = new Set(TOOLS.map((tool) => tool.name));
const READ_ONLY = { harness_recall: true, harness_remember: false, harness_progress: false, harness_verify: true, harness_digest: false, harness_status: true, graph_query: true, graph_affected: true, graph_explain: true };
assert.deepEqual([...toolNames].sort(), Object.keys(READ_ONLY).sort());
for (const tool of TOOLS) {
  for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) assert.equal(typeof tool.annotations?.[hint], 'boolean', `${tool.name} declares ${hint}`);
  assert.equal(tool.annotations.readOnlyHint, READ_ONLY[tool.name], `${tool.name} read-only hint`);
  assert.equal(tool.annotations.destructiveHint, false, `${tool.name} never destroys data`);
}
assert.equal(toolNames.has('harness_bench'), false);

const cli = spawnSync(process.execPath, [path.join(root, 'bin', 'atlias.mjs'), '--help'], { encoding: 'utf8' });
assert.equal(cli.status, 0, cli.stderr);
assert.match(cli.stdout, /atlias install/);
assert.doesNotMatch(cli.stdout, /agent --engine|eval --tier|harness_bench/);
const invalidInstall = spawnSync(process.execPath, [path.join(root, 'bin', 'atlias.mjs'), 'install', '--unknown-host'], { encoding: 'utf8' });
assert.equal(invalidInstall.status, 2);
assert.match(invalidInstall.stderr, /Unsupported host option/);
const positionalInstall = spawnSync(process.execPath, [path.join(root, 'bin', 'atlias.mjs'), 'install', 'typo', '--codex'], { encoding: 'utf8' });
assert.equal(positionalInstall.status, 2);
assert.match(positionalInstall.stderr, /Unsupported host option/);
const noHost = spawnSync(process.execPath, [path.join(root, 'bin', 'atlias.mjs'), 'uninstall'], { encoding: 'utf8' });
assert.equal(noHost.status, 2);
assert.match(noHost.stderr, /Choose a host/);

console.log('public package checks passed');

// Compaction hooks (Gev, 2026-10-22: Claude Code rejected both as "Hook JSON output validation
// failed"). PreCompact's plain stdout is Claude Code's extra summary instructions; PostCompact's
// output only reaches the user, and the handoff note goes back through SessionStart.
{
  const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atlias-compact-'));
  const env = { ...process.env, ATLIAS_HOME: path.join(tmpCwd, 'home'), CLAUDE_PLUGIN_ROOT: root };
  const hook = (ev) => spawnSync(process.execPath, [path.join(root, 'lib/hooks.mjs'), ev], { input: JSON.stringify({ session_id: 's1', cwd: tmpCwd, trigger: 'manual', hook_event_name: ev }), encoding: 'utf8', env, cwd: tmpCwd });
  const pre = hook('pre-compact');
  assert.equal(pre.status, 0);
  assert.match(pre.stdout, /^atlias: keep in the summary/, 'PreCompact prints plain instructions');
  assert.doesNotMatch(pre.stdout, /hookSpecificOutput/, 'PreCompact must not print hookSpecificOutput, which Claude Code rejects');
  const post = hook('post-compact');
  assert.equal(post.status, 0);
  assert.equal(post.stdout.trim(), '', 'PostCompact prints nothing; the note returns through SessionStart');
}

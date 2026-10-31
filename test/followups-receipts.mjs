// Run the documented supplemental no-model suites with private homes.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const root = path.resolve(import.meta.dirname, '..');
const folder = path.join(root, 'checks-steer'); fs.mkdirSync(folder, { recursive: true });
const env = { ...process.env, ATLIAS_HOME: path.join(folder, 'home'), CLAUDE_CONFIG_DIR: path.join(folder, 'claude'), CODEX_HOME: path.join(folder, 'codex'), GEMINI_CLI_HOME: path.join(folder, 'gemini'), ATLIAS_NO_DETACH: '1' };
const commands = [
  ['install-sandbox', ['test/install-sandbox.mjs']],
  ['node-test', ['--test', ...fs.readdirSync(path.join(root, 'test')).filter(f => f.endsWith('.test.mjs')).map(f => 'test/' + f)]],
  ['search-functional', ['test/evolution-search-functional.mjs']],
  ['search-adversarial', ['test/evolution-search-adversarial.mjs']],
  ['controller-functional', ['test/evolution-controller-functional.mjs']],
  ['controller-adversarial', ['test/evolution-controller-adversarial.mjs']],
  ['codex-native-flow', ['test/codex-native-flow.mjs']],
  ['native-media', ['test/native-media-check.mjs']],
  ['native-media-plain', ['test/native-media-check.mjs', '--plain']],
  ['native-terminal-usability', ['test/native-terminal-usability-check.mjs']],
  ['terminal-default', ['test/terminal-default-check.mjs']],
  ['native-account-resume', ['test/native-account-resume-check.mjs']],
];
const receipts = [];
for (const [name, args] of commands) {
  const log = path.join(folder, name + '.log'), fd = fs.openSync(log, 'w');
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', fd, fd], windowsHide: true });
  const result = await new Promise(resolve => { child.once('error', e => resolve({ exit: null, error: e.message })); child.once('exit', (exit, signal) => resolve({ exit, signal })); });
  fs.closeSync(fd);
  const text = fs.readFileSync(log, 'utf8');
  const counts = text.split(/\r?\n/).filter(line => /checks passed|tests |pass |fail |skipped|passed|failed|scenarios|assertions/i.test(line)).slice(-12);
  receipts.push({ name, command: 'node ' + args.join(' '), ...result, counts });
  fs.writeFileSync(path.join(folder, 'receipts.json'), JSON.stringify(receipts, null, 2));
  console.log(JSON.stringify(receipts.at(-1)));
}
process.exitCode = receipts.every(r => r.exit === 0) ? 0 : 1;

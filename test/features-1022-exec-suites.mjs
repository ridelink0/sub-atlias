// H.A.C council round two (2026-10-22, h2), feature 2: atlias exec --output-format and --permissions.
// The echo engine is used, so no model is called. The suite runs the real bin in a fresh project folder.
import { spawnSync } from 'node:child_process';

export default function execFormatSuites({ suite, check, TMP, ROOT, fs, path }) {
  const proj = path.join(TMP, 'exec-project');
  fs.mkdirSync(proj, { recursive: true });
  const bin = path.join(ROOT, 'bin', 'atlias.mjs');
  const run = (args) => spawnSync(process.execPath, [bin, 'exec', ...args], { cwd: proj, encoding: 'utf8', env: process.env, timeout: 120000 });
  const lines = (out) => String(out || '').split(/\r?\n/).filter((l) => l.trim());
  suite('exec format expert', 'exec stream-json: one JSON object per line, from start to done', () => {
    const r = run(['hello there', '--engine', 'echo', '--output-format', 'stream-json']);
    const evs = lines(r.stdout).map((l) => { try { return JSON.parse(l); } catch { return { type: 'unparsed', line: l }; } });
    check('stream-json exits 0 and every line is a JSON object', r.status === 0 && evs.length >= 3 && evs.every((e) => e.type !== 'unparsed'), { happened: `exit ${r.status}; ${r.stdout.slice(0, 200)} ${r.stderr.slice(0, 200)}`, why: 'A script reading the stream must be able to parse every line.', fix: 'Check the emit calls in lib/agent.mjs execOnce and the exec case in bin/atlias.mjs.' });
    check('the stream starts with start and ends with done, with the stop reason', evs[0] && evs[0].type === 'start' && evs[evs.length - 1].type === 'done' && evs[evs.length - 1].stop_reason === 'answered', { happened: evs.map((e) => e.type).join(','), why: 'A consumer needs a start and a done to know the run began and how it ended.', fix: 'Emit start before the turn and done after it, with the stop reason.' });
    const asst = evs.find((e) => e.type === 'assistant');
    check('the assistant text is carried in the stream', asst && asst.text === 'echo: hello there' && evs[evs.length - 1].cache !== undefined, { happened: JSON.stringify(asst), why: 'The reply must reach a script without parsing the terminal.', fix: 'Emit the assistant event with the reply text.' });
  });
  suite('exec format expert', 'exec text and json: the default output is what it was', () => {
    const plain = run(['hello there', '--engine', 'echo']);
    check('the default output is the plain reply', plain.status === 0 && plain.stdout.trim() === 'echo: hello there', { happened: JSON.stringify(plain.stdout), why: 'Scripts already read the plain text; the default must not change.', fix: 'Print res.text when no format is given.' });
    const js = run(['hello there', '--engine', 'echo', '--json']);
    let parsed = null;
    try { parsed = JSON.parse(js.stdout); } catch { /* checked below */ }
    check('--json still prints one JSON object with the reply', parsed && parsed.reply === 'echo: hello there', { happened: js.stdout.slice(0, 160), why: '--json is in use already; the new flag must not break it.', fix: 'Keep the json branch for --json.' });
  });
  suite('exec format expert', 'exec --permissions: a named mode is used for the run, and bad values are refused', () => {
    const ro = run(['hello there', '--engine', 'echo', '--output-format', 'stream-json', '--permissions', 'read-only']);
    const start = lines(ro.stdout).map((l) => { try { return JSON.parse(l); } catch { return {}; } }).find((e) => e.type === 'start');
    check('--permissions read-only is the mode the run starts with', ro.status === 0 && start && start.permissions === 'read-only', { happened: `${ro.status}; ${JSON.stringify(start)}`, why: 'The flag must set the mode the tools check against.', fix: 'Pass permissions into runOnce and apply setRunOverride for the run.' });
    const badFmt = run(['hello there', '--engine', 'echo', '--output-format', 'xml']);
    check('an unknown --output-format is refused with exit 2', badFmt.status === 2 && /stream-json/.test(badFmt.stdout), { happened: `${badFmt.status}; ${badFmt.stdout.slice(0, 120)}`, why: 'A typo must not silently print text.', fix: 'Validate the format before running.' });
    const badPerm = run(['hello there', '--engine', 'echo', '--permissions', 'yolo']);
    check('an unknown --permissions value is refused with exit 2', badPerm.status === 2 && /read-only, plan, workspace or auto/.test(badPerm.stdout), { happened: `${badPerm.status}; ${badPerm.stdout.slice(0, 120)}`, why: 'An unknown mode must never fall back to a looser one.', fix: 'Validate the value before running.' });
  });
}

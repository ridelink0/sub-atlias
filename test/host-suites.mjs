// What each host really sends, pinned to its source. Codex shapes come from
// openai/codex: apply_patch hooks get tool_input {command: "<patch>"}
// (codex-rs/core/src/tools/handlers/apply_patch.rs), shell hooks get tool_name
// "Bash" with {command} and a plain string tool_response with no exit code
// (unified_exec), and PreToolUse fails open on permissionDecision "ask"
// (codex-rs/hooks/src/events/pre_tool_use.rs). Loaded by test/run.mjs.
import * as core from '../lib/core.mjs';
import * as guard from '../lib/guard.mjs';
import * as track from '../lib/track.mjs';
import * as integrity from '../lib/integrity.mjs';
import * as hooksMod from '../lib/hooks.mjs';
import * as settings from '../lib/settings.mjs';
import * as pointer from '../lib/pointer.mjs';
import * as hostsMod from '../lib/hosts.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export default async function hostSuites({ suite, check, PROJECT }) {
  const NL = String.fromCharCode(10);
  const patch = ['*** Begin Patch', '*** Update File: src/a.js', '@@', '-x', '+y', '*** Add File: b.js', '+z', '*** Delete File: old.js', '*** Update File: c.js', '*** Move to: d.js', '*** End Patch'].join(NL);

  // Round five, PR-1. Claude Code cancels a command hook that reaches its
  // timeout and drops its output (Hooks reference), and in the 3.8.1 study it
  // cancelled 80 atlias hook calls in 22 of 34 runs at 8 seconds. The tool
  // hooks now get 30, as Stop has. PostToolUse is narrowed to the tools
  // track.postTool acts on, and PostToolUseFailure to the shell tools, which is
  // all postToolFailure reads; PreToolUse keeps ".*", because the loop guard
  // counts repeats of every tool and the destructive guard reads the shell.
  suite('hook budget expert', 'the tool hooks have room, and fire where they do something', () => {
    const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
    const group = (ev) => (doc.hooks[ev] || [])[0] || {};
    const timeoutOf = (ev) => ((group(ev).hooks || [])[0] || {}).timeout;
    const short = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop'].filter((ev) => !(timeoutOf(ev) >= 30));
    check('the tool hooks and Stop may take 30 seconds before the host cancels them', short.length === 0,
      { happened: short.map((ev) => `${ev} ${timeoutOf(ev)}s`).join(', '), why: 'A hook the host cancels at its timeout records nothing: a PostToolUse cancelled after a check leaves the gate saying no check ran, which cost a full-context round each time in the 3.8.1 study.', fix: 'Set timeout 30 on PreToolUse, PostToolUse, PostToolUseFailure and Stop in hooks/hooks.json.' });
    check('PreToolUse still fires for every tool', group('PreToolUse').matcher === '.*',
      { happened: String(group('PreToolUse').matcher), why: 'The loop guard counts identical calls of any tool (Grep, Glob, WebFetch, an MCP tool), and the destructive guard reads every shell command; a narrower matcher switches both off for the tools it leaves out.', fix: 'Keep matcher ".*" on PreToolUse.' });
    const names = (ev) => String(group(ev).matcher || '').split('|');
    // The proof that the narrowing loses nothing: for tools the matchers leave
    // out, both handlers return nothing and record nothing, with an input that
    // would be recorded (a check, a big code file) if the tool were one they
    // read.
    const others = ['Glob', 'Grep', 'LS', 'Task', 'Agent', 'TodoWrite', 'WebFetch', 'WebSearch', 'NotebookRead', 'ExitPlanMode', 'Skill', 'mcp__atlias__graph_query', 'mcp__github__get_file_contents', 'mcp__fs__write_file', 'BashOutput', 'KillShell'];
    const quietFor = (handler, sid) => {
      const said = others.filter((tool) => handler({ session_id: sid, cwd: PROJECT, tool_name: tool, tool_input: { command: 'npm test', file_path: path.join(PROJECT, 'big.js'), path: PROJECT, pattern: 'x' }, tool_response: { stdout: '', exit_code: 1 }, error: 'failed' }) !== null);
      return { said, recorded: core.events(sid) };
    };
    const acted = [...core.EDIT_TOOL_NAMES, ...core.SHELL_TOOL_NAMES, ...pointer.READ_TOOL_NAMES];
    const missed = acted.filter((n) => !names('PostToolUse').includes(n));
    const extra = names('PostToolUse').filter((n) => !acted.includes(n));
    const post = quietFor(track.postTool, 'hook-budget-post');
    check('PostToolUse fires for every tool track.postTool acts on, and only those', missed.length === 0 && extra.length === 0 && acted.every((n) => core.isEditTool(n) || core.isShellTool(n) || pointer.READ_TOOLS.test(n)) && post.said.length === 0 && post.recorded.length === 0 && !others.some((t) => names('PostToolUse').includes(t)),
      { happened: `matcher ${group('PostToolUse').matcher}; missing ${missed.join(',') || 'none'}; extra ${extra.join(',') || 'none'}; spoke for ${post.said.join(',') || 'none'}; recorded ${JSON.stringify(post.recorded).slice(0, 200)}`, why: 'The matcher may only leave out a tool the hook provably does nothing for: one left out that it acts on is an edit the gate never sees or a check it never records, and one kept that it ignores costs a Node start per call.', fix: 'Set the PostToolUse matcher to core.EDIT_TOOL_NAMES, core.SHELL_TOOL_NAMES and pointer.READ_TOOL_NAMES joined with |.' });
    const shellOnly = names('PostToolUseFailure');
    const fail = quietFor(track.postToolFailure, 'hook-budget-failure');
    check('PostToolUseFailure fires for the shell tools, the only ones it reads', shellOnly.length === core.SHELL_TOOL_NAMES.length && core.SHELL_TOOL_NAMES.every((n) => shellOnly.includes(n)) && fail.said.length === 0 && fail.recorded.length === 0,
      { happened: `matcher ${group('PostToolUseFailure').matcher}; spoke for ${fail.said.join(',') || 'none'}; recorded ${JSON.stringify(fail.recorded).slice(0, 200)}`, why: 'A failed check is recorded from this hook; a shell tool left out is a failing check the gate never hears about.', fix: 'Set the PostToolUseFailure matcher to core.SHELL_TOOL_NAMES joined with |.' });
    // Codex and Gemini CLI install the same handlers with their own budgets.
    const codex = Object.fromEntries(hostsMod.CODEX_EVENTS.map(([ev, , t, m]) => [ev, { t, m }]));
    const gem = Object.fromEntries(hostsMod.GEMINI_EVENTS.map(([ev, , t]) => [ev, t]));
    check('Codex and Gemini CLI give their tool hooks the same 30 seconds', codex.PreToolUse.t >= 30 && codex.PostToolUse.t >= 30 && codex.Stop.t >= 30 && gem.BeforeTool >= 30000 && gem.AfterTool >= 30000 && gem.AfterAgent >= 30000 && codex.PreToolUse.m === '.*' && codex.PostToolUse.m === '.*',
      { happened: JSON.stringify({ codex, gem }), why: 'The same handler runs in every host; a tighter budget in one is a cancellation that happens only there, the hardest kind to see.', fix: 'Raise the tool hooks in CODEX_EVENTS to 30 (seconds) and in GEMINI_EVENTS to 30000 (milliseconds); keep ".*" for Codex until its tool names are pinned.' });
  });

  suite('codex payload expert', 'Codex edits are seen', () => {
    const files = core.filesFromTool('apply_patch', { command: patch });
    check('a Codex patch names every file it adds, updates or renames to', ['src/a.js', 'b.js', 'c.js', 'd.js'].every((f) => files.includes(f)) && !files.includes('old.js'), { happened: JSON.stringify(files), why: 'Codex sends the patch in tool_input.command; reading only input or patch left every Codex edit invisible to the gate.', fix: 'Check filesFromTool.' });
    check('a patch with Windows line endings still names its files', core.filesFromTool('apply_patch', { command: patch.split(NL).join('\r\n') }).includes('src/a.js'), { happened: JSON.stringify(core.filesFromTool('apply_patch', { command: patch.split(NL).join('\r\n') })), why: 'Codex runs on Windows too.', fix: 'Trim each captured path.' });
    check('the older input and patch keys still work', core.filesFromTool('apply_patch', { input: patch }).includes('b.js') && core.filesFromTool('apply_patch', { patch }).includes('b.js'), { happened: 'an older shape was dropped', why: 'Not every Codex build is current.', fix: 'Keep input and patch in the list.' });
    check('the patch is not mistaken for a shell command', core.commandFromTool('apply_patch', { command: patch }) === null && core.commandFromTool('Bash', { command: 'npm test' }) === 'npm test', { happened: String(core.commandFromTool('apply_patch', { command: patch })).slice(0, 40), why: 'A patch that adds the text rm -rf to a file would otherwise look like a command.', fix: 'commandFromTool returns null for edit tools.' });
    check('a shell command that merely mentions a patch header is not an edit', core.filesFromTool('Bash', { command: 'echo "*** Update File: x.js is a header"' }).length === 0, { happened: JSON.stringify(core.filesFromTool('Bash', { command: 'echo "*** Update File: x.js is a header"' })), why: 'Only a real patch body starts a line with the header.', fix: 'Anchor the headers at the start of a line.' });
    const sid = 'codex-apply-patch';
    track.postTool({ session_id: sid, cwd: PROJECT, tool_name: 'apply_patch', tool_input: { command: patch }, tool_response: 'Success. Updated the following files:' + NL + 'M src/a.js' });
    const ev = core.events(sid).find((e) => e.kind === 'edit');
    check('a Codex edit reaches the session record the gate reads', ev && ev.tool === 'apply_patch' && ev.files.includes('src/a.js'), { happened: JSON.stringify(ev), why: 'The syntax, placeholder and wiring checks only look at recorded edits.', fix: 'Check track.postTool with a Codex payload.' });
    track.postTool({ session_id: sid, cwd: PROJECT, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: '1 failing' + NL + 'AssertionError: expected 2' });
    const sh = core.events(sid).filter((e) => e.kind === 'shell').pop();
    check('a Codex test run with no exit code is still read as failed from its text', sh && sh.verify && sh.outcome === 'fail', { happened: JSON.stringify(sh), why: 'Codex sends only the output string; the failure text is all there is to go on.', fix: 'integrity.verdict falls back to FAIL_RE.' });
    const quiet = integrity.verdict({ tool_response: 'all good' });
    check('and one with no failure text is unknown, never a pass', quiet.outcome === 'unknown', { happened: JSON.stringify(quiet), why: 'Without an exit code, silence is not proof.', fix: 'Only code 0 is a pass.' });
  });

  suite('stuck pattern expert', 'two calls taking turns are stopped in every host', () => {
    const sid = 'alternating-host';
    const A = { session_id: sid, cwd: PROJECT, tool_name: 'Read', tool_input: { file_path: 'a.js' } };
    const B = { session_id: sid, cwd: PROJECT, tool_name: 'Grep', tool_input: { pattern: 'x' } };
    const answers = [A, B, A, B, A, B].map((p) => guard.preTool(p, 'claude'));
    check('the sixth call of an A B A B A B run is denied', answers.slice(0, 5).every((r) => r === null) && answers[5] && answers[5].hookSpecificOutput.permissionDecision === 'deny' && /back and forth/.test(answers[5].hookSpecificOutput.permissionDecisionReason), { happened: JSON.stringify(answers.map((r) => r && r.hookSpecificOutput.permissionDecision)), why: 'Counting identical calls never sees a loop made of two different ones.', fix: 'Check the keys test in guard.preTool.' });
    // A seventh A is its fourth identical call, which the repeat guard rightly
    // stops; raise that threshold to see the alternating reset on its own.
    settings.set('guard.loopThreshold', '20');
    const s2 = 'alternating-reset';
    const A2 = { ...A, session_id: s2 };
    const B2 = { ...B, session_id: s2 };
    [A2, B2, A2, B2, A2].forEach((p) => guard.preTool(p, 'claude'));
    const sixth = guard.preTool(B2, 'claude');
    const seventh = guard.preTool(A2, 'claude');
    settings.reset('guard.loopThreshold');
    check('after the denial the pattern starts over, as the message says', sixth && sixth.hookSpecificOutput.permissionDecision === 'deny' && seventh === null, { happened: JSON.stringify([sixth && sixth.hookSpecificOutput.permissionDecision, seventh && seventh.hookSpecificOutput.permissionDecision]), why: 'A guard that keeps denying after promising a reset is a guard people turn off.', fix: 'Scan only after the last alternating deny.' });
  });

  suite('approval expert', 'destructive commands on hosts that cannot ask', () => {
    const cmd = 'git push --force origin main';
    const sid = 'codex-destructive';
    const pay = { session_id: sid, cwd: PROJECT, tool_name: 'Bash', tool_input: { command: cmd } };
    check('the command under test is one the guard flags', Boolean(guard.destructiveReason(cmd)), { happened: 'not flagged', why: 'Otherwise the rest of this suite proves nothing.', fix: 'Pick a command destructiveReason flags.' });
    const first = guard.preTool(pay, 'codex');
    check('on Codex it is denied, with an instruction to ask the user', first && first.hookSpecificOutput.permissionDecision === 'deny' && /Ask the user/.test(first.hookSpecificOutput.permissionDecisionReason), { happened: JSON.stringify(first), why: 'Codex runs the command anyway when a hook answers ask.', fix: 'Deny on hosts outside CAN_ASK.' });
    const again = guard.preTool(pay, 'codex');
    check('retrying without the user answering is denied again', again && again.hookSpecificOutput.permissionDecision === 'deny', { happened: JSON.stringify(again), why: 'The model must not approve its own command.', fix: 'Require a prompt event after the deny.' });
    core.recordEvent(sid, { kind: 'prompt', prompt_id: 'user-said-yes', text: 'yes, push it' });
    const allowed = guard.preTool(pay, 'codex');
    check('after the user answers, the identical command goes through', allowed === null, { happened: JSON.stringify(allowed), why: 'Otherwise the guard could never be satisfied on Codex.', fix: 'Allow when a prompt follows the last deny.' });
    const later = guard.preTool(pay, 'codex');
    check('one answer allows one run', later && later.hookSpecificOutput.permissionDecision === 'deny', { happened: JSON.stringify(later), why: 'Yes to one force push is not yes to every force push.', fix: 'Record destructive-confirmed and deny again after it.' });
    const gem = hooksMod.shape(guard.preTool({ ...pay, session_id: 'gemini-destructive' }, 'gemini'), 'gemini');
    check('on Gemini CLI it arrives as a deny, not an allow', gem && gem.decision === 'deny', { happened: JSON.stringify(gem), why: 'shape() turned ask into allow, so the command ran unchallenged.', fix: 'Deny on hosts outside CAN_ASK.' });
    const claude = guard.preTool({ ...pay, session_id: 'claude-destructive' }, 'claude');
    check('Claude Code still gets an ask, which it can show the user', claude && claude.hookSpecificOutput.permissionDecision === 'ask', { happened: JSON.stringify(claude), why: 'Claude Code pauses for the user on ask; a deny there would be a needless extra round.', fix: 'Keep claude in CAN_ASK.' });
  });
}

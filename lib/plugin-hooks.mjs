// Claude Code plugin hooks, run by Atlias's own loop (agent.pluginHooks, off by default). A hook is a
// command; it gets the event as JSON on stdin and answers the way Claude Code reads it: exit 2 blocks
// with stderr as the reason, and exit 0 may print JSON (decision, permissionDecision, additionalContext,
// continue, systemMessage) or, for SessionStart and UserPromptSubmit, plain text added as context.
//
// Off by default because a hook's added context goes into what the model reads: one plugin's
// SessionStart text on this PC is thousands of tokens, and the opening of a session is re-sent on
// every call (RESEARCH-FIRST 0d). Turned on, every hook runs, nothing is shortened.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config, clip } from './core.mjs';
import * as plugins from './plugins.mjs';

export function hooksOn(cfg = config().agent) { return Boolean(cfg) && cfg.pluginHooks === 'on' && plugins.pluginsOn(cfg); }

// The names Claude Code's matchers are written against.
const CLAUDE_TOOL = { shell: 'Bash', background: 'Bash', read_file: 'Read', outline: 'Read', edit_file: 'Edit', apply_patch: 'Edit', write_file: 'Write', grep: 'Grep', list_dir: 'LS', web_fetch: 'WebFetch', agent: 'Task', todo: 'TodoWrite' };
export function claudeToolName(call) {
  if (call.tool === 'mcp') return `mcp__${call.server || ''}__${call.name || ''}`;
  return Object.hasOwn(CLAUDE_TOOL, call.tool) ? CLAUDE_TOOL[call.tool] : String(call.tool || '');
}
export function claudeToolInput(call, cwd) {
  const file = call.path ? (path.isAbsolute(call.path) ? call.path : path.join(cwd, call.path)) : undefined;
  switch (call.tool) {
    case 'shell': case 'background': return { command: Array.isArray(call.command) ? call.command.join(' ') : String(call.command || '') };
    case 'read_file': case 'outline': return { file_path: file, ...(call.offset ? { offset: call.offset } : {}), ...(call.limit ? { limit: call.limit } : {}) };
    case 'edit_file': return { file_path: file, old_string: call.old_string, new_string: call.new_string, replace_all: Boolean(call.replace_all) };
    case 'write_file': return { file_path: file, content: call.content };
    case 'apply_patch': return { patch: call.input };
    case 'grep': return { pattern: call.pattern, path: file };
    case 'list_dir': return { path: file || cwd };
    case 'web_fetch': return { url: call.url };
    case 'agent': return { prompt: call.task, description: call.name || '' };
    case 'mcp': return call.arguments && typeof call.arguments === 'object' ? call.arguments : {};
    default: { const { tool, id, ...rest } = call; return Object.fromEntries(Object.entries(rest).filter(([k]) => !k.startsWith('_'))); }
  }
}

export function matches(matcher, name) {
  if (!matcher || matcher === '*') return true;
  try { return new RegExp(`^(?:${matcher})$`).test(name); } catch { return matcher === name; }
}

// Claude Code on Windows runs hook commands with Git Bash; so does Atlias when it can find one.
function bashPath() {
  if (process.platform !== 'win32') return '/bin/sh';
  const given = process.env.CLAUDE_CODE_GIT_BASH_PATH;
  if (given && fs.existsSync(given)) return given;
  for (const p of [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'), path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe')]) if (fs.existsSync(p)) return p;
  // Git installed elsewhere (this PC: D:\Git): its bash beside git.exe on PATH. Never System32's bash.exe,
  // which is WSL, a different machine with different paths.
  for (const dir of String(process.env.PATH || process.env.Path || '').split(';').filter(Boolean)) {
    if (fs.existsSync(path.join(dir, 'git.exe'))) for (const p of [path.join(dir, '..', 'bin', 'bash.exe'), path.join(dir, '..', 'usr', 'bin', 'bash.exe')]) if (fs.existsSync(p)) return path.resolve(p);
    if (/[\\/]git[\\/]/i.test(dir + path.sep) && fs.existsSync(path.join(dir, 'bash.exe'))) return path.join(dir, 'bash.exe');
  }
  return '';
}

// One hook command: { code, stdout, stderr }. Never throws; a hook that cannot start reports code -1.
export function runHook(h, input, cwd) {
  return new Promise((resolve) => {
    const env = { ...process.env, CLAUDE_PLUGIN_ROOT: h.root, CLAUDE_PLUGIN_DATA: h.dataDir || '', CLAUDE_PROJECT_DIR: cwd };
    const sh = bashPath();
    let child;
    try {
      child = sh ? spawn(sh, ['-c', h.command], { cwd, env, windowsHide: true }) : spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${h.command}"`], { cwd, env, windowsHide: true, windowsVerbatimArguments: true });
    } catch (e) { return resolve({ code: -1, stdout: '', stderr: e.message }); }
    let out = '', err = '', settled = false;
    const finish = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => { try { child.stdin.destroy(); child.kill(); } catch { /* gone */ } finish({ code: -1, stdout: out, stderr: `the hook took longer than ${h.timeout} s` }); }, h.timeout * 1000);
    child.stdout.on('data', (d) => { out = (out + d).slice(-200000); });
    child.stderr.on('data', (d) => { err = (err + d).slice(-20000); });
    child.on('error', (e) => finish({ code: -1, stdout: out, stderr: e.message }));
    child.on('close', (code) => finish({ code: code ?? -1, stdout: out, stderr: err }));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

// Every hook for an event, in order. Returns { context, block, deny, ask, stop, messages }:
// context is text for the model, block/deny a reason, ask a reason to ask the person, stop a reason
// to end the turn, messages lines for the person's screen.
export async function fire(event, payload, { cwd, sid = '', toolName = '', list = null, run = runHook, cfg = config().agent } = {}) {
  const out = { context: [], block: null, deny: null, ask: null, stop: null, messages: [] };
  if (!list && !hooksOn(cfg)) return out;
  const all = (list || plugins.hooks({ cfg })[event] || []).filter((h) => !['PreToolUse', 'PostToolUse'].includes(event) || matches(h.matcher, toolName));
  for (const h of all) {
    const input = { session_id: sid, transcript_path: '', cwd, hook_event_name: event, permission_mode: cfg && cfg.permissions === 'ask' ? 'default' : 'acceptEdits', ...payload };
    const r = await run(h, input, cwd);
    const who = `${h.plugin} hook`;
    if (r.code === 2) {
      const why = clip((r.stderr || r.stdout || 'no reason given').trim(), 2000);
      if (event === 'PreToolUse') out.deny = out.deny || `${who}: ${why}`;
      else if (['UserPromptSubmit', 'Stop', 'PostToolUse'].includes(event)) out.block = out.block || `${who}: ${why}`;
      continue;
    }
    if (r.code !== 0) { out.messages.push(`${who} failed (${r.code}): ${clip((r.stderr || '').trim().split(/\r?\n/).pop() || 'no output', 160)}`); continue; }
    const text = String(r.stdout || '').trim();
    let doc = null;
    if (text.startsWith('{')) { try { doc = JSON.parse(text); } catch { doc = null; } }
    if (!doc) { if (text && ['SessionStart', 'UserPromptSubmit'].includes(event)) out.context.push(text); continue; }
    const spec = doc.hookSpecificOutput && typeof doc.hookSpecificOutput === 'object' ? doc.hookSpecificOutput : {};
    if (typeof doc.systemMessage === 'string' && doc.systemMessage.trim()) out.messages.push(`${who}: ${clip(doc.systemMessage.trim(), 300)}`);
    if (doc.continue === false) out.stop = out.stop || `${who}: ${doc.stopReason || 'it ended the turn'}`;
    if (typeof spec.additionalContext === 'string' && spec.additionalContext.trim()) out.context.push(spec.additionalContext.trim());
    const decision = spec.permissionDecision || (doc.decision === 'approve' ? 'allow' : doc.decision === 'block' && event === 'PreToolUse' ? 'deny' : '');
    const reason = String(spec.permissionDecisionReason || doc.reason || '').trim();
    if (event === 'PreToolUse' && decision === 'deny') out.deny = out.deny || `${who}: ${reason || 'denied'}`;
    if (event === 'PreToolUse' && decision === 'ask') out.ask = out.ask || `${who}: ${reason || 'asks first'}`;
    if (event !== 'PreToolUse' && doc.decision === 'block') out.block = out.block || `${who}: ${reason || 'blocked'}`;
  }
  return out;
}

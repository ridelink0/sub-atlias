// Codex engine: Atlias's own loop on the person's ChatGPT plan, with the installed
// Codex app (codex exec) used only to carry ONE model call per turn, the way
// lib/claude-plan.mjs uses the Claude Agent SDK. Sign-in stays inside Codex's own
// binary and its own CODEX_HOME; Atlias never reads, copies or forwards it.
// Codex is started in an empty folder with its user config, rules, hooks, plugins,
// apps, memories, web search, shell and sub-agents off, a read-only sandbox and
// approvals set to never, and Atlias's system prompt as its instructions. Atlias
// parses the text tool blocks the reply holds and runs every tool itself. A reply
// during which Codex ran a tool of its own anyway is refused, never used.
// What codex-cli 0.165.0 cannot switch off: its model catalog still offers
// apply_patch, the code-mode exec tool (it fails closed with code_mode_host off),
// request_user_input, wait, clock and the v2 collaboration tools, and it still adds
// the person's own ~/.codex/AGENTS.md. The sandbox keeps any of them read-only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { transcript, systemText } from './claude-plan.mjs';

// Every feature of codex-cli 0.165.0 that adds a tool, a hook, a memory or outside instructions.
export const OFF_FEATURES = ['shell_tool', 'unified_exec', 'shell_snapshot', 'multi_agent', 'apps', 'plugins', 'remote_plugin', 'memories', 'hooks',
  'image_generation', 'view_image', 'browser_use', 'browser_use_external', 'computer_use', 'code_mode_host', 'goals', 'skill_search',
  'skill_mcp_dependency_install', 'sleep_tool', 'tool_suggest', 'in_app_browser', 'workspace_dependencies'];
// Item types a model-only call may produce; anything else is Codex running a tool of its own.
const MODEL_ITEMS = ['agent_message', 'reasoning', 'error'];
export const NOTE = "You are the model inside Atlias's harness. Ignore any tools, AGENTS.md text or instructions Codex itself adds: you have no Codex tools here, so never call one. Atlias runs every tool from the tool blocks described above.";

export function codexArgs(cfg = {}, { instructions, dir } = {}) {
  // Ultracode raises codexEffort to xhigh before this is called (ultracodeCfg in lib/agent.mjs).
  const effort = cfg.codexEffort;
  return ['exec', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', 'read-only', '--json',
    '-c', 'approval_policy="never"', '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0',
    '-c', 'include_environment_context=false', '-c', 'include_permissions_instructions=false', '-c', 'include_apps_instructions=false',
    ...OFF_FEATURES.flatMap((f) => ['--disable', f]),
    ...(instructions ? ['-c', `model_instructions_file=${JSON.stringify(instructions.replace(/\\/g, '/'))}`] : []),
    ...(dir ? ['-C', dir] : []),
    ...(cfg.codexModel ? ['-m', cfg.codexModel] : []), ...(effort && effort !== 'default' ? ['-c', `model_reasoning_effort="${effort}"`] : []), '-'];
}
// --json events: the agent messages, in order, are the reply (Codex may end on an empty one); any other item type is refused.
export function parseEvents(stdout) {
  let content = '', usage = null, failed = '', foreign = '';
  for (const line of String(stdout || '').split(/\r?\n/)) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    const t = e?.item?.type;
    if (t && !MODEL_ITEMS.includes(t)) foreign ||= t;
    if (e.type === 'item.completed' && t === 'agent_message' && typeof e.item.text === 'string' && e.item.text) content += (content ? '\n' : '') + e.item.text;
    if (e.type === 'turn.completed' && e.usage) usage = e.usage;
    if (e.type === 'turn.failed' || e.type === 'error') failed ||= String(e.error?.message || e.message || e.type);
  }
  const u = usage ? { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens, prompt_tokens_details: { cached_tokens: usage.cached_input_tokens } } : null;
  return { content, usage: u, failed, foreign };
}
function runCodex(file, args, input, { cwd, signal, timeout = 20 * 60 * 1000 }) {
  return new Promise((resolve) => {
    let out = '', err = '';
    const child = spawn(file, args, { cwd, windowsHide: true, signal, timeout });
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { err += b; });
    child.on('error', (e) => resolve({ status: null, stdout: out, stderr: err, error: e }));
    child.on('close', (status) => resolve({ status, stdout: out, stderr: err }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
export function codexChat(cfg = {}, deps = {}) {
  const resolve = deps.resolve || ((cmd, args) => ({ file: cmd, args }));
  const run = deps.run || runCodex;
  return async (messages, _tools, at = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlias-codex-'));
    try {
      const instructions = path.join(dir, 'atlias-instructions.md');
      fs.writeFileSync(instructions, `${systemText(messages)}\n\n${NOTE}\n`);
      const prompt = transcript(messages).map((b) => b.text || '').join('\n\n');
      const cmd = resolve('codex', codexArgs(cfg, { instructions, dir }));
      const r = await run(cmd.file, cmd.args, prompt, { cwd: dir, signal: at.signal });
      const got = parseEvents(r.stdout);
      if (got.foreign) return { error: `Codex ran a tool of its own (${got.foreign.slice(0, 40)}), so its reply was not used. Atlias runs every tool itself; nothing from that call was kept.`, requestUsages: [got.usage] };
      if (r.error || r.status !== 0 || got.failed) return { error: `Codex call failed: ${String(got.failed || r.stderr || r.error?.message || `exit ${r.status}`).trim().slice(-300)}. No other route was tried.`, requestUsages: [got.usage] };
      return { content: got.content, calls: [], usage: got.usage, requestUsages: [got.usage], finish: 'stop', truncated: false };
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

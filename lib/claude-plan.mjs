import { hasAttachmentInput, mediaBlocks, validateImageHistory } from './media-input.mjs';
// Claude plan engine: Atlias's own loop on the person's own Claude plan, through
// the official Claude Agent SDK. Sign-in is Anthropic's own flow in Anthropic's
// own binary; Atlias never reads, stores or forwards the credential. Each model
// call is ONE turn with Atlias's system prompt: Claude Code's tools, settings,
// plugins, MCP servers and hooks are all switched off, and Atlias's loop runs
// every tool itself from the text tool blocks the model writes. API keys and
// cloud-provider switches are removed from the SDK's environment, and a call
// whose credential source is anything but the plan login is refused before any
// text is used, so this route never bills an API account and never hands the
// task to Claude Code's agent loop.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { STATE_DIR, VERSION } from './core.mjs';

export const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';
export const SDK_VERSION = '0.3.303';
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];
export const SETUP_COMMAND = 'atlias setup claude';
// The SDK installs one native Claude Code binary for this platform; its size is
// told to the person before the install starts.
export const INSTALL_SIZE = 'about 330 MB';
// Credentials and switches that would move a call onto an API account, a bearer
// token or a cloud provider. None of them reaches the SDK process.
export const BLOCKED_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_PROFILE',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_MANTLE', 'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_IDENTITY_TOKEN', 'ANTHROPIC_IDENTITY_TOKEN_FILE', 'CLAUDE_CODE_API_KEY_HELPER_TTL_MS'];
// How Atlias's conversation is laid out for a model that sees one user turn.
export const TRANSCRIPT_NOTE = 'The user message holds this conversation so far, one block per message, oldest first, each opened by a [user], [assistant] or [tool result] line. Write only your next reply as the assistant, using the tool blocks described above when you need a tool.';

export const runtimeRoot = (stateDir = STATE_DIR) => path.join(stateDir, 'claude-plan', 'runtime');
const sdkDir = (root) => path.join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');

export function prepared({ root = runtimeRoot() } = {}) {
  try { return JSON.parse(fs.readFileSync(path.join(sdkDir(root), 'package.json'), 'utf8')).version === SDK_VERSION && fs.statSync(path.join(sdkDir(root), 'sdk.mjs')).isFile(); }
  catch { return false; }
}
// The native binary the SDK itself runs, used here only for Anthropic's own
// login and status commands.
export function binaryPath({ root = runtimeRoot(), platform = process.platform, arch = process.arch } = {}) {
  const file = path.join(root, 'node_modules', '@anthropic-ai', `claude-agent-sdk-${platform}-${arch}`, platform === 'win32' ? 'claude.exe' : 'claude');
  return fs.existsSync(file) ? file : null;
}
// npm on Windows is npm.cmd, which Node will not spawn without a shell, and its
// shim is not the one-line form resolveCommand reads. npm's own npm-cli.js sits
// beside every Node install, so it runs under this Node with no shell at all.
export function npmCommand({ execPath = process.execPath, env = process.env, exists = fs.existsSync, platform = process.platform } = {}) {
  if (typeof env.npm_execpath === 'string' && /\.c?js$/i.test(env.npm_execpath) && exists(env.npm_execpath)) return { file: execPath, args: [env.npm_execpath] };
  for (const cli of [path.join(path.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(path.dirname(execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]) if (exists(cli)) return { file: execPath, args: [cli] };
  return { file: platform === 'win32' ? 'npm.cmd' : 'npm', args: [] };
}
export function prepare({ root = runtimeRoot(), npm = npmCommand(), spawn = spawnSync } = {}) {
  fs.mkdirSync(root, { recursive: true });
  const pkg = path.join(root, 'package.json');
  if (!fs.existsSync(pkg)) fs.writeFileSync(pkg, JSON.stringify({ name: 'atlias-claude-plan-runtime', private: true }, null, 2) + '\n');
  const args = [...npm.args, 'install', `${SDK_PACKAGE}@${SDK_VERSION}`, '--prefix', root, '--no-audit', '--no-fund', '--save-exact'];
  const r = spawn(npm.file, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  return { ok: !r.error && r.status === 0 && prepared({ root }), exitCode: Number.isInteger(r.status) ? r.status : null };
}

export function cleanEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!BLOCKED_ENV.includes(k.toUpperCase()) && v !== undefined) out[k] = v;
  out.CLAUDE_AGENT_SDK_CLIENT_APP = `atlias/${VERSION}`;
  return out;
}
// Only booleans escape: the status output itself, which may name an account,
// never leaves this function.
export function parsePlanStatus(result) {
  if (!result || result.error || result.status !== 0) return { authenticated: false, plan: false };
  let body;
  for (const text of [String(result.stdout || '').trim(), String(result.stderr || '').trim()]) { try { body = JSON.parse(text); break; } catch { /* the other stream */ } }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { authenticated: false, plan: false };
  const method = typeof body.authMethod === 'string' ? body.authMethod.toLowerCase() : '';
  const explicit = [body.loggedIn, body.authenticated].filter((v) => typeof v === 'boolean');
  const authenticated = explicit.includes(false) ? false : explicit.includes(true) || method === 'claude.ai';
  return { authenticated, plan: authenticated && method === 'claude.ai' };
}
export function planStatus({ root = runtimeRoot(), spawn = spawnSync, env = process.env } = {}) {
  const bin = binaryPath({ root });
  if (!bin) return { authenticated: false, plan: false, binary: false };
  return { ...parsePlanStatus(spawn(bin, ['auth', 'status', '--json'], { encoding: 'utf8', env: cleanEnv(env), timeout: 15000, windowsHide: true })), binary: true };
}
// Anthropic's own sign-in, in Anthropic's own binary, in the person's terminal.
export function planLogin({ root = runtimeRoot(), spawn = spawnSync, env = process.env } = {}) {
  const bin = binaryPath({ root });
  if (!bin) return { started: false, exitCode: null };
  const r = spawn(bin, ['auth', 'login', '--claudeai'], { stdio: 'inherit', env: cleanEnv(env), windowsHide: false });
  return { started: !r.error, exitCode: Number.isInteger(r.status) ? r.status : null };
}

const LABEL = { user: '[user]', assistant: '[assistant]', tool: '[tool result]' };
// One text block per message, so a call's blocks are the previous call's blocks
// plus new ones and the prompt cache keeps serving the shared prefix.
export function transcript(messages) {
  const blocks = [];
  for (const m of messages || []) {
    if (!m || m.role === 'system') continue;
    const text = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('') : '';
    if (hasAttachmentInput(m)) { blocks.push({ type: 'text', text: `${LABEL[m.role] || `[${m.role}]`}\n` }, ...mediaBlocks(m, 'anthropic')); }
    else blocks.push({ type: 'text', text: `${LABEL[m.role] || `[${m.role}]`}\n${text}` });
  }
  return blocks.length ? blocks : [{ type: 'text', text: '[user]\n' }];
}
export function systemText(messages) {
  const sys = (messages || []).filter((m) => m && m.role === 'system').map((m) => String(m.content || '')).join('\n\n');
  return sys ? `${sys}\n\n${TRANSCRIPT_NOTE}` : TRANSCRIPT_NOTE;
}
// What Claude Code would otherwise add to each call. Every call here is a new
// CLI process, so its opening git status snapshot (branch, changed files,
// recent commits; cat() in the bundled CLI reads CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS)
// is taken again each time, and after any edit or commit it differs: it sits
// before the transcript, so the whole cached transcript is thrown away. The
// other two are the documented switches for CLAUDE.md files and attachments
// (code.claude.com/docs/en/agent-sdk/modifying-system-prompts).
export const STABLE_PREFIX_ENV = { CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_ATTACHMENTS: '1' };
// CLAUDE_CODE_PROMPT_CACHE_TTL: on a Claude subscription an SDK turn is written to the 1-hour cache, billed at 2x base
// input against 1.25x for 5 minutes (platform.claude.com prompt-caching); the variable is read for the main bucket in
// Ctn() of the bundled CLI. A run nobody is waiting on (exec, --once, a sub-agent) makes its calls seconds apart: the
// polyglot runs of 2026-10-23 cost 23% less on the same tasks with the 5-minute write ($0.827 against $1.075). A turn
// at the prompt is different: in Gev's recorded sessions 26% of prompts came 5 to 60 minutes after the last event, and
// each of those would write the whole conversation again where the 1-hour entry is read at 0.05x. So an interactive
// turn keeps the CLI's own 1-hour default and everything else asks for 5 minutes.
export const ONE_SHOT_TTL_ENV = { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' };
export function planOptions(cfg = {}, { cwd, env = process.env, system, abortController, interactive = false } = {}) {
  const effort = EFFORTS.includes(cfg.claudePlanEffort) ? cfg.claudePlanEffort : undefined;
  return {
    model: cfg.claudePlanModel || MODELS[0], ...(effort ? { effort } : {}), systemPrompt: system,
    tools: [], allowedTools: [], mcpServers: {}, strictMcpConfig: true, settingSources: [], plugins: [],
    persistSession: false, maxTurns: 1, cwd, env: { ...cleanEnv(env), ...STABLE_PREFIX_ENV, ...(interactive ? {} : ONE_SHOT_TTL_ENV) }, abortController,
  };
}
async function loadSdk(root) {
  if (!prepared({ root })) throw Error(`The Claude Agent SDK is not installed. Run ${SETUP_COMMAND} or /onboarding.`);
  return import(pathToFileURL(path.join(sdkDir(root), 'sdk.mjs')).href);
}
async function* once(blocks) { yield { type: 'user', message: { role: 'user', content: blocks }, parent_tool_use_id: null, session_id: '' }; }

export function claudePlanChat(cfg = {}, deps = {}) {
  const root = deps.root || runtimeRoot();
  return async (messages, _tools, at = {}) => {
    let blocks;
    try { validateImageHistory(messages); blocks = transcript(messages); } catch (e) { return { error: e.message, requestUsages: [] }; }
    let sdk;
    try { sdk = deps.sdk || await loadSdk(root); } catch (e) { return { error: e.message, requestUsages: [] }; }
    const abortController = new AbortController();
    // TUI-B: the turn's signal ends the SDK query too.
    if (at.signal) { if (at.signal.aborted) abortController.abort(); else at.signal.addEventListener('abort', () => abortController.abort(), { once: true }); }
    const options = planOptions(cfg, { cwd: at.cwd, env: deps.env || process.env, system: systemText(messages), abortController, interactive: Boolean(at.interactive) });
    let init = null, result = null, text = '';
    try {
      for await (const m of sdk.query({ prompt: once(blocks), options })) {
        if (m.type === 'system' && m.subtype === 'init') {
          init = m;
          if (m.apiKeySource !== 'none') {
            abortController.abort();
            return { error: `Claude plan route refused: the Claude login reported an API-key credential (${/^[\w /.-]{1,40}$/.test(String(m.apiKeySource)) ? m.apiKeySource : 'unknown'}), not a Claude plan sign-in. Run ${SETUP_COMMAND} to sign in with your Claude account. No API or other route was used.`, requestUsages: [] };
          }
        } else if (m.type === 'assistant' && !m.parent_tool_use_id && !init) {
          abortController.abort();
          return { error: 'Claude plan route refused: the SDK sent a reply before reporting its credential source. Nothing from it was used.', requestUsages: [] };
        } else if (m.type === 'assistant' && !m.parent_tool_use_id) {
          for (const b of m.message?.content || []) if (b && b.type === 'text' && typeof b.text === 'string') text += b.text;
        } else if (m.type === 'result') result = m;
      }
    } catch (e) {
      const msg = e && typeof e.message === 'string' ? e.message : String(e);
      return { error: `Claude plan call failed: ${msg.slice(0, 300)}. No other route was tried.`, requestUsages: [null] };
    }
    if (!result) return { error: 'Claude plan call ended without a result. No other route was tried.', requestUsages: [null] };
    const usage = result.usage ? { _atliasProtocol: 'anthropic', providerUsage: result.usage, input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens,
      cache_read_input_tokens: result.usage.cache_read_input_tokens, cache_creation_input_tokens: result.usage.cache_creation_input_tokens,
      // The SDK prices the call itself (API-equivalent USD); kept so a run can report its whole cost, output included.
      ...(Number.isFinite(result.total_cost_usd) ? { cost_usd: result.total_cost_usd } : {}) } : null;
    if (result.is_error || result.subtype !== 'success') {
      return { error: `Claude plan call failed (${String(result.subtype).slice(0, 40)}${result.api_error_status ? `, HTTP ${result.api_error_status}` : ''}): ${String(result.result || (result.errors || []).join('; ') || '').slice(0, 300)}`, requestUsages: [usage] };
    }
    const content = text || String(result.result || '');
    const finish = String(result.stop_reason || '');
    return { content, calls: [], usage, requestUsages: [usage], finish, truncated: finish === 'max_tokens' };
  };
}

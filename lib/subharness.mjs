// Native host launcher and transparent local API meter. It changes neither
// prompts nor tools, and launches one native session for all follow-up turns.
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { ROOT, STATE_DIR, ensureDir } from './core.mjs';
import { resolveCommand } from './agent.mjs';
import { validate, load, tokens, cost, summarize } from './provider.mjs';
import fs from 'node:fs';
import { logo } from './logo.mjs';

export function usageReader(protocol, streamed) {
  let raw = null, terminal = !streamed, pending = '', broken = false;
  let started = false, outputFinal = !streamed || protocol !== 'anthropic';
  const accept = (e) => {
    if (protocol === 'anthropic') {
      if (e.type === 'message_start') {
        if (started || terminal) broken = true;
        started = true; terminal = false; outputFinal = false;
        raw = e.message?.usage ? { ...e.message.usage } : null;
      }
      if (e.type === 'message_delta') {
        if (!started || terminal) broken = true;
        const usage = e.usage;
        if (!usage || typeof usage !== 'object' || Array.isArray(usage)) { broken = true; outputFinal = false; }
        else {
          raw = { ...raw, ...usage };
          outputFinal = Number.isSafeInteger(usage.output_tokens) && usage.output_tokens >= 0;
          if (!outputFinal) broken = true;
        }
      }
      if (e.type === 'message_stop') { if (!started) broken = true; terminal = true; }
      if (e.type === 'error') broken = true;
    } else if (['response.completed', 'response.incomplete', 'response.failed'].includes(e.type)) {
      terminal = true;
      raw = e.response?.usage || null;
    }
  };
  return {
    push(text) {
      pending += text;
      if (pending.length > 8 * 1024 * 1024) { broken = true; pending = ''; return; }
      if (streamed) {
        const lines = pending.split(/\r?\n/); pending = lines.pop();
        for (const line of lines) if (line.startsWith('data:') && line.slice(5).trim() !== '[DONE]') {
          try { accept(JSON.parse(line.slice(5))); } catch { broken = true; }
        }
      }
    },
    finish() {
      if (streamed && pending.trim()) {
        if (pending.startsWith('data:') && pending.slice(5).trim() !== '[DONE]') {
          try { accept(JSON.parse(pending.slice(5))); } catch { broken = true; }
        } else broken = true;
      }
      if (!streamed) {
        try {
          const e = JSON.parse(pending); raw = e.usage;
          terminal = protocol === 'anthropic' ? e.type === 'message' && e.stop_reason !== null && e.stop_reason !== undefined : ['completed', 'incomplete', 'failed'].includes(e.status);
        } catch { broken = true; }
      }
      // message_start's output count is provisional, even when it is zero.
      // Preserve it as raw evidence; only a final delta can qualify spend.
      return { rawUsage: raw, terminal: terminal && !broken, tokens: terminal && !broken && outputFinal ? tokens(raw, protocol) : null };
    },
  };
}
export async function meter(profile, { env = process.env, onReceipt = () => {} } = {}) {
  const p = validate(profile);
  const secret = p.keyEnv ? env[p.keyEnv] : null;
  if (p.keyEnv && !secret) throw Error(`Set the credential environment variable ${p.keyEnv} before launching.`);
  const localToken = crypto.randomBytes(32).toString('hex');
  const active = new Set();
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${localToken}` && req.headers['x-api-key'] !== localToken) { res.writeHead(401); res.end(); return; }
    const u = new URL(req.url, 'http://localhost');
    const route = u.pathname.replace(/^\/v1(?=\/)/, '');
    const inference = req.method === 'POST' && (p.protocol === 'anthropic' ? route === '/messages' : ['/responses', '/responses/compact'].includes(route));
    const auxiliary = (req.method === 'GET' && route === '/models') || (p.protocol === 'anthropic' && req.method === 'POST' && route === '/messages/count_tokens');
    if (!inference && !auxiliary) { res.writeHead(404); res.end(); return; }
    let receipt = { at: new Date().toISOString(), inference, protocol: p.protocol, model: p.model, route, terminal: false, tokens: null, cost: null };
    const abort = new AbortController(); active.add(abort);
    const disconnected = () => { if (!res.writableFinished) abort.abort(); };
    res.on('close', disconnected);
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { chunks.push(chunk); size += chunk.length; if (size > 32 * 1024 * 1024) throw Error('Request too large'); }
      const body = Buffer.concat(chunks);
      receipt.requestBytes = body.length;
      receipt.requestSha256 = crypto.createHash('sha256').update(body).digest('hex');
      const headers = {};
      for (const [key, value] of Object.entries(req.headers)) if (!['authorization', 'x-api-key', 'cookie', 'host', 'connection', 'content-length', 'accept-encoding', 'proxy-authorization'].includes(key) && value !== undefined) headers[key] = value;
      if (secret) headers[p.authHeader === 'x-api-key' || (!p.authHeader && p.protocol === 'anthropic') ? 'x-api-key' : 'authorization'] = p.authHeader === 'x-api-key' || (!p.authHeader && p.protocol === 'anthropic') ? secret : `Bearer ${secret}`;
      const target = p.baseUrl + route + u.search;
      const upstream = await fetch(target, { method: req.method, headers, ...(req.method === 'POST' ? { body } : {}), signal: abort.signal, redirect: 'manual' });
      receipt.status = upstream.status;
      const outputHeaders = {};
      for (const [key, value] of upstream.headers) if (!['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'set-cookie', 'location'].includes(key)) outputHeaders[key] = value;
      res.writeHead(upstream.status, outputHeaders);
      const reader = usageReader(p.protocol, (upstream.headers.get('content-type') || '').includes('text/event-stream'));
      const decoder = new TextDecoder();
      if (upstream.body) for await (const chunk of upstream.body) {
        if (inference) reader.push(decoder.decode(chunk, { stream: true }));
        if (!res.write(Buffer.from(chunk))) await new Promise((resolve) => {
          const ready = () => { res.off('drain', ready); res.off('close', ready); resolve(); };
          res.once('drain', ready); res.once('close', ready);
        });
      }
      if (inference) {
        reader.push(decoder.decode());
        receipt = { ...receipt, ...reader.finish() };
        let requested;
        try { requested = JSON.parse(body).model; } catch { /* unknown price scope */ }
        receipt.cost = requested === p.model ? cost(receipt.tokens, p.pricing) : null;
        receipt.pricing = p.pricing || null;
      }
      res.end();
    } catch {
      receipt.error = 'transport_failed';
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Atlias API transport failed; usage may be unknown.' } }));
    } finally {
      active.delete(abort);
      res.off('close', disconnected);
      if (inference) onReceipt(receipt);
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { base: `http://127.0.0.1:${server.address().port}`, token: localToken,
    async close() { for (const c of active) c.abort(); server.closeIdleConnections?.(); await new Promise((resolve) => server.close(resolve)); } };
}
export function nativeOptions(host, profile, gateway, args = [], env = process.env) {
  if (host === 'claude' && profile.protocol !== 'anthropic' || host === 'codex' && profile.protocol !== 'responses') throw Error('The profile protocol must match the native host.');
  const nextEnv = { ...env, ATLIAS_FLAG_AUTHORITY_LEDGER: '1' };
  if (host === 'claude') {
    for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete nextEnv[name];
    Object.assign(nextEnv, { ANTHROPIC_BASE_URL: gateway.base, ANTHROPIC_AUTH_TOKEN: gateway.token, ANTHROPIC_MODEL: profile.model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: profile.model, ANTHROPIC_DEFAULT_OPUS_MODEL: profile.model, ANTHROPIC_DEFAULT_HAIKU_MODEL: profile.model, ANTHROPIC_SMALL_FAST_MODEL: profile.model });
    return { command: 'claude', env: nextEnv, args: ['--plugin-dir', ROOT, ...args] };
  }
  const p = 'atlias_api';
  const configs = ['model=' + JSON.stringify(profile.model), `model_provider="${p}"`, `model_providers.${p}.name="Atlias API"`,
    `model_providers.${p}.base_url="${gateway.base}/v1"`, `model_providers.${p}.wire_api="responses"`,
    `model_providers.${p}.requires_openai_auth=false`, `model_providers.${p}.supports_websockets=false`, `model_providers.${p}.env_key="ATLIAS_GATEWAY_TOKEN"`];
  nextEnv.ATLIAS_GATEWAY_TOKEN = gateway.token;
  // Native exec/resume reads its own overrides; parent-only overrides can be
  // ignored. Keep the native subcommands and all supplied arguments in order.
  const commandIndex = args.findIndex((a) => ['exec', 'e', 'resume'].includes(a));
  let boundary = commandIndex < 0 ? 0 : commandIndex + 1;
  if (['exec', 'e'].includes(args[commandIndex]) && args[boundary] === 'resume') boundary++;
  return { command: 'codex', env: nextEnv, args: [...args.slice(0, boundary), ...configs.flatMap((c) => ['-c', c]), ...args.slice(boundary)] };
}
export async function launch({ host, file, args = [], executable, logFile }) {
  if (!['claude', 'codex'].includes(host)) throw Error('--host must be claude or codex.');
  const profile = load(file);
  if ((host === 'claude' ? 'anthropic' : 'responses') !== profile.protocol) throw Error('The profile protocol must match the native host.');
  if (host === 'codex') {
    const hosts = await import('./hosts.mjs');
    hosts.installCodex();
  }
  const rows = [];
  const log = logFile || path.join(STATE_DIR, 'api-usage', `${Date.now()}-${crypto.randomUUID()}.jsonl`);
  ensureDir(path.dirname(log));
  const gateway = await meter(profile, { onReceipt: (r) => { rows.push(r); fs.appendFileSync(log, JSON.stringify(r) + '\n', { mode: 0o600 }); } });
  try {
    const opts = nativeOptions(host, profile, gateway, args);
    const command = resolveCommand(executable || opts.command, opts.args);
    if (process.stderr.isTTY) process.stderr.write(logo({ width: process.stderr.columns }) + '\n');
    process.stderr.write(`Sub-atlias with ${host}\nModel: ${profile.model} | Your provider API billing\nDescribe a task in the host prompt. Use its /help for commands.\nUsage receipts: ${log}\n`);
    const child = spawn(command.file, command.args, { env: opts.env, stdio: 'inherit', windowsHide: true });
    const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => resolve(code ?? 1)); });
    process.stderr.write(JSON.stringify(summarize(rows)) + '\n');
    return result;
  } finally { await gateway.close(); }
}

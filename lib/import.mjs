// Moving to Atlias from Claude Code, Codex, Gemini CLI and Antigravity.
// Gev (2026-10-17): the first time `atlias agent` starts it offers to bring over what the person
// already has in the other tools (instructions, memory, skills, slash commands, MCP server
// definitions, and on request the saved sessions), skipping what Atlias already has, copying
// nothing without a yes, never copying a credential, and writing a manifest so the whole import
// can be taken back with `atlias import --undo`.
//
// Where each tool keeps its things is from the Atlias research (research-last-phase.md, section 5).
// Interactive and command-line only: nothing here is reached by `atlias exec`, `atlias eval`,
// tools/h2h or runLoop, and lib/loop.mjs, lib/eval.mjs and the h2h tools do not import this file.
//
// Safety lines, each with a planted-break test in test/import-suites.mjs:
//   1. Credential files (.credentials.json, auth.json, oauth tokens, .env, keys) are never read.
//   2. Anything that looks like a secret is dropped or redacted before it is written.
//   3. Nothing is written until a plan was shown and answered yes (or --yes was given).
//   4. Nothing that already exists in the Atlias home is overwritten.
//   5. Undo removes only files the manifest lists, only if they are still what the import wrote.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME, STATE_DIR, CLAUDE_DIR, CODEX_DIR, GEMINI_DIR, ROOT, config, readText, readJson, writeText, writeJson, ensureDir, safeId, clip } from './core.mjs';

export const TOOLS = ['claude', 'codex', 'gemini', 'antigravity'];
export const LABELS = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', antigravity: 'Antigravity' };
export const MAX_TEXT_BYTES = 200000;       // an instruction, memory or command file larger than this is left alone
export const MAX_SKILL_FILES = 300;
export const MAX_SKILL_BYTES = 4 * 1024 * 1024;
export const MAX_SESSION_BYTES = 80 * 1024 * 1024;
export const RESULT_MAX = 300;              // a tool result longer than this is dropped from an imported session
export const TEXT_MAX = 4000;               // one message in an imported session is clipped to this
export const NOTE_MAX = 6000;               // the digest of the old conversation that the first new turn carries
export const COMMAND_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function defaultHomes() {
  return { userHome: HOME, atlias: STATE_DIR, claude: CLAUDE_DIR, codex: CODEX_DIR, gemini: GEMINI_DIR };
}
const homesOf = (o) => ({ ...defaultHomes(), ...(o || {}) });

// ---------- credentials and secrets ----------
const CRED_BASENAME = [
  /^\.?credentials(\.json)?$/i, /^auth\.json$/i, /^oauth[_-]?creds?(\.json)?$/i, /oauth[-_]?token/i, /^token\.json$/i,
  /^\.env(\..*)?$/i, /^\.netrc$|^_netrc$|^\.npmrc$|^\.pypirc$|^\.git-credentials$/i, /^secrets?\.[a-z]+$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, /\.(pem|key|p12|pfx|jks|keystore|sqlite|sqlite3|db)$/i, /^service-account.*\.json$/i,
  /^jetski-standalone-oauth-token$/i, /^cookies?$/i, /^login data$/i,
];
const CRED_DIR = /(^|[\\/])(\.ssh|\.aws|\.gnupg|\.kube|\.azure|\.docker)([\\/]|$)/i;
// A path that is, or sits inside, a credential store. Every read in this file goes through it.
export function isCredentialPath(p) {
  const s = String(p || '');
  const base = path.basename(s);
  return CRED_BASENAME.some((re) => re.test(base)) || CRED_DIR.test(s);
}
const SECRET_RES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{16,}/, /\bsk_(?:live|test)_[A-Za-z0-9]{10,}/, /\brk_live_[A-Za-z0-9]{10,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/, /\bglpat-[A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/, /\bAIza[0-9A-Za-z_-]{30,}/, /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bsbp_[a-f0-9]{30,}/, /\bnpm_[A-Za-z0-9]{30,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/,
  /https?:\/\/[^/\s:@]+:[^/\s@]+@/,
  /\b[A-Za-z0-9_]*(?:api[_-]?key|secret|token|password|passwd|private[_-]?key|credential)[A-Za-z0-9_]*["']?\s*[=:]\s*["']?[^\s"',;]{8,}/i,
];
export function looksSecret(text) { const t = String(text ?? ''); return SECRET_RES.some((re) => re.test(t)); }
// Inline: the matching piece becomes [redacted]. { text, n }.
export function redactInline(text) {
  let n = 0;
  let t = String(text ?? '');
  for (const re of SECRET_RES) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    t = t.replace(g, () => { n++; return '[redacted]'; });
  }
  return { text: t, n };
}
// Line by line: a line that looks like a secret is replaced by a note. { text, n }.
export function dropSecretLines(text) {
  let n = 0;
  const out = String(text ?? '').split(/\r?\n/).map((line) => { if (looksSecret(line)) { n++; return '[line removed by atlias import: it looked like a secret]'; } return line; });
  return { text: out.join('\n'), n };
}

// ---------- safe reading ----------
function sizeOf(p) { try { const st = fs.statSync(p); return st.isFile() ? st.size : -1; } catch { return -1; } }
function readSafe(p, max = MAX_TEXT_BYTES) {
  if (isCredentialPath(p)) return null;
  const size = sizeOf(p);
  if (size < 0 || size > max) return null;
  const t = readText(p);
  return t == null ? null : t.replace(/^\uFEFF/, '');
}
function listDir(dir) { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } }
// A directory entry that is a directory, following links and junctions (the hosts install most skills that way).
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---------- a tiny TOML reader: exactly what Codex config and Gemini commands use ----------
function tomlString(v) {
  const s = v.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) return s.slice(1, -1).replace(/\\(["\\nt])/g, (m, c) => ({ n: '\n', t: '\t', '"': '"', '\\': '\\' }[c]));
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1);
  return null;
}
function tomlArray(v) {
  const s = v.trim();
  if (!s.startsWith('[') || !s.endsWith(']')) return null;
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
  let m;
  while ((m = re.exec(s.slice(1, -1)))) out.push(m[1] !== undefined ? tomlString('"' + m[1] + '"') : m[2]);
  return out;
}
// { tables: { 'a.b': { key: rawValueText } } } with multi-line arrays and triple-quoted strings joined.
function parseToml(text) {
  const tables = { '': {} };
  let cur = '';
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const head = /^\s*\[([^\[\]]+)\]\s*(#.*)?$/.exec(line);
    if (head) { cur = head[1].trim().replace(/\s*\.\s*/g, '.').replace(/"/g, ''); tables[cur] = tables[cur] || {}; continue; }
    const kv = /^\s*([A-Za-z0-9_.\-"]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].replace(/"/g, '');
    let val = kv[2];
    if (/^("""|''')/.test(val.trim())) {
      const q = val.trim().slice(0, 3);
      let body = val.trim().slice(3);
      if (body.includes(q)) { tables[cur][key] = { multi: body.slice(0, body.indexOf(q)), q }; continue; }
      const acc = [body];
      while (++i < lines.length) { const idx = lines[i].indexOf(q); if (idx >= 0) { acc.push(lines[i].slice(0, idx)); break; } acc.push(lines[i]); }
      tables[cur][key] = { multi: acc.join('\n').replace(/^\r?\n/, ''), q };
      continue;
    }
    if (val.trim().startsWith('[') && !val.includes(']')) { while (++i < lines.length) { val += ' ' + lines[i]; if (lines[i].includes(']')) break; } }
    tables[cur][key] = val.trim();
  }
  return tables;
}
const tomlValue = (v) => (v && typeof v === 'object' ? (v.q === '"""' ? v.multi.replace(/\\(["\\nt])/g, (m, c) => ({ n: '\n', t: '\t', '"': '"', '\\': '\\' }[c])) : v.multi) : v == null ? null : tomlString(String(v)));

// ---------- MCP server definitions, with every secret taken out ----------
function cleanUrl(u) {
  try {
    const x = new URL(u);
    x.username = ''; x.password = '';
    for (const k of [...x.searchParams.keys()]) if (/key|token|secret|auth|pass|sig/i.test(k)) x.searchParams.delete(k);
    return x.toString();
  } catch { return looksSecret(u) ? null : u; }
}
// def: { command, args, url, env, headers } in any tool's spelling. Returns the definition Atlias keeps:
// names of environment variables and headers survive, their values never do.
export function sanitizeServer(def, tool) {
  const d = def && typeof def === 'object' ? def : {};
  const out = { from: tool };
  if (typeof d.command === 'string') out.command = looksSecret(d.command) ? '[removed]' : d.command;
  if (Array.isArray(d.args)) {
    let dropped = 0;
    out.args = d.args.map((a) => { if (looksSecret(a)) { dropped++; return '[removed]'; } return String(a); });
    if (dropped) out.note = `${dropped} argument${dropped === 1 ? '' : 's'} looked like a secret and ${dropped === 1 ? 'was' : 'were'} removed; add ${dropped === 1 ? 'it' : 'them'} back by hand`;
  }
  const url = d.url || d.httpUrl || d.serverUrl;
  if (typeof url === 'string') { const u = cleanUrl(url); if (u) out.url = u; }
  const envNames = new Set();
  for (const key of ['env', 'environment']) if (d[key] && typeof d[key] === 'object') for (const k of Object.keys(d[key])) envNames.add(k);
  if (envNames.size) out.envNames = [...envNames].sort();
  const headerNames = new Set();
  if (d.headers && typeof d.headers === 'object') for (const k of Object.keys(d.headers)) headerNames.add(k);
  if (d.bearer_token_env_var) headerNames.add('Authorization');
  if (headerNames.size) out.headerNames = [...headerNames].sort();
  if (out.envNames || out.headerNames) out.note = ((out.note ? out.note + '; ' : '') + 'the values of its environment variables and headers were not copied; enter them again');
  return out;
}
function mcpFromJson(file, tool, key = 'mcpServers') {
  // Only the server map is taken from the file; the rest of it (accounts, tokens, history) is dropped unread.
  const raw = readSafe(file, 50 * 1024 * 1024);
  let doc = null;
  try { doc = raw == null ? null : JSON.parse(raw); } catch { doc = null; }
  const map = doc && doc[key];
  if (!map || typeof map !== 'object') return [];
  return Object.entries(map).filter(([n]) => COMMAND_NAME_RE.test(n)).map(([name, def]) => ({ name, def: sanitizeServer(def, tool) }));
}
function mcpFromToml(file, tool) {
  const text = readSafe(file, 5 * 1024 * 1024);
  if (text == null) return [];
  const tables = parseToml(text);
  const servers = {};
  for (const [t, kv] of Object.entries(tables)) {
    const m = /^mcp_servers\.([^.]+)(?:\.(env|http_headers|headers|env_http_headers))?$/.exec(t);
    if (!m) continue;
    const s = servers[m[1]] = servers[m[1]] || {};
    if (m[2]) { const bag = (m[2] === 'env' ? 'env' : 'headers'); s[bag] = { ...(s[bag] || {}), ...Object.fromEntries(Object.keys(kv).map((k) => [k, ''])) }; continue; }
    if (kv.command) s.command = tomlString(String(kv.command));
    if (kv.args) s.args = tomlArray(String(kv.args)) || [];
    if (kv.url) s.url = tomlString(String(kv.url));
    if (kv.bearer_token_env_var) s.bearer_token_env_var = true;
    if (kv.env) { const names = [...String(kv.env).matchAll(/([A-Za-z0-9_]+)\s*=/g)].map((x) => x[1]); s.env = { ...(s.env || {}), ...Object.fromEntries(names.map((n) => [n, ''])) }; }
  }
  return Object.entries(servers).filter(([n]) => COMMAND_NAME_RE.test(n)).map(([name, def]) => ({ name, def: sanitizeServer(def, tool) }));
}

// ---------- the plan ----------
// An item: { tool, kind, label, src, dest, status: 'new'|'present'|'skip', why, bytes, ...extra }.
function item(o) { return { status: 'new', why: '', bytes: 0, ...o }; }
const present = (it, why) => ({ ...it, status: 'present', why });
const skipped = (it, why) => ({ ...it, status: 'skip', why });

function commandMd(name, description, body) {
  const fm = description ? `---\ndescription: ${String(description).replace(/[\r\n]+/g, ' ').trim()}\n---\n` : '';
  return fm + body.trim() + '\n';
}
function geminiCommandToMarkdown(text) {
  const t = parseToml(text)[''];
  const prompt = tomlValue(t.prompt);
  if (!prompt || !prompt.trim()) return { error: 'the file has no prompt' };
  if (/!\{|@\{/.test(prompt)) return { error: 'it runs a shell command or reads a file inline (!{ } or @{ }), which Atlias commands do not do' };
  return { md: commandMd('', tomlValue(t.description) || '', prompt.replace(/\{\{\s*args\s*\}\}/g, '$ARGUMENTS')) };
}

function scanInstructions(h, tool, files, plan) {
  for (const src of files) {
    const dest = path.join(h.atlias, 'AGENTS.md');
    const base = { tool, kind: 'instructions', label: path.basename(src), src, dest };
    const size = sizeOf(src);
    if (size < 0) continue;
    if (exists(dest)) { plan.push(present(item({ ...base, bytes: size }), 'Atlias already has its own AGENTS.md')); continue; }
    if (size > MAX_TEXT_BYTES) { plan.push(skipped(item({ ...base, bytes: size }), `over ${MAX_TEXT_BYTES} bytes`)); continue; }
    plan.push(item({ ...base, bytes: size }));
  }
}
function scanMarkdownDir(h, tool, kind, dir, destDir, plan, { skip = (n) => n === 'MEMORY.md', recurse = false } = {}) {
  for (const e of listDir(dir).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (!/\.md$/i.test(e.name) || !isFile(p) || skip(e.name)) continue;
    const dest = path.join(destDir, e.name);
    const it = item({ tool, kind, label: e.name, src: p, dest, bytes: sizeOf(p) });
    if (isCredentialPath(p)) { plan.push(skipped(it, 'a credential file; never read')); continue; }
    if (it.bytes > MAX_TEXT_BYTES) { plan.push(skipped(it, `over ${MAX_TEXT_BYTES} bytes`)); continue; }
    plan.push(exists(dest) ? present(it, 'already in the Atlias home') : it);
  }
}
function scanSkills(h, tool, dir, plan) {
  for (const e of listDir(dir).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (!isDir(p) || !isFile(path.join(p, 'SKILL.md'))) continue;
    const dest = path.join(h.atlias, 'skills', e.name);
    const it = item({ tool, kind: 'skills', label: e.name, src: p, dest });
    if (!COMMAND_NAME_RE.test(e.name.replace(/\./g, '-'))) { plan.push(skipped(it, 'the folder name is not a plain skill name')); continue; }
    if (exists(dest) || exists(path.join(ROOT, 'skills', e.name))) { plan.push(present(it, 'Atlias already has a skill of that name')); continue; }
    const problem = prepareSkill(p, false).why;
    plan.push(problem ? skipped(it, problem) : it);
  }
}
function scanCommandsDir(h, tool, dir, ext, plan) {
  const one = (src, rel) => {
    const base = rel.replace(new RegExp('\\.' + ext + '$', 'i'), '');
    const parts = base.split(/[\\/]/);
    const dest = path.join(h.atlias, 'commands', ...parts.slice(0, -1), parts[parts.length - 1] + '.md');
    const it = item({ tool, kind: 'commands', label: '/' + parts.join(':'), src, dest, bytes: sizeOf(src) });
    if (parts.length > 2 || !parts.every((x) => COMMAND_NAME_RE.test(x))) return plan.push(skipped(it, 'the name is not one Atlias commands can have (letters, digits, - and _; one folder deep)'));
    if (isCredentialPath(src)) return plan.push(skipped(it, 'a credential file; never read'));
    if (it.bytes > 20000) return plan.push(skipped(it, 'over 20000 bytes, the most an Atlias command can be'));
    if (exists(dest)) return plan.push(present(it, 'already in the Atlias home'));
    const t = readSafe(src, 20000);
    if (t == null) return plan.push(skipped(it, 'could not be read'));
    const md = tool === 'gemini' ? geminiCommandToMarkdown(t) : { md: t };
    if (md.error) return plan.push(skipped(it, md.error));
    if (looksSecret(md.md)) return plan.push(skipped(it, 'it looks like it holds a secret'));
    plan.push(it);
  };
  for (const e of listDir(dir).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (isFile(p) && new RegExp('\\.' + ext + '$', 'i').test(e.name)) one(p, e.name);
    else if (isDir(p)) for (const f of listDir(p).sort((a, b) => a.name.localeCompare(b.name))) if (isFile(path.join(p, f.name)) && new RegExp('\\.' + ext + '$', 'i').test(f.name)) one(path.join(p, f.name), path.join(e.name, f.name));
  }
}
function scanMcp(h, tool, servers, srcFile, plan) {
  for (const { name, def } of servers) {
    const dest = path.join(h.atlias, 'imported', `mcp-${tool}.json`);
    const it = item({ tool, kind: 'mcp', label: name, src: srcFile, dest, server: def });
    plan.push(exists(dest) ? present(it, 'an MCP file for this tool was already imported') : it);
  }
}
function infoRow(plan, tool, kind, label, src, why) { plan.push(skipped(item({ tool, kind, label, src, dest: '' }), why)); }

function scanClaude(h, plan, opts) {
  const c = h.claude;
  scanInstructions(h, 'claude', [path.join(c, 'CLAUDE.md'), ...listDir(path.join(c, 'rules')).filter((e) => /\.md$/i.test(e.name)).map((e) => path.join(c, 'rules', e.name)).sort()], plan);
  for (const e of listDir(path.join(c, 'projects'))) {
    const mem = path.join(c, 'projects', e.name, 'memory');
    if (isDir(mem)) scanMarkdownDir(h, 'claude', 'memory', mem, path.join(h.atlias, 'projects', e.name, 'memory'), plan);
  }
  scanSkills(h, 'claude', path.join(c, 'skills'), plan);
  scanCommandsDir(h, 'claude', path.join(c, 'commands'), 'md', plan);
  const mcpFile = [path.join(h.userHome, '.claude.json'), path.join(c, '.claude.json')].find((f) => isFile(f));
  if (mcpFile) scanMcp(h, 'claude', mcpFromJson(mcpFile, 'claude'), mcpFile, plan);
  const installed = readJson(path.join(c, 'plugins', 'installed_plugins.json'), null);
  const nPlugins = installed && installed.plugins ? Object.keys(installed.plugins).length : 0;
  if (nPlugins) infoRow(plan, 'claude', 'plugins', `${nPlugins} installed plugin${nPlugins === 1 ? '' : 's'}`, path.join(c, 'plugins'), 'Claude plugins are not runnable by Atlias; their skills and commands are not imported');
  if (exists(path.join(c, '.credentials.json'))) infoRow(plan, 'claude', 'credentials', '.credentials.json', path.join(c, '.credentials.json'), 'credential file; never read');
  if (opts.sessions) {
    for (const e of listDir(path.join(c, 'projects'))) {
      for (const f of listDir(path.join(c, 'projects', e.name))) {
        if (!f.isFile() || !/^[0-9a-f-]{36}\.jsonl$/i.test(f.name)) continue;
        const src = path.join(c, 'projects', e.name, f.name);
        const sid = 'atlias-' + f.name.replace(/\.jsonl$/i, '');
        const dest = chatFile(h, sid);
        const it = item({ tool: 'claude', kind: 'sessions', label: f.name.replace(/\.jsonl$/i, ''), src, dest, bytes: sizeOf(src), sid });
        plan.push(it.bytes > MAX_SESSION_BYTES ? skipped(it, `over ${MAX_SESSION_BYTES} bytes`) : exists(dest) ? present(it, 'already imported') : it);
      }
    }
  }
}
function scanCodex(h, plan, opts) {
  const c = h.codex;
  scanInstructions(h, 'codex', [path.join(c, 'AGENTS.md')], plan);
  scanMarkdownDir(h, 'codex', 'memory', path.join(c, 'memories'), path.join(h.atlias, 'memory', 'codex'), plan, { skip: () => false });
  scanSkills(h, 'codex', path.join(c, 'skills'), plan);
  scanSkills(h, 'codex', path.join(h.userHome, '.agents', 'skills'), plan);
  const cfg = path.join(c, 'config.toml');
  if (isFile(cfg)) scanMcp(h, 'codex', mcpFromToml(cfg, 'codex'), cfg, plan);
  if (exists(path.join(c, 'auth.json'))) infoRow(plan, 'codex', 'credentials', 'auth.json', path.join(c, 'auth.json'), 'credential file; never read');
  if (opts.sessions) {
    const walk = (dir, depth) => {
      for (const e of listDir(dir)) {
        const p = path.join(dir, e.name);
        if (e.isDirectory() && depth < 5) walk(p, depth + 1);
        else if (e.isFile() && /^rollout-.*\.jsonl$/i.test(e.name)) {
          const id = (/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(e.name) || [])[1];
          if (!id) continue;
          const sid = 'atlias-codex-' + id;
          const dest = chatFile(h, sid);
          const it = item({ tool: 'codex', kind: 'sessions', label: id, src: p, dest, bytes: sizeOf(p), sid });
          plan.push(it.bytes > MAX_SESSION_BYTES ? skipped(it, `over ${MAX_SESSION_BYTES} bytes`) : exists(dest) ? present(it, 'already imported') : it);
        }
      }
    };
    walk(path.join(c, 'sessions'), 0);
  }
}
function scanGemini(h, plan) {
  const g = h.gemini;
  scanInstructions(h, 'gemini', [path.join(g, 'GEMINI.md')], plan);
  scanCommandsDir(h, 'gemini', path.join(g, 'commands'), 'toml', plan);
  const st = path.join(g, 'settings.json');
  if (isFile(st)) scanMcp(h, 'gemini', mcpFromJson(st, 'gemini'), st, plan);
  if (exists(path.join(g, 'oauth_creds.json'))) infoRow(plan, 'gemini', 'credentials', 'oauth_creds.json', path.join(g, 'oauth_creds.json'), 'credential file; never read');
}
function scanAntigravity(h, plan, opts) {
  const g = path.join(h.gemini, 'config');
  scanSkills(h, 'antigravity', path.join(g, 'skills'), plan);
  const mc = path.join(g, 'mcp_config.json');
  if (isFile(mc)) scanMcp(h, 'antigravity', mcpFromJson(mc, 'antigravity'), mc, plan);
  if (exists(path.join(h.gemini, 'jetski-standalone-oauth-token'))) infoRow(plan, 'antigravity', 'credentials', 'jetski-standalone-oauth-token', path.join(h.gemini, 'jetski-standalone-oauth-token'), 'credential file; never read');
  if (opts.sessions && (isDir(path.join(h.gemini, 'antigravity', 'conversations')) || isDir(path.join(h.gemini, 'antigravity-cli')))) infoRow(plan, 'antigravity', 'sessions', 'conversations', path.join(h.gemini, 'antigravity'), 'Antigravity keeps conversations in a format that is not documented (partly protobuf and SQLite); not imported');
}

const chatFile = (h, sid) => path.join(h.atlias, 'sessions', `${safeId(sid)}.chat.json`);

// opts: { homes, from: 'claude'|'codex'|..., sessions: bool }. Reads nothing but listings and small text files.
export function scan(opts = {}) {
  const h = homesOf(opts.homes);
  const want = opts.from ? [].concat(opts.from) : TOOLS;
  const bad = want.filter((t) => !TOOLS.includes(t));
  if (bad.length) throw Error(`unknown tool ${bad.join(', ')}; choose from ${TOOLS.join(', ')}`);
  const plan = [];
  if (want.includes('claude')) scanClaude(h, plan, opts);
  if (want.includes('codex')) scanCodex(h, plan, opts);
  if (want.includes('gemini')) scanGemini(h, plan);
  if (want.includes('antigravity')) scanAntigravity(h, plan, opts);
  // The same destination twice in one plan (two tools shipping a skill of one name): the first wins.
  const seen = new Set();
  return plan.map((it) => {
    if (it.status !== 'new' || !it.dest || it.kind === 'instructions' || it.kind === 'mcp') return it;
    if (seen.has(it.dest)) return present(it, 'an earlier item in this import has the same name');
    seen.add(it.dest);
    return it;
  });
}

export function counts(plan) {
  const out = {};
  for (const it of plan) {
    const t = (out[it.tool] = out[it.tool] || {});
    const k = (t[it.kind] = t[it.kind] || { new: 0, present: 0, skip: 0 });
    k[it.status]++;
  }
  return out;
}
export const newItems = (plan) => plan.filter((it) => it.status === 'new');

// The text shown before anything is copied. detail: list the new items one by one (dry run).
export function describe(plan, { detail = false } = {}) {
  const cs = counts(plan);
  const L = [];
  for (const tool of TOOLS) {
    if (!cs[tool]) continue;
    L.push(`${LABELS[tool]}:`);
    for (const [kind, v] of Object.entries(cs[tool])) {
      const bits = [];
      if (v.new) bits.push(`${v.new} to import`);
      if (v.present) bits.push(`${v.present} already in Atlias`);
      if (v.skip) bits.push(`${v.skip} skipped`);
      L.push(`  ${kind.padEnd(13)} ${bits.join(', ')}`);
    }
  }
  if (!L.length) L.push('no other tool with anything to import was found on this computer');
  const why = plan.filter((it) => it.status === 'skip');
  if (why.length) { L.push('', 'skipped:'); for (const it of why.slice(0, 12)) L.push(`  ${LABELS[it.tool]} ${it.kind} ${it.label}: ${it.why}`); if (why.length > 12) L.push(`  ... and ${why.length - 12} more`); }
  if (detail) {
    const fresh = newItems(plan);
    if (fresh.length) { L.push('', 'would be written:'); for (const it of fresh.slice(0, 60)) L.push(`  ${it.kind.padEnd(12)} ${it.dest}`); if (fresh.length > 60) L.push(`  ... and ${fresh.length - 60} more`); }
  }
  L.push('', 'Credentials, tokens, keys and OAuth files are never read or copied. Anything that looks like a secret is removed from what is copied. `atlias import --undo` takes the whole import back.');
  return L.join('\n');
}

// ---------- sessions ----------
class Turns {
  constructor() { this.turns = []; this.cur = null; this.redacted = 0; }
  clean(t, max) { const r = redactInline(String(t ?? '')); this.redacted += r.n; return clip(r.text.trim(), max); }
  user(t) { const x = this.clean(t, TEXT_MAX); if (!x) return; this.cur = { user: x, parts: [] }; this.turns.push(this.cur); }
  part(s) { if (!s) return; if (!this.cur) { this.cur = { user: '(the session began without a message from the user)', parts: [] }; this.turns.push(this.cur); } this.cur.parts.push(s); }
  assistant(t) { const x = this.clean(t, TEXT_MAX); if (x) this.part(x); }
  tool(name, arg) { this.part(`[tool ${clip(String(name || 'tool'), 40)}${arg ? ': ' + this.clean(arg, 120) : ''}]`); }
  result(body, isError) {
    const text = Array.isArray(body) ? body.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n') : typeof body === 'string' ? body : JSON.stringify(body ?? '');
    const len = text.length;
    if (!len) return;
    if (len > RESULT_MAX) return this.part(`[${isError ? 'error ' : ''}result omitted: ${len} characters]`);
    this.part(`[${isError ? 'error ' : ''}result: ${this.clean(text, RESULT_MAX).replace(/\s*\n\s*/g, ' ')}]`);
  }
  history() { return this.turns.flatMap((t) => [{ role: 'user', text: t.user }, { role: 'assistant', text: t.parts.join('\n') || '(no reply recorded)' }]); }
}
function toolArg(input) {
  if (!input || typeof input !== 'object') return typeof input === 'string' ? input : '';
  for (const k of ['command', 'cmd', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt']) {
    const v = input[k];
    if (typeof v === 'string' && v) return v.replace(/\s+/g, ' ');
    if (Array.isArray(v) && v.length) return v.join(' ');
  }
  return '';
}
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
function claudeUserText(raw) {
  const t = String(raw || '').replace(SYSTEM_REMINDER, '').trim();
  if (!t) return '';
  if (/^<(command-|local-command|bash-|task-notification)/.test(t) || /^\[Request interrupted/.test(t)) return '';
  return t;
}
export function convertClaude(file) {
  const text = readSafe(file, MAX_SESSION_BYTES);
  if (text == null) return null;
  const T = new Turns();
  const summaries = [];
  let cwd = '';
  let first = 0, last = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'summary' && typeof o.summary === 'string') { summaries.push(o.summary); continue; }
    if (o.isSidechain || o.isMeta) continue;
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    if (!cwd && typeof o.cwd === 'string') cwd = o.cwd;
    const ts = Date.parse(o.timestamp);
    if (ts) { if (!first) first = ts; last = ts; }
    const content = o.message && o.message.content;
    if (o.type === 'user') {
      if (typeof content === 'string') { const t = claudeUserText(content); if (t) T.user(t); } else if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type === 'text') { const t = claudeUserText(b.text); if (t) T.user(t); } else if (b.type === 'tool_result') T.result(b.content, b.is_error);
        }
      }
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (b.type === 'text') T.assistant(b.text); else if (b.type === 'tool_use') T.tool(b.name, toolArg(b.input));
      }
    }
  }
  if (!T.turns.length || !cwd) return null;
  return { cwd, turns: T.turns, history: T.history(), summaries: summaries.map((s) => T.clean(s, 600)), first, last, redacted: T.redacted };
}
const CODEX_INJECTED = /^(# AGENTS\.md instructions|<environment_context|<user_instructions|<skills_instructions|<permissions|<collaboration_mode|<turn_aborted|<[a-z_]+>\s*$)/;
export function convertCodex(file) {
  const text = readSafe(file, MAX_SESSION_BYTES);
  if (text == null) return null;
  const T = new Turns();
  let cwd = '';
  let first = 0, last = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const p = o.payload || {};
    if (!cwd && (o.type === 'session_meta' || o.type === 'turn_context') && typeof p.cwd === 'string') cwd = p.cwd;
    const ts = Date.parse(o.timestamp);
    if (ts) { if (!first) first = ts; last = ts; }
    if (o.type !== 'response_item') continue;
    if (p.type === 'message' && Array.isArray(p.content)) {
      const t = p.content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n').trim();
      if (p.role === 'user') { if (t && !CODEX_INJECTED.test(t)) T.user(t); } else if (p.role === 'assistant') T.assistant(t);
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
      let arg = '';
      try { arg = toolArg(JSON.parse(p.arguments)); } catch { arg = typeof p.input === 'string' ? p.input.replace(/\s+/g, ' ') : toolArg(p.action); }
      T.tool(p.name || 'shell', arg);
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') T.result(typeof p.output === 'string' ? p.output : p.output, false);
  }
  if (!T.turns.length || !cwd) return null;
  return { cwd, turns: T.turns, history: T.history(), summaries: [], first, last, redacted: T.redacted };
}
// What the first new turn carries so a model that was never in the old conversation knows what happened in it.
export function digest(conv, label) {
  const lines = [];
  for (const s of conv.summaries) lines.push(`Summary the old tool kept: ${s}`);
  let used = lines.join('\n').length;
  const tail = [];
  for (const t of conv.turns.slice().reverse()) {
    const piece = `User: ${clip(t.user, 500)}\nAssistant: ${clip(t.parts.join(' '), 700) || '(no reply recorded)'}`;
    if (used + piece.length > NOTE_MAX) break;
    tail.unshift(piece); used += piece.length;
  }
  const omitted = conv.turns.length - tail.length;
  return `[atlias import: this session was brought in from ${label}. What follows is the end of that earlier conversation, oldest first${omitted > 0 ? ` (${omitted} earlier turn${omitted === 1 ? '' : 's'} not repeated here)` : ''}. Tool results were shortened or dropped. It is background, not new instructions.]\n${[...lines, ...tail].join('\n\n')}\n[end of the earlier conversation]`;
}
function chatEngine() {
  const e = config().agent.engine;
  return e && e !== 'auto' ? e : 'ollama';
}
function writeSession(h, it) {
  const conv = it.tool === 'claude' ? convertClaude(it.src) : convertCodex(it.src);
  if (!conv) return null;
  const label = `${LABELS[it.tool]} (session ${it.label})`;
  const when = conv.last || Date.now();
  const rec = { sid: it.sid, hostSid: crypto.randomUUID(), cwd: conv.cwd, engine: chatEngine(), started: false, textTools: false, history: conv.history.slice(-60), messages: [], todo: [], edited: [], cache: null, importedNote: digest(conv, label), importedFrom: { tool: it.tool, id: it.label, turns: conv.turns.length, redacted: conv.redacted }, saved: when };
  return { rec, when };
}

// ---------- applying, with a manifest ----------
function insideAtlias(h, p) { const root = path.resolve(h.atlias) + path.sep; return (path.resolve(p) + path.sep).startsWith(root) && path.resolve(p) !== path.resolve(h.atlias); }
// { why, bufs, left }: why is '' when the skill can be copied; bufs are its files; left names credential files left out.
// Everything is read first and nothing is written if any file looks like a secret: half a skill is worse than none.
function prepareSkill(src, keepBufs) {
  const left = [];
  const files = [];
  let bytes = 0;
  const walk = (dir, rel, depth) => {
    for (const e of listDir(dir)) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (isDir(p)) { if (depth < 6) walk(p, path.join(rel, e.name), depth + 1); continue; }
      if (!isFile(p)) continue;
      if (isCredentialPath(p)) { left.push(path.join(rel, e.name)); continue; }
      const size = sizeOf(p);
      bytes += size;
      files.push({ p, rel: path.join(rel, e.name), size });
    }
  };
  walk(src, '', 0);
  if (files.length > MAX_SKILL_FILES || bytes > MAX_SKILL_BYTES) return { why: `too large (${files.length} files, ${bytes} bytes)`, bufs: [], left };
  const bufs = [];
  for (const f of files) {
    const buf = fs.readFileSync(f.p);
    if (f.size < 1024 * 1024 && !buf.includes(0) && looksSecret(buf.toString('utf8'))) return { why: `${f.rel} looks like it holds a secret`, bufs: [], left };
    if (keepBufs) bufs.push({ rel: f.rel, buf });
  }
  return { why: '', bufs, left };
}
function copySkill(src, dest, made, notes) {
  if (exists(dest)) return 'the skill folder appeared in the Atlias home after the plan was made; left as it is';
  const r = prepareSkill(src, true);
  if (r.why) return r.why;
  for (const l of r.left) notes.push(`${path.basename(src)}: left out ${l} (a credential file)`);
  for (const b of r.bufs) made.file(path.join(dest, b.rel), b.buf);
  return '';
}
class Made {
  constructor(h) { this.h = h; this.files = []; this.dirs = []; }
  ensureDirs(dir) {
    const missing = [];
    fs.mkdirSync(this.h.atlias, { recursive: true });
    for (let d = path.resolve(dir); insideAtlias(this.h, d) && !exists(d); d = path.dirname(d)) missing.unshift(d);
    for (const d of missing) { fs.mkdirSync(d); this.dirs.push(d); }
  }
  file(dest, content) {
    if (!insideAtlias(this.h, dest)) throw Error(`refusing to write outside the Atlias home: ${dest}`);
    if (exists(dest)) return false;
    this.ensureDirs(path.dirname(dest));
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    fs.writeFileSync(dest, buf, { flag: 'wx' });
    this.files.push({ path: path.resolve(dest), sha256: sha(buf) });
    return true;
  }
}
// plan items with status 'new' are written; the rest are not. Returns { created, notes, manifest }.
export function apply(plan, opts = {}) {
  const h = homesOf(opts.homes);
  const made = new Made(h);
  const notes = [];
  const done = [];
  const fresh = newItems(plan);
  // One AGENTS.md from every instruction source of this import.
  const ins = fresh.filter((it) => it.kind === 'instructions');
  if (ins.length) {
    const parts = [`<!-- written by atlias import on ${new Date().toISOString().slice(0, 10)}; edit it freely -->`];
    let removed = 0;
    for (const it of ins) {
      const t = readSafe(it.src);
      if (t == null) { notes.push(`${it.label}: could not be read`); continue; }
      const r = dropSecretLines(t);
      removed += r.n;
      parts.push(`# Imported from ${LABELS[it.tool]}: ${it.label}\n\n${r.text.trim()}`);
      done.push(it);
    }
    if (done.length && made.file(ins[0].dest, parts.join('\n\n') + '\n') && removed) notes.push(`instructions: ${removed} line${removed === 1 ? '' : 's'} that looked like a secret removed`);
  }
  for (const it of fresh) {
    if (it.kind === 'instructions' || it.kind === 'mcp') continue;
    if (it.kind === 'memory' || it.kind === 'commands') {
      let t = readSafe(it.src);
      if (t == null) { notes.push(`${it.label}: could not be read`); continue; }
      if (it.kind === 'commands') {
        if (it.tool === 'gemini') { const g = geminiCommandToMarkdown(t); if (g.error) { notes.push(`${it.label}: not imported, ${g.error}`); continue; } t = g.md; }
        if (looksSecret(t)) { notes.push(`${it.label}: not imported, it looks like it holds a secret`); continue; }
      } else {
        const r = dropSecretLines(t);
        if (r.n) notes.push(`${it.label}: ${r.n} line${r.n === 1 ? '' : 's'} that looked like a secret removed`);
        t = r.text;
      }
      if (made.file(it.dest, t.endsWith('\n') ? t : t + '\n')) done.push(it);
    } else if (it.kind === 'skills') {
      const why = copySkill(it.src, it.dest, made, notes);
      if (why) notes.push(`skill ${it.label}: not imported, ${why}`); else done.push(it);
    } else if (it.kind === 'sessions') {
      const w = writeSession(h, it);
      if (!w) { notes.push(`session ${it.label}: nothing to import (no messages or no project folder recorded)`); continue; }
      const dest = it.dest;
      if (made.file(dest, JSON.stringify(w.rec, null, 2) + '\n')) { try { const t = new Date(w.when); fs.utimesSync(dest, t, t); } catch { /* the time stays as written */ } done.push(it); }
    }
  }
  // MCP: one file per tool holding every new server of that tool.
  for (const tool of TOOLS) {
    const servers = fresh.filter((it) => it.kind === 'mcp' && it.tool === tool);
    if (!servers.length) continue;
    const doc = { note: `MCP server definitions brought in from ${LABELS[tool]} by atlias import. Atlias does not start MCP servers itself yet; this file keeps the definitions, without any secret values.`, mcpServers: Object.fromEntries(servers.map((s) => [s.label, s.server])) };
    if (made.file(servers[0].dest, JSON.stringify(doc, null, 2) + '\n')) done.push(...servers);
  }
  let manifest = '';
  if (made.files.length) {
    const id = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + crypto.randomBytes(3).toString('hex');
    manifest = path.join(h.atlias, 'imports', `${id}.json`);
    // The manifest directory is made first so it can be listed too; the manifest file itself stays after an undo as the record.
    writeJson(manifest, { id, at: new Date().toISOString(), tools: [...new Set(done.map((i) => i.tool))], created: made.files, dirs: made.dirs, undone: null });
  }
  const byKind = {};
  for (const it of done) byKind[it.kind] = (byKind[it.kind] || 0) + 1;
  return { created: made.files.length, imported: done.length, byKind, notes, manifest };
}

// ---------- undo ----------
export function manifests(homes) {
  const h = homesOf(homes);
  return listDir(path.join(h.atlias, 'imports')).filter((e) => /\.json$/.test(e.name)).map((e) => path.join(h.atlias, 'imports', e.name)).sort();
}
// Removes the files the manifests list, only while they are still byte for byte what the import wrote
// (a session that was resumed and saved again is the person's work now, and stays). Then the folders the
// import made, if they are empty. { removed, kept, manifests }.
export function undo(opts = {}) {
  const h = homesOf(opts.homes);
  const removed = [];
  const kept = [];
  let n = 0;
  for (const file of manifests(opts.homes).reverse()) {
    const m = readJson(file, null);
    if (!m || m.undone || !Array.isArray(m.created)) continue;
    n++;
    for (const f of m.created) {
      const p = path.resolve(String(f.path || ''));
      if (!insideAtlias(h, p)) { kept.push({ path: p, why: 'outside the Atlias home; the manifest was altered, so it was not touched' }); continue; }
      let buf;
      try { buf = fs.readFileSync(p); } catch { continue; }
      if (sha(buf) !== f.sha256) { kept.push({ path: p, why: 'changed since the import; left in place' }); continue; }
      try { fs.unlinkSync(p); removed.push(p); } catch (e) { kept.push({ path: p, why: e.message }); }
    }
    for (const d of (m.dirs || []).slice().reverse()) {
      const p = path.resolve(String(d));
      if (!insideAtlias(h, p)) continue;
      try { if (!fs.readdirSync(p).length) fs.rmdirSync(p); } catch { /* not empty or gone */ }
    }
    m.undone = new Date().toISOString();
    writeJson(file, m);
  }
  return { removed, kept, manifests: n };
}

// ---------- the marker: asked once ----------
export const markerPath = (homes) => path.join(homesOf(homes).atlias, 'import-marker.json');
export const hasMarker = (homes) => exists(markerPath(homes));
export function writeMarker(choice, homes) {
  const p = markerPath(homes);
  if (!exists(p)) writeJson(p, { at: new Date().toISOString(), choice });
  return p;
}

// ---------- the flows ----------
const YES = /^\s*y(es)?\s*$/i;
export const isYes = (s) => YES.test(String(s ?? ''));
export function parseArgs(words) {
  const o = { dryRun: false, undo: false, sessions: false, yes: false, from: null, error: '' };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === '--dry-run') o.dryRun = true;
    else if (w === '--undo') o.undo = true;
    else if (w === '--sessions') o.sessions = true;
    else if (w === '--yes' || w === '-y') o.yes = true;
    else if (w === '--from') { const v = words[++i]; if (!TOOLS.includes(v)) o.error = `--from takes one of ${TOOLS.join(', ')}`; else o.from = v; } else if (w.startsWith('--from=')) { const v = w.slice(7); if (!TOOLS.includes(v)) o.error = `--from takes one of ${TOOLS.join(', ')}`; else o.from = v; } else o.error = `unknown option ${w}`;
  }
  return o;
}
export const USAGE = 'usage: atlias import [--dry-run] [--from claude|codex|gemini|antigravity] [--sessions] [--yes] [--undo]';
export function summaryLine(r) {
  const parts = Object.entries(r.byKind).map(([k, v]) => `${v} ${k}`);
  return r.created ? `imported ${parts.join(', ')} (${r.created} file${r.created === 1 ? '' : 's'}); \`atlias import --undo\` takes it back` : 'nothing was copied';
}
// The shared body of `atlias import` and /import. ask: async (question) => answer; without it, a real
// import needs --yes, because nothing is copied without a yes.
export async function runImport(argsOrWords, { homes, ask, out } = {}) {
  const o = Array.isArray(argsOrWords) ? parseArgs(argsOrWords) : argsOrWords;
  const say = out || (() => {});
  if (o.error) { say(`${o.error}\n${USAGE}`); return { code: 2 }; }
  if (o.undo) {
    const r = undo({ homes });
    say(r.manifests ? `removed ${r.removed.length} file${r.removed.length === 1 ? '' : 's'} from ${r.manifests} import${r.manifests === 1 ? '' : 's'}${r.kept.length ? `; left ${r.kept.length} in place:\n${r.kept.map((k) => `  ${k.path}: ${k.why}`).join('\n')}` : ''}` : 'no import to undo');
    return { code: 0, undo: r };
  }
  const plan = scan({ homes, from: o.from, sessions: o.sessions });
  say(describe(plan, { detail: o.dryRun }));
  if (o.dryRun) { say('\ndry run: nothing was copied'); return { code: 0, plan, dryRun: true }; }
  if (!newItems(plan).length) { say('\nnothing new to import'); writeMarker('nothing', homes); return { code: 0, plan }; }
  let yes = o.yes;
  if (!yes) {
    if (!ask) { say('\nnothing was copied: say yes by adding --yes, or run this where it can ask'); return { code: 1, plan }; }
    yes = isYes(await ask('\nImport these into Atlias? Nothing is copied unless you answer yes [y/N] '));
  }
  if (!yes) { say('nothing was copied'); return { code: 0, plan, declined: true }; }
  const r = apply(plan, { homes });
  writeMarker('imported', homes);
  say(summaryLine(r));
  for (const n of r.notes.slice(0, 20)) say('  ' + n);
  return { code: 0, plan, result: r };
}
// The first time `atlias agent` starts: say what was found and ask. Asked once; the marker is written
// whatever the answer. Not interactive (a pipe, a test): nothing is asked, nothing is written, no marker.
export async function firstRunOffer({ homes, ask, out, interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) } = {}) {
  if (process.env.ATLIAS_NO_IMPORT_OFFER === '1') return { skipped: 'disabled' };
  if (hasMarker(homes)) return { skipped: 'marker' };
  if (!interactive || !ask) return { skipped: 'not interactive' };
  const plan = scan({ homes, sessions: true });
  const configItems = plan.filter((it) => it.kind !== 'sessions');
  const sessionItems = plan.filter((it) => it.kind === 'sessions');
  if (!newItems(plan).length) { writeMarker('nothing', homes); return { skipped: 'nothing found' }; }
  out('Atlias found things from your other tools that it can bring over:');
  out(describe(plan));
  const yes = isYes(await ask('\nImport the instructions, memory, skills, commands and MCP definitions now? Nothing is copied unless you answer yes [y/N] '));
  let result = null;
  if (yes) {
    result = apply(configItems, { homes });
    out(summaryLine(result));
    for (const n of result.notes.slice(0, 10)) out('  ' + n);
  }
  const fresh = newItems(sessionItems);
  if (fresh.length && isYes(await ask(`Also import ${fresh.length} saved session${fresh.length === 1 ? '' : 's'} so /resume can open them? [y/N] `))) {
    const s = apply(sessionItems, { homes });
    out(summaryLine(s));
    result = result ? { ...result, sessions: s } : s;
  }
  writeMarker(yes || result ? 'imported' : 'declined', homes);
  out('This is asked once. `atlias import --dry-run` shows the plan again; `atlias import --undo` takes an import back.');
  return { asked: true, yes, result };
}

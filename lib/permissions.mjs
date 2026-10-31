// Permission modes (Gev, 2026-10-17, last-phase goal: plan, ask, auto-accept and auto modes plus MAX).
//
// agent.permissions holds one of:
//   workspace    edits in the project run, commands run, a guard-flagged command or a write outside the project asks (the default, unchanged)
//   ask          every edit and every command asks first (unchanged)
//   read-only    no edits at all; a command asks first (unchanged)
//   auto-accept  edits and writes run without asking; every command asks
//   plan         read-only exploration; writes and commands are refused with a message to present a plan
//   auto         commands run without asking; a command the guard flags, or one that touches a credential, a payment,
//                a publish or a send, asks first
//   max          never asks the user anything. Because it never asks, it REFUSES what auto would ask about, and logs
//                every call and every refusal to a file under the Atlias home.
//
// Nothing in this file runs for workspace, ask or read-only. lib/loop.mjs calls it only for the new modes.
//
// What max refuses (each refusal has a class that is logged):
//   destructive   the guard's destructive patterns (lib/guard.mjs), which include killing a process by PID
//   system        a write to, or a mutating command on, a system directory
//   outside       a delete, move, overwrite or redirect aimed outside the project folder (the work area); no copy is
//                 kept for such a target, so it is refused rather than allowed
//   credentials   reading or sending a credential, key or secret: key and token files, env dumps, secret-bearing
//                 variables and headers
//   money         a command that spends money (paid cloud resources, payment tools, paid APIs)
//   publish       a command that publishes or sends as the user (git push, package publish, deploys, posts, mail, uploads)
// Limit, stated plainly: a command is judged by its text. A program written to do one of these things in its own code
// (python -c "os.remove(...)") is not seen by this check. max narrows what a model can do by accident or by a bad
// reply; it is not a sandbox. Use agent.sandbox for that.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STATE_DIR, appendLine, clip } from './core.mjs';
import * as guard from './guard.mjs';

export const MODES = ['workspace', 'ask', 'read-only', 'auto-accept', 'plan', 'auto', 'max'];
export const NEW_MODES = new Set(['auto-accept', 'plan', 'auto', 'max']);
// The order a key or "/permissions next" moves through. ask, read-only and max are chosen by name, never cycled into.
export const CYCLE = ['workspace', 'auto-accept', 'plan', 'auto'];
export const nextMode = (current) => { const i = CYCLE.indexOf(current); return CYCLE[(i + 1) % CYCLE.length]; };

export const MODE_TEXT = {
  workspace: 'edits in the project run; a flagged command or a write outside the project asks',
  ask: 'every edit and command asks first',
  'read-only': 'no edits at all; a command asks first',
  'auto-accept': 'edits and writes run without asking; commands still ask',
  plan: 'read-only exploration; writes and commands are refused until you leave plan mode with /permissions',
  auto: 'commands run without asking; a risky one (guard-flagged, credentials, payments, publishing, sending) asks first',
  max: 'never asks anything, so it refuses catastrophic or irreversible actions and logs each call and refusal',
};
export const summary = (current) => `permissions ${current}: ${MODES.map((m) => `${m} (${MODE_TEXT[m]})`).join('; ')}`;
export const MAX_NOTICE = 'permissions max: the agent will not ask you anything. It refuses deletes outside the project, system folders, credentials, spending, publishing, sending and killing processes by PID, and logs every call (/permissions log). /permissions workspace leaves this mode.';

export const planRefusal = (tool) => `plan mode: ${tool} is not allowed here and nothing was changed or run. Present your plan to the user as text (the steps, the files you will touch, how you will check it). The user leaves plan mode with /permissions workspace (or auto-accept, auto, ask) and then you can carry it out.`;
export const maxRefusal = (cls, why) => `max mode refused (${cls}): ${why}. Nothing was run or changed. max never asks the user, so it does not do this; choose another way, or leave this part for the user.`;

// Hook point for computer use (Gev's plan: max works through Atlias computer use so the user can be offline). Not built.
// A later module sets hooks.computerAction = (call, ctx) => null | { cls, why } | string ... and loop.mjs's max gate calls
// it for any tool name that is not one of the built-in tools, before the tool runs. With no hook set, such a tool falls
// through to the loop's normal "unknown tool" answer, so nothing is added to the tool list.
export const hooks = { computerAction: null };
export const BUILTIN_TOOLS = new Set(['outline', 'read_file', 'edit_file', 'write_file', 'apply_patch', 'list_dir', 'grep', 'shell', 'todo', 'recall', 'remember', 'graph_query']);

// ---------------------------------------------------------------- paths

const WIN = process.platform === 'win32';
const norm = (p) => path.resolve(p);
export function inside(root, target) {
  const r = path.relative(norm(root), norm(target));
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}
const SYSTEM_WIN = /^[a-z]:\/(windows|program files( \(x86\))?|programdata|\$recycle\.bin|system volume information|boot|recovery)(\/|$)/;
const SYSTEM_POSIX = /^\/(etc|usr|bin|sbin|boot|sys|proc|lib|lib32|lib64|var|dev|root|system|library|private\/etc|private\/var|opt)(\/|$)/;
export function isSystemPath(p) {
  let s = String(p || '').replace(/\\/g, '/');
  const git = /^\/([a-zA-Z])\/(.*)$/.exec(s);
  if (WIN && git) s = `${git[1]}:/${git[2]}`;
  s = s.toLowerCase();
  if (s === '/dev/null' || s === '/dev/stderr' || s === '/dev/stdout') return false;
  return SYSTEM_WIN.test(s) || (!/^[a-z]:\//.test(s) && SYSTEM_POSIX.test(s));
}

// A path that holds or is a credential, key or secret.
const SECRET_BASENAME = [
  /^\.env(\..+)?$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /\.(pem|key|p12|pfx|jks|keystore|ppk|kdbx)$/i,
  /^(credentials|credentials\.json|\.netrc|_netrc|\.npmrc|\.pypirc|\.git-credentials|\.htpasswd|\.pgpass|secrets?\.(json|ya?ml|toml|env|txt)|service-account.*\.json|token\.json|auth\.json|login data|cookies|key[34]\.db|logins\.json)$/i,
];
const SECRET_SAFE = /^\.env\.(example|sample|template|dist|defaults)$/i;
const SECRET_DIRS = /(^|\/)(\.ssh|\.aws|\.gnupg|\.kube|\.azure|\.config\/gcloud|\.config\/gh|\.docker)(\/|$)/i;
export function isSecretPath(p) {
  const s = String(p || '').replace(/\\/g, '/');
  const base = s.split('/').pop();
  if (!base) return false;
  if (SECRET_SAFE.test(base) || /\.pub$/i.test(base)) return false;
  return SECRET_DIRS.test(s) || SECRET_BASENAME.some((re) => re.test(base));
}

// ---------------------------------------------------------------- shell text

// Quote-aware split into simple commands, each a list of words (quotes removed).
export function simpleWords(cmd) {
  const cmds = [];
  let words = [], cur = '', inWord = false, q = null;
  const endWord = () => { if (inWord) { words.push(cur); cur = ''; inWord = false; } };
  const endCmd = () => { endWord(); if (words.length) cmds.push(words); words = []; };
  const s = String(cmd || '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === q) q = null;
      else if (ch === '\\' && q === '"' && i + 1 < s.length && /["\\$`]/.test(s[i + 1])) { cur += s[++i]; }
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { q = ch; inWord = true; continue; }
    if (ch === '\\' && !WIN && i + 1 < s.length) { cur += s[++i]; inWord = true; continue; }
    if (ch === '\n' || ch === ';' || ch === '|' || ch === '(' || ch === ')' || ch === '`') { endCmd(); continue; }
    if (ch === '&' && s[i + 1] === '&') { endCmd(); i++; continue; }
    if (ch === '&' && s[i - 1] !== '>' && s[i + 1] !== '>') { endCmd(); continue; }
    if (/\s/.test(ch)) { endWord(); continue; }
    // A redirect is a word of its own (">", ">>", "2>", ">&1") even when written against its target: echo x>/etc/hosts.
    if (ch === '>') {
      let op = /^\d+$/.test(cur) ? cur : '';
      if (op) { cur = ''; inWord = false; } else endWord();
      op += '>';
      if (s[i + 1] === '>') { op += '>'; i++; }
      if (s[i + 1] === '&') { op += '&'; i++; while (/\d|-/.test(s[i + 1] || '')) op += s[++i]; }
      words.push(op);
      continue;
    }
    cur += ch; inWord = true;
  }
  endCmd();
  return cmds;
}
const progName = (w) => String(w || '').replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();

const UNRESOLVED = Symbol('unresolved');
// Turn a word into an absolute path, or UNRESOLVED when it names a variable that is not set.
function resolveWord(word, cwd) {
  let w = String(word);
  if (w === '~' || w.startsWith('~/') || w.startsWith('~\\')) w = os.homedir() + w.slice(1);
  let bad = false;
  w = w.replace(/%([A-Za-z_][A-Za-z0-9_]*)%|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$env:([A-Za-z_][A-Za-z0-9_]*)|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a, b, c, d) => {
    const name = a || b || c || d;
    const hit = Object.keys(process.env).find((k) => k.toLowerCase() === name.toLowerCase());
    const v = name.toUpperCase() === 'HOME' && !hit ? os.homedir() : (hit ? process.env[hit] : undefined);
    if (v === undefined) { bad = true; return m; }
    return v;
  });
  if (bad || /[$`]/.test(w)) return UNRESOLVED;
  const git = /^\/([a-zA-Z])\/(.*)$/.exec(w);
  if (WIN && git) w = `${git[1]}:/${git[2]}`;
  if (WIN && /^\/[^/]/.test(w) && !/^\/[a-zA-Z]:/.test(w)) return w; // a rooted POSIX path on Windows, kept as written
  return path.resolve(cwd, w);
}

const NULLS = new Set(['/dev/null', '/dev/stderr', '/dev/stdout', 'nul', 'nul:', '$null', '&1', '&2']);
const DELETERS = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri', 'unlink', 'shred', 'trash']);
const MOVERS = new Set(['mv', 'move', 'move-item', 'mi']);
const COPIERS = new Set(['cp', 'copy', 'copy-item', 'cpi', 'xcopy', 'robocopy', 'install', 'ln', 'rsync']);
const WRITERS = new Set(['tee', 'out-file', 'set-content', 'add-content', 'clear-content', 'sc', 'new-item', 'ni', 'set-item', 'truncate']);
const PERMS = new Set(['chmod', 'chown', 'chgrp', 'icacls', 'takeown', 'attrib', 'setfacl']);
const WINSTYLE = new Set(['del', 'erase', 'rd', 'rmdir', 'copy', 'xcopy', 'robocopy', 'move']);
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'command', 'nohup', 'time', 'exec', 'nice', 'start-process', 'call']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'cmd', 'powershell', 'pwsh']);

// The words a mutating command would change: targets, or null when the command does not mutate.
function mutationTargets(words) {
  const prog = progName(words[0]);
  const win = WINSTYLE.has(prog);
  const args = words.slice(1).filter((a) => !(/^-/.test(a) && a.length > 1) && !(win && /^\/[a-zA-Z?]{1,4}$/.test(a)));
  if (DELETERS.has(prog) || MOVERS.has(prog) || WRITERS.has(prog) || PERMS.has(prog)) return args;
  if (COPIERS.has(prog)) return args.length ? [args[args.length - 1]] : [];
  if (prog === 'sed' && words.some((a) => /^-[a-zA-Z]*i/.test(a) || a === '--in-place')) return args.length ? [args[args.length - 1]] : [];
  if (prog === 'dd') return words.filter((a) => /^of=/.test(a)).map((a) => a.slice(3));
  // Programs that write where an option says: curl -o, wget -O, tar -C, unzip -d, git clone <url> <dir>.
  const after = (flags) => words.flatMap((a, i) => (flags.includes(a) && words[i + 1] ? [words[i + 1]] : []));
  if (prog === 'curl') return after(['-o', '--output', '--output-dir']);
  if (prog === 'wget') return after(['-O', '--output-document', '-P', '--directory-prefix']);
  if (prog === 'tar') return after(['-C', '--directory']);
  if (prog === 'unzip') return after(['-d']);
  if (prog === 'git' && args[0] === 'clone' && args.length > 2) return [args[args.length - 1]];
  return null;
}

const PAID_HOSTS = /\b(api\.stripe\.com|paypal\.com|api\.paypal\.com|api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.twilio\.com|api\.sendgrid\.com)\b/i;
const SECRET_SHAPES = [
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY/,
  /\bsk-[A-Za-z0-9_-]{20,}/, /\bghp_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bxox[bpas]-[A-Za-z0-9-]{10,}/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/, /https?:\/\/[^/\s:@]+:[^/\s@]+@/,
  /\b(?:authorization|x-api-key|api-key)\s*:/i,
];
const SECRET_VAR = /(\$\{?|%|\$env:)[A-Za-z0-9_]*(API_?KEY|ACCESS_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_?KEY|CREDENTIAL)[A-Za-z0-9_]*/i;
const CRED_PROGS = new Set(['printenv', 'cmdkey', 'security', 'keyctl', 'secret-tool', 'pass', 'gpg-agent']);
const SEND_PROGS = new Set(['sendmail', 'mail', 'mailx', 'mutt', 'swaks', 'msmtp', 'send-mailmessage', 'twurl', 'nc', 'ncat', 'netcat', 'telnet', 'ssh', 'scp', 'sftp', 'ftp', 'tftp', 'rclone', 'aws-s3-sync']);
const MONEY_PROGS = new Set(['stripe', 'paypal']);
const CLOUD = new Set(['aws', 'gcloud', 'az', 'doctl', 'heroku', 'flyctl', 'fly', 'railway', 'linode-cli', 'hcloud', 'oci']);
const SPEND_VERB = /^(create|run-instances|purchase|buy|order|subscribe|scale|launch|provision|apply|deploy|allocate|start-instances|import|reserve)/i;
const HTTP = new Set(['curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'http', 'https', 'xh']);
const UPLOAD = /^(-d|--data(-\w+)?|-F|--form|-T|--upload-file|--post-data|--post-file|--json|-Body|-InFile|-Form)$/i;
const NONGET = /^(?:-X|--request|-Method|--method)$/i;

function publishReason(words, text) {
  const prog = progName(words[0]);
  const sub = words.slice(1).filter((a) => !/^-/.test(a));
  const rest = words.slice(1);
  if (prog === 'git') {
    // The git subcommand is the first word that is not an option or an option's value (-C dir, -c name=value).
    let first = null;
    for (let i = 0; i < rest.length; i++) { if (rest[i] === '-C' || rest[i] === '-c') { i++; continue; } if (!/^-/.test(rest[i])) { first = rest[i]; break; } }
    if (first === 'push' || first === 'send-email') return `git ${first} publishes your work`;
  }
  if (['npm', 'yarn', 'pnpm', 'cargo', 'gem', 'twine', 'poetry', 'dotnet'].includes(prog) && sub.some((a) => /^(publish|push|upload)$/.test(a))) return `${prog} ${sub[0]} publishes a package`;
  if (prog === 'docker' && sub[0] === 'push') return 'docker push publishes an image';
  if (['vercel', 'netlify', 'wrangler', 'firebase', 'surge', 'expo', 'eas'].includes(prog) && sub.some((a) => /^(deploy|publish|submit|update)$/.test(a) || a === '--prod')) return `${prog} deploys or publishes`;
  if (prog === 'vercel' && rest.includes('--prod')) return 'vercel --prod deploys';
  if (prog === 'gh') {
    if (/^(release|pr|issue|gist|repo|workflow|label|secret|variable)$/.test(sub[0] || '') && /^(create|comment|edit|merge|close|delete|run|publish|reopen|set|fork|rename|transfer)$/.test(sub[1] || '')) return `gh ${sub[0]} ${sub[1]} acts on GitHub as you`;
    if (sub[0] === 'api' && rest.some((a, i) => NONGET.test(a) && /^(POST|PUT|PATCH|DELETE)$/i.test(rest[i + 1] || ''))) return 'gh api writes to GitHub as you';
  }
  if (SEND_PROGS.has(prog)) return `${prog} sends data to another machine or person`;
  if (prog === 'rsync' && rest.some((a) => /^[^/\\\s]+:[^\s]*$|@/.test(a) && !/^[a-zA-Z]:[\\/]/.test(a))) return 'rsync sends files to another machine';
  if (HTTP.has(prog)) {
    const post = rest.some((a, i) => (NONGET.test(a) && /^(POST|PUT|PATCH|DELETE)$/i.test(rest[i + 1] || '')) || UPLOAD.test(a) || /^--(request|method)=(POST|PUT|PATCH|DELETE)$/i.test(a));
    if (post) return `${prog} sends data to a remote service`;
  }
  return null;
}
function moneyReason(words, text) {
  const prog = progName(words[0]);
  const sub = words.slice(1).filter((a) => !/^-/.test(a));
  if (MONEY_PROGS.has(prog)) return `${prog} moves money`;
  if (prog === 'terraform' && /^(apply|destroy)$/.test(sub[0] || '')) return 'terraform apply creates paid resources';
  if (CLOUD.has(prog) && sub.some((a) => SPEND_VERB.test(a))) return `${prog} ${sub.slice(0, 3).join(' ')} can create paid resources`;
  if (HTTP.has(prog) && PAID_HOSTS.test(text)) return 'a call to a paid or billing API';
  return null;
}
function credentialReason(words, text) {
  const prog = progName(words[0]);
  if (prog === 'env' && words.length === 1) return 'env prints every environment variable, secrets included';
  if (CRED_PROGS.has(prog)) return `${prog} reads credentials`;
  if (['get-childitem', 'gci', 'ls', 'dir', 'get-item', 'gi'].includes(prog) && words.some((a) => /^env:/i.test(a))) return 'listing the environment shows secrets';
  if (prog === 'set' && words.length === 1) return 'set prints every environment variable, secrets included';
  if (prog === 'gh' && words[1] === 'auth' && words[2] === 'token') return 'gh auth token prints a credential';
  if (prog === 'git' && words[1] === 'credential') return 'git credential reads stored credentials';
  if (prog === 'aws' && words[1] === 'configure' && words[2] === 'get') return 'aws configure get reads credentials';
  if (['op', 'vault', 'gcloud'].includes(prog) && words.some((a) => /^(read|print-access-token|print-identity-token|get)$/.test(a)) && /\b(secret|token|item|kv)\b/i.test(text)) return `${prog} reads a secret`;
  if (prog === 'npm' && words[1] === 'token') return 'npm token handles credentials';
  if (prog === 'docker' && words[1] === 'login') return 'docker login uses credentials';
  for (const w of words.slice(1)) {
    const eq = w.includes('=') ? w.slice(w.indexOf('=') + 1) : w;
    if (isSecretPath(w) || isSecretPath(eq)) return `${clip(w, 80)} is a credential, key or secret file`;
  }
  if (SECRET_VAR.test(text)) return 'the command uses a secret-bearing variable';
  if (SECRET_SHAPES.some((re) => re.test(text))) return 'the command carries a credential or key';
  return null;
}

// What max refuses in one shell command, or null. cwd is the project folder.
export function shellVerdict(cmd, cwd, depth = 0) {
  const text = String(cmd || '');
  const why = guard.destructiveReason(text);
  if (why) return { cls: 'destructive', why };
  let here = cwd;
  for (const raw of simpleWords(text)) {
    // Leading NAME=value assignments and wrapper programs do not change what is run: FOO=1 rm x, sudo rm x, nohup rm x.
    let words = raw;
    for (;;) {
      if (words.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) { words = words.slice(1); continue; }
      if (words.length > 1 && WRAPPERS.has(progName(words[0]))) { words = words.slice(1); while (words.length > 1 && /^-/.test(words[0])) words = words.slice(1); continue; }
      break;
    }
    const prog = progName(words[0]);
    if (SHELLS.has(prog) && depth < 3) {
      const i = words.findIndex((a, k) => k > 0 && /^(-l?c|-command|-c|\/c|\/k|-encodedcommand)$/i.test(a));
      if (i > 0 && words[i + 1]) {
        if (/^-encodedcommand$/i.test(words[i])) return { cls: 'credentials', why: 'an encoded command cannot be checked, so it is refused' };
        const inner = shellVerdict(words.slice(i + 1).join(' '), here, depth + 1);
        if (inner) return inner;
      }
      continue;
    }
    if (prog === 'cd' || prog === 'set-location' || prog === 'pushd' || prog === 'chdir') {
      const t = words.slice(1).filter((a) => !/^\/d$/i.test(a))[0];
      if (t) { const r = resolveWord(t, here); here = r === UNRESOLVED ? null : r; }
      continue;
    }
    const cred = credentialReason(words, words.join(' '));
    if (cred) return { cls: 'credentials', why: cred };
    const money = moneyReason(words, words.join(' '));
    if (money) return { cls: 'money', why: money };
    const pub = publishReason(words, words.join(' '));
    if (pub) return { cls: 'publish', why: pub };
    const targets = mutationTargets(words) || [];
    // redirect targets: the word after ">", ">>", "2>" (simpleWords makes each operator a word of its own)
    for (let i = 0; i < words.length; i++) if (/^\d*>>?$/.test(words[i]) && words[i + 1] !== undefined) targets.push(words[i + 1]);
    for (const t of targets) {
      if (!t || NULLS.has(String(t).toLowerCase())) continue;
      const base = here === null ? UNRESOLVED : here;
      const abs = resolveWord(t, base === UNRESOLVED ? cwd : base);
      if (abs === UNRESOLVED || base === UNRESOLVED) return { cls: 'outside', why: `${clip(t, 80)} cannot be resolved to a place inside the project` };
      if (inside(cwd, abs)) { if (isSecretPath(abs)) return { cls: 'credentials', why: `${clip(t, 80)} is a credential, key or secret file` }; continue; }
      if (isSystemPath(abs)) return { cls: 'system', why: `${clip(String(abs), 80)} is a system location` };
      return { cls: 'outside', why: `${clip(String(abs), 80)} is outside the project and no copy of it is kept` };
    }
  }
  return null;
}

// What auto asks about: the risks max refuses, minus the guard's own patterns (the shell case asks about those already).
export function sensitiveReason(cmd, cwd) {
  const v = shellVerdict(cmd, cwd);
  if (!v || v.cls === 'destructive') return null;
  return `${v.cls}: ${v.why}`;
}

// ---------------------------------------------------------------- max gate

// The file paths a call writes, reads, or both, for the gate. parsePatch is passed in by loop.mjs, which owns it.
export function callPaths(call, abs, parsePatch) {
  const writes = [], reads = [];
  if (call.tool === 'edit_file' || call.tool === 'write_file') { if (call.path) writes.push(abs(call.path)); }
  else if (call.tool === 'apply_patch') {
    let parsed = null;
    try { parsed = parsePatch(String(call.input ?? '')); } catch { parsed = null; }
    for (const h of (parsed && parsed.hunks) || []) { writes.push(abs(h.path)); if (h.moveTo) writes.push(abs(h.moveTo)); }
  } else if (call.tool === 'read_file' || call.tool === 'outline' || call.tool === 'grep') { if (call.path) reads.push(abs(call.path)); }
  return { writes, reads };
}

// The verdict for one call under max, or null to let it run.
export function maxVerdict(call, ctx) {
  const { cwd, abs, parsePatch } = ctx;
  if (call._verify === true) return null; // the harness's own project check, never the model's
  if (!BUILTIN_TOOLS.has(call.tool)) {
    if (typeof hooks.computerAction === 'function') {
      const h = hooks.computerAction(call, ctx);
      if (h) return typeof h === 'string' ? { cls: 'computer', why: h } : h;
    }
    return null;
  }
  if (call.tool === 'shell') {
    const argv = Array.isArray(call.command) ? call.command.map(String) : null;
    const flat = argv ? argv.join(' ') : String(call.command || '');
    // A patch sent through the shell is run again as apply_patch by the loop, and that call is judged by its own file paths.
    if ((argv && /^apply_?patch$/.test(argv[0])) || (/^\s*apply_?patch\b/.test(flat) && flat.includes('*** Begin Patch'))) return null;
    return shellVerdict(flat, cwd);
  }
  const { writes, reads } = callPaths(call, abs, parsePatch);
  for (const p of writes) {
    if (inside(cwd, p)) { if (isSecretPath(p)) return { cls: 'credentials', why: `${p} is a credential, key or secret file` }; continue; }
    if (isSystemPath(p)) return { cls: 'system', why: `${p} is a system location` };
    return { cls: 'outside', why: `${p} is outside the project and no copy of it is kept` };
  }
  for (const p of reads) if (isSecretPath(p)) return { cls: 'credentials', why: `${p} is a credential, key or secret file` };
  return null;
}

// ---------------------------------------------------------------- action log

export const logPath = (sid) => path.join(STATE_DIR, 'max-log', `${String(sid).replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`);
export function targetOf(call) {
  if (call.tool === 'shell') return clip(Array.isArray(call.command) ? call.command.join(' ') : String(call.command || ''), 200);
  if (call.tool === 'apply_patch') return clip(String(call.input || '').split(/\r?\n/).filter((l) => /^\*\*\* (Add|Update|Delete) File:/.test(l)).join('; ') || 'a patch', 200);
  return clip(String(call.path || call.pattern || call.query || call.question || ''), 200);
}
export function logAction(state, entry) {
  try { appendLine(logPath(state.sid), JSON.stringify({ t: Date.now(), sid: state.sid, mode: 'max', ...entry })); } catch { /* a log that cannot be written must not stop the run; the refusal still stands */ }
}
export function readLog(sid) {
  try { return fs.readFileSync(logPath(sid), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}
export function logText(sid, n = 20) {
  const rows = readLog(sid).slice(-n);
  if (!rows.length) return `no max-mode actions logged for this session (${logPath(sid)})`;
  return rows.map((r) => `${new Date(r.t).toISOString()}  ${r.outcome}${r.cls ? ` [${r.cls}]` : ''}  ${r.tool}  ${r.target || ''}${r.detail ? `  -> ${r.detail}` : ''}`).join('\n') + `\n(full log: ${logPath(sid)})`;
}

// ---------------------------------------------------------------- the interactive command

// /permissions [mode|next|log]. set(mode) writes agent.permissions and returns { ok, text }; current is the mode now.
export function command(arg, { current, set, sid }) {
  const v = String(arg || '').trim().toLowerCase();
  if (!v) return summary(current);
  if (v === 'log') return logText(sid);
  const mode = v === 'next' || v === 'cycle' ? nextMode(current) : v;
  if (!MODES.includes(mode)) return `permissions is one of ${MODES.join(', ')}, or next to cycle (${CYCLE.join(' > ')}), or log; got ${JSON.stringify(arg)}`;
  const r = set(mode);
  if (!r.ok) return r.text;
  return mode === 'max' ? `${r.text}\n${MAX_NOTICE}` : `${r.text}\n${MODE_TEXT[mode]}`;
}

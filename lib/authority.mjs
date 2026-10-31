// Exact session authority, separate from the bounded evidence/event log.
// Hosts serialize UserPromptSubmit for a session. Repeated text remains a
// separate occurrence; only a retry with the same native prompt id is deduped.
import path from 'node:path';
import { sessionDir, safeId, readText, writeJson, config, CLAUDE_DIR, CODEX_DIR, HOME, actorSession } from './core.mjs';
import { readSkill } from './skills.mjs';
import fs from 'node:fs';

export const ledgerPath = (sid) => path.join(sessionDir(), `${safeId(sid)}.authority.json`);
export function clear(sid) {
  if (sid && sid !== 'no-session') change(sid, () => []);
}
function change(sid, edit) {
  const lock = ledgerPath(sid) + '.lock';
  let fd;
  for (let attempt = 0; ; attempt++) {
    try { fd = fs.openSync(lock, 'wx'); break; } catch (e) {
      // Windows can report an already-open CREATE_NEW lock as EPERM/EACCES
      // instead of EEXIST. Retry these busy cases; never remove another lock.
      if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(e.code) || attempt >= 750) throw Error(`Authority ledger update failed (${e.code}); exact authority was not retained.`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try { writeJson(ledgerPath(sid), edit(read(sid))); }
  finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
export function read(sid) {
  if (!sid || sid === 'no-session') return [];
  const text = readText(ledgerPath(sid));
  if (text === null) return [];
  let rows;
  try { rows = JSON.parse(text); } catch { throw Error('Invalid authority ledger; exact authority is unavailable.'); }
  if (!Array.isArray(rows) || rows.some((r) => !r || !['request', 'skill'].includes(r.kind) || typeof r.text !== 'string')) throw Error('Invalid authority ledger; exact authority is unavailable.');
  return rows;
}
export function record(sid, text, promptId) {
  if (!sid || sid === 'no-session') return;
  change(sid, (rows) => {
    if (!promptId || !rows.some((r) => r.kind === 'request' && r.id === promptId)) rows.push({ kind: 'request', ...(promptId ? { id: promptId } : {}), text: String(text) });
    return rows;
  });
}
export function skill(sid, file, text) {
  if (!sid || sid === 'no-session') return;
  change(sid, (rows) => {
  // A later read of an amended skill is a new ordered instruction occurrence.
  const previous = rows.at(-1);
    if (!(previous?.kind === 'skill' && previous.file === file && previous.text === text)) rows.push({ kind: 'skill', file, text });
    return rows;
  });
}
export function selected(payload) {
  const text = String(payload.prompt || '');
  const names = new Set([...text.matchAll(/(?:^|\s)(?:\$|\/)([A-Za-z0-9_-]+)(?=\s|[.,;:]|$)/g)].map((m) => m[1].toLowerCase()));
  if (!names.size) return;
  const cwd = payload.cwd || process.cwd();
  // Native hosts inject explicitly selected project skills without a Read
  // tool call. Resolve exact names only; never guess with a substring match.
  const dirs = [path.join(HOME, '.agents', 'skills'), path.join(CLAUDE_DIR, 'skills'), path.join(CODEX_DIR, 'skills'),
    path.join(cwd, '.agents', 'skills'), path.join(cwd, '.claude', 'skills'), path.join(cwd, '.codex', 'skills')];
  const found = new Map();
  for (const dir of dirs) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      const candidate = readSkill(path.join(dir, entry));
      if (candidate && names.has(candidate.name.toLowerCase())) found.set(candidate.name.toLowerCase(), candidate.path);
    }
  }
  for (const file of found.values()) {
    const original = readText(file);
      if (original !== null) skill(actorSession(payload), file, original);
  }
}
export function render(sid, cfg = config()) {
  if (!cfg.flags?.authorityLedger) return '';
  const rows = read(sid);
  if (!rows.length) return '';
  const versions = new Map();
  const body = (r, i) => {
    const title = `${r.kind === 'request' ? 'User request' : `Selected skill ${r.file}`} ${i + 1}:\n`;
    if (cfg.flags.authorityBodiesOnce && r.kind === 'skill' && typeof r.file === 'string') {
      // The full exact body remains in this same rendered context. A repeat
      // points to its first occurrence, not to an external retrieval handle.
      const key = JSON.stringify([r.file, r.text]);
      const first = versions.get(key);
      if (first !== undefined) return title + `Apply again the complete unchanged skill instructions from occurrence ${first}. The full body is retained above in this same authority context.`;
      versions.set(key, i + 1);
    }
    return title + r.text;
  };
  return '[atlias exact session authority: requests and selected skill instructions in occurrence order. Later amendments govern earlier requests. This is retained authority, not a new user request.]\n' +
    rows.map(body).join('\n\n');
}

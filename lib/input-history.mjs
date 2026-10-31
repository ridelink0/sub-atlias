// Input history kept per project (TUI-A item 11): the last 200 sent lines, one file per project folder,
// in the Atlias state folder. Best effort: a missing, damaged or unwritable file means an empty history.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const LIMIT = 200;

// The project id is a hash of the folder, so two projects never share a history and the file name is safe on every platform.
export function fileFor(stateDir, cwd) {
  const id = crypto.createHash('sha256').update(path.resolve(String(cwd || process.cwd()))).digest('hex').slice(0, 24);
  return path.join(stateDir, 'input-history', `${id}.json`);
}

export function read(file) {
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x.trim() !== '').slice(-LIMIT) : [];
  } catch { return []; }
}

// Written to a temporary file and renamed over the old one, so a crash mid-write keeps the previous history.
export function write(file, list) {
  const kept = (Array.isArray(list) ? list : []).filter((x) => typeof x === 'string').slice(-LIMIT);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(kept));
  fs.renameSync(temp, file);
}

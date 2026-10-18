import fs from 'node:fs';
import path from 'node:path';

const ROOTS = [
  'Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState/settings.json',
  'Packages/Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe/LocalState/settings.json',
  'Packages/Microsoft.WindowsTerminalCanary_8wekyb3d8bbwe/LocalState/settings.json',
  'Microsoft/Windows Terminal/settings.json',
];
const isSpace = (c) => c === ' ' || c === '\n' || c === '\r' || c === '\t';

function skipTrivia(text, at) {
  while (at < text.length) {
    if (isSpace(text[at])) { at++; continue; }
    if (text.startsWith('//', at)) { const end = text.indexOf('\n', at + 2); at = end < 0 ? text.length : end + 1; continue; }
    if (text.startsWith('/*', at)) { const end = text.indexOf('*/', at + 2); if (end < 0) throw Error('settings.json has an unfinished comment'); at = end + 2; continue; }
    break;
  }
  return at;
}
function readString(text, at) {
  if (text[at] !== '"') throw Error('settings.json contains an invalid object key');
  let i = at + 1;
  for (; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '"') return { value: JSON.parse(text.slice(at, i + 1)), end: i + 1 };
    if (text[i] < ' ') throw Error('settings.json contains an invalid string');
  }
  throw Error('settings.json contains an unfinished string');
}
function parseValue(text, at, root = false) {
  at = skipTrivia(text, at);
  const start = at;
  if (text[at] === '"') { const s = readString(text, at); return { value: s.value, end: s.end }; }
  if (text[at] === '{') {
    const properties = [];
    let i = skipTrivia(text, at + 1);
    if (text[i] === '}') return { value: {}, end: i + 1, properties };
    for (;;) {
      i = skipTrivia(text, i);
      const key = readString(text, i);
      i = skipTrivia(text, key.end);
      if (text[i++] !== ':') throw Error('settings.json contains an invalid object');
      const valueStart = skipTrivia(text, i);
      const parsed = parseValue(text, valueStart);
      if (root) properties.push({ key: key.value, valueStart, valueEnd: parsed.end, value: parsed.value });
      i = skipTrivia(text, parsed.end);
      if (text[i] === '}') return { value: {}, end: i + 1, properties };
      if (text[i++] !== ',') throw Error('settings.json contains an invalid object');
      i = skipTrivia(text, i);
      if (text[i] === '}') return { value: {}, end: i + 1, properties };
    }
  }
  if (text[at] === '[') {
    let i = skipTrivia(text, at + 1);
    if (text[i] === ']') return { value: [], end: i + 1 };
    for (;;) {
      const parsed = parseValue(text, i);
      i = skipTrivia(text, parsed.end);
      if (text[i] === ']') return { value: [], end: i + 1 };
      if (text[i++] !== ',') throw Error('settings.json contains an invalid array');
      i = skipTrivia(text, i);
      if (text[i] === ']') return { value: [], end: i + 1 };
    }
  }
  const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at));
  if (match) return { value: match[0] === 'true' ? true : match[0] === 'false' ? false : match[0] === 'null' ? null : Number(match[0]), end: at + match[0].length };
  throw Error(`settings.json contains an invalid value at character ${start}`);
}
function rootObject(text) {
  const start = skipTrivia(text, 0);
  if (text[start] !== '{') throw Error('Windows Terminal settings.json must contain a root object');
  const parsed = parseValue(text, start, true);
  if (skipTrivia(text, parsed.end) !== text.length) throw Error('settings.json contains content after its root object');
  return { start, end: parsed.end, properties: parsed.properties || [] };
}

export function supportedHost({ platform = process.platform, env = process.env } = {}) {
  return platform === 'win32' && typeof env.WT_SESSION === 'string' && env.WT_SESSION.length > 0;
}
export function settingsCandidates({ env = process.env, join = path.join } = {}) {
  const local = env.LOCALAPPDATA || env.LocalAppData || '';
  return local ? ROOTS.map((suffix) => join(local, ...suffix.split('/'))) : [];
}
function locate({ env, existsSync }) {
  return settingsCandidates({ env }).find((file) => existsSync(file)) || null;
}
export function readCopyOnSelect(text) {
  const root = rootObject(text);
  const rows = root.properties.filter((property) => property.key === 'copyOnSelect');
  if (!rows.length) return { configured: false, value: false };
  if (rows.some((row) => typeof row.value !== 'boolean')) throw Error('Windows Terminal copyOnSelect must be true or false; settings were not changed');
  return { configured: true, value: rows.at(-1).value };
}
export function setCopyOnSelectText(text, enabled) {
  if (typeof enabled !== 'boolean') throw Error('copyOnSelect must be true or false');
  const root = rootObject(text);
  const rows = root.properties.filter((property) => property.key === 'copyOnSelect');
  if (rows.some((row) => typeof row.value !== 'boolean')) throw Error('Windows Terminal copyOnSelect must be true or false; settings were not changed');
  if (rows.length) {
    let output = text;
    for (const row of [...rows].reverse()) output = output.slice(0, row.valueStart) + String(enabled) + output.slice(row.valueEnd);
    return output;
  }
  const firstKey = root.properties[0];
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const indent = firstKey ? (text.slice(root.start + 1, firstKey.valueStart).match(/(?:^|\n)([ \t]*)"/) || [])[1] || '  ' : '  ';
  const insertion = `${newline}${indent}"copyOnSelect": ${enabled}${root.properties.length ? ',' : ''}`;
  return text.slice(0, root.start + 1) + insertion + text.slice(root.start + 1);
}
function writeAtomic(file, contents, { statSync, writeFileSync, renameSync, unlinkSync }) {
  const original = statSync(file);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, contents, { mode: original.mode });
  try { renameSync(temp, file); }
  catch (error) { try { unlinkSync(temp); } catch { /* preserve the original failure */ } throw error; }
}

export function copyOnSelectStatus({ platform = process.platform, env = process.env, existsSync = fs.existsSync, readFileSync = fs.readFileSync } = {}) {
  if (!supportedHost({ platform, env })) return { supported: false, text: 'copy-on-select: unsupported host; Atlias leaves selection and clipboard behavior to the terminal. This option is supported only inside Windows Terminal.' };
  const file = locate({ env, existsSync });
  if (!file) return { supported: false, text: 'copy-on-select: Windows Terminal settings.json was not found; no file was changed.' };
  try {
    const state = readCopyOnSelect(readFileSync(file, 'utf8'));
    return { supported: true, file, configured: state.configured, value: state.value,
      text: `copy-on-select: ${state.value ? 'on' : 'off'}${state.configured ? '' : ' (Windows Terminal default)'}; applies to every Windows Terminal profile in this installation; right-click pastes while on.` };
  } catch (error) { return { supported: true, file, error: true, text: `copy-on-select: settings could not be read safely: ${error.message}` }; }
}
export function configureCopyOnSelect(enabled, { platform = process.platform, env = process.env, existsSync = fs.existsSync, readFileSync = fs.readFileSync, statSync = fs.statSync, writeFileSync = fs.writeFileSync, renameSync = fs.renameSync, unlinkSync = fs.unlinkSync } = {}) {
  if (!supportedHost({ platform, env })) return { ok: false, text: 'copy-on-select is unsupported by this host. Atlias leaves selection and clipboard behavior to the terminal.' };
  const file = locate({ env, existsSync });
  if (!file) return { ok: false, text: 'Windows Terminal settings.json was not found. No file was changed.' };
  try {
    const original = readFileSync(file, 'utf8');
    const next = setCopyOnSelectText(original, enabled);
    if (next !== original) writeAtomic(file, next, { statSync, writeFileSync, renameSync, unlinkSync });
    return { ok: true, file, enabled, text: `copy-on-select is ${enabled ? 'on' : 'off'} in Windows Terminal settings. This is a host-wide setting for every profile; right-click pastes when it is on. Restart Windows Terminal to use its updated settings.` };
  } catch (error) { return { ok: false, file, text: `Windows Terminal settings were not changed: ${error.message}` }; }
}

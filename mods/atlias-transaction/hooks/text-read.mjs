// RESEARCH-FIRST 3/9: reduce repeated data, not instructions or evidence.
// Pure standard JavaScript for native Mods; no Node or host filesystem access.
const KEYS = ['filePath', 'content', 'numLines', 'startLine', 'totalLines'];
const OPTIONAL = 'truncatedByTokenCap';
const NUMBERED = 'line-number-tab-v1';
const PLAIN = 'text-v1';

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function keys(value, names) {
  return record(value) && Object.keys(value).length === names.length
    && names.every(name => Object.hasOwn(value, name));
}

function envelope(value) {
  if (!keys(value, ['result', 'text']) || typeof value.text !== 'string'
      || !keys(value.result, ['type', 'file']) || value.result.type !== 'text') return false;
  const file = value.result.file;
  if (!record(file) || !keys(file, Object.hasOwn(file, OPTIONAL) ? [...KEYS, OPTIONAL] : KEYS)) return false;
  return typeof file.filePath === 'string' && Number.isSafeInteger(file.numLines) && file.numLines >= 0
    && Number.isSafeInteger(file.startLine) && file.startLine >= 1
    && Number.isSafeInteger(file.totalLines) && file.totalLines >= 0
    && file.startLine - 1 + file.numLines <= file.totalLines
    && (!Object.hasOwn(file, OPTIONAL) || typeof file[OPTIONAL] === 'boolean');
}

function numbered(content, start) {
  const lines = content.split('\n');
  if (!Number.isSafeInteger(start + lines.length - 1)) return null;
  return lines.map((line, index) => `${start + index}\t${line}`).join('\n');
}

function utf8Bytes(text) {
  let bytes = 0;
  for (const char of text) {
    const point = char.codePointAt(0);
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export function compactTextRead(native) {
  if (!envelope(native) || typeof native.result.file.content !== 'string') return native;
  const file = native.result.file;
  if (file.numLines !== file.content.split('\n').length) return native;
  const format = file.content === native.text ? PLAIN : numbered(file.content, file.startLine) === native.text ? NUMBERED : null;
  if (!format) return native;
  const compact = { ...native, result: { ...native.result, file: {
    ...file, content: { from: 'native.text', format },
  } } };
  // Be conservative at both the result-text and JSON-string transport layers.
  const original = JSON.stringify(native);
  const encoded = JSON.stringify(compact);
  const textGain = utf8Bytes(original) - utf8Bytes(encoded);
  const transportGain = utf8Bytes(JSON.stringify(original)) - utf8Bytes(JSON.stringify(encoded));
  return Math.min(textGain, transportGain) > 0 ? compact : native;
}

export function restoreTextRead(compact) {
  if (!envelope(compact)) return null;
  const file = compact.result.file;
  const recipe = file.content;
  if (!keys(recipe, ['from', 'format']) || recipe.from !== 'native.text') return null;
  let content;
  if (recipe.format === PLAIN) content = compact.text;
  else if (recipe.format === NUMBERED) {
    const lines = compact.text.split('\n');
    if (!Number.isSafeInteger(file.startLine + lines.length - 1)) return null;
    const restored = [];
    for (let index = 0; index < lines.length; index++) {
      const prefix = `${file.startLine + index}\t`;
      if (!lines[index].startsWith(prefix)) return null;
      restored.push(lines[index].slice(prefix.length));
    }
    content = restored.join('\n');
  } else return null;
  if (file.numLines !== content.split('\n').length) return null;
  return { ...compact, result: { ...compact.result, file: { ...file, content } } };
}

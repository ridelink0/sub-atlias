import { compactTextRead, restoreTextRead } from '../mods/atlias-transaction/hooks/text-read.mjs';
import { register, SPEC } from '../mods/atlias-transaction/hooks/register.mjs';

function native(content, startLine = 1, optional = {}) {
  const lines = content.split('\n');
  return { result: { type: 'text', file: { filePath: 'D:\\fixture\\source.txt', content,
    numLines: lines.length, startLine, totalLines: startLine - 1 + lines.length, ...optional } },
    text: lines.map((line, index) => `${startLine + index}\t${line}`).join('\n') };
}

async function batch(options, value) {
  const hooks = new Map(); const calls = []; let offered;
  const on = (event, matcher, hook) => {
    hooks.set(event, typeof matcher === 'function' ? matcher : hook);
    return { catch() { return this; } };
  };
  register(on, options);
  const api = { tool: {
    list: async () => [{ name: 'Read' }, { name: 'ToolSearch' }],
    register: async spec => { offered = spec; },
    check: async e => { calls.push(['check', e]); return { decision: 'allow' }; },
    call: async e => { calls.push(['call', e]); return value; },
  } };
  const next = async e => e; next.signal = new AbortController().signal;
  await hooks.get('session.start')(api, {}, next);
  const event = { operations: [{ tool: 'Read', args: { file_path: 'D:\\fixture\\source.txt' } }] };
  const response = await hooks.get('tool.call')(api, event, next);
  return { answer: options.enabled ? JSON.parse(response.result) : response, event, offered, calls };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export default async function addSuites({ asyncSuite, check }) {
  await asyncSuite('context expert', 'native read views: lossless duplicate content', async () => {
    const info = { happened: 'A text result was represented once.', why: 'Reducing copied evidence must preserve exact native text and metadata.', fix: 'Only encode proven duplicates and restore their complete content.' };
    for (const [name, content, start, extra] of [
      ['ordinary', 'actual source body '.repeat(40), 1, {}],
      ['CRLF and Unicode', ('\u00e9\u96ea\ud834\udd1e\tbody '.repeat(20)) + '\r\n\r\nsecond line\r\n', 7, {}],
      ['truncated', 'retained prefix '.repeat(40), 90, { truncatedByTokenCap: true }],
      ['truncation false', 'all source '.repeat(40), 1, { truncatedByTokenCap: false }],
      ['terminal newline', 'body '.repeat(40) + '\n', 3, {}],
      ['no terminal newline', 'body '.repeat(40), 3, {}],
      ['embedded prefixes', 'body '.repeat(40) + '\n2\tuser text\n3\t', 12, {}],
    ]) {
      const value = native(content, start, extra); const before = JSON.stringify(value);
      const view = compactTextRead(value);
      check(name + ' encodes only the repeated file content', view !== value && view.result.file.content.from === 'native.text', info);
      check(name + ' keeps exact model-facing text and all metadata', view.text === value.text
        && same({ ...view.result.file, content }, value.result.file), info);
      check(name + ' reconstructs the native envelope byte for byte', JSON.stringify(restoreTextRead(view)) === before, info);
      check(name + ' is smaller in UTF-8 without changing the input object', Buffer.byteLength(JSON.stringify(view)) < Buffer.byteLength(before) && JSON.stringify(value) === before, info);
      check(name + ' also shrinks when encoded in JSON transport', Buffer.byteLength(JSON.stringify(JSON.stringify(view))) < Buffer.byteLength(JSON.stringify(before)), info);
    }
    const plain = native('plain native text '.repeat(40)); plain.text = plain.result.file.content;
    check('identical unnumbered text round trips with its distinct recipe', compactTextRead(plain).result.file.content.format === 'text-v1' && same(restoreTextRead(compactTextRead(plain)), plain), info);
    const short = native('tiny');
    check('non-beneficial result remains the exact original object', compactTextRead(short) === short, info);
    const tie = native('x'.repeat(40)); tie.text = tie.result.file.content;
    check('a near tie cannot grow at the JSON-string transport layer', compactTextRead(tie) === tie, info);
    const empty = native(''); empty.result.file.numLines = 0; empty.result.file.totalLines = 0;
    check('empty text retains the original representation', compactTextRead(empty) === empty, info);
    const changed = native('body '.repeat(40)); changed.text += '\nWARNING: diagnostic outside numbered source';
    check('unknown formatting or diagnostics remain the complete original', compactTextRead(changed) === changed, info);
    for (const bad of [null, [], true, { text: 'error', isError: true }, { ...plain, extra: 'future' },
      { ...plain, result: { ...plain.result, type: 'image' } },
      { ...plain, result: { ...plain.result, file: { ...plain.result.file, future: 'retain' } } },
      { ...plain, result: { ...plain.result, file: { ...plain.result.file, startLine: 0 } } },
      { ...plain, result: { ...plain.result, file: { ...plain.result.file, numLines: NaN } } },
      { ...plain, result: { ...plain.result, file: { ...plain.result.file, totalLines: 0 } } },
      { ...plain, result: { ...plain.result, file: { ...plain.result.file, numLines: 2, totalLines: 3 } } },
      { ...plain, result: { ...plain.result, file: { ...plain.result.file, truncatedByTokenCap: 'false' } } },
    ]) check('malformed or future envelopes pass through without dropping fields', compactTextRead(bad) === bad, info);
    const view = compactTextRead(native('body '.repeat(40) + '\nlast', 8));
    for (const corrupt of [null, plain, { ...view, text: view.text.replace('8\t', '9\t') },
      { ...view, result: { ...view.result, file: { ...view.result.file, content: { from: 'other', format: 'text-v1' } } } },
      { ...view, result: { ...view.result, file: { ...view.result.file, content: { from: 'native.text', format: 'future' } } } },
      { ...view, result: { ...view.result, file: { ...view.result.file, content: { from: 'native.text', format: 'text-v1', extra: true } } } },
      { ...view, result: { ...view.result, file: { ...view.result.file, numLines: 1 } } },
    ]) check('decoder rejects missing, malformed or unknown recipes', restoreTextRead(corrupt) === null, info);
    const maximum = native('body '.repeat(40)); maximum.result.file.startLine = Number.MAX_SAFE_INTEGER;
    maximum.result.file.totalLines = Number.MAX_SAFE_INTEGER; maximum.result.file.content += '\nsecond';
    maximum.text = Number.MAX_SAFE_INTEGER + '\t' + maximum.result.file.content;
    check('numbered rendering rejects unsafe line arithmetic', compactTextRead(maximum) === maximum, info);

    const value = native('native result '.repeat(40));
    const off = await batch({ enabled: true }, value);
    const on = await batch({ enabled: true, deduplicateTextReads: true }, value);
    check('option off preserves the original result and tool contract', same(off.answer.results[0].native, value) && off.offered.description === SPEC.description, info);
    check('option on changes only the duplicate model-facing result', same(restoreTextRead(on.answer.results[0].native), value) && on.answer.results[0].native.text === value.text && on.calls.length === 2, info);
    check('enabled tool describes how to reconstruct content', on.offered.description.includes('Exact numbered Read text is retained;') && on.offered.description.includes('line-number-tab-v1') && on.offered.description.includes('text-v1'), info);
    const disabled = await batch({ enabled: false, deduplicateTextReads: true }, value);
    check('master off prevents registration, native dispatch and result rewrite', disabled.offered === undefined && disabled.calls.length === 0 && disabled.answer === disabled.event, info);
    const error = { text: 'permission denied exact diagnostic', deny: 'denied', isError: true };
    const failed = await batch({ enabled: true, deduplicateTextReads: true }, error);
    check('failed Reads retain exact text, denial and error state', same(failed.answer.results[0].native, error) && failed.answer.status === 'refused', info);
  });
}

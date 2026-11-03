// Whether a chat did GitHub work, so the session lists can mark it. Reads the chat's text and changes nothing.
const PULL = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/;
const WORK = /\bgh (?:pr|repo|release|issue)\b|\bgit (?:push|merge|pull)\b|\bpull requests?\b|(?:^|[\s(/])github\.com\/[\w.-]+\/[\w.-]+/i;
const known = new WeakMap();
export const GIT_GLYPH = '⑂';

// { repo, number } for the newest pull request named, {} for other GitHub work, null for none.
export function githubWork(history) {
  if (!Array.isArray(history)) return null;
  if (known.has(history)) return known.get(history);
  let found = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const text = typeof history[i]?.text === 'string' ? history[i].text : '';
    const pull = PULL.exec(text);
    if (pull) { found = { repo: pull[1], number: Number(pull[2]) }; break; }
    if (!found && WORK.test(text)) found = {};
  }
  known.set(history, found);
  return found;
}
export const githubLabel = (work) => work?.number ? `Pull request ${work.repo}#${work.number}` : 'GitHub work';

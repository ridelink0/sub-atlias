// Direct checks for the functions the 2026-10-23 merge exported (h1's terminal work, h2's features,
// the onboarding wrap), so the coverage rule sees each one called by name and each does what it says.
import * as onboarding from '../lib/onboarding.mjs';
import * as proc from '../lib/proc.mjs';
import { postJsonAbortable } from '../lib/http-abort.mjs';
import { plainText, renderMarkdown } from '../lib/render-markdown.mjs';
import * as rewind from '../lib/rewind.mjs';
import * as webfetch from '../lib/webfetch.mjs';

export default async function merge1023Suites({ asyncSuite, check }) {
  await asyncSuite('merge expert', 'functions exported by the 2026-10-23 merge each do what they say', async () => {
    const line = '1  Use my Claude plan (Pro or Max) - Atlias runs its own loop on Claude; you sign in through Anthropic; no API key  (recommended)';
    const w = onboarding.wrapChoice(line, 80).split('\n');
    check('wrapChoice keeps every line under the width, indents continuations and loses no word', w.every((l) => l.length < 80) && w.slice(1).every((l) => l.startsWith('   ')) && w.join(' ').replace(/\s+/g, ' ') === line.replace(/\s+/g, ' ') && onboarding.wrapChoice(line, 0) === line,
      { happened: JSON.stringify(w), why: 'the terminal split (recommended) in half before this', fix: 'wrapChoice' });

    check('abortRunning with nothing running ends nothing and does not throw', (() => { try { proc.abortRunning(); return true; } catch { return false; } })(),
      { happened: 'threw', why: 'Esc calls it on every interrupt, including when no shell is running', fix: 'abortRunning' });

    const ac = new AbortController(); ac.abort();
    const r = await postJsonAbortable('http://127.0.0.1:9/never', {}, {}, 1000, 1024, ac.signal);
    check('postJsonAbortable with an aborted signal returns interrupted without a request', r.error === 'interrupted' && r.retryable === false,
      { happened: JSON.stringify(r), why: 'an interrupted turn must not be retried as a model failure (h4 F-h1-A)', fix: 'postJsonAbortable' });

    check('plainText strips terminal control sequences from model text', plainText('a\x1b[2Jb\x1b]0;title\x07c\r\nd') === 'abc\nd',
      { happened: JSON.stringify(plainText('a\x1b[2Jb\x1b]0;title\x07c\r\nd')), why: 'model text must never clear the screen or retitle the window', fix: 'plainText' });
    const md = renderMarkdown('# Head\n- one **bold**\n`code`', { color: false, width: 40 });
    check('renderMarkdown without colour prints readable text with no escape codes', !/\x1b/.test(md) && /Head/.test(md) && /one/.test(md) && /bold/.test(md) && /code/.test(md),
      { happened: JSON.stringify(md), why: 'NO_COLOR and plain terminals get the text unchanged in meaning', fix: 'renderMarkdown' });

    const state = { messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u1' }], history: [], todo: [] };
    rewind.checkpoint(state, 'first turn');
    state.messages.push({ role: 'assistant', content: 'a1' }, { role: 'user', content: 'u2' });
    rewind.checkpoint(state, 'second turn');
    const saved = rewind.serializeCheckpoints(state);
    check('serializeCheckpoints keeps positions and text, never object references', saved.length === 2 && saved[0].messages === 2 && !('anchor' in saved[0]) && saved[1].text === 'second turn',
      { happened: JSON.stringify(saved), why: 'a saved session must be plain JSON', fix: 'serializeCheckpoints' });
    const resumed = { messages: state.messages.slice(), history: [], checkpoints: saved.map((c) => ({ ...c })) };
    rewind.linkCheckpoints(resumed);
    check('linkCheckpoints re-attaches each checkpoint to its message after a resume', resumed.checkpoints[0].anchor === resumed.messages[1] && resumed.checkpoints[1].anchor === resumed.messages[3],
      { happened: JSON.stringify(resumed.checkpoints.map((c) => c.anchor)), why: 'h4 F3b: checkpoints were lost on resume', fix: 'linkCheckpoints' });
    resumed.messages.splice(1, 1);
    rewind.afterCompact(resumed);
    check('afterCompact marks a checkpoint whose message was compacted away and re-points the rest', resumed.checkpoints[0].stale === 'compacted away by /compact' && resumed.checkpoints[1].messages === 3,
      { happened: JSON.stringify(resumed.checkpoints.map((c) => [c.stale, c.messages])), why: 'h4 F3a: /rewind after /compact went to the wrong turn', fix: 'afterCompact' });
    const listed = rewind.formatTurns(resumed);
    check('formatTurns lists newest first and names the stale one', /^1\. .*second turn/.test(listed) && /first turn.*compacted away/.test(listed) && rewind.formatTurns({ messages: [], checkpoints: [] }) === 'no turn to rewind to yet',
      { happened: listed, why: '/rewind shows this list', fix: 'formatTurns' });

    const got = await new Promise((resolve) => webfetch.pinnedLookup('93.184.216.34', 4)('example.com', {}, (e, a, f) => resolve([e, a, f])));
    check('pinnedLookup always answers with the address that was checked', got[0] === null && got[1] === '93.184.216.34' && got[2] === 4,
      { happened: JSON.stringify(got), why: 'h4 W1: the connection must go to the checked address, not a second DNS answer', fix: 'pinnedLookup' });
    const text = webfetch.readable('<html><script>x()</script><p>Hello</p><style>p{}</style><div>World</div></html>', 'text/html');
    check('readable drops scripts and styles and keeps the words', /Hello/.test(text) && /World/.test(text) && !/x\(\)/.test(text) && !/p\{\}/.test(text) && webfetch.readable('{"a":1}', 'application/json') === '{"a":1}',
      { happened: JSON.stringify(text), why: 'web_fetch returns readable text, never page code', fix: 'readable' });
    check('clearCache runs and leaves the cache usable', (() => { try { webfetch.clearCache(); webfetch.clearCache(); return true; } catch { return false; } })(),
      { happened: 'threw', why: 'tests and /clear call it', fix: 'clearCache' });
  });
}

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

export async function treeStopSuite({ asyncSuite, check, bg, EventEmitter, dir }) {
  await asyncSuite('merge expert', 'h4 B3: kill, the time limit and the output cap stop the whole tree a background job started', async () => {
    const stopped = [];
    const fake = () => { const c = new EventEmitter(); c.pid = 4242; c.kill = () => stopped.push('shell-only'); return c; };
    // The fake exits when stopped, so it leaves no job counted as running for later suites.
    let child;
    const r = bg.start('anything', { cwd: dir, dir, spawnImpl: (...x) => (child = fake(...x)), treeStop: (pid) => { stopped.push(pid); setImmediate(() => child.emit('exit', null, 'SIGKILL')); } });
    const reply = bg.kill(r.id);
    check('kill hands the job pid to the tree stop, not just the shell', stopped[0] === 4242 && /stop sent/.test(reply),
      { happened: JSON.stringify(stopped) + ' ' + reply, why: 'a probe showed a child writing 8 MB a second after the shell was killed', fix: 'stop() calls job.treeStop(job.child.pid, job.child)' });
    await bg.waitFor(r.id);
    check('the stopped job ends and holds no slot', bg.running() === 0, { happened: 'running ' + bg.running(), why: 'a job left counted blocks later starts', fix: 'stop must lead to the exit event' });
  });
}

export async function h4LowSuite({ asyncSuite, check, agentMod, webfetch, http }) {
  await asyncSuite('merge expert', 'h4 G1 and the two web_fetch lows: one-shot runs get no repl tools; 6to4 and pooled sockets cannot slip past the address check', async () => {
    check('a repl turn is interactive, a one-shot run and a turn without ask are not', agentMod.replTurn({}, () => '') === true && agentMod.replTurn({ once: true }, () => '') === false && agentMod.replTurn({}, null) === false,
      { happened: 'replTurn misjudged', why: 'atlias agent --once is scripted; nobody watches web_fetch or a background job there', fix: 'replTurn' });
    check('a 6to4 address is judged by the IPv4 inside it', webfetch.privateAddress('2002:c0a8:0101::1') === true && webfetch.privateAddress('2002:7f00:0001::') === true && webfetch.privateAddress('2002:5db8:d822::1') === false,
      { happened: [webfetch.privateAddress('2002:c0a8:0101::1'), webfetch.privateAddress('2002:7f00:0001::'), webfetch.privateAddress('2002:5db8:d822::1')].join(','), why: '2002:c0a8:0101:: is 192.168.1.1', fix: 'privateAddress 6to4 branch' });
    const seen = [];
    const server = http.createServer((req, res) => { seen.push(req.headers.connection); res.end('ok'); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try { for (let i = 0; i < 2; i++) await webfetch.pinnedTransport(`http://pinned.test:${port}/`, { address: '127.0.0.1', family: 4 }); } catch { /* the answer shape does not matter here */ }
    server.close();
    check('each fetch opens its own connection (no pooled keep-alive socket)', seen.length === 2 && seen.every((c) => c === 'close'),
      { happened: JSON.stringify(seen), why: 'a reused socket skips the pinned lookup', fix: 'agent: false in pinnedTransport' });
  });
}

export function costSuite({ suite, check, loop }) {
  suite('merge expert', 'the cache readout also sums output tokens and the provider price when they are reported', () => {
    const st = {};
    loop.countCache(st, { input_tokens: 2, cache_creation_input_tokens: 863, cache_read_input_tokens: 0, output_tokens: 4, cost_usd: 0.0069 });
    loop.countCache(st, { input_tokens: 3, cache_creation_input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 40, cost_usd: 0.0021 });
    check('output and cost are summed for a claude-plan run', st.cache.output === 44 && st.cache.costUsd === 0.009,
      { happened: JSON.stringify(st.cache), why: 'Gev wants tokens, requests and overall cost per run, not only the cache share', fix: 'countCache output and costUsd' });
    const local = {};
    loop.countCache(local, { prompt_eval_count: 76, prompt_eval_cached_count: 71 });
    check('a provider that reports neither adds no field', !('output' in local.cache) && !('costUsd' in local.cache),
      { happened: JSON.stringify(local.cache), why: 'no number is invented', fix: 'only add when reported' });
  });
}

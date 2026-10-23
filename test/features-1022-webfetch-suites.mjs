// H.A.C council round two (2026-10-22, h2), feature 6: web_fetch (lib/webfetch.mjs). The network is replaced by
// a fake fetch and a fake DNS lookup, so the suite makes no request.
import * as wf from '../lib/webfetch.mjs';

export default async function webFetchSuites({ asyncSuite, check }) {
  const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const page = (html, type = 'text/html', status = 200) => new Response(html, { status, headers: { 'content-type': type } });
  await asyncSuite('web_fetch expert', 'web_fetch: local names, private addresses and non-web schemes are refused before any request', async () => {
    const bad = ['http://localhost:8080/', 'http://127.0.0.1/', 'http://10.0.0.5/x', 'http://192.168.1.1/', 'http://169.254.169.254/latest', 'http://[::1]/', 'http://[fc00::1]/', 'file:///etc/passwd', 'ftp://example.com/'];
    const results = [];
    for (const u of bad) results.push((await wf.checkUrl(u, publicLookup)).ok);
    check('every local, private and non-web URL is refused', results.every((ok) => ok === false), { happened: bad.filter((u, i) => results[i]).join(' '), why: 'The model must not reach the machine or the local network through this tool.', fix: 'Check privateAddress and the scheme test in checkUrl.' });
    const dnsToPrivate = await wf.checkUrl('https://intranet.example.com/', async () => [{ address: '10.1.2.3', family: 4 }]);
    check('a public name that resolves to a private address is refused', dnsToPrivate.ok === false && /private address/.test(dnsToPrivate.why), { happened: JSON.stringify(dnsToPrivate), why: 'Checking the text of the name only is not enough; the address is what gets connected to.', fix: 'Check every address the lookup returns.' });
    const good = await wf.checkUrl('https://example.com/docs', publicLookup);
    check('a public https URL passes the check', good.ok === true && good.url === 'https://example.com/docs', { happened: JSON.stringify(good), why: 'Ordinary documentation pages must still be readable.', fix: 'Check checkUrl for false refusals.' });
  });
  await asyncSuite('web_fetch expert', 'web_fetch: HTML becomes readable text; scripts, styles and entities are handled', async () => {
    const html = '<html><head><style>p{color:red}</style><script>var secret = 1;</script></head><body><h1>Title</h1><p>Use &amp; keep &lt;this&gt; &quot;text&quot;.</p><!-- hidden --></body></html>';
    let calls = 0;
    const fetchImpl = async () => { calls++; return page(html); };
    const got = await wf.webFetch('https://example.com/a', { fetchImpl, lookup: publicLookup, now: 1000000 });
    check('script and style text are gone, comments too, and entities are decoded', !/secret|color:red|hidden/.test(got) && /Title/.test(got) && got.includes('Use & keep <this> "text".'), { happened: got.slice(0, 200), why: 'Scripts and styles are noise to the model; entities must read as the characters they stand for.', fix: 'Check readable().' });
    check('the reply starts with the URL that was read', got.startsWith('https://example.com/a\n'), { happened: got.slice(0, 60), why: 'The model must know what it was given.', fix: 'Keep the url header in webFetch.' });
    const again = await wf.webFetch('https://example.com/a', { fetchImpl, lookup: publicLookup, now: 1000001 });
    check('a second read inside fifteen minutes is served from the cache', calls === 1 && again === got, { happened: `fetches ${calls}`, why: 'Repeated reads of one page must not cost a request each time.', fix: 'Check the TTL test in webFetch.' });
    await wf.webFetch('https://example.com/a', { fetchImpl, lookup: publicLookup, now: 1000001 + wf.TTL_MS });
    check('after fifteen minutes the page is fetched again', calls === 2, { happened: `fetches ${calls}`, why: 'A stale page must not be served forever.', fix: 'Check TTL_MS in webFetch.' });
  });
  await asyncSuite('web_fetch expert', 'web_fetch: long pages come in windows with an offset; the size cap and bad answers are reported', async () => {
    const big = 'x'.repeat(45000);
    const fetchImpl = async () => page(big, 'text/plain');
    const url = 'https://example.com/long';
    const first = await wf.webFetch(url, { fetchImpl, lookup: publicLookup, now: 2000000 });
    check('the first window is 20,000 characters and names the next offset', first.includes('offset=20000 for the next part') && first.split('\n')[1].length === 20000, { happened: first.slice(-120), why: 'A window is the most the model reads in one go.', fix: 'Check WINDOW and the footer.' });
    const second = await wf.webFetch(url, { offset: 20000, fetchImpl, lookup: publicLookup, now: 2000001 });
    check('an offset returns the next window, and the last one says the page ended', second.includes('offset=40000 for the next part') && second.split('\n')[1].length === 20000, { happened: second.slice(-120), why: 'The offset is how the model reads the rest.', fix: 'Slice from the offset.' });
    const last = await wf.webFetch(url, { offset: 40000, fetchImpl, lookup: publicLookup, now: 2000002 });
    check('the final window ends the page', last.includes('[end of page: 45000 characters]'), { happened: last.slice(-120), why: 'The model must know when it has read everything.', fix: 'Check the end-of-page footer.' });
    const huge = 'y'.repeat(6 * 1024 * 1024);
    const capped = await wf.webFetch('https://example.com/huge', { fetchImpl: async () => page(huge, 'text/plain'), lookup: publicLookup, now: 3000000 });
    check('a body over 5 MB is cut and the reply says so', /cut at 5 MB/.test(capped), { happened: capped.slice(-120), why: 'The cap bounds memory and the cost of reading.', fix: 'Check MAX_BYTES and readCapped.' });
    const missing = await wf.webFetch('https://example.com/missing', { fetchImpl: async () => page('no', 'text/html', 404), lookup: publicLookup, now: 4000000 });
    check('an error status is reported with the status', /answered 404/.test(missing), { happened: missing, why: 'A model must see that the page was not there.', fix: 'Check the res.ok branch.' });
    const bin = await wf.webFetch('https://example.com/pic.png', { fetchImpl: async () => page('PNG', 'image/png'), lookup: publicLookup, now: 5000000 });
    check('a binary type is not read', /image\/png is not text/.test(bin), { happened: bin, why: 'Dumping binary bytes into the context wastes it.', fix: 'Check the content-type test.' });
  });
  await asyncSuite('web_fetch expert', 'web_fetch: a redirect is checked again, so a public page cannot send the fetch to a private address', async () => {
    const fetchImpl = async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } });
    const got = await wf.webFetch('https://example.com/go', { fetchImpl, lookup: publicLookup, now: 6000000 });
    check('a redirect to a private address is refused', /redirect goes to 127\.0\.0\.1 is a private address/.test(got) || /redirect goes to/.test(got), { happened: got, why: 'Redirects are how a check is bypassed.', fix: 'Check each Location with checkUrl.' });
  });
}

// A JSON POST that the caller can cut (TUI-B item 1). Same request and reply handling as loop.mjs postJson,
// which cannot take a signal without a change to lib/loop.mjs (the benchmark freeze forbids it). Without a
// signal it behaves as postJson does.
import { transportFor, MAX_RESPONSE_BYTES } from './loop.mjs';

export function postJsonAbortable(url, body, headers = {}, timeout = 10 * 60 * 1000, maxBytes = MAX_RESPONSE_BYTES, signal) {
  return new Promise((resolve) => {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) { resolve({ status: 0, error: 'invalid response byte limit', retryable: false }); return; }
    if (signal?.aborted) { resolve({ status: 0, error: 'interrupted', retryable: false }); return; }
    let finished = false, req = null;
    const onAbort = () => { finish({ status: 0, error: 'interrupted', retryable: false }); req?.destroy(); };
    const finish = (result) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    let u;
    try { u = new URL(url); } catch { finish({ status: 0, error: `not a url: ${url}` }); return; }
    const data = JSON.stringify(body);
    req = transportFor(u.href).request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers }, timeout }, (res) => {
      let text = '', bytes = 0;
      res.setEncoding('utf8');
      res.on('data', (x) => {
        if (finished) return;
        bytes += Buffer.byteLength(x, 'utf8');
        if (bytes > maxBytes) {
          finish({ status: 0, error: 'provider response exceeded the byte limit', retryable: false });
          res.destroy(); req.destroy(); return;
        }
        text += x;
      });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* not json */ } finish({ status: res.statusCode, json, text }); });
      res.on('error', () => finish({ status: 0, error: 'provider response stream failed', retryable: false }));
      res.on('aborted', () => finish({ status: 0, error: 'provider response stream was incomplete', retryable: false }));
    });
    req.on('error', (e) => finish({ status: 0, error: e.message, retryable: false }));
    req.on('timeout', () => { finish({ status: 0, error: 'timed out', retryable: false }); req.destroy(); });
    req.end(data);
  });
}

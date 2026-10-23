// web_fetch (H.A.C round two, 2026-10-22, h2, feature 6). A module only: the loop does not yet offer the tool,
// because lib/loop.mjs is pinned by the benchmark-path freeze (test/import-suites.mjs). Interactive turns are the
// intended place. GET one http or https URL: 20 s timeout, 5 MB cap, HTML reduced to readable text, returned in
// 20,000-character windows with an offset, a 15-minute in-memory cache, and no localhost or private addresses
// (checked on the name's addresses and on every redirect).
import dns from 'node:dns';
import net from 'node:net';

export const TIMEOUT_MS = 20000;
export const MAX_BYTES = 5 * 1024 * 1024;
export const WINDOW = 20000;
export const TTL_MS = 15 * 60 * 1000;
export const MAX_REDIRECTS = 3;
const cache = new Map();
export function clearCache() { cache.clear(); }

export function privateAddress(ip) {
  const v = net.isIP(String(ip));
  if (v === 4) {
    const [a, b] = String(ip).split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (v === 6) {
    const s = String(ip).toLowerCase();
    if (s === '::1' || s === '::') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return privateAddress(mapped[1]);
    return /^f[cd]/.test(s) || /^fe[89ab]/.test(s);
  }
  return true;
}

// Checks one URL before any request: scheme, local names, and the addresses the name resolves to.
export async function checkUrl(raw, lookup = (h) => dns.promises.lookup(h, { all: true })) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return { ok: false, why: 'not a URL' }; }
  if (!['http:', 'https:'].includes(u.protocol)) return { ok: false, why: 'only http and https URLs are fetched' };
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return { ok: false, why: `${host} is a local name` };
  if (net.isIP(host)) return privateAddress(host) ? { ok: false, why: `${host} is a private address` } : { ok: true, url: u.href };
  let addrs;
  try { addrs = await lookup(host); } catch { return { ok: false, why: `${host} does not resolve` }; }
  const bad = (addrs || []).find((a) => privateAddress(a.address));
  if (bad) return { ok: false, why: `${host} resolves to a private address (${bad.address})` };
  return { ok: true, url: u.href };
}

// HTML to readable text: scripts, styles and comments dropped, block tags as line breaks, common entities decoded.
export function readable(body, type = '') {
  if (!/html/i.test(type)) return body;
  let s = body.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<\/?(p|div|br|li|tr|h[1-6]|section|article|header|footer|pre|table|ul|ol)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
  const lines = s.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim());
  return lines.filter((l, i) => l || (i > 0 && lines[i - 1])).join('\n').trim();
}

async function readCapped(res, max) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const t = await res.text();
    return { text: t.slice(0, max), truncated: t.length > max };
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.length > max) {
      chunks.push(value.subarray(0, max - size));
      size = max;
      truncated = true;
      try { await reader.cancel(); } catch { /* the cap is reached either way */ }
      break;
    }
    chunks.push(value);
    size += value.length;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

// The tool. Returns the text the model would read.
export async function webFetch(raw, { offset = 0, fetchImpl = globalThis.fetch, now = Date.now(), lookup, timeoutMs = TIMEOUT_MS } = {}) {
  const first = await checkUrl(raw, lookup);
  if (!first.ok) return `web_fetch refused: ${first.why}.`;
  let page = cache.get(first.url);
  if (!page || now - page.at >= TTL_MS) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      let url = first.url;
      let res;
      for (let hops = 0; ; hops++) {
        res = await fetchImpl(url, { redirect: 'manual', signal: ac.signal });
        const loc = res.headers && res.headers.get ? res.headers.get('location') : null;
        if (res.status >= 300 && res.status < 400 && loc) {
          if (hops >= MAX_REDIRECTS) return 'web_fetch refused: too many redirects';
          const next = await checkUrl(new URL(loc, url).href, lookup);
          if (!next.ok) return `web_fetch refused: the redirect goes to ${next.why}.`;
          url = next.url;
          continue;
        }
        break;
      }
      if (!res.ok) return `web_fetch: ${url} answered ${res.status}.`;
      const type = res.headers.get('content-type') || 'text/plain';
      if (!/^text\/|json|xml|html/i.test(type)) return `web_fetch: ${type} is not text, so it was not read.`;
      const body = await readCapped(res, MAX_BYTES);
      page = { at: now, url, text: readable(body.text, type), truncated: body.truncated };
      cache.set(first.url, page);
    } catch (e) {
      return `web_fetch: ${e && e.name === 'AbortError' ? `timed out after ${timeoutMs / 1000} s` : `failed: ${e && e.message ? e.message : e}`}`;
    } finally { clearTimeout(timer); }
  }
  const off = Math.max(0, Math.floor(Number(offset) || 0));
  const piece = page.text.slice(off, off + WINDOW);
  const end = off + piece.length;
  const cut = page.truncated ? ' (the page was cut at 5 MB)' : '';
  const footer = end < page.text.length
    ? `[showing characters ${off}-${end} of ${page.text.length}${cut}; offset=${end} for the next part]`
    : `[end of page: ${page.text.length} characters${cut}]`;
  return `${page.url}\n${piece}\n${footer}`;
}

// One request per refresh serves every view; no credential is sent by visitors.
let configuration, pending, bundle, loadedAt = 0;
export async function feed(kind) {
  configuration ??= fetch('/live-config.json', { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error('Live configuration unavailable'); return r.json(); });
  const config = await configuration;
  if (!config.endpoint) { const r = await fetch('/' + kind + '.json', { cache: 'no-store' }); if (!r.ok) throw new Error('Snapshot unavailable'); return r.json(); }
  if (!/^https:\/\/api\.github\.com\/gists\/[a-f0-9]{32}$/.test(config.endpoint)) throw new Error('Live endpoint invalid');
  if (!pending && Date.now() - loadedAt >= 85000) pending = (async () => {
    const r = await fetch('/api/live', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('Live feed HTTP ' + r.status);
    const data = await r.json();
    if (data.schema !== 'atlias.live.v1' || !data.status || !data.history) throw new Error('Live feed invalid');
    bundle = data; loadedAt = Date.now();
  })().finally(() => { pending = null; });
  if (pending) await pending;
  if (!bundle?.[kind]) throw new Error('Live section missing');
  return bundle[kind];
}

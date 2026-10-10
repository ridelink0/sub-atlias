import fs from 'node:fs';
let cached, loadedAt = 0, pending;
export default async function live(request, response) {
  if (!['GET', 'HEAD'].includes(request.method)) { response.setHeader('Allow', 'GET, HEAD'); response.statusCode=405; response.end(); return; }
  try {
    if (!pending && Date.now()-loadedAt >= 85000) pending = (async () => {
      const config=JSON.parse(fs.readFileSync(new URL('../live-config.json',import.meta.url),'utf8'));
      if (!/^https:\/\/api\.github\.com\/gists\/[a-f0-9]{32}$/.test(config.endpoint)) throw new Error('unconfigured');
      const r=await fetch(config.endpoint,{headers:{Accept:'application/vnd.github+json','User-Agent':'Atlias-public-status'},signal:AbortSignal.timeout(12000)});
      if (!r.ok) throw new Error('upstream');
      const g=await r.json(), f=g.files?.['atlias-live.json'];
      if (g.owner?.login !== 'ridelink0' || !f || f.truncated || typeof f.content!=='string' || f.content.length>900000) throw new Error('invalid');
      const b=JSON.parse(f.content);
      if (b.schema!=='atlias.live.v1' || b.status?.schema!=='atlias.public-status.v1' || b.history?.schema!=='atlias.public-history.v1') throw new Error('schema');
      cached=f.content; loadedAt=Date.now();
    })().finally(()=>{pending=null;});
    if (pending) await pending;
    response.setHeader('Content-Type','application/json; charset=utf-8');
    response.setHeader('Cache-Control','public, max-age=0, s-maxage=90');
    response.statusCode=200; response.end(request.method==='HEAD'?'':cached);
  } catch { response.setHeader('Cache-Control','no-store'); response.statusCode=503; response.end(JSON.stringify({error:'Live evidence unavailable; existing observations may be stale.'})); }
}

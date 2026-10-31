import assert from 'node:assert/strict';
const original=globalThis.fetch;
const bundle={schema:'atlias.live.v1',generatedAt:'2026-10-10T06:00:00Z',status:{schema:'atlias.public-status.v1'},history:{schema:'atlias.public-history.v1'}};
const response=()=>({headers:{},setHeader(k,v){this.headers[k]=v;},end(v){this.body=v;}});
let calls=0;
try {
  globalThis.fetch=async()=>{calls++;return {ok:true,json:async()=>({owner:{login:'ridelink0'},files:{'atlias-live.json':{content:JSON.stringify(bundle),truncated:false}}})};};
  const good=(await import('../site/api/live.mjs?functional')).default;
  const r=response(); await good({method:'GET'},r); assert.equal(r.statusCode,200); assert.deepEqual(JSON.parse(r.body),bundle); assert.ok(r.headers['Cache-Control'].includes('s-maxage=90'));
  const head=response();await good({method:'HEAD'},head);assert.equal(head.body,'');assert.equal(calls,1);
  console.log('PASS functional public API schema, shared cache, HEAD and one upstream fetch');
  const post=response();await good({method:'POST'},post);assert.equal(post.statusCode,405);assert.equal(calls,1);
  for(const [label,fixture] of [['wrong-owner',{owner:{login:'other'},files:{'atlias-live.json':{content:JSON.stringify(bundle)}}}],['truncated',{owner:{login:'ridelink0'},files:{'atlias-live.json':{truncated:true,content:'private-secret'}}}],['malformed',{owner:{login:'ridelink0'},files:{'atlias-live.json':{content:'private-secret'}}}]]) {
    globalThis.fetch=async()=>({ok:true,json:async()=>fixture});
    const handler=(await import('../site/api/live.mjs?'+label)).default, bad=response(); await handler({method:'GET'},bad);
    assert.equal(bad.statusCode,503);assert.equal(bad.headers['Cache-Control'],'no-store');assert.equal(bad.body.includes('private-secret'),false);
  }
  console.log('PASS separate adversarial write methods, unrelated artifact, truncation and malformed upstream with no content leak');
}finally{globalThis.fetch=original;}

import test from 'node:test';
import assert from 'node:assert/strict';

const load = () => import('../lib/media-pricing.mjs');
const settings = {surplusBaseUrl:'https://api.surplusintelligence.ai/v1',marginBps:500,safetyBps:500,antseedFeeBps:400};
const image = () => ({model:'venice-sd35',kind:'image',provider:'venice',inputs:['text'],parameters:{n:1,size:'1024x1024'},estimatedCostUsd:0.02,pricingBasis:'operator-estimate'});
const edit = () => ({model:'muse-image-edit',kind:'image',provider:'venice',inputs:['text','image'],parameters:{n:1},estimatedCostUsd:0.03,pricingBasis:'operator-estimate'});
const video = () => ({model:'longcat-distilled-image-to-video',kind:'video',provider:'venice',inputs:['text','image'],parameters:{duration_seconds:5,resolution:'720p'},estimatedCostUsd:0.2,pricingBasis:'operator-estimate'});
const decision = () => ({model:'jev-1.13',kind:'decision',provider:'typesafe',inputs:['text'],parameters:{},pricingBasis:'operator-estimate'});
const policy = (services=[image()]) => ({version:1,reviewedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600_000).toISOString(),feeCushionBps:1000,services});
const configured = (services) => ({...settings,mediaConfig:policy(services)});

test('media configuration is optional and performs no public requests when absent',async()=>{
 const {fetchMediaQuotes}=await load();
 const result=await fetchMediaQuotes(settings,()=>assert.fail('no network without consent'));
 assert.deepEqual(result.services,{});
 assert.deepEqual(result.unavailable,{});
 assert.ok(Number.isFinite(Date.parse(result.generatedAt)));
});

test('invalid origin and economic settings reject before any public request',async()=>{
 const {fetchMediaQuotes}=await load();
 for(const change of [{surplusBaseUrl:'https://evil.invalid/v1'},{surplusBaseUrl:'https://api.surplusintelligence.ai/v1?key=secret'},{marginBps:-1},{marginBps:10000},{safetyBps:NaN},{safetyBps:0.5},{antseedFeeBps:10000},{antseedFeeBps:-1}]) {
  await assert.rejects(fetchMediaQuotes({...configured(),...change},()=>assert.fail('no network')),/Invalid|Untrusted/);
 }
});

test('media estimates require explicit reviewed unexpired consent lasting at most 24 hours and 10 percent fee cushion',async()=>{
 const {fetchMediaQuotes}=await load();
 for(const change of [null,{version:2},{reviewedAt:'REVIEW_REQUIRED'},{reviewedAt:new Date(Date.now()+120000).toISOString()},{reviewedAt:new Date(Date.now()-86401_000).toISOString()},{expiresAt:new Date(Date.now()-1000).toISOString()},{expiresAt:new Date(Date.now()+86401_000).toISOString()},{feeCushionBps:999},{feeCushionBps:Infinity},{services:null}]) {
  const config=change===null?null:{...policy(),...change};
  await assert.rejects(fetchMediaQuotes({...settings,mediaConfig:config},()=>assert.fail('no network')),/Invalid.*media|expired|review/i);
 }
});

test('only reviewed model modality inputs and fixed supported parameters can be priced',async()=>{
 const {fetchMediaQuotes}=await load();
 const bad=[{...image(),provider:'typesafe'},{...image(),kind:'video'},{...image(),model:'../admin'},{...image(),model:'unreviewed-model'},{...image(),inputs:['text','audio']},{...image(),inputs:[]},{...image(),parameters:{n:2,size:'1024x1024'}},{...image(),parameters:{n:1,size:'2048x2048'}},{...image(),parameters:{n:1,size:'1024x1024',quality:'ultra'}},{...image(),parameters:{n:1}},{...image(),estimatedCostUsd:0},{...image(),estimatedCostUsd:'0.02'},{...image(),estimatedCostUsd:Infinity},{...image(),pricingBasis:'public-ceiling'},{...edit(),parameters:{n:1,size:'1024x1024'}},{...video(),inputs:['text']},{...video(),parameters:{duration_seconds:5,resolution:'720p',audio:false}},{...video(),parameters:{duration_seconds:5,resolution:'720p',aspect_ratio:'16:9'}},{...video(),parameters:{duration_seconds:10,resolution:'720p'}},{...decision(),parameters:{n:1}},{...image(),provider_base_url:'https://evil.invalid'}];
 for(const entry of bad) await assert.rejects(fetchMediaQuotes(configured([entry]),()=>assert.fail('no network')),/Invalid|Unsupported|review/i);
 await assert.rejects(fetchMediaQuotes(configured([image(),image()]),()=>assert.fail('no network')),/duplicate|Invalid/i);
});

// Public GET schema pinned to surplus-intelligence 2207d607e747f487a4d83e60c7f24ad677a55a7f.
// Minimal non-secret fixtures exercise the real parser; no paid API is invoked.
const ZERO={inputUsdPerMillion:0,outputUsdPerMillion:0,cachedInputUsdPerMillion:0};
const mediaPricing=(perImageUsd=0)=>({perImageUsd,per1kCharsUsd:0,perMinuteUsd:0,per1MTokensUsd:0,inputPer1MUsd:0,outputPer1MUsd:0,outputPerMpUsd:0});
const catalogRow=(entry)=>({model:entry.model,providers:[],mediaType:entry.kind==='decision'?'decisions':entry.kind,mediaPricing:entry.kind==='decision'?{...mediaPricing(),inputPer1MUsd:0.042}:mediaPricing(entry.kind==='image'?0.01:0)});
const offer=(entry,changes={})=>({provider_id:entry.provider,seller_base_url:entry.provider==='typesafe'?'https://api.typesafe.ai/v1':'https://api.venice.ai/api/v1',healthy:true,available:true,cap_remaining:null,media_unit:entry.kind==='image'?'image':entry.kind==='video'?'job':null,media_unit_price:entry.kind==='image'?8000:entry.kind==='video'?14400:null,effective_input_per_1m:entry.kind==='decision'?420:0,effective_output_per_1m:0,...changes});
function transport(entries=[image()],options={}) {
 const calls=[];
 const catalog=options.catalog??{updated_at:new Date().toISOString(),models:entries.map(catalogRow)};
 const books=Object.fromEntries(entries.map(entry=>[entry.model,{model:entry.model,offers:[offer(entry)]}]));
 Object.assign(books,options.books);
 const fetchImpl=async(url,init)=>{
  calls.push({url:String(url),init});
  const data=String(url).endsWith('/v1/prices')?catalog:books[decodeURIComponent(String(url).split('/').at(-1))];
  return Response.json(data);
 };
 return {calls,fetchImpl};
}

test('image and edit estimates separate output-unit prices from token dimensions and cover all sell-side fees',async()=>{
 const {fetchMediaQuotes}=await load(),entries=[image(),edit()],s=configured(entries),t=transport(entries);
 const result=await fetchMediaQuotes(s,t.fetchImpl);
 assert.deepEqual(Object.keys(result.services),entries.map(e=>e.model));
 assert.deepEqual(result.unavailable,{});
 for(const entry of entries) {
  const quote=result.services[entry.model];
  assert.equal(quote.upstreamModel,entry.model);assert.equal(quote.provider,'api.venice.ai');assert.equal(quote.kind,'image');
  assert.deepEqual(quote.pricing,ZERO);assert.deepEqual(quote.upstreamPricing,ZERO);assert.equal(quote.maxPricePer1m,0);
  assert.ok(Math.abs(quote.estimatedUpstreamUsd-entry.estimatedCostUsd*1.1)<1e-8);
  assert.ok(quote.unitPriceUsd*0.96>=quote.estimatedUpstreamUsd*1.05/0.95);
  assert.equal(quote.guaranteedBound,false);assert.equal(quote.priceBasis,'reviewed-operator-estimate');assert.equal(quote.policyExpiresAt,s.mediaConfig.expiresAt);
  assert.deepEqual(quote.media,entry);
 }
 assert.equal(t.calls.length,3);
 for(const {url,init} of t.calls) {
  assert.ok(url.startsWith('https://api.surplusintelligence.ai/'));assert.equal(init.method,'GET');assert.equal(init.redirect,'error');
  assert.equal(new Headers(init.headers).has('authorization'),false);assert.ok(init.signal instanceof AbortSignal);
 }
});

test('video needs operator whole-render estimate and never converts public job tariff into a guaranteed bound',async()=>{
 const {fetchMediaQuotes}=await load(),entry=video(),s=configured([entry]);
 const result=await fetchMediaQuotes(s,transport([entry]).fetchImpl),quote=result.services[entry.model];
 assert.ok(quote);assert.equal(quote.kind,'video');assert.equal(quote.estimatedUpstreamUsd,0.22);
 assert.deepEqual(quote.pricing,ZERO);assert.equal(quote.guaranteedBound,false);
 assert.match(quote.warnings.join(' '),/render|ceiling|enforc/i);
 assert.deepEqual(quote.media.parameters,{duration_seconds:5,resolution:'720p'});
});

test('decisions honor zero output and use a maximum native-book plus official reference token envelope',async()=>{
 const {fetchMediaQuotes}=await load(),entry=decision(),s=configured([entry]);
 const book={model:entry.model,offers:[offer(entry),offer(entry,{effective_input_per_1m:60000,effective_output_per_1m:1000})]};
 const result=await fetchMediaQuotes(s,transport([entry],{books:{[entry.model]:book}}).fetchImpl),quote=result.services[entry.model];
 assert.ok(quote);assert.equal(quote.provider,'api.typesafe.ai');assert.equal(quote.kind,'decision');
 assert.equal(quote.upstreamPricing.inputUsdPerMillion,0.066);assert.equal(quote.upstreamPricing.cachedInputUsdPerMillion,0.066);assert.equal(quote.upstreamPricing.outputUsdPerMillion,0.0011);
 assert.equal(quote.maxPricePer1m,0.066);assert.equal(quote.unitPriceUsd,undefined);
 assert.ok(quote.pricing.inputUsdPerMillion*0.96>=0.066*1.05/0.95);
 const zero=await fetchMediaQuotes(s,transport([entry]).fetchImpl);
 assert.equal(zero.services[entry.model].upstreamPricing.inputUsdPerMillion,0.0462);
 assert.equal(zero.services[entry.model].pricing.outputUsdPerMillion,0);
});

test('healthy available non-exhausted native host supply is mandatory and recursive routes are excluded',async()=>{
 const {fetchMediaQuotes}=await load(),entry=image();
 for(const change of [{healthy:false},{available:false},{cap_remaining:0},{cap_remaining:-1},{cap_remaining:'10'},{cap_remaining:{unknown:true}},{provider_id:'antseed'},{provider_id:'mordiem'},{seller_base_url:'https://api.venice.ai.evil.invalid/v1'},{seller_base_url:'http://api.venice.ai/v1'},{seller_base_url:'https://secret@api.venice.ai/v1'},{seller_base_url:'https://api.venice.ai:444/v1'}]) {
  const books={[entry.model]:{model:entry.model,offers:[offer(entry,change)]}};
  const result=await fetchMediaQuotes(configured([entry]),transport([entry],{books}).fetchImpl);
  assert.deepEqual(result.services,{});assert.match(result.unavailable[entry.model],/supply|native|route/i);
 }
});

test('operator estimates below the most expensive eligible visible media tariff are not advertised',async()=>{
 const {fetchMediaQuotes}=await load();
 for(const entry of [image(),video()]) {
  const books={[entry.model]:{model:entry.model,offers:[offer(entry),offer(entry,{media_unit_price:900000})]}};
  const result=await fetchMediaQuotes(configured([entry]),transport([entry],{books}).fetchImpl);
  assert.deepEqual(result.services,{});assert.match(result.unavailable[entry.model],/estimate|tariff/i);
 }
});

test('missing or incompatible media price units and null prices never become zero-cost fallbacks',async()=>{
 const {fetchMediaQuotes}=await load(),entry=image();
 for(const change of [{media_unit_price:null},{media_unit_price:0},{media_unit_price:-1},{media_unit_price:'8000'},{media_unit_price:Infinity},{media_unit_price:undefined},{media_unit:'job'},{media_unit:null}]) {
  const books={[entry.model]:{model:entry.model,offers:[offer(entry,change)]}};
  const result=await fetchMediaQuotes(configured([entry]),transport([entry],{books}).fetchImpl);
  assert.deepEqual(result.services,{});assert.match(result.unavailable[entry.model],/tariff|price|unit|schema/i);
 }
});

test('catalog freshness model identity modality and complete known reference dimensions fail closed',async()=>{
 const {fetchMediaQuotes}=await load(),entry=image(),row=catalogRow(entry);
 const bad=[{updated_at:'invalid',models:[row]},{updated_at:new Date(Date.now()-86401_000).toISOString(),models:[row]},{updated_at:new Date(Date.now()+120000).toISOString(),models:[row]},{models:[row]}, {updated_at:new Date().toISOString(),models:[]}, {updated_at:new Date().toISOString(),models:[row,row]}, {updated_at:new Date().toISOString(),models:[{...row,mediaType:'video'}]}, {updated_at:new Date().toISOString(),models:[{...row,mediaPricing:{}}]}, {updated_at:new Date().toISOString(),models:[{...row,mediaPricing:{...row.mediaPricing,perImageUsd:null}}]}, {updated_at:new Date().toISOString(),models:[{...row,mediaPricing:{...row.mediaPricing,unknownDimension:1}}]}];
 for(const catalog of bad) {
  const result=await fetchMediaQuotes(configured([entry]),transport([entry],{catalog}).fetchImpl);
  assert.deepEqual(result.services,{});assert.match(result.unavailable[entry.model],/catalog|reference|schema/i);
 }
});

test('decision reference and native book require real token dimensions but permit genuine zero output',async()=>{
 const {fetchMediaQuotes}=await load(),entry=decision();
 for(const change of [{effective_input_per_1m:null},{effective_input_per_1m:0},{effective_output_per_1m:undefined},{effective_output_per_1m:-1},{effective_output_per_1m:'0'}]) {
  const books={[entry.model]:{model:entry.model,offers:[offer(entry,change)]}};
  const result=await fetchMediaQuotes(configured([entry]),transport([entry],{books}).fetchImpl);
  assert.deepEqual(result.services,{});assert.match(result.unavailable[entry.model],/token|rate|price/i);
 }
 const catalog={updated_at:new Date().toISOString(),models:[{...catalogRow(entry),mediaPricing:{...mediaPricing(),inputPer1MUsd:0}}]};
 const result=await fetchMediaQuotes(configured([entry]),transport([entry],{catalog}).fetchImpl);
 assert.deepEqual(result.services,{});assert.match(result.unavailable[entry.model],/reference|rate/i);
});

test('source failures are per-model, bounded, sanitized and cannot leak transport credentials',async()=>{
 const {fetchMediaQuotes}=await load(),entry=image();
 for(const badResponse of [()=>{throw Error('inf_SECRET_FIXTURE');},()=>new Response('inf_SECRET_FIXTURE',{status:401}),()=>new Response('inf_SECRET_FIXTURE',{status:200}),()=>new Response('x'.repeat(8*1024*1024+1))]) {
  const result=await fetchMediaQuotes(configured([entry]),async()=>badResponse());
  assert.deepEqual(result.services,{});assert.ok(result.unavailable[entry.model]);assert.doesNotMatch(JSON.stringify(result),/inf_SECRET_FIXTURE/);
 }
 const t=transport([entry,edit()]);
 const result=await fetchMediaQuotes(configured([entry,edit()]),async(url,init)=>String(url).endsWith('/'+entry.model)?Response.json({model:'wrong-model',offers:[]}):t.fetchImpl(url,init));
 assert.equal(result.services[entry.model],undefined);assert.ok(result.unavailable[entry.model]);assert.ok(result.services['muse-image-edit']);
});

test('public media tariffs with unexpected token charges are not treated as zero-token jobs',async()=>{
 const {fetchMediaQuotes}=await load(),entry=image();
 for(const change of [{effective_input_per_1m:1000},{effective_output_per_1m:1000},{effective_input_per_1m:undefined}]) {
  const books={[entry.model]:{model:entry.model,offers:[offer(entry,change)]}};
  const result=await fetchMediaQuotes(configured([entry]),transport([entry],{books}).fetchImpl);
  assert.deepEqual(result.services,{});assert.match(result.unavailable[entry.model],/token|dimension|price/i);
 }
});

test('finite operator costs that overflow derived prices fail closed instead of serializing infinity as null',async()=>{
 const {fetchMediaQuotes}=await load(),entry={...image(),estimatedCostUsd:1e308};
 const result=await fetchMediaQuotes(configured([entry]),transport([entry]).fetchImpl);
 assert.deepEqual(result.services,{});assert.match(result.unavailable[entry.model],/price|range|overflow/i);
});

test('asynchronous public discovery cannot mutate reviewed dimensions or the validated economics',async()=>{
 const {fetchMediaQuotes}=await load(),entry=image(),s=configured([entry]),t=transport([entry]);
 const result=await fetchMediaQuotes(s,async(url,init)=>{
  const response=await t.fetchImpl(url,init);
  s.mediaConfig.services[0].parameters.n=10;s.marginBps=0;
  return response;
 });
 const quote=result.services[entry.model];assert.ok(quote);assert.equal(quote.media.parameters.n,1);
 assert.ok(quote.unitPriceUsd*0.96>=quote.estimatedUpstreamUsd*1.05/0.95);
 entry.parameters.n=20;
 assert.equal(quote.media.parameters.n,1);
});

test('quotes are never emitted when review consent expires during a public source await',async()=>{
 const {fetchMediaQuotes}=await load(),entry=image(),s=configured([entry]),t=transport([entry]);
 const realNow=Date.now;let now=realNow();s.mediaConfig.expiresAt=new Date(now+1000).toISOString();
 Date.now=()=>now;
 try {
  const result=await fetchMediaQuotes(s,async(url,init)=>{
   const response=await t.fetchImpl(url,init);now+=2000;return response;
  });
  assert.deepEqual(result.services,{});assert.match(result.unavailable[entry.model],/expired|consent|policy/i);
 }finally{Date.now=realNow;}
});

test('invalid media evidence retains its diagnostic when the orderbook read crosses consent expiry',async t=>{
 const {fetchMediaQuotes}=await load();
 for(const [name,bookFor,expected,estimatedCostUsd] of [
  ['malformed orderbook',()=>({model:'wrong',offers:null}),/model\/schema mismatch/],
  ['invalid tariff',entry=>({model:entry.model,offers:[offer(entry,{media_unit_price:null})]}),/invalid media tariff/],
  ['insufficient estimate',entry=>({model:entry.model,offers:[offer(entry,{media_unit_price:900000})]}),/estimate below/],
  ['derived price overflow',entry=>({model:entry.model,offers:[offer(entry)]}),/overflow\/out of range/,1e308],
 ])await t.test(name,async()=>{
  const entry={...image(),...(estimatedCostUsd===undefined?{}:{estimatedCostUsd})},s=configured([entry]);
  const t=transport([entry],{books:{[entry.model]:bookFor(entry)}});
  const realNow=Date.now;let now=realNow();s.mediaConfig.expiresAt=new Date(now+1000).toISOString();Date.now=()=>now;
  try{
   const result=await fetchMediaQuotes(s,async(url,init)=>{
    const response=await t.fetchImpl(url,init);if(String(url).endsWith('/'+entry.model))now+=2000;return response;
   });
   assert.deepEqual(result.services,{});assert.match(result.unavailable[entry.model],expected);
   assert.doesNotMatch(result.unavailable[entry.model],/consent expired/);assert.equal(t.calls.length,2);
  }finally{Date.now=realNow;}
 });
});

test('example uses review-required date placeholders and the four reviewed cheapest representative families',async()=>{
 const {readFile}=await import('node:fs/promises');
 const config=JSON.parse(await readFile(new URL('../examples/media.config.json',import.meta.url),'utf8'));
 assert.match(config.reviewedAt,/REVIEW_REQUIRED/);assert.match(config.expiresAt,/REVIEW_REQUIRED/);
 assert.deepEqual(config.services.map(s=>s.model),[image().model,edit().model,video().model,decision().model]);
 const {fetchMediaQuotes}=await load();
 await assert.rejects(fetchMediaQuotes({...settings,mediaConfig:config},()=>assert.fail('example must require review')),/review|expired/i);
 // Replacing date placeholders is necessary but does not alter the fixed request profiles.
 const t=transport(config.services),reviewed={...config,reviewedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString()};
 const result=await fetchMediaQuotes({...settings,mediaConfig:reviewed},t.fetchImpl);
 assert.equal(Object.keys(result.services).length,4);assert.deepEqual(result.unavailable,{});
});

test('reference envelope includes larger visible native direct token rates without accepting malformed dimensions',async()=>{
 const {fetchMediaQuotes}=await load(),entry=decision();
 const books={[entry.model]:{model:entry.model,offers:[offer(entry,{direct_input_per_1m:80000,direct_output_per_1m:2000})]}};
 const result=await fetchMediaQuotes(configured([entry]),transport([entry],{books}).fetchImpl);
 assert.equal(result.services[entry.model].upstreamPricing.inputUsdPerMillion,0.088);
 assert.equal(result.services[entry.model].upstreamPricing.outputUsdPerMillion,0.0022);
 books[entry.model].offers[0].direct_input_per_1m='80000';
 const bad=await fetchMediaQuotes(configured([entry]),transport([entry],{books}).fetchImpl);
 assert.deepEqual(bad.services,{});
});

test('an earlier model quote cannot outlive policy expiry while a later book request is awaiting',async()=>{
 const {fetchMediaQuotes}=await load(),entries=[image(),edit()],s=configured(entries),t=transport(entries);
 const realNow=Date.now;let now=realNow();s.mediaConfig.expiresAt=new Date(now+1000).toISOString();Date.now=()=>now;
 try {
  const result=await fetchMediaQuotes(s,async(url,init)=>{
   const response=await t.fetchImpl(url,init);if(String(url).endsWith('/muse-image-edit'))now+=2000;return response;
  });
  assert.deepEqual(result.services,{});
  assert.ok(entries.every(entry=>/expired|consent/i.test(result.unavailable[entry.model])));
 }finally{Date.now=realNow;}
});

test('public source byte limit cancels streaming before consuming an oversized complete response',async()=>{
 const {fetchMediaQuotes}=await load(),entry=image();let canceled=false,reads=0;
 const body=new ReadableStream({pull(controller){reads++;controller.enqueue(new Uint8Array(1024*1024));if(reads===12)controller.close();},cancel(){canceled=true;}});
 const result=await fetchMediaQuotes(configured([entry]),async()=>new Response(body));
 assert.deepEqual(result.services,{});assert.ok(canceled);assert.ok(reads<12);
});

test('decision books cannot hide per-job charges in token-only quotes',async()=>{
 const {fetchMediaQuotes}=await load(),entry=decision();
 for(const change of [{media_unit:'job',media_unit_price:1},{media_unit_price:'1'},{direct_media_unit_price:1}]) {
  const books={[entry.model]:{model:entry.model,offers:[offer(entry,change)]}};
  const result=await fetchMediaQuotes(configured([entry]),transport([entry],{books}).fetchImpl);
  assert.deepEqual(result.services,{});assert.match(result.unavailable[entry.model],/dimension|tariff|price/i);
 }
});

test('media books cannot hide nonzero or malformed direct token dimensions',async()=>{
 const {fetchMediaQuotes}=await load(),entry=image();
 for(const change of [{direct_input_per_1m:1},{direct_output_per_1m:1},{direct_input_per_1m:'0'}]) {
  const books={[entry.model]:{model:entry.model,offers:[offer(entry,change)]}};
  const result=await fetchMediaQuotes(configured([entry]),transport([entry],{books}).fetchImpl);
  assert.deepEqual(result.services,{});assert.match(result.unavailable[entry.model],/dimension|token|price/i);
 }
});

test('media reference tariff is also respected when larger than effective tariff',async()=>{
 const {fetchMediaQuotes}=await load(),entry=image();
 for(const direct_media_unit_price of [900000,'900000']) {
  const books={[entry.model]:{model:entry.model,offers:[offer(entry,{direct_media_unit_price})]}};
  const result=await fetchMediaQuotes(configured([entry]),transport([entry],{books}).fetchImpl);
  assert.deepEqual(result.services,{});assert.match(result.unavailable[entry.model],/estimate|tariff|price/i);
 }
});

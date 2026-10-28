import test from 'node:test';
import assert from 'node:assert/strict';

const settings={surplusBaseUrl:'https://api.surplusintelligence.ai/v1',models:['gpt-oss-120b'],marginBps:500,safetyBps:500};
const book={model:'gpt-oss-120b',offers:[{id:'offer-1',provider_id:'openai',seller_base_url:'https://api.openai.com/v1',available:true,healthy:true,cap_remaining:null,effective_input_per_1m:100000,effective_output_per_1m:200000}]};
function transport(payload=book) {
 const calls=[];
 const fetchImpl=async(url,options)=>{calls.push({url:String(url),options});return new Response(JSON.stringify(payload),{status:200,headers:{'content-type':'application/json'}});};
 return {fetchImpl,calls};
}
async function module(){return import('../lib/pricing.mjs');}

test('public book missing cache/account fee and enforcement evidence cannot produce profitable quotes',async()=>{
 const {fetchQuotes}=await module();const t=transport();
 const q=await fetchQuotes(settings,'inf_fixture_only',t.fetchImpl);
 assert.deepEqual(q.services,{});assert.ok(Number.isFinite(Date.parse(q.generatedAt)));
 assert.match(q.unavailable['gpt-oss-120b'],/cache|bound|fee/i);
 assert.equal(t.calls.length,1);
 assert.equal(t.calls[0].url,'https://api.surplusintelligence.ai/api/markets/gpt-oss-120b');
 assert.equal(t.calls[0].options.method,'GET');
 assert.equal(new Headers(t.calls[0].options.headers).has('authorization'),false);
});

test('loss pricing never relaxes upstream proof requirements or invents missing cache fields',async()=>{
 const {fetchQuotes}=await module();const t=transport();
 const q=await fetchQuotes({...settings,lossTest:true,lossPriceFactor:0.1},'inf_fixture_only',t.fetchImpl);
 assert.deepEqual(q.services,{});assert.ok(q.unavailable['gpt-oss-120b']);
});

test('AntSeed and unreviewed aggregator routes are excluded before economic selection',async()=>{
 const {fetchQuotes}=await module();
 const q=await fetchQuotes(settings,'inf_fixture_only',transport({...book,offers:[{...book.offers[0],provider_id:'antseed',seller_base_url:'https://antseed.com/v1'},{...book.offers[0],provider_id:'openrouter',seller_base_url:'https://openrouter.ai/api/v1'}]}).fetchImpl);
 assert.deepEqual(q.services,{});assert.match(q.unavailable['gpt-oss-120b'],/non-returning|loop|direct/i);
});

test('unhealthy unavailable and exhausted supply is never quoted',async()=>{
 const {fetchQuotes}=await module();
 for(const change of [{healthy:false},{available:false},{cap_remaining:0}]){
  const q=await fetchQuotes(settings,'inf_fixture_only',transport({...book,offers:[{...book.offers[0],...change}]}).fetchImpl);
  assert.deepEqual(q.services,{});assert.match(q.unavailable['gpt-oss-120b'],/supply/i);
 }
});

test('only allowlisted exact models are fetched and model mismatch fails closed',async()=>{
 const {fetchQuotes}=await module();const t=transport({...book,model:'different-model'});
 const q=await fetchQuotes(settings,'inf_fixture_only',t.fetchImpl);
 assert.deepEqual(q.services,{});assert.match(q.unavailable['gpt-oss-120b'],/model/i);
 assert.equal(t.calls.length,1);
});

test('network/auth/error bodies never leak credentials or become price fallbacks',async()=>{
 const {fetchQuotes}=await module();
 const q=await fetchQuotes(settings,'inf_secret_fixture',async()=>{throw Error('inf_secret_fixture');});
 assert.deepEqual(q.services,{});assert.doesNotMatch(JSON.stringify(q),/inf_secret_fixture/);
 const denied=await fetchQuotes(settings,'inf_secret_fixture',async()=>new Response('inf_secret_fixture',{status:401}));
 assert.deepEqual(denied.services,{});assert.doesNotMatch(JSON.stringify(denied),/inf_secret_fixture/);
});

test('invalid settings fail before network and normal mode cannot silently use loss pricing',async()=>{
 const {fetchQuotes}=await module();
 for(const change of [{surplusBaseUrl:'https://evil.invalid/v1'},{models:[]},{models:['../admin']},{marginBps:-1},{safetyBps:NaN},{lossPriceFactor:0.1},{lossTest:true,lossPriceFactor:0.2}]) {
  await assert.rejects(fetchQuotes({...settings,...change},'inf_fixture_only',()=>{throw Error('network must not run');}),/Invalid|Untrusted/);
 }
});

const policy=()=>({version:1,allowEstimates:true,provider:'venice',reviewedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600_000).toISOString(),sourceRevision:'2207d607e747f487a4d83e60c7f24ad677a55a7f',feeCushionBps:1000,offerMultiplierCeiling:2});
const catalog={updated_at:new Date().toISOString(),models:[{model:'gpt-oss-120b',providers:[{provider:'venice',pricing:{input:0.07,output:0.3,cacheRead:0.0105}}]}]};
const veniceBook={...book,offers:[{...book.offers[0],provider_id:'venice',seller_base_url:'https://api.venice.ai/api/v1',effective_input_per_1m:40000,effective_output_per_1m:100000}]};
const operationalFetch=async(url)=>new Response(JSON.stringify(String(url).endsWith('/v1/prices') ? catalog : veniceBook),{status:200});

test('explicit reviewed expiring policy creates labeled provider-pinned operational estimates',async()=>{
 const {fetchQuotes}=await module();const q=await fetchQuotes({...settings,pricingPolicy:policy()},'inf_fixture_only',operationalFetch);
 const s=q.services['gpt-oss-120b'];assert.ok(s);
 assert.equal(s.provider,'api.venice.ai');assert.equal(s.guaranteedBound,false);assert.equal(s.priceBasis,'reviewed-reference-envelope-estimate');
 assert.equal(s.upstreamPricing.inputUsdPerMillion,0.154);
 assert.equal(s.upstreamPricing.outputUsdPerMillion,0.66);
 assert.equal(s.upstreamPricing.cachedInputUsdPerMillion,0.154);
 assert.ok(s.pricing.inputUsdPerMillion>=s.upstreamPricing.inputUsdPerMillion*1.05/0.95);
 assert.equal(s.maxPricePer1m,0.66);
});

test('loss factor affects sell prices only, not upstream envelope or price ceiling',async()=>{
 const {fetchQuotes}=await module();const normal=await fetchQuotes({...settings,pricingPolicy:policy()},'inf_fixture_only',operationalFetch);
 const loss=await fetchQuotes({...settings,pricingPolicy:policy(),lossTest:true,lossPriceFactor:0.1},'inf_fixture_only',operationalFetch);
 const a=normal.services['gpt-oss-120b'],b=loss.services['gpt-oss-120b'];assert.ok(a&&b);
 assert.deepEqual(a.upstreamPricing,b.upstreamPricing);assert.equal(a.maxPricePer1m,b.maxPricePer1m);
 assert.equal(b.pricing.inputUsdPerMillion,a.pricing.inputUsdPerMillion*0.1);
});

test('expired policy, absent cache rate, mismatched provider and unknown billed dimensions fail closed',async()=>{
 const {fetchQuotes}=await module();
 for(const p of [{...policy(),expiresAt:'2000-01-01'},{...policy(),provider:'antseed'}]) await assert.rejects(fetchQuotes({...settings,pricingPolicy:p},'fixture',operationalFetch),/policy/i);
 for(const pricing of [{input:0.07,output:0.3},{input:0.07,output:0.3,cacheRead:0.01,webSearch:5}]) {
  const f=async(url)=>new Response(JSON.stringify(String(url).endsWith('/v1/prices') ? {...catalog,models:[{model:'gpt-oss-120b',providers:[{provider:'venice',pricing}]}]} : veniceBook),{status:200});
  const q=await fetchQuotes({...settings,pricingPolicy:policy()},'fixture',f);assert.deepEqual(q.services,{});
 }
});

test('Groq source-reviewed cache-at-input policy handles omitted native cache rates without guessing free cache',async()=>{
 const {fetchQuotes}=await module();
 const p={...policy(),provider:'groq',cacheAtInput:true};
 const f=async(url)=>new Response(JSON.stringify(String(url).endsWith('/v1/prices') ? {...catalog,models:[{model:'gpt-oss-120b',providers:[{provider:'groq',pricing:{input:0.07,output:0.3}}]}]} : {...book,offers:[{...book.offers[0],provider_id:'groq',seller_base_url:'https://api.groq.com/openai/v1'}]}),{status:200});
 const q=await fetchQuotes({...settings,pricingPolicy:p},'fixture',f);const s=q.services['gpt-oss-120b'];
 assert.ok(s);assert.equal(s.provider,'api.groq.com');assert.ok(s.upstreamPricing.inputUsdPerMillion>=0.154);assert.equal(s.upstreamPricing.cachedInputUsdPerMillion,s.upstreamPricing.inputUsdPerMillion);
 const noConsent=await fetchQuotes({...settings,pricingPolicy:{...p,cacheAtInput:undefined}},'fixture',f);assert.deepEqual(noConsent.services,{});
});

test('explicit reference fallback uses maximum component across catalog providers if pinned provider card is absent',async()=>{
 const {fetchQuotes}=await module();const p={...policy(),provider:'groq',cacheAtInput:true,referenceFallback:true};
 const f=async(url)=>new Response(JSON.stringify(String(url).endsWith('/v1/prices') ? catalog : {...book,offers:[{...book.offers[0],provider_id:'groq',seller_base_url:'https://api.groq.com/openai/v1'}]}),{status:200});
 const q=await fetchQuotes({...settings,pricingPolicy:p},'fixture',f);assert.ok(q.services['gpt-oss-120b']);
});

test('prices CLI refuses missing credentials without writing state or printing secrets',async()=>{
 const {spawnSync}=await import('node:child_process');
 const {mkdtemp,access,rm,writeFile}=await import('node:fs/promises');
 const {resolve}=await import('node:path');
 const dir=await mkdtemp(resolve(process.env.TMPDIR ?? process.cwd(),'pricing-cli-'));
 try {
  const env={...process.env,STATE_DIR:dir};delete env.SURPLUS_API_KEY;delete env.SURPLUS_API_KEY_FILE;delete env.PRICING_POLICY_FILE;
  await writeFile(resolve(dir,'empty.env'),'',{mode:0o600});
  const result=spawnSync(process.execPath,['scripts/prices.mjs','--env',resolve(dir,'empty.env')],{cwd:resolve(import.meta.dirname,'..'),env,encoding:'utf8'});
  assert.notEqual(result.status,0);assert.match(result.stderr,/Set SURPLUS_API_KEY/);
  await assert.rejects(access(resolve(dir,'quotes.json')));
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('explicit live-book mode adds only configured cushions and margin to worst healthy pinned offer',async()=>{
 const {fetchQuotes}=await module();const p={...policy(),provider:'groq',cacheAtInput:true,referenceFallback:true,basis:'live-book'};
 const offers=[{...book.offers[0],provider_id:'groq',seller_base_url:'https://api.groq.com/openai/v1',discount_pct:90,effective_input_per_1m:1000,effective_output_per_1m:2000},{...book.offers[0],provider_id:'groq',seller_base_url:'https://api.groq.com/openai/v1',discount_pct:80,effective_input_per_1m:2000,effective_output_per_1m:4000}];
 const f=async url=>Response.json(String(url).endsWith('/v1/prices')?catalog:{...book,offers});
 const q=await fetchQuotes({...settings,pricingPolicy:p},'fixture',f);const s=q.services['gpt-oss-120b'];
 assert.ok(s);assert.equal(s.upstreamPricing.inputUsdPerMillion,.0022);assert.equal(s.upstreamPricing.outputUsdPerMillion,.0044);
 assert.equal(s.cachedInputUsdPerMillion,undefined);assert.equal(s.upstreamPricing.cachedInputUsdPerMillion,.0022);
 assert.equal(s.minDiscountPct,80);assert.equal(s.guaranteedBound,false);
 assert.equal(s.priceBasis,'live-book-maximum-estimate');
});
test('repricer explicitly covers AntSeed protocol fee before targeting net gross margin',async()=>{
 const {fetchQuotes}=await module();const q=await fetchQuotes({...settings,antseedFeeBps:400,pricingPolicy:policy()},'fixture',operationalFetch);
 const service=q.services['gpt-oss-120b'];
 const net=service.pricing.inputUsdPerMillion*(1-400/10000);
 assert.ok(net>=service.upstreamPricing.inputUsdPerMillion*(1+settings.safetyBps/10000)/(1-settings.marginBps/10000));
});
// The real public API cannot support a positive profit-bound test: its missing
// evidence is a real blocker, not a reason to invent a wire contract in fixtures.

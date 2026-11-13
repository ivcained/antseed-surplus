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

test('reviewed native Google reference policy enables multimodal text models without enabling aggregator hosts',async()=>{
 const {fetchQuotes}=await module();
 const p={...policy(),provider:'google'};
 const googleCatalog={...catalog,models:[{model:'gpt-oss-120b',providers:[{provider:'google',pricing:{input:.15,output:.6,cacheRead:.015}}]}]};
 const direct={...book,offers:[{...book.offers[0],provider_id:'google',seller_base_url:'https://generativelanguage.googleapis.com/v1beta'}]};
 const f=async url=>Response.json(String(url).endsWith('/v1/prices')?googleCatalog:direct);
 const q=await fetchQuotes({...settings,pricingPolicy:p},'fixture',f);
 assert.equal(q.services['gpt-oss-120b'].provider,'generativelanguage.googleapis.com');
 assert.equal(q.services['gpt-oss-120b'].guaranteedBound,false);
 const wrong=async url=>Response.json(String(url).endsWith('/v1/prices')?googleCatalog:{...direct,offers:[{...direct.offers[0],seller_base_url:'https://aggregator.example/v1'}]});
 assert.deepEqual((await fetchQuotes({...settings,pricingPolicy:p},'fixture',wrong)).services,{});
 await assert.rejects(fetchQuotes({...settings,pricingPolicy:{...p,basis:'live-book'}},'fixture',f),/Groq|policy/i);
});
test('reference fallback can explicitly select a reviewed reference provider instead of unrelated add-on tariffs',async()=>{
 const {fetchQuotes}=await module();
 const p={...policy(),provider:'google',referenceFallback:true,referenceProvider:'venice'};
 const rows={...catalog,models:[{model:'gpt-oss-120b',providers:[...catalog.models[0].providers,{provider:'openrouter',pricing:{input:1,output:2,cacheRead:.1,webSearch:.01}}]}]};
 const f=async url=>Response.json(String(url).endsWith('/v1/prices')?rows:{...book,offers:[{...book.offers[0],provider_id:'google',seller_base_url:'https://generativelanguage.googleapis.com/v1beta/openai'}]});
 const result=await fetchQuotes({...settings,pricingPolicy:p},'fixture',f);
 assert.ok(result.services['gpt-oss-120b']);
 assert.equal(result.services['gpt-oss-120b'].upstreamPricing.inputUsdPerMillion,.154);
 for(const referenceProvider of ['antseed','missing'])await assert.rejects(fetchQuotes({...settings,pricingPolicy:{...p,referenceProvider}},'fixture',f),/reference|policy/i);
 await assert.rejects(fetchQuotes({...settings,pricingPolicy:{...p,referenceFallback:false}},'fixture',f),/reference|policy/i);
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

// Synthetic catalog/book evidence tests local policy, not live provider support.
const endpointHost={venice:'api.venice.ai',groq:'api.groq.com',google:'generativelanguage.googleapis.com',openai:'api.openai.com'};
function endpointOffer(provider,host=endpointHost[provider],change={}) {
 return {...book.offers[0],provider_id:provider,seller_base_url:`https://${host}/v1`,effective_input_per_1m:10000,effective_output_per_1m:20000,...change};
}
function endpointTransport(rows,books) {
 const calls=[];
 return {calls,fetchImpl:async(url,init)=>{
  calls.push({url:String(url),init});
  if(String(url).endsWith('/v1/prices'))return Response.json({updated_at:new Date().toISOString(),models:rows});
  const model=decodeURIComponent(String(url).split('/').at(-1));
  return Response.json({model,offers:books[model]??[]});
 }};
}
const endpointRow=(model,provider,pricing={input:1,output:2,cacheRead:.1})=>({model,providers:[{provider,pricing}]});

test('mixed exact model routes select OpenAI, AI Studio and Vertex without changing base consent or economics',async()=>{
 const {fetchQuotes}=await module();
 const models=['openai-pdf','studio-chat','vertex-video','default-venice'];
 const p={...policy(),modelRoutes:{'openai-pdf':{provider:'openai',host:'api.openai.com'},'studio-chat':{provider:'google',host:'generativelanguage.googleapis.com'},'vertex-video':{provider:'google',host:'aiplatform.googleapis.com'}}};
 const hosts=['api.openai.com','generativelanguage.googleapis.com','aiplatform.googleapis.com','api.venice.ai'];
 const providers=['openai','google','google','venice'];
 const t=endpointTransport(models.map((m,i)=>endpointRow(m,providers[i])),Object.fromEntries(models.map((m,i)=>[m,[endpointOffer(providers[i],hosts[i])]])));
 const q=await fetchQuotes({...settings,models,pricingPolicy:p},'inf_discovery_must_not_send',t.fetchImpl);
 assert.deepEqual(Object.keys(q.services),models);assert.deepEqual(q.unavailable,{});
 for(const [i,model] of models.entries()) {
  const s=q.services[model];assert.equal(s.provider,hosts[i]);assert.equal(s.upstreamModel,model);
  assert.deepEqual(s.upstreamPricing,{inputUsdPerMillion:2.2,outputUsdPerMillion:4.4,cachedInputUsdPerMillion:2.2});
  assert.equal(s.guaranteedBound,false);assert.equal(s.priceBasis,'reviewed-reference-envelope-estimate');
  assert.equal(s.policyExpiresAt,p.expiresAt);assert.equal(s.policySourceRevision,p.sourceRevision);assert.equal(s.feeCushionBps,p.feeCushionBps);assert.equal(s.antseedFeeBps,400);
  assert.ok(s.pricing.inputUsdPerMillion>=s.upstreamPricing.inputUsdPerMillion*1.05/.95/.96);
 }
 assert.equal(t.calls.length,models.length+1);
 for(const {url,init} of t.calls){assert.equal(new URL(url).origin,'https://api.surplusintelligence.ai');assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.deepEqual([...new Headers(init.headers)],[['accept','application/json']]);assert.doesNotMatch(JSON.stringify({url,init}),/inf_discovery/);}
});

test('reviewed OpenAI base and explicit OpenAI reference fallback require complete cache evidence',async()=>{
 const {fetchQuotes}=await module();const model=settings.models[0];
 for(const provider of ['openai','google']) {
  const p={...policy(),provider,...(provider==='google'?{referenceFallback:true,referenceProvider:'openai'}:{})};
  const t=endpointTransport([endpointRow(model,'openai')],{[model]:[endpointOffer(provider)]});
  const q=await fetchQuotes({...settings,pricingPolicy:p},'fixture',t.fetchImpl);
  assert.equal(q.services[model]?.provider,endpointHost[provider]);
  for(const pricing of [{input:1,output:2},{input:1,output:2,cacheRead:.1,webSearch:1}]) {
   const bad=endpointTransport([endpointRow(model,'openai',pricing)],{[model]:[endpointOffer(provider)]});
   assert.deepEqual((await fetchQuotes({...settings,pricingPolicy:{...p,cacheAtInput:true}},'fixture',bad.fetchImpl)).services,{});
  }
 }
});

test('Google default remains AI Studio and explicit Vertex selection isolates healthy host prices',async()=>{
 const {fetchQuotes}=await module();const model=settings.models[0];
 const offers=[endpointOffer('google'),endpointOffer('google','aiplatform.googleapis.com',{effective_input_per_1m:9000000,effective_output_per_1m:11000000}),endpointOffer('openai','generativelanguage.googleapis.com',{effective_input_per_1m:99000000,effective_output_per_1m:99000000}),endpointOffer('google','aiplatform.googleapis.com',{healthy:false,effective_input_per_1m:99000000,effective_output_per_1m:99000000})];
 const t=endpointTransport([endpointRow(model,'google')],{[model]:offers});
 const base={...settings,pricingPolicy:{...policy(),provider:'google'}};
 const studio=(await fetchQuotes(base,'fixture',t.fetchImpl)).services[model];
 assert.equal(studio.provider,'generativelanguage.googleapis.com');assert.equal(studio.upstreamPricing.outputUsdPerMillion,4.4);
 const vertex=(await fetchQuotes({...base,pricingPolicy:{...base.pricingPolicy,modelRoutes:{[model]:{provider:'google',host:'aiplatform.googleapis.com'}}}},'fixture',t.fetchImpl)).services[model];
 assert.equal(vertex.provider,'aiplatform.googleapis.com');assert.equal(vertex.upstreamPricing.inputUsdPerMillion,9.9);assert.equal(vertex.upstreamPricing.outputUsdPerMillion,12.100000001); // Preserve existing conservative upward rounding.
});

test('selected endpoint cannot borrow wrong-host, wrong-provider, unhealthy, exhausted or empty supply',async()=>{
 const {fetchQuotes}=await module();const model=settings.models[0];
 const s={...settings,pricingPolicy:{...policy(),provider:'google',modelRoutes:{[model]:{provider:'google',host:'aiplatform.googleapis.com'}}}};
 for(const offers of [[],[endpointOffer('google')],[endpointOffer('openai','aiplatform.googleapis.com')],...[{healthy:false},{available:false},{cap_remaining:0}].map(change=>[endpointOffer('google','aiplatform.googleapis.com',change)]),...['https://aiplatform.googleapis.com.evil/v1','https://user:pass@aiplatform.googleapis.com/v1','https://aiplatform.googleapis.com:444/v1','http://aiplatform.googleapis.com/v1'].map(seller_base_url=>[endpointOffer('google','aiplatform.googleapis.com',{seller_base_url})])]) {
  const t=endpointTransport([endpointRow(model,'google')],{[model]:offers});
  const q=await fetchQuotes(s,'fixture',t.fetchImpl);assert.deepEqual(q.services,{});assert.ok(q.unavailable[model]);
 }
});

const malformedRoutes=[
 ['null',null],['array',[]],['string','google'],['date',new Date()],['inherited model',Object.create({[settings.models[0]]:{provider:'google',host:'aiplatform.googleapis.com'}})],['unknown model',{'not-configured':{provider:'google',host:'aiplatform.googleapis.com'}}],['wildcard model',{'*':{provider:'google',host:'aiplatform.googleapis.com'}}],
 ...[null,[],{}, {provider:'google'}, {host:'aiplatform.googleapis.com'}, {provider:'google',host:'aiplatform.googleapis.com',feeCushionBps:0}, {provider:'google',host:'aiplatform.googleapis.com',referenceFallback:true}, {provider:'google',host:'aiplatform.googleapis.com',expiresAt:'2099-01-01'}, {provider:'google',host:'aiplatform.googleapis.com',basis:'live-book'}].map((route,i)=>[`shape ${i}`,{[settings.models[0]]:route}]),
 ...[['antseed','antseed.com'],['openrouter','openrouter.ai'],['anthropic','api.anthropic.com'],['google','api.openai.com'],['google','https://aiplatform.googleapis.com'],['google','aiplatform.googleapis.com:443'],['google','user@aiplatform.googleapis.com'],['google','aiplatform.googleapis.com.evil'],['google','*.googleapis.com'],['google','aiplatform.googleapis.com/'],['google','AIPLATFORM.GOOGLEAPIS.COM'],['openai','api.openai.com.'],['openai',null],['openai',42]].map(([provider,host])=>[`${provider}/${host}`,{[settings.models[0]]:{provider,host}}]),
];
for(const [name,modelRoutes] of malformedRoutes)for(const expired of [false,true])test(`invalid modelRoutes ${name} fails before discovery and ${expired?'expired':'valid'} consent classification`,async()=>{
 const {fetchQuotes,PricingConsentExpiredError}=await module();let calls=0;
 const p={...policy(),modelRoutes,...(expired?{reviewedAt:new Date(Date.now()-7200000).toISOString(),expiresAt:new Date(Date.now()-3600000).toISOString()}:{})};
 await assert.rejects(fetchQuotes({...settings,pricingPolicy:p},'fixture',async()=>{calls++;return Response.json(catalog);}),error=>!(error instanceof PricingConsentExpiredError)&&/route|policy/i.test(error.message));
 assert.equal(calls,0);
});

test('routes cannot broaden live-book consent beyond reviewed providers with cache-at-input',async()=>{
 const {fetchQuotes}=await module();let calls=0;
 const unreviewed={...policy(),provider:'groq',cacheAtInput:true,basis:'live-book',modelRoutes:{[settings.models[0]]:{provider:'openrouter',host:'openrouter.ai'}}};
 await assert.rejects(fetchQuotes({...settings,pricingPolicy:unreviewed},'fixture',async()=>{calls++;return Response.json(catalog);}),/Invalid model route policy|reviewed native provider route/);
 const noConsent={...policy(),provider:'venice',cacheAtInput:false,basis:'live-book',modelRoutes:{[settings.models[0]]:{provider:'venice',host:'api.venice.ai'}}};
 await assert.rejects(fetchQuotes({...settings,pricingPolicy:noConsent},'fixture',async()=>{calls++;return Response.json(catalog);}),/cache-at-input consent/);
 assert.equal(calls,0);
});

test('malformed text routes are fatal even when media consent has expired',async()=>{
 const {fetchQuotes}=await module();let calls=0;
 const mediaConfig={version:1,reviewedAt:new Date(Date.now()-7200000).toISOString(),expiresAt:new Date(Date.now()-3600000).toISOString(),feeCushionBps:1000,services:[{model:'venice-sd35',kind:'image',provider:'venice',inputs:['text'],parameters:{n:1,size:'1024x1024'},estimatedCostUsd:.02,pricingBasis:'operator-estimate'}]};
 await assert.rejects(fetchQuotes({...settings,pricingPolicy:{...policy(),modelRoutes:{unknown:{provider:'openai',host:'api.openai.com'}}},mediaConfig},'fixture',async()=>{calls++;return Response.json(catalog);}),error=>error.name!=='ConsentExpiredError'&&/route|policy/i.test(error.message));
 assert.equal(calls,0);
});

test('OpenAI exact route uses a Venice reference card only under inherited explicit fallback consent',async()=>{
 const {fetchQuotes}=await module();const model='gpt-4o';
 const t=endpointTransport([endpointRow(model,'venice',{input:2.5,output:10,cacheRead:1.25})],{[model]:[endpointOffer('openai')]});
 const p={...policy(),modelRoutes:{[model]:{provider:'openai',host:'api.openai.com'}}};
 const s={...settings,models:[model]};
 assert.deepEqual((await fetchQuotes({...s,pricingPolicy:p},'fixture',t.fetchImpl)).services,{});
 const q=await fetchQuotes({...s,pricingPolicy:{...p,referenceFallback:true,referenceProvider:'venice'}},'fixture',t.fetchImpl);
 assert.equal(q.services[model]?.provider,'api.openai.com');
 assert.deepEqual(q.services[model]?.upstreamPricing,{inputUsdPerMillion:5.5,outputUsdPerMillion:22,cachedInputUsdPerMillion:5.5});
});

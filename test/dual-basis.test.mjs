import test from 'node:test';
import assert from 'node:assert/strict';

const groqBook={model:'duo-a',offers:[{id:'g1',provider_id:'groq',seller_base_url:'https://api.groq.com/openai/v1',available:true,healthy:true,cap_remaining:null,effective_input_per_1m:56000,effective_output_per_1m:240000,discount_pct:99}]};
const veniceBook={model:'duo-b',offers:[{id:'v1',provider_id:'venice',seller_base_url:'https://api.venice.ai/api/v1',available:true,healthy:true,cap_remaining:null,effective_input_per_1m:1600000,effective_output_per_1m:8000000,discount_pct:20}]};
const catalog={updated_at:new Date().toISOString(),models:[
 {model:'duo-a',providers:[{provider:'groq',pricing:{input:0.55,output:2.19}}]},
 {model:'duo-b',providers:[{provider:'venice',pricing:{input:1,output:5,cacheRead:1}}]}]};
function fetchImpl(url){
 const u=String(url);
 if(u.endsWith('/v1/prices'))return new Response(JSON.stringify(catalog),{status:200,headers:{'content-type':'application/json'}});
 if(u.endsWith('/api/markets/duo-a'))return new Response(JSON.stringify(groqBook),{status:200,headers:{'content-type':'application/json'}});
 if(u.endsWith('/api/markets/duo-b'))return new Response(JSON.stringify(veniceBook),{status:200,headers:{'content-type':'application/json'}});
 throw Error('unexpected '+u);
}
const policyBase={version:1,allowEstimates:true,provider:'groq',cacheAtInput:true,referenceFallback:true,reviewedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+23*3600_000).toISOString(),sourceRevision:'2207d607e747f487a4d83e60c7f24ad677a55a7f',feeCushionBps:1000,offerMultiplierCeiling:2};

test('dual-basis: one policy prices live-book groq and envelope venice models together',async()=>{
 const {fetchQuotes}=await import('../lib/pricing.mjs');
 const policy={...policyBase,provider:'venice',modelRoutes:{'duo-a':{provider:'groq',host:'api.groq.com'}},modelBasis:{'duo-a':'live-book','duo-b':'reference-envelope'}};
 const settings={surplusBaseUrl:'https://api.surplusintelligence.ai/v1',models:['duo-a','duo-b'],marginBps:100,safetyBps:500,pricingPolicy:policy};
 const q=await fetchQuotes(settings,'inf_duo_fixture',fetchImpl);
 assert.ok(q.services['duo-a']);
 assert.equal(q.services['duo-a'].priceBasis,'live-book-maximum-estimate');
 assert.ok(Number.isFinite(q.services['duo-a'].minDiscountPct));
 assert.ok(q.services['duo-b']);
 assert.equal(q.services['duo-b'].priceBasis,'reviewed-reference-envelope-estimate');
 assert.equal(q.services['duo-b'].minDiscountPct,undefined);
 assert.deepEqual(q.unavailable,{});
});

test('dual-basis: live-book on a reviewed venice route is accepted',async()=>{
 const {fetchQuotes}=await import('../lib/pricing.mjs');
 const policy={...policyBase,provider:'venice',modelRoutes:{'duo-b':{provider:'venice',host:'api.venice.ai'}},modelBasis:{'duo-b':'live-book'}};
 const settings={surplusBaseUrl:'https://api.surplusintelligence.ai/v1',models:['duo-b'],marginBps:100,safetyBps:500,pricingPolicy:policy};
 const q=await fetchQuotes(settings,'inf_duo_fixture',fetchImpl);
 assert.equal(q.services['duo-b'].priceBasis,'live-book-maximum-estimate');
 assert.ok(Number.isFinite(q.services['duo-b'].minDiscountPct));
});
test('dual-basis: live-book on an unreviewed route is refused before pricing',async()=>{
 const {fetchQuotes}=await import('../lib/pricing.mjs');
 const policy={...policyBase,provider:'venice',modelRoutes:{'duo-b':{provider:'openrouter',host:'openrouter.ai'}},modelBasis:{'duo-b':'live-book'}};
 const settings={surplusBaseUrl:'https://api.surplusintelligence.ai/v1',models:['duo-b'],marginBps:100,safetyBps:500,pricingPolicy:policy};
 await assert.rejects(fetchQuotes(settings,'inf_duo_fixture',fetchImpl),/Invalid model route policy|reviewed native provider route/);
});

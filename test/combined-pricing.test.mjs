import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeContentQuotes,fetchQuotes} from '../lib/pricing.mjs';
const stamp=new Date().toISOString();
const mediaConfig=()=>({version:1,reviewedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),feeCushionBps:1000,services:[{model:'venice-sd35',kind:'image',provider:'venice',inputs:['text'],parameters:{n:1,size:'1024x1024'},estimatedCostUsd:.02,pricingBasis:'operator-estimate'}]});
test('normal seller pricing entrypoint discovers explicitly enabled media using anonymous public requests',async()=>{
 const calls=[];
 const settings={surplusBaseUrl:'https://api.surplusintelligence.ai/v1',models:['chat'],marginBps:500,safetyBps:500,antseedFeeBps:400,mediaConfig:mediaConfig()};
 const price={perImageUsd:.01,per1kCharsUsd:0,perMinuteUsd:0,per1MTokensUsd:0,inputPer1MUsd:0,outputPer1MUsd:0,outputPerMpUsd:0};
 const request=async(url,init)=>{calls.push({url,init});if(String(url).endsWith('/v1/prices'))return Response.json({updated_at:new Date().toISOString(),models:[{model:'venice-sd35',mediaType:'image',mediaPricing:price}]});const model=decodeURIComponent(String(url).split('/').at(-1));return Response.json({model,offers:model==='chat'?[]:[{provider_id:'venice',seller_base_url:'https://api.venice.ai/api/v1',healthy:true,available:true,cap_remaining:null,effective_input_per_1m:0,effective_output_per_1m:0,media_unit:'image',media_unit_price:8000,direct_media_unit_price:10000}]});};
 const result=await fetchQuotes(settings,'inf_never_sent',request);
 assert.equal(result.services['venice-sd35']?.kind,'image');
 assert.ok(result.services['venice-sd35'].unitPriceUsd>.02);
 assert.equal(result.services['venice-sd35'].pricing.outputUsdPerMillion,0);
 assert.ok(calls.every(c=>!new Headers(c.init.headers).has('authorization')));
});
test('same model cannot be configured as both a text and media service even if one quote is unavailable',async()=>{
 const settings={surplusBaseUrl:'https://api.surplusintelligence.ai/v1',models:['venice-sd35'],marginBps:500,safetyBps:500,mediaConfig:mediaConfig()};
 await assert.rejects(fetchQuotes(settings,'fixture',async()=>Response.json({model:'venice-sd35',offers:[]})),/duplicate|collision/i);
});
test('combines token and unit quotes without changing billing dimensions or refreshing stale evidence',()=>{
 const old=new Date(Date.now()-20000).toISOString();
 const text={generatedAt:stamp,services:{chat:{pricing:{inputUsdPerMillion:1,outputUsdPerMillion:2}}},unavailable:{missing:'No native supply'}};
 const media={generatedAt:old,services:{image:{kind:'image',unitPriceUsd:.02,pricing:{inputUsdPerMillion:0,outputUsdPerMillion:0}},decision:{kind:'decision',pricing:{inputUsdPerMillion:.1,outputUsdPerMillion:0}}},unavailable:{video:'No native supply'}};
 const combined=mergeContentQuotes(text,media);
 assert.equal(combined.generatedAt,old);
 assert.deepEqual(Object.keys(combined.services).sort(),['chat','decision','image']);
 assert.equal(combined.services.image.unitPriceUsd,.02);
 assert.equal(combined.services.decision.pricing.outputUsdPerMillion,0);
 assert.deepEqual(combined.unavailable,{missing:'No native supply',video:'No native supply'});
 assert.deepEqual(Object.keys(text.services),['chat']);
});
test('rejects duplicate token/unit service names rather than silently replacing the advertised tariff',()=>{
 assert.throws(()=>mergeContentQuotes({generatedAt:stamp,services:{same:{}},unavailable:{}},{generatedAt:stamp,services:{same:{}},unavailable:{}}),/duplicate|collision/i);
});
test('invalid quote timestamps fail closed and cannot make mixed evidence look fresh',()=>{
 assert.throws(()=>mergeContentQuotes({generatedAt:'invalid',services:{},unavailable:{}},{generatedAt:stamp,services:{},unavailable:{}}),/timestamp|generated/i);
});

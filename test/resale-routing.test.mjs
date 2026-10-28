import test from 'node:test';
import assert from 'node:assert/strict';
import {createGateway} from '../lib/gateway.mjs';

test('resale blocks AntSeed loops, forces price objective and minimum discount, journals actual buyer charge',async t=>{
 let captured;const events=[];
 const settings={surplusBaseUrl:'https://api.surplusintelligence.ai/v1',models:['m'],maxTokens:10,maxInputBytes:4096,maxConcurrent:1,quoteMaxAgeMs:60000,lossTest:false};
 const q={generatedAt:new Date().toISOString(),services:{m:{provider:'groq',upstreamModel:'m',pricing:{inputUsdPerMillion:1,outputUsdPerMillion:1,cachedInputUsdPerMillion:1},upstreamPricing:{inputUsdPerMillion:.5,outputUsdPerMillion:.5,cachedInputUsdPerMillion:.5},maxPricePer1m:.5,minDiscountPct:20}}};
 const server=createGateway({settings,apiKey:'inf_test',localToken:'local',getQuotes:()=>q,fetchImpl:async(url,init)=>{captured=init;return Response.json({choices:[{message:{role:'assistant',content:'ok'}}],usage:{prompt_tokens:4,completion_tokens:2,buyer_cost_micro:3}},{headers:{'x-request-id':'request-upstream','x-si-provider-family':'groq'}});},onEvent:e=>events.push(e)});
 await new Promise(r=>server.listen(0,r));t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 const r=await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`,{method:'POST',headers:{authorization:'Bearer local','content-type':'application/json'},body:JSON.stringify({model:'m',messages:[{role:'user',content:'hi'}],providers_blocked:[],si_route:{objective:'latency'},provider:'antseed'})});
 assert.equal(r.status,200);await r.json();
 const sent=JSON.parse(captured.body);
 assert.deepEqual(sent.providers_blocked,['antseed']);assert.deepEqual(sent.si_route,{objective:'price_without_cache',cache:false});
 assert.equal(captured.headers['x-min-discount'],'20');
 assert.equal(events[0].usage.buyer_cost_micro,3);assert.equal(events[0].upstreamRequestId,'request-upstream');
});

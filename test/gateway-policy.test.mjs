import test from 'node:test';
import assert from 'node:assert/strict';
import {createGateway} from '../lib/gateway.mjs';
async function fixture(t,changes={}){
 let called=0,url,payload;
 const pricing={inputUsdPerMillion:1,outputUsdPerMillion:1,cachedInputUsdPerMillion:1};
 const quote={upstreamModel:'m',provider:'api.groq.com',pricing,upstreamPricing:pricing,maxPricePer1m:1,...changes};
 const settings={surplusBaseUrl:'https://api.surplusintelligence.ai/v1',models:['m'],maxTokens:10,maxInputBytes:4096,maxConcurrent:1,quoteMaxAgeMs:60000,lossTest:false};
 const server=createGateway({settings,localToken:'local',apiKey:'fixture',getQuotes:()=>({generatedAt:new Date().toISOString(),services:{m:quote}}),fetchImpl:async(u,init)=>{called++;url=String(u);payload=JSON.parse(init.body);return Response.json({choices:[{message:{role:'assistant',content:'ok'}}]});}});
 await new Promise(r=>server.listen(0,r));t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 const request=(stream=false)=>fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`,{method:'POST',headers:{authorization:'Bearer local','content-type':'application/json'},body:JSON.stringify({model:'m',messages:[],...(stream?{stream:true,stream_options:{include_usage:false}}:{})})});
 return {request,called:()=>called,url:()=>url,payload:()=>payload};
}
test('minimum discount uses unconditional URL floor rather than feature-gated header alone',async t=>{
 const f=await fixture(t,{minDiscountPct:20});const r=await f.request();assert.equal(r.status,200);await r.json();
 assert.equal(f.url(),'https://api.surplusintelligence.ai/min20/v1/chat/completions');
});
test('fresh quote cannot outlive its explicitly expired pricing consent',async t=>{
 const f=await fixture(t,{policyExpiresAt:new Date(Date.now()-1).toISOString()});const r=await f.request();assert.equal(r.status,503);assert.equal(f.called(),0);
});
test('streaming forces upstream usage reporting even when the buyer disables it',async t=>{
 const f=await fixture(t);const r=await f.request(true);await r.text();assert.deepEqual(f.payload().stream_options,{include_usage:true});
});

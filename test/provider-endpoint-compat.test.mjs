import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {fetchQuotes} from '../lib/pricing.mjs';
import {createGateway} from '../lib/gateway.mjs';
import {buildContentRequest} from '../lib/content-probe.mjs';

// These fixtures prove adapter preservation, not live model/endpoint support.
// OpenAI PDF Chat schema: https://developers.openai.com/api/docs/guides/file-inputs.md
// Vertex generic input_audio blobs (video/mp4):
// https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/migrate/openai/overview
const models=['pdf-chat','studio-chat','vertex-video-chat'];
const providerIds=['openai','google','google'];
const hosts=['api.openai.com','generativelanguage.googleapis.com','aiplatform.googleapis.com'];
const policy=()=>({version:1,allowEstimates:true,provider:'google',reviewedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),sourceRevision:'2207d607e747f487a4d83e60c7f24ad677a55a7f',feeCushionBps:1000,offerMultiplierCeiling:2,modelRoutes:Object.fromEntries(models.map((model,i)=>[model,{provider:providerIds[i],host:hosts[i]}]))});
const settings=()=>({surplusBaseUrl:'https://api.surplusintelligence.ai/v1',models,marginBps:500,safetyBps:500,pricingPolicy:policy(),maxTokens:1024,maxInputBytes:16384,maxConcurrent:1,quoteMaxAgeMs:60000});
const completion={choices:[{message:{role:'assistant',content:'fixture accepted'},finish_reason:'stop'}]};

test('reviewed endpoint quotes pin actual loopback Chat forwarding while nested PDF/video bytes survive unchanged',async t=>{
 const config=settings(),discovery=[],paid=[],events=[];
 const quotes=await fetchQuotes(config,'fixture_discovery_key_never_sent',async(url,init)=>{
  discovery.push({url,init});assert.equal(init.method,'GET');assert.equal(init.redirect,'error');
  assert.deepEqual([...new Headers(init.headers)],[['accept','application/json']]);
  if(url==='https://api.surplusintelligence.ai/v1/prices')return Response.json({updated_at:new Date().toISOString(),models:models.map((model,i)=>({model,providers:[{provider:providerIds[i],pricing:{input:1,output:2,cacheRead:.1}}]}))});
  const model=decodeURIComponent(new URL(url).pathname.split('/').at(-1)),i=models.indexOf(model);
  assert.notEqual(i,-1);assert.equal(new URL(url).origin,'https://api.surplusintelligence.ai');
  return Response.json({model,offers:[{provider_id:providerIds[i],seller_base_url:`https://${hosts[i]}/v1`,healthy:true,available:true,cap_remaining:null,effective_input_per_1m:10000,effective_output_per_1m:20000}]});
 });
 assert.deepEqual(Object.keys(quotes.services),models,'all configured endpoints must have independent reviewed quotes');
 assert.equal(discovery.length,4);
 const server=createGateway({settings:config,apiKey:'fixture_upstream_only',localToken:'fixture_loopback_only',getQuotes:()=>quotes,onEvent:event=>events.push(event),fetchImpl:async(url,init)=>{
  assert.equal(url,'https://api.surplusintelligence.ai/v1/chat/completions');assert.equal(init.method,'POST');assert.equal(init.redirect,'error');
  assert.deepEqual(init.headers,{authorization:'Bearer fixture_upstream_only','content-type':'application/json'});
  paid.push(JSON.parse(init.body));return Response.json(completion);
 }});
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const baseUrl=`http://127.0.0.1:${server.address().port}`;
 const pdf=Buffer.from('%PDF-1.7\nsynthetic byte-preservation fixture\n\u0000\u00ff\n%%EOF','utf8');
 const video=Buffer.from([0,0,0,20,102,116,121,112,109,112,52,50,0,255,128,13,10]);
 const requests=[
  buildContentRequest('file-input',models[0],{bytes:pdf,mime:'application/pdf'}),
  {path:'/v1/chat/completions',headers:{'content-type':'application/json'},body:JSON.stringify({model:models[1],messages:[{role:'system',content:'Preserve nested blocks.'},{role:'user',content:[{type:'text',text:'AI Studio text remains a Chat content array.'}]}],max_tokens:16})},
  buildContentRequest('video-input',models[2],{bytes:video,mime:'video/mp4'}),
 ];
 for(const [i,model] of models.entries()) {
  const request=requests[i],body=JSON.parse(request.body);
  assert.equal(request.path,'/v1/chat/completions');
  const original=JSON.stringify(body.messages);
  const response=await fetch(`${baseUrl}${request.path}`,{method:'POST',headers:{...request.headers,authorization:'Bearer fixture_loopback_only','x-api-key':'fixture_buyer_must_not_forward','x-si-provider':'evil.invalid'},body:JSON.stringify({...body,provider:'evil.invalid',max_price_per_1m:999,providers_blocked:[],si_route:{cache:true},extra_body:{provider:'evil.invalid'}})});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),completion);
  const forwarded=paid.at(-1),quote=quotes.services[model];
  assert.equal(forwarded.provider,hosts[i]);assert.equal(forwarded.model,model);assert.equal(forwarded.max_price_per_1m,quote.maxPricePer1m);
  assert.deepEqual(forwarded.providers_blocked,['antseed']);assert.deepEqual(forwarded.si_route,{objective:'price_without_cache',cache:false});assert.equal(forwarded.extra_body,undefined);
  assert.equal(JSON.stringify(forwarded.messages),original,'nested JSON bytes must not be translated, rewrapped or stripped');
  assert.deepEqual(forwarded,{...body,provider:hosts[i],max_price_per_1m:quote.maxPricePer1m,providers_blocked:['antseed'],si_route:{objective:'price_without_cache',cache:false}},'the full native builder envelope must survive except for reviewed routing fields');
  assert.equal(forwarded.max_tokens,body.max_tokens);
 }
 assert.equal(paid.length,3);
 assert.deepEqual(paid[0].messages[0].content[1],{type:'file',file:{filename:'fixture.pdf',file_data:`data:application/pdf;base64,${pdf.toString('base64')}`}});
 assert.deepEqual(Buffer.from(paid[0].messages[0].content[1].file.file_data.split(',')[1],'base64'),pdf);
 assert.deepEqual(paid[2],{
  model:models[2],
  messages:[{role:'user',content:[{type:'text',text:'Describe the predominant color and motion in this short video.'},{type:'input_audio',input_audio:{format:'video/mp4',data:video.toString('base64')}}]}],
  max_tokens:1024,temperature:0,
  provider:'aiplatform.googleapis.com',max_price_per_1m:quotes.services[models[2]].maxPricePer1m,
  providers_blocked:['antseed'],si_route:{objective:'price_without_cache',cache:false},
 },'the actual controlled video builder must forward the entire raw-base64 envelope with exact reviewed routing');
 const encoded=paid[2].messages[0].content[1].input_audio.data;
 assert.doesNotMatch(encoded,/^data:/,'this controlled Vertex probe must not send a data URI prefix');
 assert.match(encoded,/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
 assert.deepEqual(Buffer.from(encoded,'base64'),video);
 assert.equal(Buffer.from(encoded,'base64').toString('base64'),encoded);
 assert.equal(events.length,3);assert.doesNotMatch(JSON.stringify(events),/fixture_upstream_only|fixture_loopback_only|fixture_buyer|base64|Preserve nested/);
});

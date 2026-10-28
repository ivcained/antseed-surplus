import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4FoAAAAASUVORK5CYII=';
const image={model:'image-a',kind:'image',provider:'api.venice.ai',inputs:['text'],parameters:{size:'1024x1024'},estimatedCostUsd:0.02};
const edit={...image,model:'edit-a',inputs:['image','text']};
const decision={model:'jev-a',kind:'decision',provider:'api.typesafe.ai',inputs:['state'],parameters:{}};
const rates={inputUsdPerMillion:1,outputUsdPerMillion:2,cachedInputUsdPerMillion:1};
const settings={surplusBaseUrl:'https://api.surplusintelligence.ai/v1',models:['text-a','jev-a'],maxTokens:32,maxConcurrent:1,maxInputBytes:1024*1024,quoteMaxAgeMs:60000,requestTimeoutMs:1000,mediaConfig:{services:{'image-a':image,'edit-a':edit,'jev-a':decision}}};
function quotes(){return {generatedAt:new Date().toISOString(),services:Object.fromEntries([image,edit,decision,{model:'text-a',provider:'api.groq.com'}].map(m=>[m.model,{upstreamModel:m.model,provider:m.provider,kind:m.kind,media:m.kind?m:undefined,unitPriceUsd:0.03,estimatedUpstreamUsd:0.02,policyExpiresAt:new Date(Date.now()+60000).toISOString(),pricing:{...rates,...(m.kind==='decision'?{outputUsdPerMillion:0}:{})},upstreamPricing:{...rates,...(m.kind==='decision'?{outputUsdPerMillion:0}:{})},maxPricePer1m:3}]))};}
const native={model:'jev-a',answers:{ok:{type:'noul',noul:0.9}},usage:{input_tokens:4,output_tokens:0,buyer_cost_micro:2}};
const responseValue={id:'resp_1',object:'response',status:'completed',output:[{type:'message',content:[{type:'output_text',text:'ok'}]}],usage:{input_tokens:3,output_tokens:1,buyer_cost_micro:2}};
const messageValue={id:'msg_1',type:'message',role:'assistant',content:[{type:'text',text:'ok'}],usage:{input_tokens:3,output_tokens:1}};
async function fixture(t,options={}){
 const {createExtendedHandler}=await import('../lib/extended-gateway.mjs');const calls=[],events=[];
 const handler=createExtendedHandler({settings:{...settings,...options.settings},apiKey:'inf_extended_server_only',getQuotes:options.getQuotes??quotes,videoBridge:options.videoBridge,fetchImpl:async(...args)=>{calls.push(args);return options.fetchImpl?options.fetchImpl(...args):Response.json({created:1,data:[{b64_json:png}],usage:{buyer_cost_micro:20000}});},onEvent:event=>events.push(event)});
 const server=createServer(async(req,res)=>{if(!await handler(req,res)){res.writeHead(404);res.end();}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
 const base=`http://127.0.0.1:${server.address().port}`;
 return {base,calls,events,post:(path,body,headers={})=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer local-private','x-api-key':'local-private',...headers},body:JSON.stringify(body)})};
}
test('unknown paths are not consumed; generation pins model/provider and never forwards local credentials',async t=>{
 const f=await fixture(t);assert.equal((await fetch(f.base+'/unknown')).status,404);
 const r=await f.post('/v1/images/generations',{model:'image-a',prompt:'private image prompt',n:1,size:'1024x1024',provider:'evil',provider_base_url:'https://evil',providers_blocked:[],extra_body:{api_key:'private'}});
 assert.equal(r.status,200);assert.equal((await r.json()).data[0].b64_json,png);assert.equal(f.calls.length,1);
 const [url,init]=f.calls[0],payload=JSON.parse(init.body);assert.equal(url,'https://api.surplusintelligence.ai/v1/images/generations');assert.equal(init.redirect,'error');assert.deepEqual(Object.keys(init.headers).sort(),['authorization','content-type']);assert.equal(init.headers.authorization,'Bearer inf_extended_server_only');assert.equal(payload.provider,'api.venice.ai');assert.equal(payload.model,'image-a');assert.deepEqual(payload.providers_blocked,['antseed']);assert.equal(payload.extra_body,undefined);assert.equal(payload.provider_base_url,undefined);assert.doesNotMatch(JSON.stringify(f.events),/private image prompt|inf_extended|local-private/);
});
test('generation denies unpriced dimensions, edits, masks, counts, oversized prompts and hidden media aliases before dispatch',async t=>{
 const f=await fixture(t);for(const extra of [{n:2},{n:0},{size:'2048x2048'},{quality:'hd'},{width:4096},{prompt:'x'.repeat(2001)},{mask:'x'},{image_url:'https://example.com/a.png'},{images:['https://example.com/a.png']},{stream:true},{model:'edit-a'}]){const r=await f.post('/v1/images/generations',{model:'image-a',prompt:'hello',...extra});assert.ok(r.status>=400,JSON.stringify(extra));}assert.equal(f.calls.length,0);
});
test('fresh consented quotes and explicit configuration are required, without positive image token tariffs',async t=>{
 let q=quotes();for(const v of Object.values(q.services)){v.pricing=undefined;v.upstreamPricing=undefined;}const f=await fixture(t,{getQuotes:()=>q});assert.equal((await f.post('/v1/images/generations',{model:'image-a',prompt:'hello'})).status,200);
 for(const mutate of [q=>q.generatedAt=new Date(Date.now()-60001).toISOString(),q=>q.generatedAt=new Date(Date.now()+10000).toISOString(),q=>q.services['image-a'].policyExpiresAt=new Date(0).toISOString(),q=>q.services['image-a'].provider='evil.example',q=>q.services['image-a'].unitPriceUsd=0,q=>q.services['image-a'].estimatedUpstreamUsd=NaN,q=>q.services['image-a'].media.parameters.size='2048x2048']){q=structuredClone(quotes());mutate(q);assert.equal((await f.post('/v1/images/generations',{model:'image-a',prompt:'hello'})).status,503);}assert.equal(f.calls.length,1);
});

function reviewedMuse(){
 const entry={model:'muse-image-edit',kind:'image',provider:'venice',inputs:['text','image'],parameters:{n:1},estimatedCostUsd:0.02,pricingBasis:'operator-estimate'};
 const mediaConfig={version:1,reviewedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),feeCushionBps:1000,services:[entry]};
 const q={generatedAt:new Date().toISOString(),services:{'muse-image-edit':{upstreamModel:'muse-image-edit',provider:'api.venice.ai',kind:'image',media:structuredClone(entry),policyExpiresAt:mediaConfig.expiresAt,unitPriceUsd:0.03,estimatedUpstreamUsd:0.022,pricing:{inputUsdPerMillion:0,outputUsdPerMillion:0,cachedInputUsdPerMillion:0},upstreamPricing:{inputUsdPerMillion:0,outputUsdPerMillion:0,cachedInputUsdPerMillion:0},maxPricePer1m:0}}};
 return {settings:{mediaConfig},getQuotes:()=>q,q};
}
for(const format of ['JSON','multipart'])for(const count of [undefined,1])test(`reviewed Venice Muse ${format} edit omits wire n after quote overlay with caller n ${count??'absent'}`,async t=>{
 const options=reviewedMuse(),before=structuredClone(options.q),f=await fixture(t,options);
 const body={model:'muse-image-edit',prompt:'edit this',provider:'evil',...(count===undefined?{}:{n:count})};let result;
 if(format==='JSON')result=await f.post('/v1/images/edits',{...body,image_url:`data:image/png;base64,${png}`});
 else{
  const form=new FormData();for(const [key,value]of Object.entries(body))form.set(key,String(value));form.set('image',new Blob([Buffer.from(png,'base64')],{type:'image/png'}),'source.png');
  result=await fetch(f.base+'/v1/images/edits',{method:'POST',body:form});
 }
 assert.equal(result.status,200);assert.equal((await result.json()).data.length,1);assert.equal(f.calls.length,1);
 const [url,init]=f.calls[0];assert.equal(url,'https://api.surplusintelligence.ai/v1/images/edits');
 if(format==='JSON'){
  const payload=JSON.parse(init.body);assert.equal(Object.hasOwn(payload,'n'),false);assert.equal(payload.provider,'api.venice.ai');assert.equal(payload.model,'muse-image-edit');assert.deepEqual(payload.providers_blocked,['antseed']);assert.deepEqual(payload.input_images,[`data:image/png;base64,${png}`]);
 }else{
  assert.ok(init.body instanceof FormData);const serialized=await new Response(init.body).text();assert.doesNotMatch(serialized,/name="n"/);assert.equal(init.body.has('n'),false);assert.equal(init.body.get('provider'),'api.venice.ai');assert.equal(init.body.get('model'),'muse-image-edit');assert.equal(init.headers['content-type'],undefined);assert.deepEqual(JSON.parse(init.body.get('providers_blocked')),['antseed']);assert.deepEqual(Buffer.from(await init.body.get('image').arrayBuffer()),Buffer.from(png,'base64'));
 }
 assert.deepEqual(options.q,before);assert.deepEqual(options.q.services['muse-image-edit'].media.parameters,{n:1});assert.deepEqual(options.settings.mediaConfig.services[0].parameters,{n:1});assert.equal(f.events[0].usage.buyer_cost_micro,20000);
});
test('reviewed Muse edit still rejects non-one counts before dispatch in both input formats',async t=>{
 const f=await fixture(t,reviewedMuse());
 for(const n of [0,2,-1,1.5,'1',null,true]){
  const r=await f.post('/v1/images/edits',{model:'muse-image-edit',prompt:'edit',image_url:`data:image/png;base64,${png}`,n});assert.equal(r.status,400);assert.equal((await r.json()).error.code,'image_count_limit');
 }
 for(const n of ['0','2','-1','1.0','01','true','']){
  const form=new FormData();form.set('model','muse-image-edit');form.set('prompt','edit');form.set('n',n);form.set('image',new Blob([Buffer.from(png,'base64')],{type:'image/png'}),'source.png');
  const r=await fetch(f.base+'/v1/images/edits',{method:'POST',body:form});assert.equal(r.status,400);assert.equal((await r.json()).error.code,'image_count_limit');
 }assert.equal(f.calls.length,0);
});
test('reviewed Muse edit retains single-output response validation and exact consent bindings',async t=>{
 const options=reviewedMuse(),f=await fixture(t,{...options,fetchImpl:()=>Response.json({data:[{b64_json:png},{b64_json:png}]})}),body={model:'muse-image-edit',prompt:'edit',image_url:`data:image/png;base64,${png}`};
 const r=await f.post('/v1/images/edits',body);assert.equal(r.status,502);assert.equal((await r.json()).error.code,'upstream_invalid_response');assert.equal(f.calls.length,1);
 const valid=structuredClone(options.q);for(const mutate of [q=>q.services['muse-image-edit'].provider='venice',q=>q.services['muse-image-edit'].upstreamModel='other',q=>q.services['muse-image-edit'].media.parameters.n=2,q=>q.services['muse-image-edit'].policyExpiresAt=new Date(0).toISOString()]){
  Object.assign(options.q,structuredClone(valid));mutate(options.q);assert.equal((await f.post('/v1/images/edits',body)).status,503);
 }assert.equal(f.calls.length,1);
});
test('Muse model on another pinned provider retains n',async t=>{
 const options=reviewedMuse();options.settings.mediaConfig.services[0].provider='typesafe';options.q.services['muse-image-edit'].media.provider='typesafe';options.q.services['muse-image-edit'].provider='api.typesafe.ai';
 const f=await fixture(t,options);assert.equal((await f.post('/v1/images/edits',{model:'muse-image-edit',prompt:'edit',image_url:`data:image/png;base64,${png}`})).status,200);assert.equal(JSON.parse(f.calls[0][1].body).n,1);
});
test('JSON edits normalize image inputs with fixed pricing parameters, refusing unsafe URLs and masks',async t=>{
 const f=await fixture(t);const body={model:'edit-a',prompt:'edit',image_url:`data:image/png;base64,${png}`};
 assert.equal((await f.post('/v1/images/edits',body)).status,200);const payload=JSON.parse(f.calls[0][1].body);assert.deepEqual(payload.input_images,[body.image_url]);assert.equal(payload.size,'1024x1024');assert.equal(payload.n,1);
 for(const extra of [{mask:'bad'},{mask_url:'https://example.com/a.png'},{image_url:'http://example.com/a.png'},{image_url:'https://127.0.0.1/a.png'},{image_url:'https://169.254.169.254/a'},{image_url:'https://user:pass@example.com/a.png'},{image_url:'file:///private'},{image_url:'data:text/html;base64,PGgxPg=='},{image_url:'data:image/png;base64,aGVsbG8='},{image_url:undefined},{input_images:Array(9).fill(body.image_url)},{model:'image-a'}]){assert.ok((await f.post('/v1/images/edits',{...body,...extra})).status>=400,JSON.stringify(extra));}assert.equal(f.calls.length,1);
});
test('multipart edits preserve binary images, replace routing fields and reject malformed MIME/masks',async t=>{
 const f=await fixture(t);const make=(type='image/png',bytes=Buffer.from(png,'base64'))=>{const b=new FormData();b.set('model','edit-a');b.set('prompt','edit this');b.set('provider','evil');b.set('provider_base_url','https://evil');b.set('image',new Blob([bytes],{type}),'source.png');return b;};
 const result=await fetch(f.base+'/v1/images/edits',{method:'POST',body:make(),headers:{authorization:'Bearer local-private'}});assert.equal(result.status,200);
 const init=f.calls[0][1];assert.ok(init.body instanceof FormData);assert.equal(init.headers['content-type'],undefined);assert.equal(init.body.get('provider'),'api.venice.ai');assert.equal(init.body.get('provider_base_url'),null);assert.equal(init.body.get('model'),'edit-a');assert.equal(init.body.get('n'),'1');assert.deepEqual(Buffer.from(await init.body.get('image').arrayBuffer()),Buffer.from(png,'base64'));
 for(const b of [make('text/html'),make('image/png',Buffer.from('not png')),(()=>{const b=make();b.set('mask',new Blob(['bad']),'mask.png');return b;})(),(()=>{const b=make();b.append('model','image-a');return b;})()])assert.ok((await fetch(f.base+'/v1/images/edits',{method:'POST',body:b})).status>=400);assert.equal(f.calls.length,1);
});
test('image errors, empty artifacts, invalid encodings and credential URLs are sanitized with no retry',async t=>{
 let next;const f=await fixture(t,{fetchImpl:()=>next});
 for(const value of [{error:{message:'inf_private provider-secret'}},{data:[]},{data:[{b64_json:''}]},{data:[{b64_json:'not base64'}]},{data:[{url:'https://user:inf_private@example.com/a.png'}]},{data:[{url:'http://example.com/a.png'}]},{data:[{url:'https://example.com/a.png?api_key=inf_private'}]}]){next=Response.json(value);const r=await f.post('/v1/images/generations',{model:'image-a',prompt:'hello'});assert.equal(r.status,502);assert.doesNotMatch(await r.text(),/inf_private|provider-secret/);}
 next=new Response('inf_private provider-secret',{status:403,headers:{'x-api-key':'inf_private'}});const r=await f.post('/v1/images/generations',{model:'image-a',prompt:'hello'});assert.equal(r.status,502);assert.equal(r.headers.get('x-api-key'),null);assert.doesNotMatch(await r.text(),/inf_private|provider-secret/);assert.equal(f.calls.length,8);
});
test('native decisions preserve state/question map and zero-output usage without Chat coercion',async t=>{
 const f=await fixture(t,{fetchImpl:()=>Response.json(native)});const state={a:[1,'private state']},questions={ok:{type:'noul',instructions:'private question',criteria:{a:1}}};const r=await f.post('/v1/systemone',{model:'jev-a',state,questions,provider:{base_url:'https://evil'},max_tokens:8});assert.equal(r.status,200);assert.deepEqual(await r.json(),native);
 assert.equal(f.calls[0][0],'https://api.surplusintelligence.ai/v1/decisions');const body=JSON.parse(f.calls[0][1].body);assert.deepEqual(body.state,state);assert.deepEqual(body.questions,questions);assert.equal(body.provider,'api.typesafe.ai');assert.equal(body.max_tokens,8);assert.deepEqual(f.events[0].usage,native.usage);assert.doesNotMatch(JSON.stringify(f.events),/private state|private question/);
});
test('native decisions validate questions and all requested answers; zero token rates are only allowed for decision output',async t=>{
 let value=native,q=quotes();const f=await fixture(t,{getQuotes:()=>q,fetchImpl:()=>Response.json(value)});const body={model:'jev-a',state:'ping',questions:{ok:{type:'noul'}}};
 for(const extra of [{questions:[]},{questions:{}},{questions:{ok:{type:'unknown'}}},{state:undefined},{max_tokens:33},{stream:true}])assert.equal((await f.post('/v1/systemone',{...body,...extra})).status,400);assert.equal(f.calls.length,0);
 for(const answers of [{},{ok:{type:'noul',noul:'bad'}}]){value={answers};assert.equal((await f.post('/v1/systemone',body)).status,502);}
 q=quotes();q.services['jev-a'].upstreamPricing.inputUsdPerMillion=0;assert.equal((await f.post('/v1/systemone',body)).status,503);
});
test('Responses and Messages use distinct native schemas, bounded output tokens and fixed routes',async t=>{
 const f=await fixture(t,{fetchImpl:url=>Response.json(url.endsWith('/responses')?responseValue:messageValue)});
 const response=await f.post('/v1/responses',{model:'text-a',input:[{role:'user',content:[{type:'input_text',text:'private text'}]}],instructions:'be concise',provider:'evil',extra_body:{url:'https://evil'}});assert.equal(response.status,200);assert.deepEqual(await response.json(),responseValue);const rb=JSON.parse(f.calls[0][1].body);assert.equal(rb.max_output_tokens,32);assert.equal(rb.extra_body,undefined);assert.equal(rb.provider,'api.groq.com');assert.equal(rb.input[0].content[0].type,'input_text');
 const message=await f.post('/v1/messages',{model:'text-a',messages:[{role:'user',content:[{type:'text',text:'hi'}]}],system:'hello'});assert.equal(message.status,200);assert.deepEqual(await message.json(),messageValue);assert.equal(f.calls[1][0],'https://api.surplusintelligence.ai/anthropic/v1/messages');const mb=JSON.parse(f.calls[1][1].body);assert.equal(mb.max_tokens,32);assert.equal(mb.system,'hello');assert.equal(f.calls[1][1].headers['x-api-key'],undefined);
});
test('text wrappers reject stateful/paid hosted-tool extensions, schema confusion and invalid budgets',async t=>{
 const f=await fixture(t);for(const extra of [{previous_response_id:'resp_private'},{conversation:'conv'},{background:true},{max_output_tokens:33},{max_output_tokens:0},{max_tokens:33},{input:undefined},{tools:[{type:'web_search'}]},{stream:'yes'}])assert.ok((await f.post('/v1/responses',{model:'text-a',input:'hello',...extra})).status>=400,JSON.stringify(extra));
 for(const extra of [{messages:undefined},{max_tokens:33},{tools:[{type:'computer_20250124',name:'computer'}]}])assert.ok((await f.post('/v1/messages',{model:'text-a',messages:[{role:'user',content:'hi'}],...extra})).status>=400);assert.equal(f.calls.length,0);
});

test('Responses named SSE streams live, preserves fragmented UTF8 and completes without Chat DONE',async t=>{
 let controller;const upstream=new ReadableStream({start(c){controller=c;}});const f=await fixture(t,{fetchImpl:()=>new Response(upstream,{headers:{'content-type':'text/event-stream'}})});
 const pending=f.post('/v1/responses',{model:'text-a',input:'hello',stream:true});while(!f.calls.length)await new Promise(r=>setTimeout(r,2));
 const first='event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"こんにちは"}\r\n\r\n';const bytes=new TextEncoder().encode(first);for(let i=0;i<bytes.length;i+=3)controller.enqueue(bytes.slice(i,i+3));const result=await pending;assert.equal(result.status,200);const reader=result.body.getReader();const initial=await reader.read();assert.equal(new TextDecoder().decode(initial.value),first);
 const last=`event: response.completed\ndata: ${JSON.stringify({type:'response.completed',response:responseValue})}\n\n`;controller.enqueue(new TextEncoder().encode(last));controller.close();let rest='';for(;;){const {value,done}=await reader.read();if(done)break;rest+=new TextDecoder().decode(value);}assert.equal(rest,last);assert.deepEqual(f.events.at(-1).usage,responseValue.usage);assert.equal(f.events.at(-1).status,200);
});
test('Anthropic SSE preserves named events and merges only genuine start/delta usage',async t=>{
 const stream='event: message_start\ndata: {"type":"message_start","message":{"type":"message","usage":{"input_tokens":3,"output_tokens":0}}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":2,"buyer_cost_micro":3}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
 const f=await fixture(t,{fetchImpl:()=>new Response(stream,{headers:{'content-type':'text/event-stream'}})});const r=await f.post('/v1/messages',{model:'text-a',messages:[{role:'user',content:'hi'}],stream:true});assert.equal(r.status,200);assert.equal(await r.text(),stream);assert.deepEqual(f.events[0].usage,{input_tokens:3,output_tokens:2,buyer_cost_micro:3});
});
test('SSE explicit errors, failed completions, Chat DONE and incomplete named streams never report success',async t=>{
 let stream;const f=await fixture(t,{fetchImpl:()=>new Response(stream,{headers:{'content-type':'text/event-stream'}})});
 for(const bad of ['event: error\ndata: {"type":"error","error":{"message":"inf_private prompt-secret"}}\n\n','event: response.failed\ndata: {"type":"response.failed","response":{"error":{"message":"inf_private"}}}\n\n','data: [DONE]\n\n']){stream=bad;const r=await f.post('/v1/responses',{model:'text-a',input:'hi',stream:true});assert.equal(r.status,502);assert.doesNotMatch(await r.text(),/inf_private|prompt-secret/);}
 stream='event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"partial"}\n\n';const r=await f.post('/v1/responses',{model:'text-a',input:'hi',stream:true});const body=await r.text();assert.match(body,/partial/);assert.match(body,/upstream_stream_failed/);assert.equal(f.events.at(-1).status,502);
 stream='event: message_stop\ndata: {"type":"message_stop"}\n\n';assert.equal((await f.post('/v1/messages',{model:'text-a',messages:[{role:'user',content:'hi'}],stream:true})).status,502);
});
test('handler owns concurrency and a hard deadline even when injected fetch ignores abort',async t=>{
 let release,n=0;const block=new Promise(r=>release=r);const f=await fixture(t,{settings:{requestTimeoutMs:80},fetchImpl:()=>++n===1?block:Response.json({data:[{b64_json:png}]})});const first=f.post('/v1/images/generations',{model:'image-a',prompt:'hi'});while(!f.calls.length)await new Promise(r=>setTimeout(r,2));assert.equal((await f.post('/v1/images/generations',{model:'image-a',prompt:'hi'})).status,429);const result=await first;assert.equal(result.status,504);assert.equal(f.calls[0][1].signal.aborted,true);release(Response.json({data:[{b64_json:png}]}));assert.equal((await f.post('/v1/images/generations',{model:'image-a',prompt:'hi'})).status,200);
});
test('client cancellation aborts upstream and releases extended concurrency',async t=>{
 const f=await fixture(t,{fetchImpl:()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(': heartbeat\n\n'));},cancel(){}}),{headers:{'content-type':'text/event-stream'}})});const r=await f.post('/v1/responses',{model:'text-a',input:'hi',stream:true});const reader=r.body.getReader();await reader.read();await reader.cancel();for(let i=0;i<100&&!f.calls[0][1].signal.aborted;i++)await new Promise(r=>setTimeout(r,2));assert.equal(f.calls[0][1].signal.aborted,true);
});
test('fresh quote recheck prevents dispatch after consent changed during preflight',async t=>{
 let n=0;const f=await fixture(t,{getQuotes:()=>{const q=quotes();if(++n===2)q.generatedAt=new Date(0).toISOString();return q;}});assert.equal((await f.post('/v1/images/generations',{model:'image-a',prompt:'hi'})).status,503);assert.equal(f.calls.length,0);
});
test('bounded image response reader rejects more than 32 MiB and does not forward upstream headers',async t=>{
 const f=await fixture(t,{fetchImpl:()=>new Response(new ReadableStream({start(c){for(let i=0;i<33;i++)c.enqueue(new Uint8Array(1024*1024));c.close();}}),{headers:{'content-type':'application/json','x-api-key':'private'}})});const r=await f.post('/v1/images/generations',{model:'image-a',prompt:'hi'});assert.equal(r.status,502);assert.equal(r.headers.get('x-api-key'),null);
});
test('video endpoints delegate only trusted quote/service bindings and expose no SI job metadata',async t=>{
 const video={model:'video-a',kind:'video',provider:'api.venice.ai',inputs:['image'],parameters:{duration_seconds:5,resolution:'720p'},estimatedCostUsd:0.2};const q=quotes();q.services['video-a']={upstreamModel:'video-a',provider:video.provider,kind:'video',media:video,unitPriceUsd:0.3,estimatedUpstreamUsd:0.2,policyExpiresAt:new Date(Date.now()+60000).toISOString()};const calls=[];
 const f=await fixture(t,{settings:{mediaConfig:{services:{...settings.mediaConfig.services,'video-a':video}}},getQuotes:()=>q,videoBridge:{queue:async(body,quote,options)=>{calls.push({body,quote,options});return Response.json({queue_id:'ant_local_job'});},retrieve:async(id,model)=>{calls.push({id,model});return new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'video/mp4'}});}}});
 const r=await f.post('/api/v1/video/queue',{model:'video-a',prompt:'hi',image_url:`data:image/png;base64,${png}`,duration_seconds:5,resolution:'720p',provider:'evil'},{'x-surplus-request-id':'antseed-stable-1'});assert.equal(r.status,200);assert.deepEqual(await r.json(),{queue_id:'ant_local_job'});assert.equal(calls[0].quote.provider,'api.venice.ai');assert.equal(calls[0].body.provider,undefined);assert.equal(calls[0].body.duration,5);assert.deepEqual(calls[0].options,{requestId:'antseed-stable-1'});
 assert.equal((await f.post('/api/v1/video/retrieve',{queue_id:'ant_local_job'})).status,400);const retrieve=await f.post('/api/v1/video/retrieve',{queue_id:'ant_local_job'},{'x-antseed-service':'video-a'});assert.equal(retrieve.headers.get('content-type'),'video/mp4');assert.deepEqual(Buffer.from(await retrieve.arrayBuffer()),Buffer.from([1,2,3]));assert.deepEqual(calls[1],{id:'ant_local_job',model:'video-a'});assert.equal(f.calls.length,0);
});

test('actual media pricing uses family names inside config/media but canonical host in the routing quote',async t=>{
 const entry={...image,provider:'venice',parameters:{n:1,size:'1024x1024'}};const q=quotes();q.services['image-a'].media={...entry,parameters:{size:'1024x1024',n:1}};q.services['image-a'].maxPricePer1m=0;
 const f=await fixture(t,{settings:{mediaConfig:{services:[entry]}},getQuotes:()=>q});assert.equal((await f.post('/v1/images/generations',{model:'image-a',prompt:'hi'})).status,200);assert.equal(JSON.parse(f.calls[0][1].body).provider,'api.venice.ai');assert.equal(JSON.parse(f.calls[0][1].body).n,1);
});
test('native decisions preserve alpha finite doubles, boolean choices, extras and genuine absent usage',async t=>{
 const answer={answers:{p:{type:'noul',noul:1.0000000002},c:{type:'choice',choice:true,probabilities:{true:0.8,false:0.2},confidence:0.8},s:{type:'score',score:5,confidence:1}}};const f=await fixture(t,{fetchImpl:()=>Response.json(answer)});const r=await f.post('/v1/systemone',{model:'jev-a',state:[],questions:{p:{type:'noul'},c:{type:'choice'},s:{type:'score'}},session_id:'native-private-session',trace:{enabled:false},provider_order:['evil'],provider_url:'https://evil'});assert.equal(r.status,200);assert.deepEqual(await r.json(),answer);const payload=JSON.parse(f.calls[0][1].body);assert.equal(payload.session_id,'native-private-session');assert.deepEqual(payload.trace,{enabled:false});assert.equal(payload.provider_order,undefined);assert.equal(payload.provider_url,undefined);assert.equal(f.events[0].usage,undefined);
});
test('media ingress has separate default 12 MiB capacity and a configurable strict ceiling',async t=>{
 const f=await fixture(t,{settings:{maxInputBytes:4096}});const body={model:'image-a',prompt:'hi',provider_base_url:'x'.repeat(200000)};assert.equal((await f.post('/v1/images/generations',body)).status,200);
 const limited=await fixture(t,{settings:{mediaMaxInputBytes:8192}});assert.equal((await limited.post('/v1/images/generations',body)).status,413);assert.equal(limited.calls.length,0);
});
test('video retrieve returns pending JSON quickly, accepts only matching node-bound service selectors',async t=>{
 const video={model:'video-a',kind:'video',provider:'venice',inputs:['image'],parameters:{duration_seconds:5,resolution:'720p'}};const calls=[];const f=await fixture(t,{settings:{mediaConfig:{services:[video]}},videoBridge:{retrieve:async(id,model)=>{calls.push({id,model});return Response.json({status:'PROCESSING',average_execution_time:5});}}});
 const r=await f.post('/api/v1/video/retrieve',{queue_id:'job',model:'video-a',service:'video-a'},{'x-antseed-service':'video-a'});assert.equal(r.status,200);assert.deepEqual(await r.json(),{status:'PROCESSING',average_execution_time:5});assert.equal(calls.length,1);
 assert.equal((await f.post('/api/v1/video/retrieve',{queue_id:'job',model:'wrong'},{'x-antseed-service':'video-a'})).status,400);assert.equal(calls.length,1);
});
test('video duration aliases bind the reviewed variant and bridge receives only its native contract',async t=>{
 const video={model:'video-a',kind:'video',provider:'venice',inputs:['text','image'],parameters:{duration_seconds:5,resolution:'720p'},estimatedCostUsd:0.2};const q=quotes();q.services['video-a']={upstreamModel:'video-a',provider:'api.venice.ai',kind:'video',media:video,unitPriceUsd:0.3,estimatedUpstreamUsd:0.2,policyExpiresAt:new Date(Date.now()+60000).toISOString()};const calls=[];
 const f=await fixture(t,{settings:{mediaConfig:{services:[video]}},getQuotes:()=>q,videoBridge:{queue:async(body,quote,options)=>{assert.deepEqual(Object.keys(body).sort(),['duration','duration_seconds','image_url','model','prompt','resolution']);assert.equal(body.duration,5);calls.push({body,options});return Response.json({queue_id:'job'});}}});const body={model:'video-a',prompt:'hi',duration:'5s',image_url:`data:image/png;base64,${png}`};assert.equal((await f.post('/api/v1/video/queue',body,{'x-surplus-request-id':'trusted-id'})).status,200);
 for(const extra of [{duration:'auto'},{duration:'10s'},{duration_seconds:10},{audio:false},{aspect_ratio:'16:9'}])assert.equal((await f.post('/api/v1/video/queue',{...body,...extra},{'x-surplus-request-id':'trusted-id'})).status,400);assert.equal((await f.post('/api/v1/video/queue',body)).status,400);assert.equal(calls.length,1);
});
test('trusted video bridge local failures keep their status without leaking error bodies',async t=>{
 const video={model:'video-a',kind:'video',provider:'venice'};const f=await fixture(t,{settings:{mediaConfig:{services:[video]}},videoBridge:{retrieve:()=>Response.json({error:{message:'inf_private'}},{status:404})}});const r=await f.post('/api/v1/video/retrieve',{queue_id:'job'},{'x-antseed-service':'video-a'});assert.equal(r.status,404);assert.doesNotMatch(await r.text(),/inf_private/);
});
test('decision routing cannot drift from reviewed media identity or outlive consent',async t=>{
 let q;const f=await fixture(t,{getQuotes:()=>q,fetchImpl:()=>Response.json(native)});for(const mutate of [q=>q.services['jev-a'].provider='api.groq.com',q=>q.services['jev-a'].media={...decision,kind:'image'},q=>delete q.services['jev-a'].policyExpiresAt]){q=structuredClone(quotes());mutate(q);assert.equal((await f.post('/v1/systemone',{model:'jev-a',state:'ping',questions:{ok:{type:'noul'}}})).status,503);}assert.equal(f.calls.length,0);
});
test('signature-spoofed/truncated image files are not dispatched',async t=>{
 const f=await fixture(t);const bytes=Buffer.from(png,'base64');for(const corrupt of [bytes.subarray(0,24),Buffer.concat([Buffer.from([255,216,255]),Buffer.from('not a jpeg'),Buffer.from([255,217])])]){const data=`data:${corrupt[0]===255?'image/jpeg':'image/png'};base64,${corrupt.toString('base64')}`;assert.equal((await f.post('/v1/images/edits',{model:'edit-a',prompt:'edit',image_url:data})).status,400);}assert.equal(f.calls.length,0);
});
test('a failed MP4 stream is disconnected rather than appending an SSE error into video bytes',async t=>{
 const video={model:'video-a',kind:'video',provider:'venice'};let n=0;const f=await fixture(t,{settings:{mediaConfig:{services:[video]}},videoBridge:{retrieve:()=>new Response(new ReadableStream({pull(c){if(n++===0)c.enqueue(new Uint8Array([1,2,3]));else c.error(new Error('private'));}}),{headers:{'content-type':'video/mp4'}})}});await assert.rejects(async()=>{const r=await f.post('/api/v1/video/retrieve',{queue_id:'job'},{'x-antseed-service':'video-a'});await r.arrayBuffer();});
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const settings = {surplusBaseUrl:'https://api.surplusintelligence.ai/v1', models:['model-a'], maxTokens:64, maxInputBytes:4096, maxConcurrent:1, quoteMaxAgeMs:60000, lossTest:false};
function quotes() { return {generatedAt:new Date().toISOString(),services:{'model-a':{upstreamModel:'model-a',provider:'venice',pricing:{inputUsdPerMillion:2,outputUsdPerMillion:3,cachedInputUsdPerMillion:1},upstreamPricing:{inputUsdPerMillion:1,outputUsdPerMillion:2,cachedInputUsdPerMillion:0.5},maxPricePer1m:2.5}}}; }
const completion = {id:'reply-1',choices:[{message:{role:'assistant',content:'hello'},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5}};
async function fixture(t, options={}) {
  const {createGateway} = await import('../lib/gateway.mjs');
  const dir=await mkdtemp(join(tmpdir(),'gateway-test-'));
  const calls=[], events=[];
  const server=createGateway({settings:{...settings,stateDir:dir,...options.settings},apiKey:options.apiKey??'inf_test_server_only',localToken:options.localToken??'local-secret',getQuotes:options.getQuotes??quotes,fetchImpl:async(...args)=>{calls.push(args); return options.fetchImpl ? options.fetchImpl(...args) : Response.json(completion);},onEvent:event=>events.push(event)});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(async()=>{server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  return {server,dir,base,calls,events,post:(body={},headers={})=>fetch(base+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer local-secret','content-type':'application/json',...headers},body:JSON.stringify({model:'model-a',messages:[{role:'user',content:'private prompt'}],...body})})};
}

test('health is free; authentication and exact route are required',async t=>{
  const f=await fixture(t);
  assert.equal((await fetch(f.base+'/health')).status,200);
  assert.equal((await f.post({}, {authorization:'Bearer wrong'})).status,401);
  assert.equal((await fetch(f.base+'/v1/models',{headers:{authorization:'Bearer local-secret'}})).status,200);
  assert.equal((await fetch(f.base+'/https://evil.example')).status,404);
  assert.equal(f.calls.length,0);
});
test('forwards only allowed JSON and own headers, pins routing and output bound',async t=>{
  const f=await fixture(t);
  const r=await f.post({provider:'evil',max_price_per_1m:999,stream:false,web_search:true,extra_body:{api_key:'secret'},temperature:0.2,tools:[{type:'function',function:{name:'lookup',parameters:{type:'object'}}}]},{'x-si-provider':'evil','x-request-id':'caller-id','x-api-key':'caller-secret'});
  assert.equal(r.status,200);assert.deepEqual(await r.json(),completion);
  const [url,init]=f.calls[0], body=JSON.parse(init.body);
  assert.equal(String(url),'https://api.surplusintelligence.ai/v1/chat/completions');
  assert.equal(init.redirect,'error');
  assert.deepEqual(Object.keys(init.headers).sort(),['authorization','content-type']);
  assert.equal(init.headers.authorization,'Bearer inf_test_server_only');
  assert.deepEqual(Object.keys(body).sort(),['max_price_per_1m','max_tokens','messages','model','provider','providers_blocked','si_route','stream','temperature','tools']);
  assert.equal(body.provider,'venice');assert.equal(body.max_price_per_1m,2.5);assert.equal(body.max_tokens,64);
  assert.equal(f.events.length,1);assert.deepEqual(f.events[0].usage,completion.usage);
  assert.doesNotMatch(JSON.stringify(f.events),/private prompt|hello|inf_test|caller-secret/);
});
test('unlisted model, built-in tools, invalid token budgets and oversized body never spend',async t=>{
  const f=await fixture(t);
  for(const body of [{model:'missing'},{max_tokens:65},{max_completion_tokens:65},{max_tokens:-1},{tools:[{type:'web_search'}]},{messages:[{role:'user',content:'x'.repeat(5000)}]}]) assert.ok((await f.post(body)).status>=400);
  assert.equal(f.calls.length,0);
});
test('stale, future, missing, malformed or underbounded quotes fail closed',async t=>{
  let q=quotes();const f=await fixture(t,{getQuotes:()=>q});
  const bad=[()=>q.generatedAt=new Date(Date.now()-60001).toISOString(),()=>q.generatedAt=new Date(Date.now()+60000).toISOString(),()=>delete q.services['model-a'].pricing,()=>q.services['model-a'].upstreamPricing.outputUsdPerMillion=NaN,()=>q.services['model-a'].maxPricePer1m=0.1,()=>q.services['model-a'].pricing.inputUsdPerMillion=0.1,()=>q.services['model-a'].provider='https://evil',()=>q.services['model-a'].maxPricePer1m='Infinity'];
  for(const mutate of bad){q=quotes();mutate();assert.equal((await f.post()).status,503);}
  assert.equal(f.calls.length,0);
});
test('upstream HTTP and embedded errors are generic failures without body leaks',async t=>{
  let response=Response.json({error:{message:'inf_secret private provider body'}},{status:200});
  const f=await fixture(t,{fetchImpl:()=>response});
  for(const next of [response,Response.json({error:{message:'private provider body'}},{status:403}),new Response('not json',{status:200}),Response.json({choices:[]})]){response=next;const r=await f.post();assert.equal(r.status,502);assert.doesNotMatch(await r.text(),/inf_secret|private provider body|not json/);}
  assert.doesNotMatch(JSON.stringify(f.events),/inf_secret|private provider body/);
});
async function eventAfter(f,count=1) {
  for(let i=0;i<200 && f.events.length<count;i++) await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(f.events.length,count,'private completion event must not stall');
  return f.events.at(-1);
}
function assertPrivateFailure(event,status,code) {
  assert.deepEqual(Object.keys(event).sort(),['requestId','model','status',...(status===undefined?[]:['upstreamStatus']),...(code===undefined?[]:['upstreamErrorCode'])].sort());
  assert.equal(event.status,502);assert.equal(event.model,'model-a');
  assert.equal(event.upstreamStatus,status);assert.equal(event.upstreamErrorCode,code);
}
async function assertPublicFailure(response) {
  assert.equal(response.status,502);
  const body=await response.json();
  assert.deepEqual(body,{error:{code:'upstream_request_failed',message:'upstream_request_failed',request_id:response.headers.get('x-request-id')}});
}
test('private HTTP diagnostics allow only bounded status and explicit provider codes',async t=>{
  let response;const f=await fixture(t,{fetchImpl:()=>response});
  const cases=[[400,{code:'INVALID_ARGUMENT'},'INVALID_ARGUMENT'],[401,{status:'PERMISSION_DENIED'},'PERMISSION_DENIED'],[429,{code:429,status:'RESOURCE_EXHAUSTED'},'RESOURCE_EXHAUSTED'],[500,{code:'invalid_request_error'},'invalid_request_error'],[503,{code:'server_error'},'server_error']];
  for(const [status,error,code] of cases) {
    response=Response.json({error:{...error,message:'private prompt inf_secret https://private.example',stack:'private stack'},metadata:{token:'private token'}},{status});
    await assertPublicFailure(await f.post());
    assertPrivateFailure(await eventAfter(f,f.calls.length),status,code);
  }
  assert.equal(f.calls.length,cases.length,'diagnostics must never retry or dispatch separately');
  assert.doesNotMatch(JSON.stringify(f.events),/private prompt|inf_secret|private.example|private stack|private token/);
});
test('unknown, credential-shaped and numeric provider codes never enter private events',async t=>{
  let response;const f=await fixture(t,{fetchImpl:()=>response});
  const codes=['sk_syntheticSecretIdentifier','inf_test_server_only','local-secret','Bearer synthetic secret',123,-1,1e100,{nested:'INVALID_ARGUMENT'},['INVALID_ARGUMENT'],null];
  for(const code of codes) {
    response=Response.json({error:{code,status:code,message:'private prompt synthetic secret'}},{status:400});
    await assertPublicFailure(await f.post());assertPrivateFailure(await eventAfter(f,f.calls.length),400);
  }
  assert.equal(f.calls.length,codes.length);
});
test('private diagnostics skip malformed, oversized and invalid UTF-8 bodies',async t=>{
  let response;const f=await fixture(t,{fetchImpl:()=>response});
  const valid=JSON.stringify({error:{code:'INVALID_ARGUMENT'}});
  const bodies=[['not json',undefined],[valid+' '.repeat(16384-valid.length),'INVALID_ARGUMENT'],[valid+' '.repeat(16385-valid.length),undefined],[new Uint8Array([...new TextEncoder().encode(valid),0xff]),undefined],['{"error":{"code":"INVALID_ARGUMENT"}',undefined]];
  for(const [body,code] of bodies) {
    response=new Response(body,{status:400});await assertPublicFailure(await f.post());
    assertPrivateFailure(await eventAfter(f,f.calls.length),400,code);
  }
});
test('oversized diagnostic streams cancel before reading the remaining body',async t=>{
  let cancelled=false,pulls=0;
  const body=new ReadableStream({pull(controller){pulls++;controller.enqueue(new TextEncoder().encode('x'.repeat(16385)));},cancel(){cancelled=true;}},{highWaterMark:0});
  const f=await fixture(t,{fetchImpl:()=>new Response(body,{status:429})});
  await assertPublicFailure(await f.post());assertPrivateFailure(await eventAfter(f),429);
  assert.equal(cancelled,true);assert.equal(body.locked,false);assert.equal(pulls,1);assert.equal(f.calls.length,1);
});
test('diagnostic work is bounded even when an upstream emits empty chunks',async t=>{
  let pulls=0,cancelled=false;
  const body=new ReadableStream({pull(controller){if(++pulls<=300)controller.enqueue(new Uint8Array());else {controller.enqueue(new TextEncoder().encode('{"error":{"code":"INVALID_ARGUMENT"}}'));controller.close();}},cancel(){cancelled=true;}},{highWaterMark:0});
  const f=await fixture(t,{fetchImpl:()=>new Response(body,{status:400})});
  await assertPublicFailure(await f.post());assertPrivateFailure(await eventAfter(f),400);
  assert.ok(pulls<=256);assert.equal(cancelled,true);assert.equal(body.locked,false);
});
function busyWait(ms) {
  const until=performance.now()+ms;
  while(performance.now()<until) {/* Reproduce synchronous upstream pull work. */}
}
function busyDiagnosticStream() {
  const state={pulls:0,cancelled:false};
  state.body=new ReadableStream({
    pull(controller) {
      state.pulls++;busyWait(2);
      if(state.pulls<=80)controller.enqueue(new Uint8Array());
      else {controller.enqueue(new TextEncoder().encode('{"error":{"code":"INVALID_ARGUMENT"}}'));controller.close();}
    },
    cancel(){state.cancelled=true;}
  },{highWaterMark:0});
  return state;
}
test('monotonic diagnostic budget stops immediately resolved empty reads before accepting late JSON',async t=>{
  const stream=busyDiagnosticStream();let endedBeforeRead=false,start,elapsed;
  const f=await fixture(t,{settings:{requestTimeoutMs:1000},fetchImpl:()=>{start=performance.now();return new Response(stream.body,{status:400});}});
  f.server.on('request',(_req,res)=>{const originalEnd=res.end;res.end=function(...args){const result=originalEnd.apply(this,args);endedBeforeRead=res.writableEnded && stream.pulls===0;return result;};});
  await assertPublicFailure(await f.post());assertPrivateFailure(await eventAfter(f),400);
  elapsed=performance.now()-start;t.diagnostic(`diagnostic elapsed=${elapsed.toFixed(1)}ms pulls=${stream.pulls}`);
  assert.ok(stream.pulls<=25,'the 50ms elapsed budget must stop 2ms synchronous pulls before accepting late JSON');
  assert.equal(endedBeforeRead,true);assert.equal(stream.cancelled,true);assert.equal(stream.body.locked,false);assert.equal(f.calls.length,1);
});
test('original request deadline bounds immediately resolved diagnostic reads below the diagnostic budget',async t=>{
  const stream=busyDiagnosticStream();let start;
  const f=await fixture(t,{settings:{requestTimeoutMs:20},fetchImpl:()=>{start=performance.now();return new Response(stream.body,{status:401});}});
  await assertPublicFailure(await f.post());assertPrivateFailure(await eventAfter(f),401);
  t.diagnostic(`request elapsed=${(performance.now()-start).toFixed(1)}ms pulls=${stream.pulls}`);
  assert.ok(stream.pulls<=10,'the original 20ms deadline must win over the 50ms diagnostic budget even if abort timers are starved');
  assert.equal(stream.cancelled,true);assert.equal(stream.body.locked,false);assert.equal(f.calls.length,1);
});
test('diagnostics cannot restart an original request deadline already consumed by synchronous fetch work',async t=>{
  const stream=busyDiagnosticStream();
  const f=await fixture(t,{settings:{requestTimeoutMs:20},fetchImpl:()=>{busyWait(30);return new Response(stream.body,{status:403});}});
  await assertPublicFailure(await f.post());assertPrivateFailure(await eventAfter(f),403);
  assert.equal(stream.pulls,0,'an expired original deadline must skip diagnostic reads even before its timer fires');
  assert.equal(stream.cancelled,true);assert.equal(stream.body.locked,false);assert.equal(f.calls.length,1);
});
test('diagnostic read failures and absent bodies cannot change public failures',async t=>{
  let response;const f=await fixture(t,{fetchImpl:()=>response});
  for(const body of [null,new ReadableStream({start(controller){controller.error(new Error('private prompt inf_secret'));}})]) {
    response=new Response(body,{status:503});await assertPublicFailure(await f.post());assertPrivateFailure(await eventAfter(f,f.calls.length),503);
  }
});
test('allowlisted provider codes that contain configured credentials are still excluded',async t=>{
  for(const secret of ['INVALID_ARGUMENT','ARGUMENT']) {
    const f=await fixture(t,{apiKey:secret,localToken:'PERMISSION_DENIED',fetchImpl:()=>Response.json({error:{code:'INVALID_ARGUMENT',status:'PERMISSION_DENIED'}},{status:400})});
    await assertPublicFailure(await f.post({}, {authorization:'Bearer PERMISSION_DENIED'}));assertPrivateFailure(await eventAfter(f),400);
  }
});
test('stalled diagnostic reads and cancellation cannot delay the public failure or private cleanup',{timeout:1500},async t=>{
  let cancelled=false;
  const body=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"error":{"code":"INVALID_ARGUMENT"}}'));},cancel(){cancelled=true;return new Promise(()=>{});}});
  const f=await fixture(t,{fetchImpl:()=>new Response(body,{status:500})});
  await assertPublicFailure(await f.post());assertPrivateFailure(await eventAfter(f),500);
  assert.equal(cancelled,true);assert.equal(body.locked,false);assert.equal(f.calls.length,1);
});
test('request deadline cancels stalled diagnostics without replacing the already-known HTTP failure',async t=>{
  let cancelled=false,signal;
  const body=new ReadableStream({cancel(){cancelled=true;}});
  const f=await fixture(t,{settings:{requestTimeoutMs:20},fetchImpl:(_url,init)=>{signal=init.signal;return new Response(body,{status:401});}});
  await assertPublicFailure(await f.post());assertPrivateFailure(await eventAfter(f),401);
  assert.equal(signal.aborted,true);assert.equal(cancelled,true);assert.equal(body.locked,false);assert.equal(f.calls.length,1);
});
test('credential-bearing request IDs are excluded on both successful and failed responses',async t=>{
  let response;const f=await fixture(t,{fetchImpl:()=>response});
  for(const status of [200,400]) for(const id of ['inf_test_server_only','prefix_inf_test_server_only_suffix','local-secret','prefix_local-secret_suffix']) {
    response=Response.json(status===200?completion:{error:{code:'INVALID_ARGUMENT'}},{status,headers:{'x-request-id':id}});
    const result=await f.post();await result.text();
    assert.equal(result.status,status===200?200:502);assert.equal((await eventAfter(f,f.calls.length)).upstreamRequestId,undefined);
  }
  assert.doesNotMatch(JSON.stringify(f.events),/inf_test_server_only|local-secret/);
});
test('safe upstream request IDs stay private and unknown HTTP statuses are omitted',async t=>{
  let response=Response.json({error:{code:'INVALID_ARGUMENT'}},{status:400,headers:{'x-request-id':'safe_request-42'}});
  const f=await fixture(t,{fetchImpl:()=>response});
  const result=await f.post();await assertPublicFailure(result);
  assert.equal(result.headers.get('x-request-id')==='safe_request-42',false);
  assert.equal((await eventAfter(f)).upstreamRequestId,'safe_request-42');
  for(const status of ['400',NaN,Infinity,600,-1,400.5]) {
    response={ok:false,status,headers:new Headers(),body:Response.json({error:{code:'INVALID_ARGUMENT'}}).body};
    await assertPublicFailure(await f.post());assertPrivateFailure(await eventAfter(f,f.calls.length),undefined,'INVALID_ARGUMENT');
  }
});
test('concurrency stays reserved until completion',async t=>{
  let release;const pending=new Promise(resolve=>release=resolve);
  const f=await fixture(t,{fetchImpl:async()=>{await pending;return Response.json(completion);}});
  const first=f.post();while(!f.calls.length) await new Promise(r=>setTimeout(r,5));
  assert.equal((await f.post()).status,429);release();assert.equal((await first).status,200);assert.equal(f.calls.length,1);
});
test('SSE streams live without whole-response buffering and preserves DONE plus usage',async t=>{
  let controller;const upstream=new ReadableStream({start(c){controller=c;}});
  const f=await fixture(t,{fetchImpl:()=>new Response(upstream,{headers:{'content-type':'text/event-stream'}})});
  const pending=f.post({stream:true});while(!controller || !f.calls.length) await new Promise(r=>setTimeout(r,5));
  const first='data: {"choices":[{"delta":{"content":"hello"}}]}\n\n';controller.enqueue(new TextEncoder().encode(first));
  const response=await pending;assert.equal(response.status,200);const reader=response.body.getReader();
  const chunk=await reader.read();assert.equal(new TextDecoder().decode(chunk.value),first);
  const last='data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\ndata: [DONE]\n\n';controller.enqueue(new TextEncoder().encode(last));controller.close();
  let rest='';for(;;){const {value,done}=await reader.read();if(done)break;rest+=new TextDecoder().decode(value);}assert.equal(rest,last);
  assert.deepEqual(f.events[0].usage,completion.usage);
});
test('client cancellation aborts the upstream request',async t=>{
  let signal;const f=await fixture(t,{fetchImpl:(_url,init)=>{signal=init.signal;return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(': ping\n\n'));},cancel(){}}),{headers:{'content-type':'text/event-stream'}});}});
  const r=await f.post({stream:true});const reader=r.body.getReader();await reader.read();await reader.cancel();
  for(let i=0;i<100&&!signal.aborted;i++)await new Promise(r=>setTimeout(r,5));assert.equal(signal.aborted,true);
});
test('listener refuses wildcard bind and defaults to loopback',async t=>{
  const {createGateway}=await import('../lib/gateway.mjs');
  const make=()=>createGateway({settings,apiKey:'inf_test',localToken:'token',getQuotes:quotes,fetchImpl:()=>{throw new Error('No live inference');}});
  const server=make();assert.throws(()=>server.listen(0,'0.0.0.0'),/127.0.0.1/);
  await new Promise(resolve=>server.listen(0,resolve));assert.equal(server.address().address,'127.0.0.1');t.after(()=>server.close());
  assert.throws(()=>createGateway({settings:{...settings,surplusBaseUrl:'https://evil.example/v1'},apiKey:'inf_test',localToken:'token',getQuotes:quotes}),/Untrusted/);
});
test('split SSE frames preserve UTF-8, CRLF, usage and DONE',async t=>{
  const text='data: {"choices":[{"delta":{"content":"こんにちは"}}]}\r\n\r\ndata: {"choices":[],"usage":{"total_tokens":5}}\r\n\r\ndata: [DONE]\r\n\r\n';
  const bytes=new TextEncoder().encode(text);
  const f=await fixture(t,{fetchImpl:()=>new Response(new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=3)c.enqueue(bytes.slice(i,i+3));c.close();}}),{headers:{'content-type':'text/event-stream'}})});
  const r=await f.post({stream:true});assert.equal(r.status,200);assert.equal(await r.text(),text);assert.equal(f.events[0].usage.total_tokens,5);
});
test('SSE embedded errors are sanitized; incomplete streams never claim success',async t=>{
  let stream='data: {"error":{"message":"private provider body inf_secret"}}\n\n';
  const f=await fixture(t,{fetchImpl:()=>new Response(stream,{headers:{'content-type':'text/event-stream'}})});
  const r=await f.post({stream:true});assert.equal(r.status,502);assert.doesNotMatch(await r.text(),/private provider body|inf_secret/);
  stream='data: {"choices":[{"delta":{"content":"hello"}}]}\n\n';
  const partial=await f.post({stream:true});const text=await partial.text();assert.match(text,/hello/);assert.match(text,/upstream_stream_failed/);assert.equal(f.events.at(-1).status,502);
});
test('rechecks quote freshness after awaited preflight before dispatch',async t=>{
  let n=0;const f=await fixture(t,{getQuotes:()=>{const q=quotes();if(++n===2)q.generatedAt=new Date(Date.now()-60001).toISOString();return q;}});
  assert.equal((await f.post()).status,503);assert.equal(f.calls.length,0);
});
test('bounded loss mode cannot extend its persisted expiry or limit',async t=>{
  const until=Date.now()+60000;
  const f=await fixture(t,{settings:{lossTest:true,lossUntil:until,lossMaxRequests:2}});assert.equal((await f.post()).status,200);
  const state=JSON.parse(await readFile(join(f.dir,'loss-budget.json'),'utf8'));state.until--;await writeFile(join(f.dir,'loss-budget.json'),JSON.stringify(state));
  assert.equal((await f.post()).status,503);assert.equal(f.calls.length,1);
});
test('loss-test count is durable across gateway restarts and refuses expiry/corruption',async t=>{
  const until=Date.now()+60000;
  const f=await fixture(t,{settings:{lossTest:true,lossUntil:until,lossMaxRequests:1},getQuotes:()=>{const q=quotes();q.services['model-a'].pricing.outputUsdPerMillion=0.1;return q;}});
  assert.equal((await f.post()).status,200);
  const budget=JSON.parse(await readFile(join(f.dir,'loss-budget.json'),'utf8'));assert.equal(budget.used,1);
  const {createGateway}=await import('../lib/gateway.mjs');let calls=0;
  const second=createGateway({settings:{...settings,stateDir:f.dir,lossTest:true,lossUntil:until,lossMaxRequests:1},apiKey:'inf_test',localToken:'local-secret',getQuotes:quotes,fetchImpl:()=>{calls++;return Response.json(completion);}});
  await new Promise(r=>second.listen(0,'127.0.0.1',r));t.after(()=>{second.closeAllConnections();second.close();});
  const request=()=>fetch(`http://127.0.0.1:${second.address().port}/v1/chat/completions`,{method:'POST',headers:{authorization:'Bearer local-secret','content-type':'application/json'},body:JSON.stringify({model:'model-a',messages:[]})});
  assert.equal((await request()).status,503);assert.equal(calls,0);
  await writeFile(join(f.dir,'loss-budget.json'),'broken');assert.equal((await request()).status,503);
  const expired=await fixture(t,{settings:{lossTest:true,lossUntil:Date.now()-1,lossMaxRequests:1}});assert.equal((await expired.post()).status,503);assert.equal(expired.calls.length,0);
});

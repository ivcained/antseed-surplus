import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';

// The first RED run deliberately has no implementation module yet.
const {waitForProbeReadiness}=await import('../lib/probe-readiness.mjs').catch(error=>{
 if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;return {};
});
const peer='a'.repeat(40),model='reviewed-exact-20261029',baseUrl='http://127.0.0.1:8378';
const protocolFor=kind=>({image:'openai-images',edit:'openai-images',video:'venice-video',decision:'typesafe-systemone',responses:'openai-responses',messages:'anthropic-messages'}[kind]??'openai-chat-completions');
const price={inputUsdPerMillion:2,outputUsdPerMillion:12,cachedInputUsdPerMillion:2};
const serviceFor=kind=>({kind:['image','edit'].includes(kind)?'image':kind==='video'?'video':kind==='decision'?'decision':'text',pricing:price,unitPriceUsd:.03});
function catalog(kind='image'){
 const protocol=protocolFor(kind),inputs=['text',...(['edit','video','vision'].includes(kind)?['image']:kind==='audio-input'?['audio']:kind==='file-input'?['file']:kind==='video-input'?['video']:[])];
 return {ok:true,peers:[{peerId:peer,providers:['surplus'],providerPricing:{surplus:{services:{[model]:price}}},providerServiceApiProtocols:{surplus:{services:{[model]:[protocol]}}},providerServiceUnitBillingModels:{surplus:{services:{[model]:{[protocol]:{version:1,components:[{unit:kind==='video'?'video_generations':'output_images',priceUsd:.03}]}}}}},providerServiceCapabilities:{surplus:{services:{[model]:{inputs,outputs:[kind==='video'?'video':['image','edit'].includes(kind)?'image':'text']}}}}}]};
}
const json=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json',...headers}});
function scenario({kind='image',before=catalog(kind),after=before,connect={ok:true},onCall}={}){
 const calls=[];let gets=0;
 const fetchImpl=async(url,options)=>{
  calls.push({url,options});onCall?.(calls.at(-1));
  return new URL(url).pathname==='/_antseed/peers'?json(++gets===1?before:after):json(connect);
 };
 return {calls,options:{baseUrl,peer,model,kind,service:serviceFor(kind),fetchImpl,timeoutMs:2000,pollIntervalMs:2,requestTimeoutMs:1000,connectTimeoutMs:1000}};
}
function run(options){assert.equal(typeof waitForProbeReadiness,'function','bounded exact-peer readiness API is missing');return waitForProbeReadiness(options);}
const rejected=(promise,code)=>assert.rejects(promise,error=>{assert.equal(error.code,code);assert.equal(error.message,`Content probe readiness: ${code}`);assert.equal(error.cause,undefined);return true;});

for(const kind of ['image','edit','video','decision','vision','responses','messages','audio-input','file-input','video-input','text'])test(`healthy ${kind} preflight uses only exact peer catalog and eager transport`,async()=>{
 const {calls,options}=scenario({kind});
 assert.deepEqual(await run(options),{peer,provider:'surplus',model,protocol:protocolFor(kind),connected:true});
 assert.deepEqual(calls.map(c=>[new URL(c.url).pathname,c.options.method]),[['/_antseed/peers','GET'],['/_antseed/connect','POST'],['/_antseed/peers','GET']]);
 assert.equal(calls[1].options.body,JSON.stringify({peerId:peer}));
 for(const {options:o} of calls){assert.equal(o.redirect,'error');assert.equal(o.credentials,'omit');assert.ok(o.signal instanceof AbortSignal);assert.equal(o.headers.authorization,undefined);assert.equal(o.headers['x-antseed-service'],undefined);}
});

test('empty discovery polls until the exact peer appears without connecting a different peer',async()=>{
 const {calls,options}=scenario();let gets=0;
 options.fetchImpl=async(url,o)=>{calls.push({url,options:o});if(o.method==='POST')return json({ok:true});return json(++gets<3?{ok:true,peers:[{peerId:'b'.repeat(40)}]}:catalog());};
 await run(options);assert.equal(gets,4);assert.equal(calls.filter(c=>c.options.method==='POST').length,1);
});
test('empty discovery ends at the monotonic overall deadline between metadata polls',{timeout:1000},async t=>{
 // Advance time only at poll boundaries, not during native Response processing.
 t.mock.timers.enable({apis:['setTimeout']});
 const {calls,options}=scenario({before:{ok:true,peers:[]}}),controller=new AbortController();let tick=100;
 const readiness=run({...options,timeoutMs:15,pollIntervalMs:10,now:()=>tick,signal:controller.signal});readiness.catch(()=>{});
 try{
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,1);
  tick=110;t.mock.timers.tick(10);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,2);
  // The second poll has only five milliseconds left; it must not renew the budget.
  tick=115;t.mock.timers.tick(5);
  await rejected(readiness,'PEER_UNAVAILABLE');
  t.mock.timers.tick(options.requestTimeoutMs);await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls.map(c=>[new URL(c.url).pathname,c.options.method]),[['/_antseed/peers','GET'],['/_antseed/peers','GET']]);
  assert.ok(calls.every(c=>!c.options.signal.aborted),'completed metadata request timers must be cleared');
 }finally{controller.abort();await readiness.catch(()=>{});}
});
test('empty discovery crossing the overall deadline inside metadata fails closed',{timeout:1000},async t=>{
 // A different legitimate boundary: the native body read, not the next poll,
 // consumes the remaining budget. Keep its exact error distinct from polling.
 t.mock.timers.enable({apis:['setTimeout']});
 const {calls,options}=scenario(),controller=new AbortController();let tick=0,cancelled=0;
 const body=new ReadableStream({pull(c){tick=15;c.enqueue(new TextEncoder().encode(JSON.stringify({ok:true,peers:[]})));},cancel(){cancelled++;return new Promise(()=>{});}},{highWaterMark:0});
 const fetchImpl=async(url,o)=>{calls.push({url,options:o});return new Response(body);};
 t.after(()=>controller.abort());
 await rejected(run({...options,fetchImpl,timeoutMs:15,now:()=>tick,signal:controller.signal}),'DEADLINE_EXCEEDED');
 t.mock.timers.tick(options.requestTimeoutMs);await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(calls.map(c=>[new URL(c.url).pathname,c.options.method]),[['/_antseed/peers','GET']]);
 assert.equal(calls[0].options.signal.aborted,true);assert.equal(cancelled,1);assert.equal(body.locked,false);
});

const mutations={
 'missing surplus provider':p=>{p.providers=['openai'];},
 'provider case alias':p=>{p.providers=['Surplus'];},
 'missing exact model':p=>{p.providerServiceApiProtocols.surplus.services={[model+'-alias']:['openai-images']};},
 'wrong exact protocol':p=>{p.providerServiceApiProtocols.surplus.services[model]=['openai-chat-completions'];},
 'protocol only under other provider':p=>{p.providerServiceApiProtocols={openai:p.providerServiceApiProtocols.surplus};},
 'default protocols do not substitute':p=>{p.providerServiceApiProtocols.surplus={defaults:['openai-images'],services:{}};},
};
for(const [name,mutate]of Object.entries(mutations))test(`${name} is rejected before eager connection`,async()=>{
 const before=catalog();mutate(before.peers[0]);const {calls,options}=scenario({before});
 await rejected(run(options),'CATALOG_MISMATCH');assert.equal(calls.length,1);
});
const mediaMutations={
 'missing unit billing':p=>{delete p.providerServiceUnitBillingModels;},
 'wrong unit version':p=>{p.providerServiceUnitBillingModels.surplus.services[model]['openai-images'].version=2;},
 'missing unit version':p=>{delete p.providerServiceUnitBillingModels.surplus.services[model]['openai-images'].version;},
 'extra billing component':p=>{p.providerServiceUnitBillingModels.surplus.services[model]['openai-images'].components.push({unit:'input_tokens',priceUsd:1});},
 'wrong billing unit':p=>{p.providerServiceUnitBillingModels.surplus.services[model]['openai-images'].components[0].unit='video_generations';},
 'free billing price':p=>{p.providerServiceUnitBillingModels.surplus.services[model]['openai-images'].components[0].priceUsd=0;},
 'negative billing price':p=>{p.providerServiceUnitBillingModels.surplus.services[model]['openai-images'].components[0].priceUsd=-1;},
 'string billing price':p=>{p.providerServiceUnitBillingModels.surplus.services[model]['openai-images'].components[0].priceUsd='0.03';},
 'changed billing price':p=>{p.providerServiceUnitBillingModels.surplus.services[model]['openai-images'].components[0].priceUsd=.04;},
 'unit only for wrong protocol':p=>{p.providerServiceUnitBillingModels.surplus.services[model]={'other-protocol':{version:1,components:[{unit:'output_images',priceUsd:.03}]}};},
 'missing capabilities':p=>{delete p.providerServiceCapabilities;},
 'missing text input':p=>{p.providerServiceCapabilities.surplus.services[model].inputs=[];},
 'wrong output kind':p=>{p.providerServiceCapabilities.surplus.services[model].outputs=['text'];},
 'generation cannot accept edit model':p=>{p.providerServiceCapabilities.surplus.services[model].inputs.push('image');},
};
for(const [name,mutate]of Object.entries(mediaMutations))test(`media ${name} is rejected before connection`,async()=>{
 const before=catalog();mutate(before.peers[0]);const {calls,options}=scenario({before});await rejected(run(options),'CATALOG_MISMATCH');assert.equal(calls.length,1);
});
for(const kind of ['edit','video'])test(`${kind} requires image input on the exact provider service`,async()=>{
 const before=catalog(kind);before.peers[0].providerServiceCapabilities.surplus.services[model].inputs=['text'];
 await rejected(run(scenario({kind,before}).options),'CATALOG_MISMATCH');
});
for(const connect of [{ok:false,error:'SECRET credential https://private.example'},{ok:'true'},{},null])test(`HTTP 200 connect ${JSON.stringify(connect)} cannot authorize dispatch`,async()=>{
 const {calls,options}=scenario({connect});await rejected(run(options),'CONNECT_FAILED');assert.equal(calls.length,2);
});
test('post-connect metadata drift fails closed before dispatch',async()=>{
 const after=catalog();after.peers[0].providerServiceUnitBillingModels.surplus.services[model]['openai-images'].components[0].priceUsd=.04;
 const {calls,options}=scenario({after});await rejected(run(options),'CATALOG_MISMATCH');assert.equal(calls.length,3);
});
test('post-connect missing peer is not treated as successful discovery',async()=>{
 const {calls,options}=scenario({after:{ok:true,peers:[]}});await rejected(run(options),'CATALOG_MISMATCH');assert.equal(calls.length,3);
});
for(const before of [{ok:false,error:'SECRET'}, {}, {ok:true,peers:{}}, {ok:true,peers:[...catalog().peers,...catalog().peers]}])test('malformed or duplicate peer catalog fails closed',async()=>{
 await rejected(run(scenario({before}).options),'CATALOG_INVALID');
});
for(const base of ['http://localhost:8378','http://127.0.0.2:8378','https://127.0.0.1:8378','http://user:pass@127.0.0.1:8378','http://127.0.0.1:8378/path','http://127.0.0.1:8378/?query=1','http://127.0.0.1:8378/#hash'])test(`non-fixed loopback base ${base} is denied without fetch`,async()=>{
 const {calls,options}=scenario();options.baseUrl=base;await rejected(run(options),'INVALID_OPTIONS');assert.equal(calls.length,0);
});
test('invalid identifiers and unbounded timing are denied without fetch',async()=>{
 for(const overrides of [{peer:'A'.repeat(40)},{model:'bad model'},{kind:'unknown'},{timeoutMs:90001},{connectTimeoutMs:40001},{requestTimeoutMs:15001},{pollIntervalMs:0},{timeoutMs:NaN}]){
  const {calls,options}=scenario();await rejected(run({...options,...overrides}),'INVALID_OPTIONS');assert.equal(calls.length,0);
 }
});
test('HTTP errors and thrown fetch errors redact arbitrary endpoint details',async()=>{
 for(const fetchImpl of [async()=>json({error:'SECRET raw upstream'},502),async()=>{throw Error('SECRET raw token');},async()=>new Response('SECRET invalid JSON')]){
  await rejected(run({...scenario().options,fetchImpl}),'REQUEST_FAILED');
 }
});
test('declared oversized body is cancelled without parsing',async()=>{
 let cancelled=false;
 const fetchImpl=async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-length':String(1024*1024+1)}});
 await rejected(run({...scenario().options,fetchImpl}),'RESPONSE_TOO_LARGE');assert.equal(cancelled,true);
});
test('streamed oversized response is cancelled',async()=>{
 let cancelled=false;
 const fetchImpl=async()=>new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array(128*1024));},cancel(){cancelled=true;}}));
 await rejected(run({...scenario().options,fetchImpl}),'RESPONSE_TOO_LARGE');assert.equal(cancelled,true);
});
test('reader cleanup releases an oversized stream despite stalled cancellation',async()=>{
 let cancelled=0,calls=0;
 const body=new ReadableStream({pull(c){c.enqueue(new Uint8Array(1024*1024+1));},cancel(){cancelled++;return new Promise(()=>{});}},{highWaterMark:0});
 const fetchImpl=async()=>{calls++;return new Response(body);};
 await rejected(run({...scenario().options,fetchImpl}),'RESPONSE_TOO_LARGE');
 assert.equal(cancelled,1);assert.equal(calls,1);assert.equal(body.locked,false);
});
for(const [name,bytes]of [['invalid UTF-8',new Uint8Array([0xff])],['invalid JSON',new TextEncoder().encode('SECRET invalid JSON')]])test(`reader cleanup releases ${name} without exposing response details`,async()=>{
 const body=new ReadableStream({start(c){c.enqueue(bytes);c.close();}});let calls=0;
 const fetchImpl=async()=>{calls++;return new Response(body);};
 await rejected(run({...scenario().options,fetchImpl}),'REQUEST_FAILED');
 assert.equal(calls,1);assert.equal(body.locked,false);
});
test('reader cleanup releases an errored stream with a fixed safe failure',async()=>{
 const body=new ReadableStream({pull(c){c.error(Error('SECRET stream error'));}},{highWaterMark:0});let calls=0;
 const fetchImpl=async()=>{calls++;return new Response(body);};
 await rejected(run({...scenario().options,fetchImpl}),'REQUEST_FAILED');
 assert.equal(calls,1);assert.equal(body.locked,false);
});
for(const mode of ['request timeout','overall deadline','external abort'])for(const cancellation of ['stalled','throwing','rejecting'])test(`reader cleanup releases a stalled read on ${mode} with ${cancellation} cancellation`,{timeout:1000},async()=>{
 let cancelled=0,calls=0,requestSignal,tick=0;
 const controller=new AbortController();
 const body=new ReadableStream({pull(){if(mode==='overall deadline')tick=10;if(mode==='external abort')queueMicrotask(()=>controller.abort(Error('SECRET abort reason')));},cancel(){cancelled++;if(cancellation==='throwing')throw Error('SECRET cancel error');if(cancellation==='rejecting')return Promise.reject(Error('SECRET cancel rejection'));return new Promise(()=>{});}},{highWaterMark:0});
 const fetchImpl=async(_,o)=>{calls++;requestSignal=o.signal;return new Response(body);};
 const timing=mode==='overall deadline'?{timeoutMs:10,requestTimeoutMs:100,now:()=>tick}:{requestTimeoutMs:10};
 await rejected(run({...scenario().options,...timing,fetchImpl,signal:controller.signal}),mode==='external abort'?'ABORTED':mode==='overall deadline'?'DEADLINE_EXCEEDED':'REQUEST_TIMEOUT');
 assert.equal(cancelled,1);assert.equal(calls,1);assert.equal(requestSignal.aborted,true);assert.equal(body.locked,false);
});
for(const mode of ['request timeout','external abort'])test(`reader cleanup cancels a late fetch response after ${mode}`,async()=>{
 let resolveFetch,calls=0,cancelled=0;
 const controller=new AbortController(),body=new ReadableStream({cancel(){cancelled++;return new Promise(()=>{});}});
 const fetchImpl=async()=>{calls++;if(mode==='external abort')queueMicrotask(()=>controller.abort('SECRET'));return new Promise(resolve=>{resolveFetch=resolve;});};
 await rejected(run({...scenario().options,fetchImpl,signal:controller.signal,requestTimeoutMs:10}),mode==='external abort'?'ABORTED':'REQUEST_TIMEOUT');
 resolveFetch(new Response(body));await new Promise(resolve=>setImmediate(resolve));
 assert.equal(cancelled,1);assert.equal(calls,1);assert.equal(body.locked,false);
});
test('never-resolving fetch is bounded and its signal is aborted',async()=>{
 let requestSignal;
 const fetchImpl=async(_,o)=>{requestSignal=o.signal;return await new Promise(()=>{});};
 await rejected(run({...scenario().options,fetchImpl,requestTimeoutMs:10}),'REQUEST_TIMEOUT');assert.equal(requestSignal.aborted,true);
});
test('stalled response body is bounded and cancelled',async()=>{
 let cancelled=false,requestSignal;
 const fetchImpl=async(_,o)=>{requestSignal=o.signal;return new Response(new ReadableStream({cancel(){cancelled=true;}}));};
 await rejected(run({...scenario().options,fetchImpl,requestTimeoutMs:10}),'REQUEST_TIMEOUT');assert.equal(requestSignal.aborted,true);assert.equal(cancelled,true);
});
test('microtask-only body cannot starve the monotonic request deadline',async()=>{
 let cancelled=false,tick=0;
 const fetchImpl=async()=>new Response(new ReadableStream({pull(c){tick++;c.enqueue(new Uint8Array(0));},cancel(){cancelled=true;}}));
 await rejected(run({...scenario().options,fetchImpl,now:()=>tick,requestTimeoutMs:10}),'REQUEST_TIMEOUT');assert.equal(cancelled,true);assert.ok(tick<100);
});
test('connect gets its own larger bound rather than the metadata request bound',async()=>{
 const {options}=scenario();let connectSignal;
 options.requestTimeoutMs=5;options.connectTimeoutMs=35;
 const fetchImpl=async(url,o)=>{
  if(new URL(url).pathname==='/_antseed/peers')return json(catalog());
  connectSignal=o.signal;await new Promise(resolve=>setTimeout(resolve,12));return json({ok:true});
 };
 assert.equal((await run({...options,fetchImpl})).connected,true);assert.equal(connectSignal.aborted,false);
});
test('connect timeout is safe and aborts its own request',async()=>{
 const {options}=scenario();let connectSignal;
 const fetchImpl=async(_,o)=>{if(o.method==='GET')return json(catalog());connectSignal=o.signal;return await new Promise(()=>{});};
 await rejected(run({...options,fetchImpl,connectTimeoutMs:10}),'CONNECT_TIMEOUT');assert.equal(connectSignal.aborted,true);
});
test('overall deadline bounds connection even when the per-connect limit is larger',async()=>{
 let tick=0;
 const fetchImpl=async(_,o)=>{if(o.method==='GET')return json(catalog());tick=11;return json({ok:true});};
 await rejected(run({...scenario().options,fetchImpl,timeoutMs:10,now:()=>tick}),'DEADLINE_EXCEEDED');
});
test('external cancellation interrupts an active fetch without raw reasons',async()=>{
 const controller=new AbortController();let requestSignal;
 const fetchImpl=async(_,o)=>{requestSignal=o.signal;controller.abort(Error('SECRET abort reason'));return await new Promise(()=>{});};
 await rejected(run({...scenario().options,fetchImpl,signal:controller.signal}),'ABORTED');assert.equal(requestSignal.aborted,true);
});
test('already cancelled preflight performs no fetch',async()=>{
 const {calls,options}=scenario();await rejected(run({...options,signal:AbortSignal.abort('SECRET')}),'ABORTED');assert.equal(calls.length,0);
});
test('cancellation interrupts discovery polling',async()=>{
 const controller=new AbortController();let calls=0;
 const fetchImpl=async()=>{calls++;setTimeout(()=>controller.abort(),5);return json({ok:true,peers:[]});};
 await rejected(run({...scenario().options,fetchImpl,signal:controller.signal,pollIntervalMs:50}),'ABORTED');assert.equal(calls,1);
});

async function scriptHarness({execute=true,readinessFails=false}={}){
 const source=(await readFile(new URL('../scripts/content-probe.mjs',import.meta.url),'utf8')).replace(/^#!.*\n/,'').replace(/^import .*;\n/gm,'');
 const events=[],env={ANTSEED_WALLET_FILE:'seller',TEST_BUYER_WALLET_FILE:'buyer',PATH:'synthetic',TMPDIR:'synthetic'},child=new EventEmitter();
 Object.assign(child,{exitCode:null,signalCode:null,stdout:new EventEmitter(),stderr:new EventEmitter()});
 const proc=new EventEmitter();Object.assign(proc,{argv:['node','content-probe','--kind','image','--model',model,...(execute?['--execute']:[])],env,execPath:'synthetic-node'});
 const settings={stateDir:'synthetic-state',gatewayPort:8379};
 class Wallet{constructor(key){this.address='0x'+(key==='seller'?'a':'b').repeat(40);this.privateKey='0x'+key;}}
 const context={process:proc,console:{log(){},error(){}},Buffer,URL,AbortSignal,AbortController,setTimeout,clearTimeout,
  Wallet,randomUUID:()=> 'synthetic-run',join:(...p)=>p.join('/'),resolve:x=>x,
  mkdir:async()=>{},lstat:async()=>({isDirectory:()=>true,isSymbolicLink:()=>false,mode:0o700}),readFile:async()=> '{}',writeFile:async()=>{},open:async()=>({write:async()=>{},close:async()=>{}}),atomicJson:async()=>{},
  createServer:()=>({once(){},listen(_port,_host,cb){cb();},close(cb){cb();}}),
  parseContentArgs:()=>({kind:'image',model,execute}),loadEnvFile:()=>{events.push('env');},loadSettings:async()=>settings,redactError:String,probeBudget:()=>1,
  readPrivateJson:async key=>({private_key:key}),validateProbeQuote:()=>{events.push('quote');return serviceFor('image');},readProbeInput:async()=>undefined,buildContentRequest:()=>({body:'{}'}),
  prepareRuntime:async()=>({configPath:'synthetic-config',cliPath:'synthetic-cli',home:'synthetic-home'}),buildBuyerConfig:()=>({}),probeBudgetPreload:()=>{events.push('preload');return 'synthetic-preload';},
  spawn:()=>{events.push('spawn');queueMicrotask(()=>child.stdout.emit('data',Buffer.from('CONTENT_PROBE_BUDGET_GUARD_READY\nCONTENT_PROBE_DISPATCH_GUARD_READY\n')));return child;},
  fetch:async()=>{events.push('startup');return new Response('{}');},
  waitForProbeReadiness:async options=>{events.push('readiness');assert.equal(options.peer,peer);assert.equal(options.model,model);assert.equal(options.kind,'image');assert.deepEqual(options.service,serviceFor('image'));assert.ok(options.signal);if(readinessFails)throw Error('synthetic refusal');return {connected:true};},
  executeContentRequest:async()=>{events.push('dispatch');return {usage:null};},stopBuyer:async()=>{events.push('stop');}
 };
 await vm.runInNewContext(`(async()=>{${source}\n})()`,context);return {events,proc};
}
test('script keeps startup/guards then preflight then fresh consent then one dispatch',async()=>{
 const {events,proc}=await scriptHarness();assert.deepEqual(events,['env','quote','preload','spawn','startup','readiness','quote','dispatch','stop']);assert.equal(proc.exitCode,undefined);
});
test('script never dispatches or revalidates consent when readiness fails',async()=>{
 const {events,proc}=await scriptHarness({readinessFails:true});assert.equal(events.includes('readiness'),true);assert.equal(events.includes('dispatch'),false);assert.equal(events.filter(x=>x==='quote').length,1);assert.equal(proc.exitCode,1);
});
test('script dry run does not load credentials/start child/preflight/dispatch',async()=>{
 const {events}=await scriptHarness({execute:false});assert.deepEqual(events,['stop']);
});

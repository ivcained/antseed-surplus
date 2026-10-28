import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {spawnSync} from 'node:child_process';
import {deflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import * as probe from '../lib/content-probe.mjs';
import {MAX_VIDEO_COST_HEADER} from '../node_modules/@antseed/cli/dist/proxy/request-utils.js';
import {configFromObject} from '../node_modules/@antseed/cli/dist/config/loader.js';
// Original 1x1 grayscale-alpha fixture, with its corrupt IDAT CRC corrected.
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=','base64');
const input={bytes:png,name:'red.png',mime:'image/png'};
const settings={models:['image','edit','video','decision','text'],quoteMaxAgeMs:300000,rpcUrl:'https://example.test'};
const price={inputUsdPerMillion:2,outputUsdPerMillion:12,cachedInputUsdPerMillion:2};
const quotes=()=>({generatedAt:new Date().toISOString(),services:{image:{kind:'image',unitPriceUsd:.03,pricing:price,media:{inputs:['text']}},edit:{kind:'image',unitPriceUsd:.04,pricing:price,media:{inputs:['text','image']}},video:{kind:'video',unitPriceUsd:.3,pricing:price,media:{inputs:['text','image']}},decision:{kind:'decision',pricing:{...price,outputUsdPerMillion:0}},text:{pricing:price}}});
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});

import {BuyerPaymentManager} from '@antseed/buyer-core/buyer-payment-manager';
test('hard run budget denies real payment-manager reserve increases before signing',async()=>{
 const guard=probe.installProbeBudgetGuard(BuyerPaymentManager,{budgetMicros:1000000n});
 let signatures=0,transport=0;
 const manager=Object.create(BuyerPaymentManager.prototype);
 manager._signer={signTypedData:async()=>{signatures++;return 'offline-signature';}};manager._channelsDomain={};
 try{
  const channel='0x'+'a'.repeat(64);
  await manager._signReserveAuth(channel,1000000n,123);assert.equal(signatures,1);
  await assert.rejects(manager._signReserveAuth(channel,1000001n,123),/hard.*budget/i);assert.equal(signatures,1);
  await assert.rejects(manager._signReserveAuth('0x'+'b'.repeat(64),1n,123),/hard.*budget/i);assert.equal(signatures,1);
  manager.getActiveSession=()=>({sessionId:channel});manager._getCeiling=()=>1000000n;manager._config={maxReserveAmountUsdc:1000000n};manager._authDeadline=()=>123;manager.getBalance=async()=>({available:100000000n});manager._commitAndSendReserveAuth=async()=>{transport++;};
  await assert.rejects(manager.topUpReserve('peer',{}),/hard.*budget/i);assert.equal(signatures,1);assert.equal(transport,0);
 }finally{guard.restore();}
});
test('child preload installs hard reserve guard before any CLI code executes',()=>{
 const program=`import {BuyerPaymentManager} from '@antseed/buyer-core/buyer-payment-manager';const manager=Object.create(BuyerPaymentManager.prototype);manager._signer={signTypedData:()=>{throw Error('must not sign')}};try{await manager._signReserveAuth('0x'+'c'.repeat(64),1000001n,123);process.exitCode=1;}catch(error){if(!/Hard content-probe budget/.test(error.message))throw error;}`;
 const result=spawnSync(process.execPath,['--import',probe.probeBudgetPreload(1,{kind:'image',model:'reviewed-image-20261029',peer:'a'.repeat(40)}),'--input-type=module','-e',program],{encoding:'utf8',timeout:10000,cwd:new URL('..',import.meta.url)});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/CONTENT_PROBE_BUDGET_GUARD_READY/);assert.match(result.stdout,/CONTENT_PROBE_DISPATCH_GUARD_READY/);
});
test('child preload refuses missing or nonexact dispatch binding',()=>{
 for(const pin of [undefined,{}, {kind:'image',model:'bad model',peer:'a'.repeat(40)},{kind:'unknown',model:'image',peer:'a'.repeat(40)},{kind:'image',model:'image',peer:'b'}])assert.throws(()=>probe.probeBudgetPreload(1,pin),/binding|exact.*model/i);
});
// No sockets, credentials, files or live payment clients: only installed routing,
// rewriting, node dispatch and buyer-handler code run; mux/payment edges are synthetic.
async function installedDispatchScenario(options){
 const {BuyerProxy}=await import('./node_modules/@antseed/cli/dist/proxy/buyer-proxy.js');
 const {AntseedNode}=await import('@antseed/node');
 const {BuyerRequestHandler}=await import('@antseed/buyer-core/buyer-request-handler');
 const {resolvePeerRoutePlan}=await import('./node_modules/@antseed/cli/dist/proxy/routing.js');
 const {detectRequestServiceApiProtocol,extractRequestBodyFields}=await import('@antseed/api-adapter');
 const {ResourceRoutes}=await import('./node_modules/@antseed/cli/dist/proxy/resource-routes.js');
 const {buildContentRequest}=await import('./lib/content-probe.mjs');
 const {kind='image',model='reviewed-image-20261029',alias='reviewed-image-20260101'}=options;
 const peerId='a'.repeat(40),provider='surplus';
 const protocol=options.advertisedProtocol??(kind==='video'?'venice-video':['image','edit'].includes(kind)?'openai-images':kind==='decision'?'typesafe-systemone':kind==='responses'?'openai-responses':kind==='messages'?'anthropic-messages':'openai-chat-completions');
 const stats={connections:0,payments:0,upstream:0,sent:[]};
 const peer={peerId,providers:[provider],services:[model],capabilities:[],defaultInputUsdPerMillion:2,defaultOutputUsdPerMillion:12};
 function offers(names){
  peer.services=names;
  peer.providerPricing={[provider]:{services:Object.fromEntries(names.map(name=>[name,{inputUsdPerMillion:2,outputUsdPerMillion:name===model?12:1,cachedInputUsdPerMillion:2}]))}};
  peer.providerServiceApiProtocols={[provider]:{services:Object.fromEntries(names.map(name=>[name,[protocol]]))}};
  peer.providerServiceUnitBillingModels={[provider]:{services:Object.fromEntries(names.map(name=>[name,{[protocol]:{components:[{id:'output',unit:kind==='video'?'video_generations':'output_images',priceUsd:name===model?.03:.01}]}}]))}};
 }
 offers(options.offers==='alias'?[alias]:options.offers==='both'?[model,alias]:[model]);
 const fixture={bytes:Buffer.from('offline fixture'),mime:kind==='audio-input'?'audio/wav':kind==='file-input'?'application/pdf':kind==='video-input'?'video/mp4':'image/png'};
 const built=buildContentRequest(kind,model,['edit','video','vision','audio-input','file-input','video-input'].includes(kind)?fixture:undefined);
 const encoded=new Request('http://example.test'+built.path,{method:'POST',headers:built.headers,body:built.body});
 const request={requestId:'offline-request',method:'POST',path:built.path,headers:{...Object.fromEntries(encoded.headers),'x-antseed-service':model,'x-antseed-pin-peer':peerId},body:Buffer.from(await encoded.arrayBuffer())};
 if(options.body){request.body=Buffer.from(options.rawJson??JSON.stringify({...JSON.parse(request.body),...options.body}));}
 if(options.header!==undefined)request.headers['x-antseed-service']=options.header;
 if(options.multipartExtra){const text=request.body.toString('latin1'),boundary=/boundary=(.*)/.exec(request.headers['content-type'])[1];request.body=Buffer.from(text.replace(`--${boundary}--`,`--${boundary}\r\nContent-Disposition: form-data; name="${options.multipartExtra.name}"${options.multipartExtra.file?'; filename="selector.txt"':''}\r\n\r\n${options.multipartExtra.value}\r\n--${boundary}--`),'latin1');}
 const mux={sendProxyRequest(req,answer){stats.upstream++;stats.sent.push({path:req.path,headers:req.headers,fields:extractRequestBodyFields(req.headers,req.body),body:Buffer.from(req.body).toString('base64')});queueMicrotask(()=>answer({requestId:req.requestId,statusCode:200,headers:{'content-type':'application/json'},body:Buffer.from(JSON.stringify(req.path.endsWith('/retrieve')?{status:'PROCESSING'}:kind==='video'?{queue_id:'q1'}:{choices:[{message:{content:'antseed content probe works'}}]}))},{streamingStart:false}));},cancelProxyRequest(){}};
 const negotiator={bpm:{releaseRequestCoverage(){},trackVideoRetrieve(){return false;}},getOrCreatePaymentMux(){return {};},trackRequestBillingContext(){stats.payments++;return 30000n;},estimateCostFromResponse(){},trackFreeUsageRequestService(){},async prepareFreeUsageOpen(){}};
 const handler=new BuyerRequestHandler({requestTimeoutMs:100},{async getConnection(){stats.connections++;if(options.mutateDuringConnection){offers([alias]);request.body.fill(32);}return {state:'Connected'};},getMux:()=>mux,getVerificationMux:()=>({}),registerPaymentMux(){},negotiator});
 const node=Object.create(AntseedNode.prototype);node._buyerHandler=handler;node._buyerContext=()=>null;node._router=null;
 const proxy=Object.create(BuyerProxy.prototype);
 Object.assign(proxy,{_node:node,_modelRoutingClient:{},_getPeers:async()=>{if(options.mutateAfterPrecheck)offers([alias]);return [peer];},_cacheLastUpdatedAtMs:Date.now(),_peerCacheTtlMs:60000,_effectivePolicy:()=>null,_markModelActivity(){if(options.mutateBeforeHandler)offers([alias]);},_inFlightBySeller:new Map(),_videoJobQueues:new Map(),_recordPeerFailure(){},_recordPeerResponseHealth(){},_recordSellerSuccess(){},_persistResourceRoutes:async()=>{},_resourceRoutes:new ResourceRoutes(),_attribution:{isBuyerHealthy:()=>false},_now:Date.now});
 const makeResponse=()=>({writableEnded:false,headersSent:false,status:0,headers:{},chunks:[],writeHead(status,headers){this.status=status;this.headers=headers;this.headersSent=true;},write(bytes){this.chunks.push(Buffer.from(bytes));return true;},end(bytes){if(bytes)this.chunks.push(Buffer.from(bytes));this.writableEnded=true;},once(){},off(){}});
 const context={requiredParameters:[],requestPolicy:null,signal:new AbortController().signal,effectivePinnedPeer:peerId};
 let result,error;const res=makeResponse();
 try{
  if(options.directHandler){request.headers['x-antseed-provider']=provider;result=await handler.sendRequest(peer,request,undefined,{pinned:true});}
  else if(options.stalePlan){const plan=resolvePeerRoutePlan(peer,detectRequestServiceApiProtocol(request),model,null,'lenient');offers([alias]);result=await proxy._dispatchToPeer(res,request,peer,new Map([[peerId,plan]]),protocol,model,null,null,true,context.signal);}
  else result=await proxy._dispatchInference(res,context,request,null);
  if(options.poll&&res.status===200){const retrieve={...request,requestId:'offline-poll',path:'/api/v1/video/retrieve',body:Buffer.from(JSON.stringify({model,queue_id:'q1'}))};const pollRes=makeResponse();result=await proxy._dispatchInference(pollRes,context,retrieve,null);stats.pollStatus=pollRes.status;stats.pollBody=Buffer.concat(pollRes.chunks).toString();}
 }catch(cause){error=cause.message;}
 console.log(JSON.stringify({...stats,status:res.status,error:error??result?.errorMessage??null,resultStatus:result?.statusCode??null,selected:resolvePeerRoutePlan(peer,protocol,model,null,'lenient')?.serviceId}));
}
function runInstalledDispatch(options){
 const pin={kind:options.kind??'image',model:options.model??'reviewed-image-20261029',peer:'a'.repeat(40)};
 const result=spawnSync(process.execPath,['--import',probe.probeBudgetPreload(1,pin),'--input-type=module','-e',`await (${installedDispatchScenario.toString()})(${JSON.stringify(options)});`],{encoding:'utf8',timeout:10000,cwd:new URL('..',import.meta.url)});
 assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout.trim().split('\n').at(-1));
}
for(const offers of ['both','alias'])test(`child exact-model dispatch rejects ${offers} canonical offer selection before payment`,()=>{
 const result=runInstalledDispatch({offers});assert.equal(result.selected,'reviewed-image-20260101');assert.equal(result.upstream,0,JSON.stringify(result));assert.equal(result.payments,0);assert.equal(result.connections,0);assert.match(result.error,/exact.*model|model.*pin/i);
});
for(const mutation of ['mutateAfterPrecheck','stalePlan','mutateBeforeHandler'])test(`child exact-model dispatch rejects catalog TOCTOU ${mutation}`,()=>{
 const result=runInstalledDispatch({[mutation]:true});assert.equal(result.upstream,0,JSON.stringify(result));assert.equal(result.payments,0);assert.equal(result.connections,0);assert.match(result.error,/exact.*model|model.*pin/i);
});
for(const kind of probe.CONTENT_KINDS)test(`child exact-model preserves native ${kind} success`,()=>{
 const result=runInstalledDispatch({kind,poll:kind==='video'});assert.equal(result.error,null,JSON.stringify(result));assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.payments,1);assert.equal(result.upstream,kind==='video'?2:1);assert.equal(result.sent[0].fields.model,'reviewed-image-20261029');
 if(kind==='video'){assert.equal(result.pollStatus,200);assert.equal(JSON.parse(result.pollBody).status,'processing');assert.equal(result.sent[1].fields.queue_id,'q1');assert.equal(result.sent[1].path,'/api/v1/video/retrieve');}
 if(kind==='edit')assert.ok(Buffer.from(result.sent[0].body,'base64').includes(Buffer.from('offline fixture')));
});
for(const kind of ['responses','messages'])test(`child exact-model preserves identity through ${kind} to chat transform`,()=>{
 const result=runInstalledDispatch({kind,advertisedProtocol:'openai-chat-completions'});assert.equal(result.error,null,JSON.stringify(result));assert.equal(result.status,200);assert.equal(result.payments,1);assert.equal(result.upstream,1);assert.equal(result.sent[0].path,'/v1/chat/completions');assert.equal(result.sent[0].fields.model,'reviewed-image-20261029');
});
test('child preload refuses a distinct module copy before either ready signal',()=>{
 const pin={kind:'image',model:'reviewed-image-20261029',peer:'a'.repeat(40)};
 const preload=probe.probeBudgetPreload(1,pin),source=Buffer.from(preload.split(',')[1],'base64').toString();
 const original=JSON.stringify(import.meta.resolve('@antseed/buyer-core/buyer-payment-manager'));
 const tampered=source.replace(`await import(${original})`,`await import(${JSON.stringify(import.meta.resolve('@antseed/buyer-core/buyer-payment-manager')+'?distinct-module-copy')})`);
 assert.notEqual(tampered,source);
 const result=spawnSync(process.execPath,['--import',`data:text/javascript;base64,${Buffer.from(tampered).toString('base64')}`,'--input-type=module','-e',"process.stdout.write('ENTRYPOINT_RAN');"],{encoding:'utf8',timeout:10000,cwd:new URL('..',import.meta.url)});
 assert.notEqual(result.status,0,result.stdout);assert.doesNotMatch(result.stdout,/GUARD_READY|ENTRYPOINT_RAN/);assert.match(result.stderr,/module.*identity|module.*graph|module.*copy/i);
});
for(const kind of probe.CONTENT_KINDS.filter(kind=>kind!=='image'))test(`child exact-model rejects cheaper alias for ${kind}`,()=>{
 const result=runInstalledDispatch({kind,offers:'both'});assert.equal(result.connections,0,JSON.stringify(result));assert.equal(result.payments,0);assert.equal(result.upstream,0);assert.match(result.error,/exact.*model|model.*pin/i);
});
for(const alias of ['vendor/reviewed-image-20261029','REVIEWED-IMAGE-20261029','reviewed-image-latest'])test(`child exact-model rejects normalized ${alias}`,()=>{
 const result=runInstalledDispatch({alias,offers:'alias'});assert.equal(result.connections,0,JSON.stringify(result));assert.equal(result.payments,0);assert.equal(result.upstream,0);assert.match(result.error,/exact.*model|model.*pin/i);
});
for(const [label,options] of [
 ['header',{header:'reviewed-image-20260101'}],
 ['service',{body:{service:'reviewed-image-20260101'}}],
 ['model',{body:{model:'reviewed-image-20260101'}}],
 ['whitespace',{body:{model:' reviewed-image-20261029 '}}],
 ['duplicate JSON model',{body:{},rawJson:'{"model":"reviewed-image-20260101","model":"reviewed-image-20261029"}'}],
 ['multipart service',{kind:'edit',multipartExtra:{name:'service',value:'reviewed-image-20260101'}}],
 ['duplicate multipart model',{kind:'edit',multipartExtra:{name:'model',value:'reviewed-image-20260101'}}],
 ['file multipart model',{kind:'edit',multipartExtra:{name:'model',value:'reviewed-image-20260101',file:true}}],
])test(`child exact-model guards final handler ${label} selector`,()=>{
 const result=runInstalledDispatch({...options,directHandler:true});assert.equal(result.connections,0,JSON.stringify(result));assert.equal(result.payments,0);assert.equal(result.upstream,0);assert.match(result.error,/exact.*model|model.*pin/i);
});
test('child exact-model snapshots request and catalog across handler connection await',()=>{
 const result=runInstalledDispatch({directHandler:true,mutateDuringConnection:true});assert.equal(result.error,null,JSON.stringify(result));assert.equal(result.resultStatus,200);assert.equal(result.upstream,1);assert.equal(result.payments,1);assert.equal(result.sent[0].fields.model,'reviewed-image-20261029');
});
test('native uppercase pending statuses reach MP4 without a second generation',async()=>{
 let calls=0;
 await probe.executeContentRequest({kind:'video',model:'video',input,baseUrl:'http://127.0.0.1:8378',budget:1,pollIntervalMs:1,timeoutMs:1000,fetchImpl:async()=>{calls++;return calls===1?response({queue_id:'q'}):calls===2?response({status:'QUEUED'}):calls===3?response({status:'PROCESSING'}):new Response(fixtureMp4(),{headers:{'content-type':'video/mp4'}});}});
 assert.equal(calls,4);
});
test('wallet FIFOs fail immediately instead of blocking open',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'content-probe-fifo-'));try{const path=join(dir,'wallet');const result=spawnSync('mkfifo',[path]);if(result.status!==0)return;const read=spawnSync(process.execPath,['--input-type=module','-e',`import {readPrivateJson} from ${JSON.stringify(new URL('../lib/content-probe.mjs',import.meta.url).href)};try{await readPrivateJson(process.argv[1]);process.exitCode=1;}catch{}`,path],{timeout:2000,encoding:'utf8'});assert.equal(read.status,0,read.stderr||'FIFO read hung');}finally{await rm(dir,{recursive:true,force:true});}
});
test('strict CLI requires exact model and accepts execute only explicitly',()=>{
 assert.deepEqual(probe.parseContentArgs(['--kind','image','--model','image']),{kind:'image',model:'image',execute:false});
 assert.equal(probe.parseContentArgs(['--kind','text','--model','text','--execute']).execute,true);
 for(const args of [[],['--kind','image','--model','a b'],['--kind','unknown','--model','x'],['--kind','image','--model','x','--execute','false'],['--kind','text','--model','x','--model','y']])assert.throws(()=>probe.parseContentArgs(args));
});
test('budget defaults to one dollar, nonvideo cannot exceed one, video maximum five',()=>{
 assert.equal(probe.probeBudget('image',{}),1);
 assert.equal(probe.probeBudget('video',{TEST_MAX_COST_USD:'5'}),5);
 for(const [kind,value] of [['image','1.01'],['video','5.01'],['video','NaN'],['video','0'],['video','1e2'],['text','-1']])assert.throws(()=>probe.probeBudget(kind,{TEST_MAX_COST_USD:value}));
});
test('quote gate rejects wrong model/kind, stale prices, expired policy and overbudget media',()=>{
 const mediaAllowed={...settings,models:['text'],mediaConfig:{services:[{model:'image',kind:'image'}]}};
 assert.equal(probe.validateProbeQuote(mediaAllowed,quotes(),'image','image',1).unitPriceUsd,.03);
 assert.throws(()=>probe.validateProbeQuote({...mediaAllowed,mediaConfig:{services:[{model:'image',kind:'video'}]}},quotes(),'image','image',1),/allow|model/);
 assert.equal(probe.validateProbeQuote(settings,quotes(),'image','image',1).unitPriceUsd,.03);
 assert.throws(()=>probe.validateProbeQuote(settings,quotes(),'video','image',1),/kind/);
 assert.throws(()=>probe.validateProbeQuote(settings,quotes(),'edit','image',1),/input|edit/);
 assert.throws(()=>probe.validateProbeQuote(settings,quotes(),'image','other',1),/allow|model/);
 const old=quotes();old.generatedAt='2000-01-01';assert.throws(()=>probe.validateProbeQuote(settings,old,'text','text',1),/stale|quote/i);
 const expired=quotes();expired.services.image.policyExpiresAt='2000-01-01';assert.throws(()=>probe.validateProbeQuote(settings,expired,'image','image',1),/expired/i);
 const costly=quotes();costly.services.image.unitPriceUsd=2;assert.throws(()=>probe.validateProbeQuote(settings,costly,'image','image',1),/budget/i);
});
test('buyer config caps payments and copies exact service prices, not old floor defaults',()=>{
 const config=probe.buildBuyerConfig(settings,quotes().services.video,'video',1,8378,'a'.repeat(40));
 assert.deepEqual(config.buyer.maxPricing.defaults,price);
 assert.equal(config.payments.maxPerRequestUsdc,'1000000');
 assert.equal(config.payments.maxReserveAmountUsdc,'1000000');
 assert.equal(config.payments.maxVideoRequestUsdc,'1000000');
 assert.equal(config.buyer.autoSweep,false);
 assert.deepEqual(config.buyer.routingPreferences.allowedPeerIds,['a'.repeat(40)]);
 const loaded=configFromObject(config);assert.equal(loaded.payments.maxPerRequestUsdc,'1000000');assert.deepEqual(loaded.buyer.maxPricing.defaults,price);
});
test('builds bounded native generation, edit, decision and video shapes',()=>{
 const image=probe.buildContentRequest('image','image');assert.equal(image.path,'/v1/images/generations');assert.deepEqual(JSON.parse(image.body),{model:'image',prompt:'A plain red square on a white background.',n:1,size:'1024x1024',response_format:'b64_json'});
 const edit=probe.buildContentRequest('edit','edit',input);assert.equal(edit.path,'/v1/images/edits');assert.equal(edit.body.get('model'),'edit');assert.equal(edit.body.get('n'),'1');assert.equal(edit.body.get('image').size,png.length);
 const video=JSON.parse(probe.buildContentRequest('video','video',input).body);assert.equal(video.duration,'5s');assert.equal(video.resolution,'720p');assert.match(video.image_url,/^data:image\/png;base64,/);assert.equal(video.audio,undefined);
 assert.equal(probe.buildContentRequest('decision','decision').path,'/v1/systemone');
 for(const kind of ['edit','video','vision','audio-input','file-input','video-input'])assert.throws(()=>probe.buildContentRequest(kind,'text'),/input/i);
});
test('decision request uses historical TypeSafe state and criteria fixture with the ok answer id',()=>{
 // SI 2207d607e747f487a4d83e60c7f24ad677a55a7f, decisions-probe.ts:85..97.
 // This historical fixture is not certification of the current upstream API.
 const request=probe.buildContentRequest('decision','typesafe/systemone');
 assert.equal(request.path,'/v1/systemone');
 assert.deepEqual(request.headers,{'content-type':'application/json'});
 assert.deepEqual(JSON.parse(request.body),{
  model:'typesafe/systemone',
  state:{ticket_summary:'Card charged twice for the June invoice; the customer asked for a refund 38 hours ago.',account_tier:'pro',messages_waiting:2},
  questions:{ok:{type:'noul',instructions:'Answer whether this ticket is urgent enough to page the on-call engineer within the hour with a calibrated probability.',criteria:{urgent:{allow:[0,1]}}}},
 });
});
for(const [label,answer,value] of [
 ['typed noul',{type:'noul',noul:0.75},0.75],
 ['untyped noul',{noul:0.75},0.75],
 ['typed probability',{type:'noul',probability:0.25},0.25],
 ['untyped probability',{probability:0.25},0.25],
 ['zero',{noul:0},0],['one',{noul:1},1],
 ['negative finite',{type:'noul',noul:-0.25},-0.25],
 ['above-one finite',{type:'noul',probability:1.25},1.25],
])test(`decision inspection accepts native ${label} answer`,async()=>{
 const result=await probe.inspectContentResponse('decision',response({answers:{ok:answer},usage:{input_tokens:3}}));
 assert.deepEqual(result,{usage:{input_tokens:3},answer:{type:'noul',noul:value}});
});
for(const [label,body] of [
 ['no answers',{}],['wrong id',{answers:{q1:{noul:0.5}}}],
 ['primitive answer',{answers:{ok:0.5}}],['array answer',{answers:{ok:[0.5]}}],
 ['null answer',{answers:{ok:null}}],['missing number',{answers:{ok:{type:'noul'}}}],
 ['string noul',{answers:{ok:{noul:'0.5'}}}],['string probability',{answers:{ok:{probability:'0.5'}}}],
 ['boolean noul',{answers:{ok:{noul:true}}}],['object noul',{answers:{ok:{noul:{value:0.5}}}}],
 ['wrong explicit type',{answers:{ok:{type:'bool',noul:0.5}}}],
 ['null explicit type',{answers:{ok:{type:null,noul:0.5}}}],
 ['chat completion',{choices:[{message:{content:'antseed content probe works'}}]}],
])test(`decision inspection rejects native ${label} despite HTTP 200`,async()=>{
 await assert.rejects(probe.inspectContentResponse('decision',response(body)),/invalid numeric decision answer ok/);
});
for(const value of ['1e400','-1e400','NaN','Infinity'])test(`decision inspection rejects nonfinite native ${value}`,async()=>{
 // Exponent overflow reaches Number.isFinite; NaN/Infinity are invalid JSON.
 const body=`{"answers":{"ok":{"noul":${value}}}}`;
 await assert.rejects(probe.inspectContentResponse('decision',new Response(body,{headers:{'content-type':'application/json'}})),/invalid numeric decision|Invalid native JSON/);
});
test('decision response does not substitute for unrelated text protocol content',async()=>{
 await assert.rejects(probe.inspectContentResponse('text',response({answers:{ok:{noul:0.5}}})),/expected objective answer/);
});
test('text wrappers and understanding preserve native nested input families',()=>{
 assert.equal(probe.buildContentRequest('responses','text').path,'/v1/responses');assert.equal(JSON.parse(probe.buildContentRequest('responses','text').body).max_output_tokens,64);
 assert.equal(probe.buildContentRequest('messages','text').path,'/v1/messages');
 for(const [kind,type,mime] of [['vision','image_url','image/png'],['audio-input','input_audio','audio/wav'],['file-input','file','application/pdf'],['video-input','video_url','video/mp4']]){
 const request=JSON.parse(probe.buildContentRequest(kind,'text',{...input,mime,name:'fixture'}).body);assert.equal(request.messages[0].content[1].type,type);assert.equal(request.max_tokens,64);
 }
});
test('validates actual image bytes and dimensions, not URLs/JSON masquerading as content',async()=>{
 const result=await probe.inspectContentResponse('image',response({data:[{b64_json:png.toString('base64')}],usage:{output_images:1}}));
 assert.equal(result.media.width,1);assert.equal(result.media.height,1);assert.equal(result.media.mime,'image/png');assert.match(result.media.sha256,/^[a-f0-9]{64}$/);assert.equal(result.bytes.length,png.length);
 const uri=await probe.inspectContentResponse('edit',response({data:[{url:`data:image/png;base64,${png.toString('base64')}`}]}));assert.equal(uri.media.width,1);
 for(const data of [[{b64_json:Buffer.from('{}').toString('base64')}],[],[{url:'http://127.0.0.1/x'}],[{url:'https://unapproved.example/x'}]])await assert.rejects(probe.inspectContentResponse('image',response({data})),/image|asset|URL|host/i);
});
// Independent fixture encoder: bit-at-a-time CRC and explicit filtered rows.
function pngChunk(type,data=Buffer.alloc(0)){
 const name=Buffer.from(type),header=Buffer.alloc(4),checksum=Buffer.alloc(4);header.writeUInt32BE(data.length);
 let crc=0xffffffff;for(const byte of Buffer.concat([name,data])){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
 checksum.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([header,name,data,checksum]);
}
function fixturePng({width=1,height=1,depth=8,color=2,interlace=0,compression=0,filter=0,raw=Buffer.from([0,255,0,0]),before=[],after=[],compressed=deflateSync(raw)}={}){
 const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=depth;header[9]=color;header[10]=compression;header[11]=filter;header[12]=interlace;
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),pngChunk('IHDR',header),...before,pngChunk('IDAT',compressed),...after,pngChunk('IEND')]);
}
const inspectPng=bytes=>probe.inspectContentResponse('image',response({data:[{b64_json:bytes.toString('base64')}]}));
for(const [name,raw] of [['non-pixel zlib text',Buffer.from('not a pixel scanline')],['truncated scanline',Buffer.from([0,255,0])],['overlong scanline',Buffer.from([0,255,0,0,1])],['invalid filter',Buffer.from([5,255,0,0])]]){
 test(`PNG rejects ${name}`,async()=>{await assert.rejects(inspectPng(fixturePng({raw})),/PNG.*(?:scanline|filter|pixel)/i);});
}
for(const [name,options] of [['RGB depth 4',{depth:4}],['unknown color',{color:1}],['unknown depth',{depth:3}],['unsupported 16-bit',{depth:16}],['unsupported packed grayscale',{color:0,depth:1}],['unsupported interlace',{interlace:1}],['invalid compression',{compression:1}],['invalid filter method',{filter:1}]]){
 test(`PNG rejects ${name} layout explicitly`,async()=>{await assert.rejects(inspectPng(fixturePng(options)),/PNG.*(?:unsupported|layout|depth|color|compression|filter|interlace)/i);});
}
test('PNG rejects the inherited corrupt-CRC fixture instead of weakening validation',async()=>{
 const corrupt=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6WQAAAAASUVORK5CYII=','base64');
 await assert.rejects(inspectPng(corrupt),/PNG.*CRC/);
 assert.deepEqual(probe.decodeProbePng(png).pixels,Buffer.from([255,255,255,255]));
});
test('PNG decodes genuine ffmpeg RGB fixture and consecutive split IDAT chunks',async()=>{
 // Offline ffmpeg color=c=red:s=2x2, rgb24 -> PNG (red is 253 after YUV conversion).
 const genuine=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEElEQVR4nGP8ywACLGCSAQANEQED1LYyQAAAAABJRU5ErkJggg==','base64');
 assert.deepEqual(probe.decodeProbePng(genuine).pixels,Buffer.from([253,0,0,255,253,0,0,255,253,0,0,255,253,0,0,255]));
 await inspectPng(genuine);
 const packed=deflateSync(Buffer.from([0,255,0,0]));
 const split=fixturePng({compressed:packed.subarray(0,3),after:[pngChunk('IDAT'),pngChunk('IDAT',packed.subarray(3))]});
 assert.deepEqual(probe.decodeProbePng(split).pixels,Buffer.from([255,0,0,255]));await inspectPng(split);
});
test('PNG verifies every chunk CRC including ancillary chunks',async()=>{
 const bad=fixturePng();bad[29]^=1;
 const ancillary=pngChunk('tEXt',Buffer.from('note\0hello'));ancillary[ancillary.length-1]^=1;
 for(const bytes of [bad,fixturePng({before:[ancillary]})])await assert.rejects(inspectPng(bytes),/PNG.*CRC/i);
});
test('PNG enforces critical chunk structure, order and exact end',async()=>{
 const valid=fixturePng(),ihdr=valid.subarray(8,33),idat=valid.subarray(33,valid.length-12),iend=pngChunk('IEND');
 const variants=[Buffer.concat([valid,Buffer.from([0])]),Buffer.concat([valid.subarray(0,8),pngChunk('IHDR',Buffer.alloc(12)),idat,iend]),Buffer.concat([valid.subarray(0,33),ihdr,idat,iend]),fixturePng({before:[pngChunk('ABCD')]}),fixturePng({after:[pngChunk('tEXt',Buffer.from('x\0y')),idat]}),Buffer.concat([valid.subarray(0,-12),pngChunk('IEND',Buffer.from([0]))]),valid.subarray(0,-1)];
 for(const bytes of variants)await assert.rejects(inspectPng(bytes),/PNG/i);
});
test('PNG rejects trailing zlib data and concatenated streams',async()=>{
 const compressed=deflateSync(Buffer.from([0,255,0,0]));
 for(const suffix of [Buffer.from([0]),compressed])await assert.rejects(inspectPng(fixturePng({compressed:Buffer.concat([compressed,suffix])})),/PNG.*(?:stream|compressed)/i);
});
test('PNG bounds pixels and decoded bytes before trying invalid zlib data',async()=>{
 for(const dimensions of [{width:16385},{width:8192,height:8192},{width:4096,height:4096,color:6}]){
  await assert.rejects(inspectPng(fixturePng({...dimensions,compressed:Buffer.from('not zlib')})),/PNG.*(?:limit|dimensions)/i);
 }
});
test('PNG reconstructs filters 0 through 4 with modulo wrap and first-row edges',async()=>{
 // RGB rows [10,20,30,250,240,230], [40,15,250,5,20,10].
 const expected=Buffer.from([10,20,30,255,250,240,230,255,40,15,250,255,5,20,10,255]);
 const rows=[[[10,20,30,250,240,230],[40,15,250,5,20,10]],[[10,20,30,240,220,200],[40,15,250,221,5,16]],[[10,20,30,250,240,230],[30,251,220,11,36,36]],[[10,20,30,245,230,215],[35,5,235,116,149,26]],[[10,20,30,240,220,200],[30,251,220,11,36,16]]];
 for(let filter=0;filter<5;filter++){
  const bytes=fixturePng({width:2,height:2,raw:Buffer.from([filter,...rows[filter][0],filter,...rows[filter][1]])});
  const decoded=probe.decodeProbePng(bytes);assert.deepEqual(decoded.pixels,expected,`filter ${filter}`);assert.equal(decoded.width,2);assert.equal(decoded.height,2);
  const result=await inspectPng(bytes);assert.deepEqual(result.media,{mime:'image/png',width:2,height:2,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
 }
});
test('PNG decodes supported 8-bit grayscale, RGB, palette and alpha layouts',async()=>{
 for(const [options,expected] of [[{color:0,raw:Buffer.from([0,42])},[42,42,42,255]],[{color:4,raw:Buffer.from([0,42,7])},[42,42,42,7]],[{color:6,raw:Buffer.from([0,10,20,30,7])},[10,20,30,7]],[{color:3,raw:Buffer.from([0,1]),before:[pngChunk('PLTE',Buffer.from([255,0,0,0,255,0])),pngChunk('tRNS',Buffer.from([255,9]))]},[0,255,0,9]],[{color:0,raw:Buffer.from([0,42]),before:[pngChunk('tRNS',Buffer.from([0,42]))]},[42,42,42,0]],[{before:[pngChunk('tRNS',Buffer.from([0,255,0,0,0,0]))]},[255,0,0,0]]]){
  assert.deepEqual(probe.decodeProbePng(fixturePng(options)).pixels,Buffer.from(expected));await inspectPng(fixturePng(options));
 }
});
test('PNG rejects invalid palettes, reconstructed indexes and transparency',async()=>{
 const palette=pngChunk('PLTE',Buffer.from([255,0,0]));
 for(const options of [{color:3},{color:3,before:[pngChunk('PLTE',Buffer.from([1,2]))]},{color:3,before:[palette],raw:Buffer.from([0,1])},{color:3,before:[palette],width:2,raw:Buffer.from([1,0,1])},{color:0,before:[palette]},{color:6,before:[pngChunk('tRNS',Buffer.from([0,0]))]},{color:3,before:[pngChunk('tRNS',Buffer.from([0])),palette]},{before:[pngChunk('tRNS',Buffer.from([1]))]}])await assert.rejects(inspectPng(fixturePng(options)),/PNG/i);
});
test('PNG fails closed for animated PNG rather than validating only its default image',async()=>{
 await assert.rejects(inspectPng(fixturePng({before:[pngChunk('acTL',Buffer.alloc(8))]})),/PNG.*(?:unsupported|animated)/i);
});
test('remote assets are credentialless, no redirects and explicit exact-host only',async()=>{
 let called=0;
 const result=await probe.inspectContentResponse('image',response({data:[{url:'https://assets.example.test/a.png?token=private'}]}),{assetHosts:['assets.example.test'],fetchImpl:async(url,options)=>{called++;assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');assert.equal(options.headers,undefined);return new Response(png);}});
 assert.equal(called,1);assert.equal(result.media.width,1);
});
test('decision answers require requested structured numeric answer; native HTTP errors remain failures',async()=>{
 const result=await probe.inspectContentResponse('decision',response({answers:{ok:{type:'noul',noul:1}},usage:{input_tokens:3}}));assert.equal(result.usage.input_tokens,3);
 for(const body of [{answers:{}},{answers:{ok:{type:'noul',noul:'yes'}}},{error:{code:'denied'}}])await assert.rejects(probe.inspectContentResponse('decision',response(body)));
 await assert.rejects(probe.inspectContentResponse('decision',response({error:{code:'pilot_denied',message:'inf_secret'}},403)),error=>error.status===403 && /HTTP 403.*pilot_denied/.test(error.message) && !error.message.includes('inf_secret'));
});
test('semantic text checks distinguish Responses and Messages and reject wrong answers',async()=>{
 for(const [kind,body] of [['text',{choices:[{message:{content:'antseed content probe works'}}]}],['responses',{output:[{type:'message',content:[{type:'output_text',text:'antseed content probe works'}]}]}],['messages',{content:[{type:'text',text:'antseed content probe works'}]}],['vision',{choices:[{message:{content:'RED'}}]}]])await probe.inspectContentResponse(kind,response(body));
 await assert.rejects(probe.inspectContentResponse('vision',response({choices:[{message:{content:'blue'}}]})),/expected/i);
 await assert.rejects(probe.inspectContentResponse('audio-input',response({choices:[{message:{content:'hello'}}]})),/TEST_EXPECT_CONTAINS/);
});
test('native video polls queue exactly once and never reinterprets failed calls as success',async()=>{
 let count=0;
 const result=await probe.executeContentRequest({kind:'video',model:'video',input,baseUrl:'http://127.0.0.1:8378',peer:'a'.repeat(40),budget:1,pollIntervalMs:1,timeoutMs:1000,fetchImpl:async(url,options)=>{
 count++;assert.equal(options.headers['x-antseed-pin-peer'],'a'.repeat(40));
 if(count===1){assert.match(url,/\/api\/v1\/video\/queue$/);assert.equal(options.headers[MAX_VIDEO_COST_HEADER],'1000000');return response({queue_id:'q1'});}
 assert.match(url,/\/api\/v1\/video\/retrieve$/);assert.deepEqual(JSON.parse(options.body),{model:'video',queue_id:'q1'});assert.equal(options.headers['x-antseed-service'],'video');
 return count===2?response({status:'running'}):new Response(Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(24)]),{headers:{'content-type':'video/mp4'}});
 },inspectVideo:async()=>({codec:'h264',duration:5,width:1280,height:720})});
 assert.equal(count,3);assert.equal(result.media.duration,5);
 let failures=0;await assert.rejects(probe.executeContentRequest({kind:'image',model:'image',baseUrl:'http://127.0.0.1:8378',budget:1,fetchImpl:async()=>{failures++;return response({error:{code:'provider_failed'}},502);}}),/HTTP 502/);assert.equal(failures,1);
});
test('MP4 validation rejects short output and JSON delivery even if queue accepted',async()=>{
 await assert.rejects(probe.inspectContentResponse('video',response({status:'succeeded',url:'https://example.test/movie'})),/MP4/i);
 const mp4=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(24)]);
 await assert.rejects(probe.inspectContentResponse('video',new Response(mp4,{headers:{'content-type':'video/mp4'}}),{inspectVideo:async()=>({codec:'h264',duration:1,width:1280,height:720})}),/duration/i);
});
test('private wallet file gate rejects public permissions and symlinks before reading',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'content-probe-test-'));
 try{const path=join(dir,'wallet.json');await writeFile(path,'{}',{mode:0o644});await assert.rejects(probe.readPrivateJson(path),/0600|private/);await chmod(path,0o600);assert.deepEqual(await probe.readPrivateJson(path),{});const link=join(dir,'link');await symlink(path,link);await assert.rejects(probe.readPrivateJson(link),/regular|symlink|private/);}finally{await rm(dir,{recursive:true,force:true});}
});
test('child cleanup is bounded, handles already exited children and escalates once',async()=>{
 const child=new EventEmitter();child.exitCode=null;child.signalCode=null;child.kills=[];child.kill=signal=>{child.kills.push(signal);if(signal==='SIGKILL'){child.signalCode=signal;child.emit('exit',null,signal);}return true;};
 await probe.stopBuyer(child,{graceMs:5,killMs:20});assert.deepEqual(child.kills,['SIGINT','SIGKILL']);
 await probe.stopBuyer(child,{graceMs:5});assert.equal(child.kills.length,2);
});
test('cleanup removes detached descendants even if group leader already exited',async()=>{
 const child=new EventEmitter();child.pid=123456789;child.exitCode=0;child.signalCode=null;let destroyed=0;child.stdout={destroy:()=>destroyed++};child.stderr={destroy:()=>destroyed++};
 const original=process.kill,kills=[];process.kill=(pid,signal)=>{assert.equal(pid,-child.pid);kills.push(signal);return true;};
 try{await probe.stopBuyer(child,{processGroup:true,graceMs:1,killMs:1});}finally{process.kill=original;}
 assert.ok(kills.includes('SIGKILL'));assert.equal(destroyed,2);
});
test('HTTP error status survives non-JSON HTML and never leaks upstream body',async()=>{
 await assert.rejects(probe.inspectContentResponse('image',new Response('<html>inf_private</html>',{status:502})),error=>error.status===502 && /HTTP 502/.test(error.message) && !error.message.includes('inf_private'));
});
function box(type,...parts){const body=Buffer.concat(parts),head=Buffer.alloc(8);head.writeUInt32BE(body.length+8);head.write(type,4);return Buffer.concat([head,body]);}
function fixtureMp4(){
 const mdhd=Buffer.alloc(24);mdhd.writeUInt32BE(1000,12);mdhd.writeUInt32BE(5000,16);
 const hdlr=Buffer.alloc(24);hdlr.write('vide',8);
 const entry=Buffer.alloc(78);entry.writeUInt16BE(1280,24);entry.writeUInt16BE(720,26);
 const stsd=box('stsd',Buffer.from([0,0,0,0,0,0,0,1]),box('avc1',entry));
 const stsz=Buffer.alloc(12);stsz.writeUInt32BE(1,4);stsz.writeUInt32BE(5,8);
 const track=box('trak',box('mdia',box('mdhd',mdhd),box('hdlr',hdlr),box('minf',box('stbl',stsd,box('stsz',stsz)))));
 return Buffer.concat([box('ftyp',Buffer.from('isom0000isom')),box('moov',track),box('mdat',Buffer.from([0,0,0,1,101]))]);
}
test('built-in bounded MP4 metadata parser needs no ffprobe and rejects malformed boxes',async()=>{
 const result=await probe.inspectVideoBytes(fixtureMp4());assert.equal(result.codec,'avc1');assert.equal(result.duration,5);assert.equal(result.width,1280);assert.equal(result.height,720);assert.equal(result.validation,'mp4-container-metadata');
 const parsed=await probe.inspectContentResponse('video',new Response(fixtureMp4(),{headers:{'content-type':'video/mp4'}}));assert.equal(parsed.media.duration,5);
 for(const bytes of [Buffer.alloc(24),fixtureMp4().subarray(0,40),box('ftyp',Buffer.from('isom'))])await assert.rejects(probe.inspectVideoBytes(bytes),/MP4|metadata|box/i);
});
// Real 16x16 H.264 red clip generated offline with ffmpeg (5 frames at 1 fps).
// Embedded fixture keeps clean-clone tests independent of installed media tools.
const realMp4=Buffer.from([
 'AAAAJGZ0eXBpc29tAAACAGlzb21pc282aXNvMmF2YzFtcDQxAAADCG1vb3YAAABsbXZoZAAAAAAAAAAAAAAAAAAAA+gAAAAAAAEA',
 'AAEAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
 'AAIAAAILdHJhawAAAFx0a2hkAAAAAwAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAA',
 'AQAAAAAAAAAAAAAAAAAAQAAAAAAQAAAAEAAAAAAAJGVkdHMAAAAcZWxzdAAAAAAAAAABAAAAAAAAAAAAAQAAAAABg21kaWEAAAAg',
 'bWRoZAAAAAAAAAAAAAAAAAAAQAAAAAAAVcQAAAAAAC1oZGxyAAAAAAAAAAB2aWRlAAAAAAAAAAAAAAAAVmlkZW9IYW5kbGVyAAAA',
 'AS5taW5mAAAAFHZtaGQAAAABAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAADuc3RibAAAAKJz',
 'dHNkAAAAAAAAAAEAAACSYXZjMQAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAQABAASAAAAEgAAAAAAAAAARVMYXZjNjIuMTEuMTAw',
 'IGxpYngyNjQAAAAAAAAAAAAAABj//wAAACxhdmNDAULACv/hABVnQsAK2nsBEAAAAwAQAAADACDxImoBAARozg/IAAAAEHBhc3AA',
 'AAABAAAAAQAAABBzdHRzAAAAAAAAAAAAAAAQc3RzYwAAAAAAAAAAAAAAFHN0c3oAAAAAAAAAAAAAAAAAAAAQc3RjbwAAAAAAAAAA',
 'AAAAKG12ZXgAAAAgdHJleAAAAAAAAAABAAAAAQAAAAAAAAAAAAAAAAAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAA',
 'AG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjIuMy4xMDAAAACEbW9vZgAAABBt',
 'ZmhkAAAAAAAAAAEAAABsdHJhZgAAACR0ZmhkAAAAOQAAAAEAAAAAAAADLAAAQAAAAAAXAQEAAAAAABR0ZmR0AQAAAAAAAAAAAAAA',
 'AAAALHRydW4AAAIFAAAABQAAAIwCAAAAAAAAFwAAAAkAAAAJAAAACQAAAAkAAABDbWRhdAAAABNliIQ6EYoAAhjxwABA9jgACHlg',
 'AAAABUGaIBSlAAAABUGaQBWlAAAABUGaYBWlAAAABUGagBWlAAAAQ21mcmEAAAArdGZyYQEAAAAAAAABAAAAAAAAAAEAAAAAAAAA',
 'AAAAAAAAAAMsAQEBAAAAEG1mcm8AAAAAAAAAQw=='
].join(''),'base64');
test('parses genuine embedded fragmented H264 video without an external binary',async()=>{
 const info=await probe.inspectVideoBytes(realMp4);assert.equal(info.codec,'avc1');assert.equal(info.duration,5);assert.equal(info.width,16);assert.equal(info.height,16);
 // Correctly reject genuine but undersized output for the requested 720p job.
 await assert.rejects(probe.inspectContentResponse('video',new Response(realMp4,{headers:{'content-type':'video/mp4'}})),/dimensions/);
});
test('CLI without execute is offline and never requires a wallet or .env',()=>{
 const result=spawnSync(process.execPath,['scripts/content-probe.mjs','--kind','image','--model','image'],{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:5000,env:{PATH:process.env.PATH,HOME:process.env.HOME}});
 assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).execute,false);assert.equal(JSON.parse(result.stdout).paidRequestSent,false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';

// Real seller lifecycle + installed provider + authenticated gateway + durable
// video bridge. Only the AntSeed daemon and external HTTP are offline doubles.
const harness=String.raw`
import {spawn} from 'node:child_process';
import {readFile,writeFile,unlink,chmod,symlink,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {runSeller} from './lib/seller.mjs';
import {createGateway} from './lib/gateway.mjs';
import {fetchQuotes} from './lib/pricing.mjs';
import {ConsentExpiredError} from './lib/media-pricing.mjs';
import plugin from '@local/antseed-provider-surplus';
import {captureUnitBillingContext} from '@antseed/buyer-core';
import {VIDEO_DOWNLOAD_STREAM_HEADER,VIDEO_DOWNLOAD_STREAM_VERSION} from '@antseed/node';
import {SellerRequestHandler} from './node_modules/@antseed/node/dist/seller-request-handler.js';
import {ResourceOwnershipStore} from './node_modules/@antseed/node/dist/resources/resource-ownership-store.js';
import {buildSellerPluginRuntimeEnv} from './node_modules/@antseed/cli/dist/cli/commands/seller/start.js';
const {stateDir,scenario}=JSON.parse(process.argv[1]);
const MODEL='longcat-distilled-image-to-video';const image='data:image/png;base64,'+(await readFile('./test/fixtures/red.png')).toString('base64');
const entry={model:MODEL,kind:'video',provider:'venice',inputs:['text','image'],parameters:{duration_seconds:5,resolution:'720p'},estimatedCostUsd:.2,pricingBasis:'operator-estimate'};
const start=Date.now();let clock=start;const RealDate=Date;globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock;}};
const settings={stateDir,surplusBaseUrl:'https://api.surplusintelligence.ai/v1',models:['text'],marginBps:2000,safetyBps:500,antseedFeeBps:400,lossTest:false,maxConcurrent:2,maxTokens:64,maxInputBytes:4096,quoteMaxAgeMs:60000,refreshMs:40,gatewayPort:0,dhtPort:0,signalingPort:0,rpcUrl:'http://127.0.0.1:1',mediaConfig:{version:1,reviewedAt:new Date(start-1000).toISOString(),expiresAt:new Date(start+1000).toISOString(),feeCushionBps:1000,services:[entry]}};
settings.pricingPolicy={version:1,allowEstimates:true,provider:'venice',sourceRevision:'a'.repeat(40),reviewedAt:new Date(start-1000).toISOString(),expiresAt:new Date(start+(scenario==='restart-expired-text'?500:60000)).toISOString(),feeCushionBps:1000,offerMultiplierCeiling:2};
const wallet={address:'fixture-wallet',privateKey:'0x'+'1'.repeat(64)};
const result={creates:0,retrieves:0,fetches:0,spawns:0};let child,gateway,token,provider,active,expiredReady,releaseQueue;const firstQueued=new Promise(r=>releaseQueue=r);
// Minimal five-second MP4 container, not a playable generated clip.
const box=(type,data)=>{const b=Buffer.alloc(8+data.length);b.writeUInt32BE(b.length);b.write(type,4);data.copy(b,8);return b;};
const mvhd=Buffer.alloc(100);mvhd.writeUInt32BE(1000,12);mvhd.writeUInt32BE(5000,16);const video=Buffer.concat([box('ftyp',Buffer.from('isom\0\0\0\0isom')),box('moov',box('mvhd',mvhd))]);let completed=false;
const fetchImpl=async(url,init={})=>{
 if(scenario==='outage-text-during'&&result.creates&&url.endsWith('/api/markets/text'))throw Error('fixture text book outage');
 if(['during-refresh','outage-during','outage-text-during','evidence-malformed-book','evidence-invalid-tariff'].includes(scenario)&&result.creates&&url.endsWith('/api/markets/'+MODEL)){
  clock=start+2000;if(scenario==='outage-during')throw Error('fixture public book outage');
  if(scenario==='evidence-malformed-book')return Response.json({model:'wrong',offers:null});
  if(scenario==='evidence-invalid-tariff')return Response.json({model:MODEL,offers:[{healthy:true,available:true,provider_id:'venice',seller_base_url:'https://api.venice.ai',effective_input_per_1m:0,effective_output_per_1m:0,media_unit:'job',media_unit_price:null}]});
 }
 if(init.method==='GET'&&url.endsWith('/v1/prices'))return Response.json({updated_at:new Date(start).toISOString(),models:[{model:'text',providers:[{provider:'venice',pricing:{input:1,output:2,cacheRead:.5}}]},{model:MODEL,mediaType:'video',mediaPricing:{perImageUsd:0,per1kCharsUsd:0,perMinuteUsd:0,per1MTokensUsd:0,inputPer1MUsd:0,outputPer1MUsd:0,outputPerMpUsd:0}}]});
 if(init.method==='GET'&&url.includes('/api/markets/'))return Response.json({model:url.endsWith('/text')?'text':MODEL,offers:url.endsWith('/text')?[{healthy:true,available:true,provider_id:'venice',seller_base_url:'https://api.venice.ai',effective_input_per_1m:1000000,effective_output_per_1m:2000000}]:[{healthy:true,available:true,provider_id:'venice',seller_base_url:'https://api.venice.ai',effective_input_per_1m:0,effective_output_per_1m:0,media_unit:'job',media_unit_price:100000}]});
 if(init.method==='POST'&&url.endsWith('/v1/video/generations')){result.creates++;return Response.json({id:'si_offline_1',job_token:'fixture_job_token',status:'queued'},{status:202});}
 if(init.method==='GET'&&url.endsWith('/v1/video/generations/si_offline_1')){result.retrieves++;return Response.json(completed?{id:'si_offline_1',status:'succeeded',results:[{artifact_index:0}],usage:{buyer_cost_usdc:'100000',settlement_status:'settled'}}:{id:'si_offline_1',status:'running'});}
 if(init.method==='GET'&&url.endsWith('/v1/media/artifacts/si_offline_1/0'))return new Response(video,{headers:{'content-type':'video/mp4','content-length':String(video.length)}});
 throw Error('Unexpected external call '+url);
};
let ownership=new ResourceOwnershipStore(join(stateDir,'ownership.db'));let configured,lastRequest;
const native={_deps:{resourceOwnershipStore:ownership},_closeOneOffBestEffort(){throw Error('must retain positive priced job');},_sendJsonError(_mux,_id,status){result.ownershipError=status;}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function launch(){
 let ready;const started=new Promise(r=>ready=r);let resolveExpiry;expiredReady=new Promise(r=>resolveExpiry=r);
 active=runSeller({settings,apiKey:'fixture_upstream_key',wallet,shutdownGraceMs:50,terminateGraceMs:50,
 fetchQuotes:async(...args)=>{result.fetches++;if(result.fetches>1)await firstQueued;if(clock>start+1000||['during-refresh','outage-text-during','evidence-malformed-book','evidence-invalid-tariff'].includes(scenario)&&result.creates)resolveExpiry();if(scenario==='outage'&&result.fetches>1)throw Error('fixture refresh outage');try{const quotes=await fetchQuotes(...args,fetchImpl);if(result.fetches>1){result.refreshConsentExpired=false;result.refreshUnavailable=quotes.unavailable;}return quotes;}catch(error){result.refreshError=error.message;result.refreshConsentExpired=error instanceof ConsentExpiredError;throw error;}},
 createGateway:options=>{token=options.localToken;gateway=createGateway({...options,fetchImpl});return gateway;},
 spawnImpl:(_exe,_args,options)=>{result.spawns++;child=spawn(process.execPath,['--input-type=module','-e',"process.on('SIGINT',()=>process.exit(0));console.log('READY');setInterval(()=>{},1000);"],options);child.stdout.on('data',async chunk=>{if(!String(chunk).includes('READY'))return;const cfg=JSON.parse(await readFile(join(stateDir,'config.json'),'utf8'));configured=cfg;cfg.seller.providers.surplus.baseUrl='http://127.0.0.1:'+gateway.address().port;const env=buildSellerPluginRuntimeEnv(cfg.seller,'surplus');provider=plugin.createProvider({...env,OPENAI_API_KEY:token,SURPLUS_PROTOCOLS_JSON:options.env.SURPLUS_PROTOCOLS_JSON});ready();});return child;}});
 active=active.then(code=>{result.code=code;ready();},error=>{result.error=error.message;ready();});await started;
}
let serial=0;async function request(path,body,service=MODEL){lastRequest={requestId:'offline-'+(++serial),method:'POST',path,headers:{'content-type':'application/json','x-antseed-service':service},body:Buffer.from(JSON.stringify(body))};return provider.handleRequest(lastRequest);}
const watchdog=setTimeout(()=>{console.log('DRAIN_RESULT '+JSON.stringify({...result,timedOut:true}));child?.kill('SIGKILL');gateway?.closeAllConnections();gateway?.close();process.exit(0);},4500);
try{
 await launch();
 const queued=await request('/api/v1/video/queue',{model:MODEL,prompt:'offline video',duration_seconds:5,resolution:'720p',image_url:image});result.queueStatus=queued.statusCode;
 result.queueBody=Buffer.from(queued.body).toString();const id=JSON.parse(result.queueBody).queue_id;
 const model=configured.seller.providers.surplus.services[MODEL].unitBillingModels['venice-video'];
 const billing=captureUnitBillingContext({sellerPeerId:'b'.repeat(40),provider:'surplus',service:MODEL,serviceApiProtocol:'venice-video',request:lastRequest});
 SellerRequestHandler.prototype._acceptVideoCreate.call(native,{protocol:'venice-video',action:'create'},lastRequest,queued,'a'.repeat(40),MODEL,billing,model,'fixture-paid-channel');
 result.originalPrice=ownership.getPendingCharge('venice-video',id,'a'.repeat(40))?.amount.toString();
 const preservedBytes=await readFile(join(stateDir,'retrieval-runtime.json'),'utf8');result.initialTextConfigured=!!configured.seller.providers.surplus.services.text;releaseQueue();
 if(scenario.startsWith('outage')||scenario.startsWith('evidence-')){if(scenario==='outage-text-during'||scenario.startsWith('evidence-')){await expiredReady;await sleep(70);result.closed=!gateway.listening;if(!result.closed)process.emit('SIGINT');await active;}else{await active;result.closed=!gateway.listening;}}
 else{
  if(scenario.startsWith('restart')||scenario.startsWith('bad')){
   process.emit('SIGINT');await active;ownership.close();ownership=new ResourceOwnershipStore(join(stateDir,'ownership.db'));native._deps.resourceOwnershipStore=ownership;result.firstCode=result.code;delete result.code;delete result.error;
   if(scenario==='bad-missing')await unlink(join(stateDir,'retrieval-runtime.json')).catch(()=>{});
   if(scenario==='bad-json')await writeFile(join(stateDir,'retrieval-runtime.json'),'{bad');
   if(scenario==='bad-binding')wallet.address='different-wallet';
   if(scenario==='bad-policy')settings.mediaConfig.services[0].provider='unreviewed';
   if(scenario==='bad-economics')settings.marginBps=10000;
   if(scenario==='bad-mode')await chmod(join(stateDir,'retrieval-runtime.json'),0o644);
   if(scenario==='bad-symlink'){await rename(join(stateDir,'retrieval-runtime.json'),join(stateDir,'moved.json'));await symlink(join(stateDir,'moved.json'),join(stateDir,'retrieval-runtime.json'));}
   if(scenario==='bad-price'){const file=join(stateDir,'retrieval-runtime.json'),record=JSON.parse(await readFile(file,'utf8'));record.payload.quotes.services[MODEL].unitPriceUsd=0;record.sha256=createHash('sha256').update(JSON.stringify(record.payload)).digest('hex');await writeFile(file,JSON.stringify(record));}
   clock=start+(scenario==='restart-old'?2*86400000:2000);await launch();
  }else{if(scenario!=='during-refresh')clock=start+2000;await expiredReady;await sleep(70);}
  result.alive=!!gateway?.listening&&child?.exitCode===null;
  if(result.alive)result.metadataUnchanged=(await readFile(join(stateDir,'retrieval-runtime.json'),'utf8'))===preservedBytes;
  if(result.alive){
   const route={protocol:'venice-video',action:'retrieve',resourceId:id};
   result.ownerAllowed=!SellerRequestHandler.prototype._handleVideoPrecheck.call(native,{},lastRequest,route,'a'.repeat(40),model);
   result.otherBuyerDenied=SellerRequestHandler.prototype._handleVideoPrecheck.call(native,{},lastRequest,route,'c'.repeat(40),model)&&result.ownershipError===404;
   result.preservedPrice=ownership.getPendingCharge('venice-video',id,'a'.repeat(40))?.amount.toString();
   result.wrongService=(await request('/api/v1/video/retrieve',{queue_id:id},'text')).statusCode;
   const r=await request('/api/v1/video/retrieve',{queue_id:id});result.retrieveStatus=r.statusCode;result.retrieveBody=Buffer.from(r.body).toString();
   completed=true;const chunks=[];const download=await provider.handleRequestStream({...lastRequest,requestId:'offline-download',headers:{...lastRequest.headers,[VIDEO_DOWNLOAD_STREAM_HEADER]:VIDEO_DOWNLOAD_STREAM_VERSION,'x-antseed-buyer-peer-id':'a'.repeat(40)}},{onResponseStart(){},onResponseChunk(chunk){chunks.push(Buffer.from(chunk.data));}});
   result.downloadStatus=download.statusCode;result.downloadMatches=Buffer.concat(chunks).equals(video);
   result.newStatus=(await request('/api/v1/video/queue',{model:MODEL,prompt:'must not create',duration_seconds:5,resolution:'720p',image_url:image})).statusCode;
   result.textStatus=(await fetch('http://127.0.0.1:'+gateway.address().port+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({model:'text',messages:[]})})).status;
   result.discovery=(await (await fetch('http://127.0.0.1:'+gateway.address().port+'/v1/models',{headers:{authorization:'Bearer '+token}})).json()).data;
   result.unauth=(await fetch('http://127.0.0.1:'+gateway.address().port+'/api/v1/video/retrieve',{method:'POST',headers:{'content-type':'application/json','x-antseed-service':MODEL},body:JSON.stringify({queue_id:id})})).status;
   process.emit('SIGINT');await active;
  }else await active;
 }
}catch(error){result.harnessError=error.stack;process.emit('SIGINT');await active?.catch(()=>{});}
clearTimeout(watchdog);ownership.close();result.lockExists=existsSync(join(stateDir,'seller.lock'));console.log('DRAIN_RESULT '+JSON.stringify(result));
`;
async function run(t,scenario){
 const scratch=join(homedir(),'.hermes-next','cache','scratch');await mkdir(scratch,{recursive:true,mode:0o700});
 const stateDir=await mkdtemp(join(scratch,'consent-drain-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));
 const proc=spawnSync(process.execPath,['--input-type=module','-e',harness,JSON.stringify({stateDir,scenario})],{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:8000,env:{PATH:process.env.PATH,HOME:stateDir,TMPDIR:process.env.TMPDIR}});
 assert.ifError(proc.error);assert.equal(proc.status,0,proc.stderr);const line=proc.stdout.split('\n').find(l=>l.startsWith('DRAIN_RESULT '));assert.ok(line,proc.stdout+proc.stderr);const result=JSON.parse(line.slice(13));assert.equal(result.timedOut,undefined,JSON.stringify(result));assert.equal(result.harnessError,undefined,JSON.stringify(result));
 if(scenario.startsWith('evidence-'))assert.match(proc.stderr,/Upstream model missing: longcat-distilled-image-to-video/);
 return result;
}
for(const scenario of ['refresh','during-refresh','restart','restart-old','restart-expired-text'])test(`${scenario}: consent expiry keeps durable paid video retrieval alive but rejects all new work`,async t=>{
 const r=await run(t,scenario);assert.equal(r.queueStatus,200,JSON.stringify(r));assert.equal(r.alive,true,JSON.stringify(r));assert.equal(r.retrieveStatus,200,JSON.stringify(r));assert.equal(r.downloadStatus,200);assert.equal(r.downloadMatches,true);assert.equal(r.newStatus,503);assert.equal(r.textStatus,503);assert.equal(r.initialTextConfigured,true);assert.equal(r.metadataUnchanged,true);assert.deepEqual(r.discovery,[]);assert.equal(r.unauth,401);assert.equal(r.creates,1);assert.equal(r.ownerAllowed,true);assert.equal(r.otherBuyerDenied,true);assert.ok(r.wrongService>=400);assert.ok(BigInt(r.originalPrice)>0n);assert.equal(r.preservedPrice,r.originalPrice);assert.equal(r.code,0);assert.equal(r.lockExists,false);assert.doesNotMatch(r.retrieveBody,/fixture_job_token|fixture_upstream_key|si_offline/);
 if(scenario==='during-refresh'){assert.equal(r.refreshConsentExpired,true,JSON.stringify(r));assert.match(r.refreshError,/Expired reviewed media configuration/);}
});
for(const scenario of ['bad-missing','bad-json','bad-binding','bad-policy','bad-economics','bad-mode','bad-symlink','bad-price'])test(`${scenario}: expired restart fails closed before launch`,async t=>{
 const r=await run(t,scenario);assert.equal(r.queueStatus,200,JSON.stringify(r));assert.equal(r.alive,false);assert.equal(r.spawns,1);assert.ok(r.error,JSON.stringify(r));assert.equal(r.lockExists,false);assert.equal(r.creates,1);
});
for(const scenario of ['outage','outage-during'])test(`${scenario}: arbitrary refresh outage remains fatal, never consent-drain`,async t=>{const r=await run(t,scenario);assert.equal(r.queueStatus,200,JSON.stringify(r));assert.equal(r.code,1);assert.equal(r.closed,true);assert.equal(r.lockExists,false);});
test('outage-text-during: text orderbook outage plus mid-discovery media expiry remains fatal, never consent-drain',async t=>{
 const r=await run(t,'outage-text-during');assert.equal(r.queueStatus,200,JSON.stringify(r));assert.equal(r.refreshConsentExpired,false,JSON.stringify(r));assert.ok(r.refreshError,JSON.stringify(r));assert.doesNotMatch(r.refreshError,/fixture text book outage/);assert.equal(r.code,1,JSON.stringify(r));assert.equal(r.closed,true);assert.equal(r.lockExists,false);assert.equal(r.creates,1);
});
for(const scenario of ['evidence-malformed-book','evidence-invalid-tariff'])test(`${scenario}: invalid media evidence crossing expiry remains fatal, never consent-drain`,async t=>{
 const r=await run(t,scenario);assert.equal(r.queueStatus,200,JSON.stringify(r));assert.equal(r.refreshConsentExpired,false,JSON.stringify(r));assert.equal(r.code,1,JSON.stringify(r));assert.equal(r.closed,true,JSON.stringify(r));assert.equal(r.lockExists,false);assert.equal(r.creates,1);
 assert.deepEqual(Object.keys(r.refreshUnavailable),['longcat-distilled-image-to-video']);
 assert.equal(r.refreshUnavailable['longcat-distilled-image-to-video'],scenario==='evidence-malformed-book'?'Public orderbook model/schema mismatch':'Missing/invalid media tariff price unit');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {buildAntseedConfig,prepareRuntime} from '../lib/runtime.mjs';
import {sellerEnvironment} from '../lib/seller.mjs';
import {loadSettings} from '../lib/settings.mjs';
import {createGateway} from '../lib/gateway.mjs';
import {keepAdvertisedPrices} from '../lib/repricing.mjs';
const zero={inputUsdPerMillion:0,outputUsdPerMillion:0,cachedInputUsdPerMillion:0};
const media=(kind,model,unitPriceUsd)=>({kind,upstreamModel:model,provider:'api.venice.ai',pricing:zero,upstreamPricing:zero,unitPriceUsd,estimatedUpstreamUsd:unitPriceUsd/2,media:{model,kind,provider:'venice',inputs:kind==='image'?['text']:['image'],parameters:kind==='video'?{duration_seconds:5,resolution:'720p'}:{size:'1024x1024'}},policyExpiresAt:new Date(Date.now()+60000).toISOString()});
const quotes={services:{'venice-sd35':media('image','venice-sd35',.03),'longcat-distilled-image-to-video':media('video','longcat-distilled-image-to-video',.3)}};
const settings={gatewayPort:18791,maxConcurrent:2,rpcUrl:'https://base.gateway.tenderly.co',dhtPort:6881,signalingPort:6882};
test('media config advertises native protocol and explicit paid output units instead of free zero tokens',()=>{
 const cfg=buildAntseedConfig(settings,quotes).seller.providers.surplus;
 assert.equal(cfg.plugin,'@local/antseed-provider-surplus');
 assert.deepEqual(cfg.services['venice-sd35'].unitBillingModels,{'openai-images':{version:1,components:[{unit:'output_images',priceUsd:.03}]}});
 assert.deepEqual(cfg.services['longcat-distilled-image-to-video'].unitBillingModels,{'venice-video':{version:1,components:[{unit:'video_generations',priceUsd:.3}]}});
 assert.deepEqual(cfg.services['venice-sd35'].capabilities.outputs,['image']);
 assert.equal(cfg.services['venice-sd35'].categories.includes('chat'),false);
});
test('runtime forwards a safe explicit protocol map but never upstream credentials',async()=>{
 const stateDir=await mkdtemp(join(tmpdir(),'content-runtime-'));
 const runtime=await prepareRuntime({...settings,stateDir},quotes);
 const env=sellerEnvironment(settings,runtime,{privateKey:'0x'+'1'.repeat(64)},'local-token',{PATH:'/bin',SURPLUS_API_KEY:'inf_secret'});
 assert.deepEqual(JSON.parse(env.SURPLUS_PROTOCOLS_JSON),{'venice-sd35':['openai-images'],'longcat-distilled-image-to-video':['venice-video']});
 assert.equal(env.SURPLUS_API_KEY,undefined);
 const manifest=JSON.parse(await readFile(join(runtime.home,'.antseed/plugins/package.json'),'utf8'));
 assert.ok(manifest.dependencies['@local/antseed-provider-surplus']);
});
test('media artifact download hosts require an explicit exact public hostname allowlist',async()=>{
 const s=await loadSettings({MEDIA_ARTIFACT_HOSTS:'cdn.venice.ai,assets.s3.us-east-1.amazonaws.com'});
 assert.deepEqual(s.mediaArtifactHosts,['cdn.venice.ai','assets.s3.us-east-1.amazonaws.com']);
 assert.deepEqual((await loadSettings({})).mediaArtifactHosts,[]);
 for(const value of ['*','*.venice.ai','127.0.0.1','10.0.0.1','localhost','https://cdn.venice.ai/a','cdn.venice.ai:443'])await assert.rejects(loadSettings({MEDIA_ARTIFACT_HOSTS:value}),/artifact|MEDIA_ARTIFACT_HOSTS/i);
});
test('settings loads explicitly selected media policy without changing original text model allowlist',async()=>{
 const stateDir=await mkdtemp(join(tmpdir(),'media-settings-'));const path=join(stateDir,'media.json');
 const config={version:1,services:[]};await writeFile(path,JSON.stringify(config),{mode:0o600});
 const s=await loadSettings({MEDIA_CONFIG_FILE:path});
 assert.deepEqual(s.mediaConfig,config);assert.deepEqual(s.models,['openai-gpt-oss-120b']);
});
test('authenticated model discovery includes fresh enabled media and excludes expired consent without spending',async t=>{
 const config={services:Object.values(quotes.services).map(quote=>quote.media)};
 const s={...settings,surplusBaseUrl:'https://api.surplusintelligence.ai/v1',models:['text'],mediaConfig:config,maxTokens:64,maxInputBytes:4096,quoteMaxAgeMs:60000};
 let q={...quotes,generatedAt:new Date().toISOString()};
 const server=createGateway({settings:s,apiKey:'inf_fixture',localToken:'local',getQuotes:()=>q,fetchImpl:()=>{throw Error('Discovery must not spend');}});
 await new Promise(r=>server.listen(0,r));t.after(()=>{server.closeAllConnections();server.close();});
 const url=`http://127.0.0.1:${server.address().port}/v1/models`;
 const get=()=>fetch(url,{headers:{authorization:'Bearer local'}}).then(r=>r.json());
 assert.deepEqual((await get()).data.map(row=>row.id).sort(),Object.keys(quotes.services).sort());
 q={...q,services:Object.fromEntries(Object.entries(q.services).map(([id,value])=>[id,{...value,policyExpiresAt:'2000-01-01T00:00:00Z'}]))};
 assert.deepEqual((await get()).data,[]);
});
test('extended endpoints inherit loopback bearer authentication and the root concurrency semaphore',async t=>{
 const s={...settings,surplusBaseUrl:'https://api.surplusintelligence.ai/v1',models:['text'],maxTokens:64,maxInputBytes:4096,quoteMaxAgeMs:60000,maxConcurrent:1};
 let release,called=0;const wait=new Promise(r=>release=r);
 const server=createGateway({settings:s,apiKey:'inf_fixture',localToken:'local',getQuotes:()=>quotes,extendedHandler:async(req,res)=>{called++;await wait;res.writeHead(200,{'content-type':'application/json'});res.end('{"data":[]}');return true;}});
 await new Promise(r=>server.listen(0,r));t.after(()=>{server.closeAllConnections();server.close();});
 const base=`http://127.0.0.1:${server.address().port}`;
 const post=token=>fetch(base+'/v1/images/generations',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:'{}'});
 assert.equal((await post('wrong')).status,401);assert.equal(called,0);
 const first=post('local');for(let i=0;i<100&&!called;i++)await new Promise(r=>setTimeout(r,5));
 assert.equal(called,1);assert.equal((await post('local')).status,429);release();assert.equal((await first).status,200);
});
test('media repricing stops on increased unit price, variant changes and changed billing kind',()=>{
 const a=quotes.services['venice-sd35'];const ad={services:{'venice-sd35':a}};
 assert.throws(()=>keepAdvertisedPrices(ad,{services:{'venice-sd35':{...a,unitPriceUsd:.04}}},{lossTest:false}),/price/i);
 assert.throws(()=>keepAdvertisedPrices(ad,{services:{'venice-sd35':{...a,media:{...a.media,parameters:{size:'2048x2048'}}}}},{lossTest:false}),/configuration|variant|parameter/i);
 assert.throws(()=>keepAdvertisedPrices(ad,{services:{'venice-sd35':{...a,kind:'decision'}}},{lossTest:false}),/kind|billing/i);
 const lower={...a,unitPriceUsd:.02};const result=keepAdvertisedPrices(ad,{services:{'venice-sd35':lower}},{lossTest:false});
 assert.equal(result.services['venice-sd35'].unitPriceUsd,.03);
});

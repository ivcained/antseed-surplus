import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAntseedConfig, readSellerWallet, prepareRuntime} from '../lib/runtime.mjs';
import {mkdtemp,writeFile,readFile,lstat,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {sellerEnvironment} from '../lib/seller.mjs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Wallet} from 'ethers';
const settings={stateDir:'/private/state',gatewayPort:18789,maxConcurrent:2,rpcUrl:'https://base.gateway.tenderly.co',dhtPort:6881,signalingPort:6882};
const quotes={services:{'gpt-oss-120b':{upstreamModel:'gpt-oss-120b',provider:'venice',pricing:{inputUsdPerMillion:1,outputUsdPerMillion:2,cachedInputUsdPerMillion:1}}}};
test('config advertises paid services only through loopback gateway with complete prices',()=>{
 const c=buildAntseedConfig(settings,quotes);
 assert.equal(c.seller.providers.surplus.baseUrl,'http://127.0.0.1:18789');
 assert.equal(c.seller.providers.surplus.apiKeyEnv,'SURPLUS_GATEWAY_TOKEN');
 assert.deepEqual(c.seller.providers.surplus.services['gpt-oss-120b'].pricing,quotes.services['gpt-oss-120b'].pricing);
 assert.equal(c.seller.healthCheck.enabled,false);
 assert.equal(JSON.stringify(c).includes('inf_'),false);
 assert.equal(c.seller.freeTier,undefined);
});
test('wallet signer must match declared address and owner-only secret file',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'seller-wallet-')); const file=join(dir,'wallet.json'); const w=Wallet.createRandom();
 await writeFile(file,JSON.stringify({private_key:w.privateKey,address:w.address}),{mode:0o600});
 assert.equal((await readSellerWallet({ANTSEED_WALLET_FILE:file})).address,w.address);
 await writeFile(file,JSON.stringify({private_key:w.privateKey,address:Wallet.createRandom().address}));
 await assert.rejects(readSellerWallet({ANTSEED_WALLET_FILE:file}),/address mismatch/);
});
test('runtime plugin tree is isolated from user global antseed state',async()=>{
 const stateDir=await mkdtemp(join(tmpdir(),'seller-runtime-')); const s={...settings,stateDir};
 const runtime=await prepareRuntime(s,quotes);
 const config=JSON.parse(await readFile(runtime.configPath,'utf8'));
 assert.equal(config.identity.displayName,'surplus-hive');
 assert.match(await readFile(runtime.cliPath,'utf8'),/node|import/);
 assert.equal(config.seller.providers.surplus.plugin,'openai');
 assert.equal((await lstat(join(runtime.home,'.antseed/plugins/node_modules'))).isSymbolicLink(),true);
 assert.equal((await lstat(stateDir)).mode & 0o077,0);
});

const run=promisify(execFile);
const textProtocols=['openai-chat-completions','openai-responses','anthropic-messages'];
const endpointQuotes={services:{
 'gpt-4o':{...quotes.services['gpt-oss-120b'],upstreamModel:'gpt-4o',provider:'api.openai.com'},
 'gemini-2.5-pro':{...quotes.services['gpt-oss-120b'],upstreamModel:'gemini-2.5-pro',provider:'aiplatform.googleapis.com'},
}};
const endpointSettings={...settings,pricingPolicy:{version:1,provider:'google',modelRoutes:{
 'gpt-4o':{provider:'openai',host:'api.openai.com'},
 'gemini-2.5-pro':{provider:'google',host:'aiplatform.googleapis.com'},
}}};
const endpointProtocols=Object.fromEntries(Object.keys(endpointQuotes.services).map(model=>[model,textProtocols]));
const zero={inputUsdPerMillion:0,outputUsdPerMillion:0,cachedInputUsdPerMillion:0};
const mediaQuotes={services:{
 ...quotes.services,
 image:{kind:'image',pricing:zero,unitPriceUsd:.03,media:{inputs:['text']}},
 video:{kind:'video',pricing:zero,unitPriceUsd:.3,media:{inputs:['image']}},
 decision:{kind:'decision',pricing:quotes.services['gpt-oss-120b'].pricing},
}};
const mediaProtocols={'gpt-oss-120b':textProtocols,image:['openai-images'],video:['venice-video'],decision:['typesafe-systemone']};

test('seller display name is surplus-hive across text, endpoint and media configs',()=>{
 for(const [s,q] of [[settings,quotes],[endpointSettings,endpointQuotes],[settings,mediaQuotes]]) {
  assert.equal(buildAntseedConfig(s,q).identity.displayName,'surplus-hive');
 }
});

async function isolatedRuntime(t,s,q) {
 const stateDir=await mkdtemp(join(tmpdir(),'seller-endpoint-runtime-'));
 t.after(()=>rm(stateDir,{recursive:true,force:true}));
 const isolated={...s,stateDir};
 const runtime=await prepareRuntime(isolated,q);
 const configText=await readFile(runtime.configPath,'utf8');
 const manifest=await readFile(join(runtime.home,'.antseed/plugins/package.json'),'utf8');
 // Synthetic hostile inherited values must not reach the child or its plugin.
 const env=sellerEnvironment(isolated,runtime,{privateKey:'0x'+'1'.repeat(64)},'fixture-local-token',{
  PATH:process.env.PATH,TMPDIR:tmpdir(),SURPLUS_API_KEY:'fixture-upstream-secret',
  OPENAI_API_KEY:'fixture-inherited-key',SURPLUS_PROTOCOLS_JSON:'fixture-inherited-protocols',
 });
 for(const key of ['SURPLUS_API_KEY','OPENAI_API_KEY'])assert.equal(env[key],undefined);
 assert.doesNotMatch(JSON.stringify({env,configText,manifest}),/fixture-upstream-secret|fixture-inherited-key|fixture-inherited-protocols/);
 return {runtime,env,config:JSON.parse(configText)};
}

async function loadPreparedProvider(runtime,env) {
 const loader=new URL('../node_modules/@antseed/cli/dist/plugins/loader.js',import.meta.url).href;
 const start=new URL('../node_modules/@antseed/cli/dist/cli/commands/seller/start.js',import.meta.url).href;
 // Exercise the installed CLI's discovery/config path, not a direct plugin import.
 // No daemon, requests, provider init, or network calls are needed for registration.
 const source=`
 globalThis.fetch=()=>{throw Error('Network disabled in runtime registration test');};
 const {readFile}=await import('node:fs/promises');
 const {loadProviderPlugin,buildPluginConfig}=await import(${JSON.stringify(loader)});
 const {buildSellerPluginRuntimeEnv,mergeSellerRuntimeEnv}=await import(${JSON.stringify(start)});
 const config=JSON.parse(await readFile(process.env.ANTSEED_CONFIG,'utf8'));
 const plugin=await loadProviderPlugin(config.seller.providers.surplus.plugin);
 const pluginConfig={...mergeSellerRuntimeEnv(buildPluginConfig(plugin.configSchema??plugin.configKeys??[]),buildSellerPluginRuntimeEnv(config.seller,'surplus')),ANTSEED_DATA_DIR:process.env.ANTSEED_DATA_DIR};
 const provider=await plugin.createProvider(pluginConfig);
 console.log(JSON.stringify({pluginName:plugin.name,name:provider.name,services:provider.services,protocols:provider.serviceApiProtocols,pricing:provider.pricing,pluginConfig}));`;
 const {stdout,stderr}=await run(process.execPath,['--input-type=module','-e',source],{timeout:30000,env,cwd:runtime.root});
 assert.equal(stderr,'');
 return JSON.parse(stdout);
}

test('endpoint-only token config selects literal surplus without dummy unit services',()=>{
 assert.ok(Object.values(endpointQuotes.services).every(q=>q.kind===undefined));
 const provider=buildAntseedConfig(endpointSettings,endpointQuotes).seller.providers.surplus;
 assert.equal(provider.plugin,'@local/antseed-provider-surplus');
 assert.deepEqual(Object.keys(provider.services),Object.keys(endpointQuotes.services));
 for(const [model,service] of Object.entries(provider.services)) {
  assert.deepEqual(service.pricing,endpointQuotes.services[model].pricing);
  assert.deepEqual(service.categories,['chat','surplus']);
  assert.equal(service.unitBillingModels,undefined);
  assert.equal(service.capabilities,undefined);
 }
});

test('endpoint-only prepared runtime injects explicit token protocols through the isolated seller environment',async t=>{
 const {runtime,env}=await isolatedRuntime(t,endpointSettings,endpointQuotes);
 assert.deepEqual(runtime.protocolMap,endpointProtocols);
 assert.deepEqual(JSON.parse(env.SURPLUS_PROTOCOLS_JSON),endpointProtocols);
});

test('endpoint-only installed CLI load registers surplus with exact token services and isolated credentials',async t=>{
 const {runtime,env}=await isolatedRuntime(t,endpointSettings,endpointQuotes);
 const provider=await loadPreparedProvider(runtime,env);
 assert.equal(provider.name,'surplus');
 assert.equal(provider.pluginName,'surplus');
 assert.deepEqual(provider.services,Object.keys(endpointQuotes.services));
 assert.deepEqual(provider.protocols,endpointProtocols);
 assert.deepEqual(provider.pricing.services,Object.fromEntries(Object.entries(endpointQuotes.services).map(([model,q])=>[model,q.pricing])));
 assert.equal(provider.pluginConfig.OPENAI_BASE_URL,'http://127.0.0.1:18789');
 assert.equal(provider.pluginConfig.OPENAI_API_KEY,'fixture-local-token');
 assert.equal(provider.pluginConfig.SURPLUS_GATEWAY_TOKEN,'fixture-local-token');
 assert.equal(provider.pluginConfig.SURPLUS_API_KEY,undefined);
 assert.deepEqual(JSON.parse(provider.pluginConfig.SURPLUS_PROTOCOLS_JSON),endpointProtocols);
});

for(const [label,policy] of [['absent policy',undefined],['absent model routes',{version:1,provider:'google'}],['empty model routes',{version:1,provider:'google',modelRoutes:{}}]]) {
 test(`legacy token runtime retains official openai and no protocol injection with ${label}`,async t=>{
  const {runtime,env,config}=await isolatedRuntime(t,{...settings,pricingPolicy:policy},quotes);
  assert.equal(config.seller.providers.surplus.plugin,'openai');
  assert.equal(runtime.protocolMap,undefined);
  assert.equal(env.SURPLUS_PROTOCOLS_JSON,undefined);
  const provider=await loadPreparedProvider(runtime,env);
  assert.equal(provider.name,'openai');
  assert.deepEqual(provider.services,Object.keys(quotes.services));
  assert.equal(provider.pluginConfig.OPENAI_API_KEY,'fixture-local-token');
 });
 test(`media runtime retains surplus and explicit protocols with ${label}`,async t=>{
  const {runtime,env,config}=await isolatedRuntime(t,{...settings,pricingPolicy:policy},mediaQuotes);
  assert.equal(config.seller.providers.surplus.plugin,'@local/antseed-provider-surplus');
  assert.deepEqual(runtime.protocolMap,mediaProtocols);
  assert.deepEqual(JSON.parse(env.SURPLUS_PROTOCOLS_JSON),mediaProtocols);
  const provider=await loadPreparedProvider(runtime,env);
  assert.equal(provider.name,'surplus');
  assert.deepEqual(provider.protocols,mediaProtocols);
  assert.deepEqual(provider.services,Object.keys(mediaQuotes.services));
 });
}

import {readFile,stat,mkdir,writeFile,rename,symlink,lstat} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Wallet} from 'ethers';
import {constants} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
function usesSurplusProvider(settings,quotes) {
 return Object.values(quotes.services).some(s=>s.kind) || Object.keys(settings.pricingPolicy?.modelRoutes??{}).length>0;
}
export function buildProtocolMap(quotes) {
 return Object.fromEntries(Object.entries(quotes.services).map(([model,s])=>[model,s.kind==='image'?['openai-images']:s.kind==='video'?['venice-video']:s.kind==='decision'?['typesafe-systemone']:['openai-chat-completions','openai-responses','anthropic-messages']]));
}
export function buildAntseedConfig(settings,quotes) {
 const services={};
 for(const [name,s] of Object.entries(quotes.services)) {
  for(const field of ['inputUsdPerMillion','outputUsdPerMillion','cachedInputUsdPerMillion']) {
   if(!Number.isFinite(s.pricing?.[field]) || s.pricing[field]<0) throw new Error(`Missing service price ${name}/${field}`);
  }
  const kind=s.kind??'text';
  if(!['text','image','video','decision'].includes(kind))throw Error('Unsupported billing kind');
  if(['image','video'].includes(kind) && (!Number.isFinite(s.unitPriceUsd)||s.unitPriceUsd<=0))throw Error('Missing positive media unit price');
  const protocol=kind==='image'?'openai-images':'venice-video';
  services[name]={upstreamModel:name,categories:[kind==='text'?'chat':kind,'surplus'],pricing:s.pricing,...(['image','video'].includes(kind)?{unitBillingModels:{[protocol]:{version:1,components:[{unit:kind==='image'?'output_images':'video_generations',priceUsd:s.unitPriceUsd}]}},capabilities:{inputs:s.media?.inputs??['text'],outputs:[kind]}}:{})};
 }
 if(!Object.keys(services).length) throw new Error('No safely priced services');
 return {identity:{displayName:'surplus-hive'},seller:{publicAddress:settings.publicAddress ?? '',reserveFloor:0,maxConcurrentBuyers:settings.maxConcurrent,healthCheck:{enabled:false},providers:{surplus:{plugin:usesSurplusProvider(settings,quotes)?'@local/antseed-provider-surplus':'openai',baseUrl:`http://127.0.0.1:${settings.gatewayPort}`,apiKeyEnv:'SURPLUS_GATEWAY_TOKEN',services}}},payments:{crypto:{rpcUrl:settings.rpcUrl}},network:{dhtPort:settings.dhtPort,signalingPort:settings.signalingPort}};
}
export async function readSellerWallet(env=process.env) {
 let key=env.ANTSEED_PRIVATE_KEY,declared;
 if(!key && env.ANTSEED_WALLET_FILE) {
  const info=await lstat(env.ANTSEED_WALLET_FILE);
  if(!info.isFile() || info.isSymbolicLink())throw new Error('Seller wallet must be a private regular file');
  if(info.mode&0o077) throw new Error('Seller wallet permissions must be 0600');
  const data=JSON.parse(await readFile(env.ANTSEED_WALLET_FILE,'utf8'));
  key=data.private_key ?? data.privateKey;declared=data.address;
 }
 if(!key) throw new Error('Set ANTSEED_PRIVATE_KEY or ANTSEED_WALLET_FILE');
 const wallet=new Wallet(key);
 if(declared && declared.toLowerCase()!==wallet.address.toLowerCase()) throw new Error('Seller wallet address mismatch');
 return wallet;
}
export async function atomicJson(path,data) {
 await mkdir(dirname(path),{recursive:true,mode:0o700});
 const temp=`${path}.${process.pid}.tmp`;
 const {open}=await import('node:fs/promises');
 const handle=await open(temp,'wx',0o600);
 try {await handle.writeFile(JSON.stringify(data,null,2)+'\n');await handle.sync();} finally {await handle.close();}
 await rename(temp,path);
 const dir=await open(dirname(path),'r');try{await dir.sync();}finally{await dir.close();}
}
const retrievalPath=settings=>join(settings.stateDir,'retrieval-runtime.json');
const checksum=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function retrievalBinding(settings,wallet) {
 return {seller:wallet.address.toLowerCase(),surplusBaseUrl:settings.surplusBaseUrl,mediaConfig:settings.mediaConfig,pricingPolicy:settings.pricingPolicy??null,marginBps:settings.marginBps,safetyBps:settings.safetyBps,antseedFeeBps:settings.antseedFeeBps??400,lossTest:settings.lossTest??false};
}
function validateRetrievalQuotes(settings,quotes) {
 const generated=Date.parse(quotes?.generatedAt),policy=settings.mediaConfig;
 if(!Number.isFinite(generated)||generated<Date.parse(policy.reviewedAt)-60000||generated>=Date.parse(policy.expiresAt)||!quotes.services||!Object.keys(quotes.services).length)throw Error('Invalid preserved video metadata');
 const zero={inputUsdPerMillion:0,outputUsdPerMillion:0,cachedInputUsdPerMillion:0};
 const round=n=>Math.ceil(n*1e9-Number.EPSILON*n*1e9)/1e9;
 for(const [model,q]of Object.entries(quotes.services)) {
  const entry=policy.services.find(s=>s.model===model);
  const estimate=round(entry?.estimatedCostUsd*(1+policy.feeCushionBps/10000));
  const factor=(1+settings.safetyBps/10000)/((1-settings.marginBps/10000)*(1-(settings.antseedFeeBps??400)/10000));
  const unit=round(estimate*factor);
  if(!entry||entry.kind!=='video'||q.kind!=='video'||q.upstreamModel!==model||q.provider!=='api.venice.ai'||!isDeepStrictEqual(q.media,entry)||q.policyExpiresAt!==policy.expiresAt||q.guaranteedBound!==false||q.priceBasis!=='reviewed-operator-estimate'||q.feeCushionBps!==policy.feeCushionBps||q.antseedFeeBps!==(settings.antseedFeeBps??400)||q.maxPricePer1m!==0||!isDeepStrictEqual(q.pricing,zero)||!isDeepStrictEqual(q.upstreamPricing,zero)||q.estimatedUpstreamUsd!==estimate||!Number.isFinite(q.unitPriceUsd)||q.unitPriceUsd<unit)throw Error('Invalid preserved video pricing/binding');
 }
 buildAntseedConfig(settings,quotes);
}
export async function saveRetrievalRuntime(settings,wallet,quotes) {
 const services=Object.fromEntries(Object.entries(quotes.services).filter(([,q])=>q.kind==='video'));
 if(!Object.keys(services).length)return;
 const preserved={generatedAt:quotes.generatedAt,services};validateRetrievalQuotes(settings,preserved);
 const payload={version:1,binding:retrievalBinding(settings,wallet),quotes:preserved};
 await atomicJson(retrievalPath(settings),{payload,sha256:checksum(payload)});
}
export async function loadRetrievalRuntime(settings,wallet) {
 // No symlinks, permissive permissions, partial JSON or missing snapshots. This
 // snapshot contains public tariffs only; job tokens remain in the bridge store.
 const {open}=await import('node:fs/promises');
 const file=await open(retrievalPath(settings),constants.O_RDONLY|constants.O_NOFOLLOW);
 let record;
 try{const info=await file.stat();if(!info.isFile()||info.mode&0o077||info.size>1024*1024)throw Error('Unsafe preserved video metadata');record=JSON.parse(await file.readFile('utf8'));}finally{await file.close();}
 if(record?.payload?.version!==1||record.sha256!==checksum(record.payload)||!isDeepStrictEqual(record.payload.binding,retrievalBinding(settings,wallet)))throw Error('Invalid preserved video runtime binding');
 validateRetrievalQuotes(settings,record.payload.quotes);return record.payload.quotes;
}
export async function prepareRuntime(settings,quotes) {
 await mkdir(settings.stateDir,{recursive:true,mode:0o700});
 const home=join(settings.stateDir,'home');
 const plugins=join(home,'.antseed','plugins');
 await mkdir(plugins,{recursive:true,mode:0o700});
 const modules=join(plugins,'node_modules');
 try {await symlink(join(root,'node_modules'),modules,'dir');} catch(e){if(e.code!=='EEXIST') throw e;const st=await lstat(modules);if(!st.isSymbolicLink())throw new Error('Unexpected runtime plugin tree');}
 await atomicJson(join(plugins,'package.json'),{name:'seller-private-plugins',private:true,dependencies:{'@antseed/provider-openai':'0.2.53','@local/antseed-provider-surplus':'file:plugins/surplus'}});
 const configPath=join(settings.stateDir,'config.json');
 const config=buildAntseedConfig(settings,quotes);
 // Fork: merge operator-owned verified-identity claims so they survive every restart.
 try {
  const v=JSON.parse(await readFile(join(settings.stateDir,'seller-verifications.json'),'utf8'));
  if(v && typeof v==='object' && !Array.isArray(v)) config.seller.verifications=v;
 } catch(e) { if(e.code!=='ENOENT') throw e; }
 await atomicJson(configPath,config);
 return {home,configPath,root,...(usesSurplusProvider(settings,quotes)?{protocolMap:buildProtocolMap(quotes)}:{}),cliPath:join(root,'node_modules','@antseed','cli','dist','cli','index.js')};
}

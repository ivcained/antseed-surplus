import {readFile,stat,mkdir,writeFile,rename,symlink,lstat} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Wallet} from 'ethers';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function buildAntseedConfig(settings,quotes) {
 const services={};
 for(const [name,s] of Object.entries(quotes.services)) {
  for(const field of ['inputUsdPerMillion','outputUsdPerMillion','cachedInputUsdPerMillion']) {
   if(!Number.isFinite(s.pricing?.[field]) || s.pricing[field]<0) throw new Error(`Missing service price ${name}/${field}`);
  }
  services[name]={upstreamModel:name,categories:['chat','surplus'],pricing:s.pricing};
 }
 if(!Object.keys(services).length) throw new Error('No safely priced services');
 return {identity:{displayName:'Surplus-backed seller'},seller:{publicAddress:settings.publicAddress ?? '',reserveFloor:0,maxConcurrentBuyers:settings.maxConcurrent,healthCheck:{enabled:false},providers:{surplus:{plugin:'openai',baseUrl:`http://127.0.0.1:${settings.gatewayPort}`,apiKeyEnv:'SURPLUS_GATEWAY_TOKEN',services}}},payments:{crypto:{rpcUrl:settings.rpcUrl}},network:{dhtPort:settings.dhtPort,signalingPort:settings.signalingPort}};
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
export async function prepareRuntime(settings,quotes) {
 await mkdir(settings.stateDir,{recursive:true,mode:0o700});
 const home=join(settings.stateDir,'home');
 const plugins=join(home,'.antseed','plugins');
 await mkdir(plugins,{recursive:true,mode:0o700});
 const modules=join(plugins,'node_modules');
 try {await symlink(join(root,'node_modules'),modules,'dir');} catch(e){if(e.code!=='EEXIST') throw e;const st=await lstat(modules);if(!st.isSymbolicLink())throw new Error('Unexpected runtime plugin tree');}
 await atomicJson(join(plugins,'package.json'),{name:'seller-private-plugins',private:true,dependencies:{'@antseed/provider-openai':'0.2.53'}});
 const configPath=join(settings.stateDir,'config.json');
 await atomicJson(configPath,buildAntseedConfig(settings,quotes));
 return {home,configPath,root,cliPath:join(root,'node_modules','@antseed','cli','dist','cli','index.js')};
}

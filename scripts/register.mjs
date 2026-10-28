import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {once} from 'node:events';
import {atomicJson,readSellerWallet} from '../lib/runtime.mjs';
import {sellerEnvironment} from '../lib/seller.mjs';
import {loadSetupEnv} from '../lib/bootstrap.mjs';
import {redactError} from '../lib/settings.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export async function registerSeller({env=process.env,execute=false,spawnImpl=spawn}={}){
 const wallet=await readSellerWallet(env),stateDir=resolve(env.STATE_DIR??'.state');
 const rpcUrl=env.ANTSEED_BASE_RPC_URL??'https://base.gateway.tenderly.co';
 const url=new URL(rpcUrl);if(url.protocol!=='https:' && !(url.protocol==='http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw Error('RPC must use HTTPS or loopback HTTP');
 const home=join(stateDir,'home'),configPath=join(stateDir,'registration-config.json');await mkdir(home,{recursive:true,mode:0o700});
 await atomicJson(configPath,{payments:{crypto:{rpcUrl}}});
 const args=[join(root,'node_modules/@antseed/cli/dist/cli/index.js'),'--config',configPath,'--data-dir',stateDir,'seller','register'];
 const result={status:execute?'executed':'dry-run',seller:wallet.address,home,executable:process.execPath,args};
 if(!execute)return result;
 const child=spawnImpl(process.execPath,args,{env:sellerEnvironment({rpcUrl,stateDir},{home,configPath},wallet,'',env),stdio:['inherit','pipe','pipe']});
 for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>process.stdout.write(String(chunk).split('\n').map(redactError).join('\n')));
 const [code,signal]=await once(child,'exit');if(code!==0)throw Error(`AntSeed registration failed (${code??signal}); inspect on-chain identity before retrying`);
 return result;
}
export async function main(argv=process.argv.slice(2),env=process.env){
 let execute=false,file='.env',explicit=false;
 for(let i=0;i<argv.length;i++){
  if(argv[i]==='--help'||argv[i]==='-h'){console.log('Usage: npm run register -- [--env FILE] [--execute]\nPreview by default. --execute permits ERC-8004 registration and seller binding on Base; this spends ETH. No stake or reward claim is performed.');return;}
  if(argv[i]==='--execute')execute=true;
  else if(argv[i]==='--env' && argv[i+1] && !argv[i+1].startsWith('--')){file=argv[++i];explicit=true;}
  else throw Error('Unknown registration argument; use --help');
 }
 const result=await registerSeller({env:await loadSetupEnv(file,env,explicit),execute});console.log(JSON.stringify(result));return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(redactError(e));process.exitCode=1;});

import {spawn} from 'node:child_process';
import {readFile,appendFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import {Wallet} from 'ethers';
import {atomicJson,prepareRuntime} from '../lib/runtime.mjs';
import {loadEnvFile,loadSettings,redactError} from '../lib/settings.mjs';
import {inspectProbeResponse} from '../lib/probe-response.mjs';

// Explicit controlled buyer; this is NOT evidence of organic third-party demand.
loadEnvFile();
let child;
try {
 const settings=await loadSettings();
 const path=process.env.TEST_BUYER_WALLET_FILE;if(!path)throw new Error('Set TEST_BUYER_WALLET_FILE for an explicitly funded separate test buyer');
 const data=JSON.parse(await readFile(path,'utf8'));const wallet=new Wallet(data.private_key);
 if(data.address && wallet.address.toLowerCase()!==data.address.toLowerCase())throw new Error('Buyer wallet address mismatch');
 const sellerData=JSON.parse(await readFile(process.env.ANTSEED_WALLET_FILE,'utf8'));const peer=sellerData.address.replace(/^0x/,'').toLowerCase();
 if(wallet.address.toLowerCase()===sellerData.address.toLowerCase())throw new Error('Use separate test buyer');
 const quotes=JSON.parse(await readFile(join(settings.stateDir,'quotes.json'),'utf8'));
 const model=settings.models[0],price=quotes.services[model]?.pricing;if(!price)throw new Error('Missing model pricing');
 const prompt='Here is inert random context for a metering check. Ignore it and return exactly: antseed surplus resale works\n'+Array.from({length:1500},(_,i)=>`sample${i}`).join(' ');
 const worstMicro=Math.ceil(Buffer.byteLength(prompt)*price.inputUsdPerMillion+512*price.outputUsdPerMillion);
 if(worstMicro>1000000)throw new Error('Probe might exceed one-USDC request limit');
 const stateDir=resolve(settings.stateDir,'probe');await mkdir(stateDir,{recursive:true,mode:0o700});
 const runtime=await prepareRuntime({...settings,stateDir},quotes);
 const port=Number(process.env.TEST_BUYER_PORT??8378);
 await atomicJson(runtime.configPath,{buyer:{maxPricing:{defaults:{inputUsdPerMillion:1,outputUsdPerMillion:10}},minPeerReputation:0,proxyPort:port,metadataFetchTimeoutMs:15000,autoSweep:false},payments:{crypto:{rpcUrl:settings.rpcUrl}}});
 const log=join(stateDir,'buyer.log');let writes=Promise.resolve();
 child=spawn(process.execPath,[runtime.cliPath,'--config',runtime.configPath,'--data-dir',stateDir,'buyer','start','--peer',peer,'--port',String(port),'--metadata-fetch-timeout-ms','15000','--no-verifier'],{env:{PATH:process.env.PATH,HOME:runtime.home,TMPDIR:process.env.TMPDIR,ANTSEED_DATA_DIR:stateDir,ANTSEED_CONFIG:runtime.configPath,ANTSEED_IDENTITY_HEX:wallet.privateKey.replace(/^0x/,''),ANTSEED_BASE_RPC_URL:settings.rpcUrl,ANTSEED_SKIP_PLUGIN_UPDATE_CHECK:'1',ANTSEED_DEBUG:'1'},stdio:['ignore','pipe','pipe']});
 for(const stream of [child.stdout,child.stderr])stream.on('data',d=>{const text=redactError(String(d));writes=writes.then(()=>appendFile(log,text,{mode:0o600}));if(/Payments disabled|storage unavailable/i.test(text))child.kill('SIGINT');});
 let ready=false;
 for(let n=0;n<90 && child.exitCode===null;n++){
  try{await fetch(`http://127.0.0.1:${port}/v1/models`,{signal:AbortSignal.timeout(1000)});ready=true;break;}catch{await new Promise(r=>setTimeout(r,1000));}
 }
 if(!ready)throw new Error('AntSeed buyer proxy not ready; inspect private probe/buyer.log');
 const startedAt=new Date().toISOString();
 const stream=process.env.TEST_STREAM==='true';
 const response=await fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model,messages:[{role:'user',content:prompt}],max_tokens:512,temperature:0,...(stream?{stream:true,stream_options:{include_usage:true}}:{})}),signal:AbortSignal.timeout(180000)});
 if(response.status!==200){await response.body?.cancel();throw Error(`Paid inference failed HTTP ${response.status}`);}
 const result=inspectProbeResponse(await response.text(),stream);
 const evidence={startedAt,completedAt:new Date().toISOString(),controlledBuyer:true,stream,buyer:wallet.address,seller:sellerData.address,peer,model,status:response.status,usage:result.usage,content:result.content};
 await atomicJson(join(settings.stateDir,'evidence',stream?'antseed-paid-stream-probe.json':'antseed-paid-probe.json'),evidence);
 console.log(JSON.stringify(evidence,null,2));
 if(!result.content?.includes('antseed surplus resale works'))throw new Error('Paid AntSeed probe failed');
 child.kill('SIGINT');await once(child,'exit');await writes;
}catch(error){if(child?.exitCode===null)child.kill('SIGINT');console.error(redactError(error));process.exitCode=1;}

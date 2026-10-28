#!/usr/bin/env node
// Controlled, explicitly funded buyer. This is not organic third-party demand.
// Dry-run is completely offline. Only --execute may start a buyer or send a request.
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {mkdir,lstat,readFile,writeFile,open} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {Wallet} from 'ethers';
import {atomicJson,prepareRuntime} from '../lib/runtime.mjs';
import {loadEnvFile,loadSettings,redactError} from '../lib/settings.mjs';
import {parseContentArgs,probeBudget,validateProbeQuote,buildBuyerConfig,buildContentRequest,estimateContentRequestCost,readProbeInput,readPrivateJson,executeContentRequest,stopBuyer,probeBudgetPreload} from '../lib/content-probe.mjs';
import {waitForProbeReadiness} from '../lib/probe-readiness.mjs';

let child,logHandle,evidenceDir,context,writes=Promise.resolve(),fatal=false;
const readinessAbort=new AbortController();
const clean=value=>redactError(value).replace(/\b[0-9a-fA-F]{64}\b/g,'[REDACTED]').slice(0,4096);
async function privateDir(path){await mkdir(path,{recursive:true,mode:0o700});const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077))throw Error('Probe directories must be private (0700), not symlinks');}
async function availablePort(port){await new Promise((resolve,reject)=>{const server=createServer();server.once('error',()=>reject(Error('TEST_BUYER_PORT is already occupied or unavailable')));server.listen(port,'127.0.0.1',()=>server.close(resolve));});}
async function interrupted(signal){fatal=true;readinessAbort.abort();process.exitCode=signal==='SIGINT'?130:143;await stopBuyer(child,{processGroup:true}).catch(()=>{});}
const onInt=()=>void interrupted('SIGINT'),onTerm=()=>void interrupted('SIGTERM');
try {
 const args=parseContentArgs(process.argv.slice(2));
 if(!args.execute){
  // Do not load env, wallet, quotes or even input in an offline plan.
  console.log(JSON.stringify({execute:false,paidRequestSent:false,controlledBuyer:true,kind:args.kind,model:args.model,inputRequired:['edit','video','vision','audio-input','file-input','video-input'].includes(args.kind),budgetDefaultUsd:1,budgetMaximumUsd:args.kind==='video'?5:1,note:'No state was read or buyer started. Explicit --execute required; supports one dispatch only.'},null,2));
 }else{
  loadEnvFile();
  const settings=await loadSettings(),budget=probeBudget(args.kind);
  if(!process.env.ANTSEED_WALLET_FILE||!process.env.TEST_BUYER_WALLET_FILE)throw Error('Set ANTSEED_WALLET_FILE and separately funded TEST_BUYER_WALLET_FILE');
  // Never silently honor an inherited seller private key in place of the pinned file.
  const sellerData=await readPrivateJson(process.env.ANTSEED_WALLET_FILE),buyerData=await readPrivateJson(process.env.TEST_BUYER_WALLET_FILE);
  const seller=new Wallet(sellerData.private_key??sellerData.privateKey),buyer=new Wallet(buyerData.private_key??buyerData.privateKey);
  for(const [data,wallet] of [[sellerData,seller],[buyerData,buyer]])if(data.address&&data.address.toLowerCase()!==wallet.address.toLowerCase())throw Error('Wallet address mismatch');
  if(seller.address.toLowerCase()===buyer.address.toLowerCase())throw Error('Use a separate explicitly funded test buyer');
  const peer=seller.address.slice(2).toLowerCase();
  const quotes=JSON.parse(await readFile(join(settings.stateDir,'quotes.json'),'utf8'));
  const service=validateProbeQuote(settings,quotes,args.kind,args.model,budget);
  const input=await readProbeInput(args.input,args.kind);const request=buildContentRequest(args.kind,args.model,input);
  // Conservative byte-count bound for the tiny text request. Media tokenization
  // can differ by provider: the child ReserveAuth guard is the hard limit.
  if(!['image','edit','video'].includes(args.kind)){
   const estimate=estimateContentRequestCost(request,service.pricing);
   if(!Number.isFinite(estimate)||estimate>budget)throw Error('Conservative token estimate exceeds local budget');
  }
  const expectedContains=process.env.TEST_EXPECT_CONTAINS;
  if(['audio-input','file-input','video-input'].includes(args.kind)&&(!expectedContains?.trim()||expectedContains.length>256))throw Error('Set TEST_EXPECT_CONTAINS (1-256 characters) for objective understanding validation');
  const assetHosts=(process.env.TEST_ASSET_HOSTS??'').split(',').filter(Boolean);
  if(assetHosts.some(host=>!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host)||host.endsWith('.localhost')||host.endsWith('.local')))throw Error('Invalid explicit TEST_ASSET_HOSTS');
  const rawPort=process.env.TEST_BUYER_PORT??'8378';if(!/^\d+$/.test(rawPort))throw Error('Invalid TEST_BUYER_PORT');
  const port=Number(rawPort);if(!Number.isSafeInteger(port)||port<1024||port>65535||port===settings.gatewayPort)throw Error('Invalid/conflicting TEST_BUYER_PORT');
  await availablePort(port);
  // A unique kind/run subtree prevents old identity/session/job reuse.
  await privateDir(settings.stateDir);
  const probeRoot=join(settings.stateDir,'content-probe');await privateDir(probeRoot);
  const kindDir=join(probeRoot,args.kind);await privateDir(kindDir);
  const runId=`${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID()}`;
  const stateDir=join(kindDir,runId);await privateDir(stateDir);
  evidenceDir=join(stateDir,'evidence');await privateDir(evidenceDir);
  context={controlledBuyer:true,kind:args.kind,model:args.model,buyer:buyer.address,seller:seller.address,peer,budgetUsd:budget,startedAt:new Date().toISOString(),...(input?{inputBytes:input.bytes.length,inputMime:input.mime}:{})};
  const runtime=await prepareRuntime({...settings,stateDir},quotes);
  await atomicJson(runtime.configPath,buildBuyerConfig(settings,service,args.model,budget,port,peer));
  logHandle=await open(join(stateDir,'buyer.log'),'wx',0o600);let logged=0,guardReady=false,dispatchGuardReady=false;
  child=spawn(process.execPath,['--import',probeBudgetPreload(budget,{kind:args.kind,model:args.model,peer}),runtime.cliPath,'--config',runtime.configPath,'--data-dir',stateDir,'buyer','start','--peer',peer,'--port',String(port),'--metadata-fetch-timeout-ms','15000','--no-verifier'],{detached:true,env:{PATH:process.env.PATH,HOME:runtime.home,TMPDIR:process.env.TMPDIR,ANTSEED_DATA_DIR:stateDir,ANTSEED_CONFIG:runtime.configPath,ANTSEED_IDENTITY_HEX:buyer.privateKey.slice(2),ANTSEED_BASE_RPC_URL:settings.rpcUrl,ANTSEED_SKIP_PLUGIN_UPDATE_CHECK:'1'},stdio:['ignore','pipe','pipe']});
  let spawnError;child.once('error',()=>{spawnError=Error('AntSeed buyer process failed to start');fatal=true;readinessAbort.abort();});
  child.once('exit',()=>readinessAbort.abort());
  for(const stream of [child.stdout,child.stderr]){
   let pending='';
   stream.on('data',bytes=>{
    pending+=String(bytes);
    if(pending.length>65536){pending='';fatal=true;void stopBuyer(child,{processGroup:true}).catch(()=>{});return;}
    const lines=pending.split('\n');pending=lines.pop();
    for(const line of lines){
     const text=clean(line)+'\n';
     if(line==='CONTENT_PROBE_BUDGET_GUARD_READY')guardReady=true;
     if(line==='CONTENT_PROBE_DISPATCH_GUARD_READY')dispatchGuardReady=true;
     if(logged<1024*1024){logged+=Buffer.byteLength(text);writes=writes.then(()=>logHandle.write(text)).catch(()=>{fatal=true;});}
     if(/Payments disabled|storage unavailable/i.test(text)){fatal=true;void stopBuyer(child,{processGroup:true}).catch(()=>{});}
    }
   });
  }
  process.on('SIGINT',onInt);process.on('SIGTERM',onTerm);
  const baseUrl=`http://127.0.0.1:${port}`;let ready=false;
  for(let n=0;n<60&&!fatal&&child.exitCode===null&&child.signalCode===null;n++){
   try{const response=await fetch(`${baseUrl}/v1/models`,{redirect:'error',signal:AbortSignal.timeout(1000)});await response.body?.cancel();if(response.ok){ready=true;break;}}catch{}
   await new Promise(resolve=>setTimeout(resolve,1000));
  }
  if(!ready||!guardReady||!dispatchGuardReady||fatal)throw spawnError??Error('AntSeed buyer not ready, hard budget/exact-model dispatch guard missing or payments disabled; inspect private buyer.log');
  // Execution-only: eager transport may establish payment/session state. The
  // existing hard budget/dispatch preload must be ready before this preflight.
  await waitForProbeReadiness({baseUrl,peer,kind:args.kind,model:args.model,service,signal:readinessAbort.signal});
  if(fatal||child.exitCode!==null||child.signalCode!==null)throw Error('AntSeed buyer terminated during readiness');
  // Freshness/consent is rechecked after startup, immediately before dispatch.
  validateProbeQuote(settings,quotes,args.kind,args.model,budget);
  const result=await executeContentRequest({kind:args.kind,model:args.model,input,baseUrl,peer,budget,expectedContains,assetHosts,onResponseInspection:inspection=>atomicJson(join(evidenceDir,'response-inspection.json'),inspection)});
  if(fatal)throw Error('Buyer terminated during paid request');
  if(args.kind==='edit'&&input&&result.bytes?.equals(input.bytes))throw Error('Edit returned unchanged source bytes');
  let artifact;
  if(result.bytes){artifact=`output.${result.media.mime==='video/mp4'?'mp4':result.media.mime==='image/jpeg'?'jpg':result.media.mime==='image/webp'?'webp':'png'}`;await writeFile(join(evidenceDir,artifact),result.bytes,{mode:0o600,flag:'wx'});}
  const {bytes,...inspection}=result;
  const evidence={...context,completedAt:new Date().toISOString(),success:true,paidRequestSent:true,...inspection,...(artifact?{artifact}:{ }),usageProvenance:result.usage?'upstream response, not independently reconciled settlement':'No upstream final usage supplied; do not infer final charge from success'};
  await atomicJson(join(evidenceDir,'result.json'),evidence);
  console.log(JSON.stringify({...evidence,evidenceDir},null,2));
 }
}catch(error){
 process.exitCode=process.exitCode||1;
 const message=clean(error);
 if(evidenceDir&&context)await atomicJson(join(evidenceDir,'failure.json'),{...context,completedAt:new Date().toISOString(),success:false,status:Number.isInteger(error.status)?error.status:null,error:message,note:'A failed or timed-out accepted request may still incur a charge; no automatic retry or cancellation.'}).catch(()=>{});
 console.error(message);
}finally{
 try{await stopBuyer(child,{processGroup:true});}catch(error){console.error(clean(error));process.exitCode=process.exitCode||1;}
 await writes;await logHandle?.close();
 process.off('SIGINT',onInt);process.off('SIGTERM',onTerm);
}

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareRuntime, atomicJson, saveRetrievalRuntime, loadRetrievalRuntime } from './runtime.mjs';
import { ConsentExpiredError } from './media-pricing.mjs';
import { redactError } from './settings.mjs';
import { keepAdvertisedPrices } from './repricing.mjs';
import { createRequire } from 'node:module';
export function sellerEnvironment(settings,runtime,wallet,localToken,parent=process.env) {
 return {PATH:parent.PATH,HOME:runtime.home,...(parent.TMPDIR?{TMPDIR:parent.TMPDIR}:{}),ANTSEED_IDENTITY_HEX:wallet.privateKey.replace(/^0x/,''),ANTSEED_BASE_RPC_URL:settings.rpcUrl,ANTSEED_DATA_DIR:settings.stateDir,ANTSEED_CONFIG:runtime.configPath,SURPLUS_GATEWAY_TOKEN:localToken,...(runtime.protocolMap?{SURPLUS_PROTOCOLS_JSON:JSON.stringify(runtime.protocolMap)}:{}),ANTSEED_SKIP_PLUGIN_UPDATE_CHECK:'1',ANTSEED_DEBUG:'1'};
}
export async function runSeller({settings,apiKey,wallet,fetchQuotes,createGateway,spawnImpl=spawn,shutdownGraceMs=20_000,terminateGraceMs=5_000}) {
 await mkdir(settings.stateDir,{recursive:true,mode:0o700});
 const lockPath=join(settings.stateDir,'seller.lock');
 const lock=await open(lockPath,'wx',0o600).catch(error=>{if(error.code==='EEXIST')throw new Error('Seller lock exists. Check prior process before removing stale lock.');throw error;});
 let quotes,child,childExit,gateway,interval,shutdown,fatalCause,operatorSignal=false,stopping=false,refreshing=false,draining=false;
 let eventWrites=Promise.resolve(),logWrites=Promise.resolve(),refreshTask=Promise.resolve();
 const running=()=>child?.pid && child.exitCode===null && child.signalCode===null;
 const stop=reason=>{
  if(shutdown)return shutdown;
  stopping=true;clearInterval(interval);quotes=null;
  console.error(`Stopping seller: ${reason}`);
  shutdown=(async()=>{
   if(running()){
    child.kill('SIGINT');
    const term=setTimeout(()=>{if(running())child.kill('SIGTERM');},shutdownGraceMs);term.unref();
    const kill=setTimeout(()=>{if(running()){fatalCause??='AntSeed required SIGKILL';child.kill('SIGKILL');}},shutdownGraceMs+terminateGraceMs);kill.unref();
    try{await childExit;}finally{clearTimeout(term);clearTimeout(kill);}
   }
   if(gateway){gateway.closeAllConnections();await new Promise(resolve=>gateway.close(resolve));}
  })();
  return shutdown;
 };
 const fail=reason=>{fatalCause??=reason;return stop(reason);};
 const onSignal=()=>{operatorSignal=true;void stop('signal');};
 try {
  await lock.writeFile(JSON.stringify({pid:process.pid,wallet:wallet.address,startedAt:new Date().toISOString()}));await lock.sync();
  const require=createRequire(import.meta.url);
  try {const Database=require('better-sqlite3');const db=new Database(':memory:');db.prepare('select 1').get();db.close();}
  catch {throw new Error('SQLite native module cannot load. Run npm ci using the same Node executable that runs the seller.');}
  let initial;
  try{initial=await fetchQuotes(settings,apiKey);}
  catch(error){
   if(!(error instanceof ConsentExpiredError))throw error;
   initial=await loadRetrievalRuntime(settings,wallet);draining=true;
  }
  if(!draining)await saveRetrievalRuntime(settings,wallet,initial);
  const runtime=await prepareRuntime(settings,initial);
  quotes=draining?null:initial;
  const localToken=randomBytes(32).toString('hex');
  const eventPath=join(settings.stateDir,'gateway-events.jsonl');
  gateway=createGateway({settings,apiKey,localToken,getQuotes:()=>draining || [settings.mediaConfig?.expiresAt,settings.pricingPolicy?.expiresAt].some(until=>Date.parse(until)<=Date.now())?null:quotes,onEvent:event=>{eventWrites=eventWrites.then(()=>appendFile(eventPath,JSON.stringify({at:new Date().toISOString(),...event})+'\n',{mode:0o600}));eventWrites.catch(()=>{void fail('event journal failed');});}});
  if(!draining)await atomicJson(join(settings.stateDir,'quotes.json'),initial);
  await new Promise((resolve,reject)=>{gateway.once('error',reject);gateway.listen(settings.gatewayPort,'127.0.0.1',resolve);});
  console.log(`Surplus gateway ready on loopback port ${settings.gatewayPort}; seller ${wallet.address}`);
  const args=[runtime.cliPath,'--config',runtime.configPath,'--data-dir',settings.stateDir,'seller','start','--provider','surplus','--dht-port',String(settings.dhtPort),'--signaling-port',String(settings.signalingPort),'--base-rpc-url',settings.rpcUrl,'--min-settle-delta','0.000001']; // Fork: seller dashboard enabled (see DASHBOARD note in README)
  child=spawnImpl(process.execPath,args,{env:sellerEnvironment(settings,runtime,wallet,localToken),stdio:['ignore','pipe','pipe']});
  // Register once, before any shutdown path can run; failed spawns emit error,
  // not exit, and signal-terminated children keep exitCode === null forever.
  childExit=new Promise(resolve=>{
   child.once('exit',(code,signal)=>resolve({code,signal}));
   child.once('error',error=>{console.error(redactError(error));resolve({error});void fail('AntSeed launch failure');});
  });
  const logPath=join(settings.stateDir,'seller.log');
  for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{
   const text=String(chunk).split('\n').map(redactError).join('\n');
   process.stdout.write(text);logWrites=logWrites.then(()=>appendFile(logPath,text,{mode:0o600}));
   logWrites.catch(()=>{void fail('seller log failed');});
   if(/Payments disabled|Metering storage unavailable|ChannelStore unavailable|metering storage is unavailable/i.test(text))void fail('AntSeed payment persistence unavailable; refusing unpaid upstream use');
  });
  if(!draining)interval=setInterval(()=>{
   if(refreshing || stopping)return;refreshing=true;
   refreshTask=(async()=>{
    try {const fresh=await fetchQuotes(settings,apiKey);if(stopping)return;quotes=keepAdvertisedPrices(initial,fresh,settings);await atomicJson(join(settings.stateDir,'quotes.json'),quotes);}
    catch(error){
     if(error instanceof ConsentExpiredError && !stopping){
      try{
       await loadRetrievalRuntime(settings,wallet);
       draining=true;clearInterval(interval);quotes=null;
       console.error('Pricing consent expired; retrieval-only (no new work)');
       return;
      }catch(metadataError){error=metadataError;}
     }
     console.error(redactError(error));
     // Fork: a transient refresh failure retains the last consented quotes
     // inside the staleness bound (the gateway refuses quotes older than
     // quoteMaxAgeMs); only a failure that outlives the bound stops the seller.
     const generated=Date.parse(quotes?.generatedAt??'');
     const age=Number.isFinite(generated)?Date.now()-generated:Infinity;
     if(age<=settings.quoteMaxAgeMs){
      console.error('quote refresh failed; retaining last quotes inside the staleness bound');
     }else{
      quotes=null;
      await fail('price refresh failed beyond the quote staleness bound; rerun prices/restart before serving');
     }
    }
    finally{refreshing=false;}
   })();
  },settings.refreshMs);
  process.on('SIGINT',onSignal);process.on('SIGTERM',onSignal);
  const {code,signal}=await childExit;
  await stop(`AntSeed exited (${code ?? signal ?? 'launch failure'})`);
  await refreshTask;await eventWrites;await logWrites;
  if(fatalCause)return code || 1;
  return code ?? (operatorSignal && ['SIGINT','SIGTERM'].includes(signal)?0:1);
 }finally{
  clearInterval(interval);process.off('SIGINT',onSignal);process.off('SIGTERM',onSignal);
  try{await stop('cleanup');await refreshTask;await eventWrites;await logWrites;}
  finally{try{await lock.close();}finally{await unlink(lockPath);}}
 }
}

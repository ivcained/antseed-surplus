import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants, openSync, readFileSync, fstatSync, closeSync } from 'node:fs';
import { mkdir, open, lstat, rename, unlink, rmdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isIP } from 'node:net';
import { createMp4Inspector } from '@antseed/api-adapter';
import { lookup as dnsLookup } from 'node:dns/promises';
import { Agent } from 'undici';

const ORIGIN = 'https://api.surplusintelligence.ai';
const MODEL = 'longcat-distilled-image-to-video';
const LOCAL_ID = /^video_[a-f0-9]{32}$/;
const UPSTREAM_ID = /^[A-Za-z0-9_-]{1,128}$/;
const validUpstreamId = value => typeof value==='string' && UPSTREAM_ID.test(value);
const validJobToken = value => typeof value==='string' && value.length>0 && value.length<=8192 && !/[\u0000-\u0020\u007f]/.test(value);
const json = (status,value) => Response.json(value,{status,headers:{'cache-control':'no-store'}});
class BridgeError extends Error {constructor(status,code){super(code);this.status=status;this.code=code;}}
function fail(status,code){throw new BridgeError(status,code);}
const digest = value => createHash('sha256').update(value).digest('hex');
function publicError(error){return json(error instanceof BridgeError?error.status:503,{error:{code:error instanceof BridgeError?error.code:'video_bridge_unavailable'}});}
function privateHost(host){return isIP(host.replace(/^\[|\]$/g,''))!==0 || !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(host);}
function publicAddress(address){
  if(isIP(address)===4){
    const [a,b,c]=address.split('.').map(Number);
    return !(a===0 || a===10 || a===127 || a>=224 || (a===100 && b>=64 && b<=127) || (a===169 && b===254) || (a===172 && b>=16 && b<=31) || (a===192 && (b===168 || b===0 || (b===88 && c===99))) || (a===198 && (b===18 || b===19 || (b===51 && c===100))) || (a===203 && b===0 && c===113));
  }
  return isIP(address)===6 && /^[23]/i.test(address) && !/^(?:2001:(?:db8|0):|2002:)/i.test(address);
}
async function deadline(milliseconds,task){
  const abort=new AbortController();let timer;
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(new BridgeError(502,'video_upstream_timeout'));},milliseconds);});
  try{return await Promise.race([Promise.resolve().then(()=>task(abort.signal)),timeout]);}finally{clearTimeout(timer);}
}
async function boundedBody(response,limit,signal){
  const header=response.headers.get('content-length');
  const length=header===null?undefined:Number(header);
  if(header!==null && (!/^[1-9][0-9]*$/.test(header) || !Number.isSafeInteger(length) || length>limit)){
    void response.body?.cancel().catch(()=>{});fail(502,'video_response_too_large');
  }
  if(!response.body)fail(502,'invalid_video_response');
  const reader=response.body.getReader(),chunks=[];let size=0;
  const cancel=()=>{void reader.cancel().catch(()=>{});};
  signal.addEventListener('abort',cancel,{once:true});
  try {
    signal.throwIfAborted();
    for(;;){
      const {value,done}=await reader.read();signal.throwIfAborted();if(done)break;
      size+=value.byteLength;
      if(size>limit || (length!==undefined && size>length))fail(502,'video_response_too_large');
      chunks.push(Buffer.from(value));
    }
    if(size===0 || (length!==undefined && length!==size))fail(502,'incomplete_video_response');
    return Buffer.concat(chunks,size);
  }finally{signal.removeEventListener('abort',cancel);cancel();reader.releaseLock();}
}
function imageInput(value){
  if(typeof value!=='string' || value.length>8*1024*1024)fail(400,'invalid_image');
  if(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value))return value;
  let url;try{url=new URL(value);}catch{fail(400,'invalid_image');}
  if(url.protocol!=='https:' || url.username || url.password || url.port || url.hash || privateHost(url.hostname))fail(400,'invalid_image');
  return value;
}
function validateQuote(quote,now){
  const parameters=quote?.media?.parameters;
  if(quote?.kind!=='video' || quote.upstreamModel!==MODEL || quote.provider!=='api.venice.ai' || !Number.isFinite(Date.parse(quote.policyExpiresAt)) || Date.parse(quote.policyExpiresAt)<=now() || !parameters || Object.keys(parameters).length!==2 || parameters.duration_seconds!==5 || parameters.resolution!=='720p')fail(503,'video_quote_unavailable');
}
function intent(body,quote,options,now){
  validateQuote(quote,now);
  if(!body || typeof body!=='object' || Array.isArray(body))fail(400,'invalid_video_request');
  const allowed=new Set(['model','prompt','duration','duration_seconds','resolution','image_url','_requestId']);
  if(Object.keys(body).some(key=>!allowed.has(key)))fail(400,'unsupported_video_parameter');
  const requestId=options?.requestId??body._requestId;
  if(typeof requestId!=='string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(requestId))fail(400,'request_id_required');
  if(typeof body.model!=='string' || !/^[A-Za-z0-9_.:/-]{1,256}$/.test(body.model) || typeof body.prompt!=='string' || !body.prompt.trim() || body.prompt.length>2000)fail(400,'invalid_video_request');
  const duration=typeof body.duration==='string' && /^[0-9]+s?$/.test(body.duration)?Number(body.duration.replace(/s$/,'')):body.duration;
  if(duration!==5 || (body.duration_seconds!==undefined && body.duration_seconds!==5) || (body.resolution!==undefined && body.resolution!=='720p'))fail(400,'video_parameters_not_reviewed');
  const payload={model:quote.upstreamModel,prompt:body.prompt,duration_seconds:5,resolution:'720p',image_url:imageInput(body.image_url),provider:quote.provider,providers_blocked:['antseed']};
  return {payload,service:body.model,requestHash:digest(requestId),fingerprint:digest(JSON.stringify([body.model,payload]))};
}

/** Private durable SI job journal. Ownership/authentication remains the caller's job.
 * Pass a trusted stable AntSeed request ID via queue's third argument or _requestId.
 * Ambiguous submissions and abandoned process locks fail closed; never clear them
 * automatically or mint a fresh request ID to retry a possibly-paid operation.
 */
export function createVideoBridge({settings,apiKey,fetchImpl=fetch,onEvent=()=>{},now=Date.now}) {
  if(!settings || typeof settings.stateDir!=='string' || !settings.stateDir)throw new Error('Private video stateDir required');
  const upstream=new URL(settings.surplusBaseUrl??`${ORIGIN}/v1`);
  if(upstream.origin!==ORIGIN || !/^\/v1\/?$/.test(upstream.pathname) || upstream.search || upstream.hash || upstream.username || upstream.password)throw new Error('Untrusted Surplus origin');
  if(typeof apiKey!=='string' || !apiKey || apiKey.length>8192 || /[\u0000-\u0020\u007f]/.test(apiKey))throw new Error('Invalid video credential');
  const root=resolve(settings.stateDir),dir=join(root,'video-bridge'),journal=join(dir,'journal.json');
  const marker=join(root,'.video-bridge-initialized'),markerBytes='video-bridge-v1\n';
  const config=settings.videoBridgeConfig??{};
  if(typeof config!=='object' || Array.isArray(config))throw new Error('Invalid videoBridgeConfig');
  const requestTimeout=config.requestTimeoutMs??30000,downloadTimeout=config.downloadTimeoutMs??120000;
  const maxBytes=config.maxArtifactBytes??64*1024*1024,maxRedirects=config.maxRedirects??3;
  for(const [value,min,max] of [[requestTimeout,1,120000],[downloadTimeout,1,300000],[maxBytes,1,64*1024*1024],[maxRedirects,0,5]])if(!Number.isSafeInteger(value) || value<min || value>max)throw new Error('Invalid video limit');
  if(!Array.isArray(settings.mediaArtifactHosts??[]) || (settings.mediaArtifactHosts??[]).some(host=>typeof host!=='string' || host.length>253 || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) || privateHost(host)))throw new Error('Invalid artifact allowlist');
  const artifactHosts=new Set(settings.mediaArtifactHosts??[]),lookup=settings.mediaArtifactLookup??dnsLookup;
  if(typeof lookup!=='function')throw new Error('Invalid artifact resolver');
  async function metadata(url,init,expectedStatus,beforeSend){
    return deadline(requestTimeout,async signal=>{
      beforeSend?.();
      let response;try{response=await fetchImpl(url,{...init,redirect:'manual',signal});}catch{fail(502,'video_upstream_failed');}
      if(response.status!==expectedStatus || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json'){
        void response.body?.cancel().catch(()=>{});fail(502,'invalid_video_response');
      }
      try{return JSON.parse((await boundedBody(response,1024*1024,signal)).toString('utf8'));}catch(error){if(error instanceof BridgeError)throw error;fail(502,'invalid_video_response');}
    });
  }
  async function download(job,index){
    const canonical=`${ORIGIN}/v1/media/artifacts/${job.siId}/${index}`;
    const pinned=new Map();
    const dispatcher=new Agent({connect:{lookup(host,options,callback){
      const addresses=pinned.get(host)?.filter(value=>!options.family || value.family===options.family);
      if(!addresses?.length){callback(new Error('Unapproved artifact destination'));return;}
      if(options.all)callback(null,addresses);else callback(null,addresses[0].address,addresses[0].family);
    }}});
    try {
      return await deadline(downloadTimeout,async signal=>{
        let target=new URL(canonical);
        for(let redirects=0;;redirects++){
          if(target.protocol!=='https:' || target.username || target.password || target.port || target.hash || privateHost(target.hostname))fail(502,'untrusted_artifact_redirect');
          const sameOrigin=target.origin===ORIGIN;
          if(sameOrigin){if(target.pathname!==new URL(canonical).pathname)fail(502,'untrusted_artifact_redirect');}
          else {
            if(!artifactHosts.has(target.hostname))fail(502,'untrusted_artifact_redirect');
            let addresses;try{addresses=await lookup(target.hostname,{all:true,verbatim:true});}catch{fail(502,'untrusted_artifact_redirect');}
            signal.throwIfAborted();
            if(!Array.isArray(addresses) || !addresses.length || addresses.some(value=>!publicAddress(value.address) || isIP(value.address)!==value.family))fail(502,'untrusted_artifact_redirect');
            pinned.set(target.hostname,addresses.map(value=>({address:value.address,family:value.family})));
          }
          let response;
          try{response=await fetchImpl(target.href,{method:'GET',redirect:'manual',signal,headers:sameOrigin?{'x-job-token':job.jobToken}:{},...(!sameOrigin?{dispatcher}:{})});}catch{fail(502,'video_artifact_unavailable');}
          if([301,302,303,307,308].includes(response.status)){
            void response.body?.cancel().catch(()=>{});
            const location=response.headers.get('location');
            if(redirects>=maxRedirects || !location)fail(502,'untrusted_artifact_redirect');
            try{target=new URL(location,target);}catch{fail(502,'untrusted_artifact_redirect');}
            continue;
          }
          if(response.status!==200 || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='video/mp4' || ![null,'identity'].includes(response.headers.get('content-encoding'))){
            void response.body?.cancel().catch(()=>{});fail(502,'invalid_video_artifact');
          }
          return await boundedBody(response,maxBytes,signal);
        }
      });
    }finally{void dispatcher.destroy().catch(()=>{});}
  }
  async function readPrivate(path,limit=16*1024*1024){
    const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    try {const info=await file.stat();if(!info.isFile() || info.mode&0o077 || info.size>limit)fail(503,'video_state_unavailable');return await file.readFile();} finally {await file.close();}
  }
  async function readState(){
    const state=JSON.parse((await readPrivate(journal)).toString('utf8'));
    if(state?.version!==1 || !state.jobs || typeof state.jobs!=='object' || Array.isArray(state.jobs))fail(503,'video_state_unavailable');
    const hashes=new Set();
    for(const [id,job] of Object.entries(state.jobs)){
      if(!LOCAL_ID.test(id) || !job || !['submitting','uncertain','accepted'].includes(job.state) || !/^[a-f0-9]{64}$/.test(job.requestHash) || hashes.has(job.requestHash) || !/^[a-f0-9]{64}$/.test(job.fingerprint) || typeof job.idempotencyKey!=='string' || typeof job.service!=='string' || job.durationSeconds!==5 || job.provider!=='api.venice.ai' || !job.payload || digest(JSON.stringify([job.service,job.payload]))!==job.fingerprint || (job.state==='accepted' && (!validUpstreamId(job.siId) || !validJobToken(job.jobToken))))fail(503,'video_state_unavailable');
      hashes.add(job.requestHash);
    }
    return state;
  }
  async function syncDirectory(path=dir){const directory=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try {await directory.sync();} finally {await directory.close();}}
  function submissionGate(expected){
    // No await between this exact durable-intent check and fetch invocation.
    for(const [path,bytes,limit] of [[marker,markerBytes,64],[journal,expected,16*1024*1024]]){
      let file;
      try {
        file=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
        const info=fstatSync(file);
        if(!info.isFile() || info.mode&0o077 || info.size>limit || readFileSync(file,'utf8')!==bytes)fail(503,'video_state_unavailable');
      }finally{if(file!==undefined)closeSync(file);}
    }
  }
  async function save(state){
    const bytes=JSON.stringify(state),temporary=join(dir,`.journal-${randomUUID()}.tmp`);
    if(Buffer.byteLength(bytes)>16*1024*1024)fail(503,'video_state_full');
    try {
      const file=await open(temporary,'wx',0o600);
      try {await file.writeFile(bytes);await file.sync();} finally {await file.close();}
      await rename(temporary,journal);await syncDirectory();
      if((await readPrivate(journal)).toString('utf8')!==bytes)fail(503,'video_state_unavailable');
    } finally {await unlink(temporary).catch(()=>{});}
  }
  async function locked(action){
    await mkdir(root,{recursive:true,mode:0o700});
    const rootInfo=await lstat(root);
    if(!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || rootInfo.mode&0o077)fail(503,'video_state_unavailable');
    // mkdir (including a caller's earlier mkdir) does not persist root's parent
    // entry. Flush every ancestor bottom-up: recursive mkdir may have created
    // any of them, and existing entries are not proof of a completed barrier.
    // O_NOFOLLOW rejects symlink ancestors rather than missing hidden target
    // parent links. Unsupported directory fsync also fails before bootstrap.
    for(let parent=dirname(root);;parent=dirname(parent)){
      await syncDirectory(parent);
      if(parent===dirname(parent))break;
    }
    // Bootstrap ownership is acquired before creating the state directory, so a
    // concurrent opener cannot win the journal lock ahead of its initializer.
    const bootstrap=join(root,'.video-bridge-initialize.lock');
    try{await mkdir(bootstrap,{mode:0o700});}catch{fail(503,'video_state_locked');}
    let lock;
    try {
      const info=await lstat(dir).catch(error=>{if(error.code!=='ENOENT')throw error;});
      if(info && (!info.isDirectory() || info.isSymbolicLink() || info.mode&0o077))fail(503,'video_state_unavailable');
      let initialized;
      try{initialized=(await readPrivate(marker,64)).toString('utf8');}catch(error){if(error.code!=='ENOENT' || info)throw error;}
      let created=false;
      if(initialized===undefined){
        // This outside tombstone must outlive loss of the entire component
        // directory. Publish it durably before creating any component state;
        // interrupted initialization deliberately requires manual recovery.
        const file=await open(marker,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
        try{await file.writeFile(markerBytes);await file.sync();}finally{await file.close();}
        await syncDirectory(root);
        await mkdir(dir,{mode:0o700});created=true;
      }else if(initialized!==markerBytes || !info)fail(503,'video_state_unavailable');
      await syncDirectory(root);
      const current=await lstat(dir);
      if(!current.isDirectory() || current.isSymbolicLink() || current.mode&0o077)fail(503,'video_state_unavailable');
      const candidate=join(dir,'lock');
      try{await mkdir(candidate,{mode:0o700});lock=candidate;}catch{fail(503,'video_state_locked');}
      let state;try{state=await readState();}catch(error){if(error.code!=='ENOENT' || !created)throw error;state={version:1,jobs:{}};await save(state);}
      return await action(state);
    } finally {
      try{if(lock)await rmdir(lock);}finally{await rmdir(bootstrap);}
    }
  }
  function videoResponse(bytes){return new Response(bytes,{status:200,headers:{'content-type':'video/mp4','content-length':String(bytes.length),'cache-control':'no-store'}});}
  function validateMp4(bytes,job){
    const inspector=createMp4Inspector();inspector.update(bytes);
    const result=inspector.finish();
    if(!result || result.durationMs<job.durationSeconds*900)fail(502,'invalid_video_artifact');
  }
  async function cacheArtifact(id,bytes){
    const temporary=join(dir,`.artifact-${randomUUID()}.tmp`);
    try {
      const file=await open(temporary,'wx',0o600);
      try {await file.writeFile(bytes);await file.sync();} finally {await file.close();}
      await rename(temporary,join(dir,`${id}.mp4`));await syncDirectory();
    } finally {await unlink(temporary).catch(()=>{});}
  }
  async function terminal(state,id,job,value){
    job.upstreamStatus=value.status;
    if(typeof value.usage?.buyer_cost_usdc==='string' && /^(?:0|[1-9][0-9]{0,39})$/.test(value.usage.buyer_cost_usdc))job.actualCostMicro=value.usage.buyer_cost_usdc;
    if(['pending','settled','failed','refunded'].includes(value.usage?.settlement_status))job.settlementStatus=value.usage.settlement_status;
    const signature=digest(JSON.stringify([value.status,job.actualCostMicro??null,job.settlementStatus??null]));
    const emit=job.eventSignature!==signature;
    job.eventSignature=signature;await save(state);
    if(emit){
      try {const pending=onEvent({queueId:id,service:job.service,provider:job.provider,siJobId:job.siId,status:value.status,...(job.actualCostMicro!==undefined?{actualCostMicro:job.actualCostMicro}:{}),...(job.settlementStatus?{settlementStatus:job.settlementStatus}:{})});Promise.resolve(pending).catch(()=>{});}catch{/* Metrics must never change job outcome. */}
    }
  }
  async function refreshSettlement(state,id,job){
    if(job.actualCostMicro!==undefined && job.settlementStatus==='settled')return;
    try {
      const value=await metadata(`${ORIGIN}/v1/video/generations/${job.siId}`,{method:'GET',headers:{'x-job-token':job.jobToken}},200);
      if(value?.id===job.siId && value.status===job.upstreamStatus)await terminal(state,id,job,value);
    }catch{/* Cached media and known terminal outcomes survive a settlement-poll outage. */}
  }
  return {
    async retrieve(id,service){
      try {
        if(typeof id!=='string' || !LOCAL_ID.test(id) || typeof service!=='string')fail(404,'video_job_not_found');
        return await locked(async state=>{
          const job=Object.hasOwn(state.jobs,id)?state.jobs[id]:undefined;
          if(!job || job.service!==service)fail(404,'video_job_not_found');
          if(job.state!=='accepted')fail(503,'submission_uncertain');
          if(['failed','canceled','expired'].includes(job.upstreamStatus)){
            await refreshSettlement(state,id,job);return json(200,{queue_id:id,status:job.upstreamStatus.toUpperCase()});
          }
          if(job.artifact){
            const bytes=await readPrivate(join(dir,`${id}.mp4`),64*1024*1024);
            if(bytes.length!==job.artifact.bytes || digest(bytes)!==job.artifact.sha256)fail(503,'video_cache_unavailable');
            validateMp4(bytes,job);await refreshSettlement(state,id,job);return videoResponse(bytes);
          }
          const value=await metadata(`${ORIGIN}/v1/video/generations/${job.siId}`,{method:'GET',headers:{'x-job-token':job.jobToken}},200);
          if(value?.id!==job.siId || !['queued','submitted','running','succeeded','failed','canceled','expired'].includes(value.status))fail(502,'invalid_video_status');
          if(['queued','submitted','running'].includes(value.status))return json(200,{queue_id:id,status:value.status==='queued'?'QUEUED':'PROCESSING'});
          if(value.status!=='succeeded'){
            await terminal(state,id,job,value);return json(200,{queue_id:id,status:value.status.toUpperCase()});
          }
          const artifact=value.results?.[0];
          if(!artifact || !Number.isSafeInteger(artifact.artifact_index) || artifact.artifact_index<0 || artifact.artifact_index>100)fail(502,'invalid_video_artifact');
          await terminal(state,id,job,value);
          const bytes=await download(job,artifact.artifact_index);validateMp4(bytes,job);
          await cacheArtifact(id,bytes);job.artifact={bytes:bytes.length,sha256:digest(bytes)};await save(state);
          return videoResponse(bytes);
        });
      }catch(error){return publicError(error);}
    },
    async queue(body,quote,options={}){
      try {
        const candidate=intent(body,quote,options,now);
        return await locked(async state=>{
          const previous=Object.entries(state.jobs).find(([,job])=>job.requestHash===candidate.requestHash);
          if(previous){
            const [id,job]=previous;
            if(job.fingerprint!==candidate.fingerprint)fail(409,'request_id_conflict');
            if(job.state!=='accepted')fail(503,'submission_uncertain');
            return json(200,{queue_id:id,status:'QUEUED'});
          }
          const id=`video_${randomBytes(16).toString('hex')}`;
          const job={...candidate,state:'submitting',idempotencyKey:randomUUID(),durationSeconds:5,provider:quote.provider,createdAt:now()};
          state.jobs[id]=job;
          // Tokens are bounded at 8 KiB; leave 16 KiB per job for credentials,
          // terminal cost/event fields and the cached-artifact manifest. Refuse
          // before spend instead of losing an accepted mapping at the size cap.
          if(Buffer.byteLength(JSON.stringify(state))+Object.keys(state.jobs).length*16384>16*1024*1024)fail(503,'video_state_full');
          await save(state);
          validateQuote(quote,now);
          try {
            const value=await metadata(`${ORIGIN}/v1/video/generations`,{method:'POST',headers:{authorization:`Bearer ${apiKey}`,'content-type':'application/json','idempotency-key':job.idempotencyKey},body:JSON.stringify(job.payload)},202,()=>submissionGate(JSON.stringify(state)));
            if(!validUpstreamId(value?.id) || !validJobToken(value?.job_token) || !['queued','submitted','running','succeeded','failed','canceled','expired'].includes(value.status))throw new Error('invalid acceptance');
            Object.assign(job,{state:'accepted',siId:value.id,jobToken:value.job_token});await save(state);
            return json(200,{queue_id:id,status:'QUEUED'});
          }catch{
            job.state='uncertain';await save(state);fail(503,'submission_uncertain');
          }
        });
      }catch(error){return publicError(error);}
    },
  };
}

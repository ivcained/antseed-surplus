import {performance} from 'node:perf_hooks';

const MAX_RESPONSE_BYTES=1024*1024;
const KINDS=new Set(['image','edit','video','decision','vision','responses','messages','audio-input','file-input','video-input','text']);
const PROTOCOLS=Object.freeze({image:'openai-images',edit:'openai-images',video:'venice-video',decision:'typesafe-systemone',responses:'openai-responses',messages:'anthropic-messages'});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const own=(value,key)=>object(value)&&Object.hasOwn(value,key)?value[key]:undefined;
const entry=(metadata,matrix,model)=>own(own(own(own(metadata,matrix),'surplus'),'services'),model);
class ReadinessError extends Error {
 constructor(code){super(`Content probe readiness: ${code}`);this.name='ReadinessError';this.code=code;}
}
const fail=code=>{throw new ReadinessError(code);};
// Never await endpoint/stream cancellation: a hostile or broken cancel promise
// must not extend the deadline. Abort and cancel are best-effort local cleanup.
const cancel=body=>{try{Promise.resolve(body?.cancel()).catch(()=>{});}catch{}};

function exactCatalog(body,binding,allowMissing){
 if(!object(body)||body.ok!==true||!Array.isArray(body.peers)||body.peers.some(p=>!object(p)||typeof p.peerId!=='string'))fail('CATALOG_INVALID');
 const matches=body.peers.filter(p=>p.peerId===binding.peer);
 if(matches.length>1)fail('CATALOG_INVALID');
 const metadata=matches[0];
 if(!metadata){if(allowMissing)return false;fail('CATALOG_MISMATCH');}
 const protocols=entry(metadata,'providerServiceApiProtocols',binding.model);
 if(!Array.isArray(metadata.providers)||!metadata.providers.includes('surplus')||!Array.isArray(protocols)||!protocols.includes(binding.protocol))fail('CATALOG_MISMATCH');
 if(['image','edit','video'].includes(binding.kind)){
  const billing=own(entry(metadata,'providerServiceUnitBillingModels',binding.model),binding.protocol);
  const components=billing?.components,component=components?.[0];
  const unit=binding.kind==='video'?'video_generations':'output_images';
  if(!object(billing)||billing.version!==1||!Array.isArray(components)||components.length!==1||!object(component)||component.unit!==unit||!Number.isFinite(component.priceUsd)||component.priceUsd<=0||component.priceUsd!==binding.unitPriceUsd)fail('CATALOG_MISMATCH');
  const caps=entry(metadata,'providerServiceCapabilities',binding.model),output=binding.kind==='video'?'video':'image';
  if(!Array.isArray(caps?.inputs)||!caps.inputs.includes('text')||!Array.isArray(caps?.outputs)||!caps.outputs.includes(output))fail('CATALOG_MISMATCH');
  if(binding.kind==='image'?caps.inputs.includes('image'):!caps.inputs.includes('image'))fail('CATALOG_MISMATCH');
 }
 return true;
}

/** Execution-only prerequisite, not a zero-authorization mode. The caller must
 * first install/verify the buyer's existing hard budget and dispatch guards.
 * Only local catalog and exact-peer transport endpoints are called; connection
 * establishment can trigger the installed transport's payment/session setup.
 * No provider inference, fallback, payment retry or quote renewal is performed.
 */
export async function waitForProbeReadiness({baseUrl,peer,model,kind,service,fetchImpl=fetch,signal,timeoutMs=90000,pollIntervalMs=1000,requestTimeoutMs=15000,connectTimeoutMs=40000,now=()=>performance.now()}={}){
 let url;
 try{url=new URL(baseUrl);}catch{fail('INVALID_OPTIONS');}
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/'||url.username||url.password||url.search||url.hash||!KINDS.has(kind)||typeof peer!=='string'||!/^[a-f0-9]{40}$/.test(peer)||typeof model!=='string'||!/^[A-Za-z0-9_.:/-]+$/.test(model)||typeof fetchImpl!=='function'||typeof now!=='function')fail('INVALID_OPTIONS');
 for(const [value,max]of [[timeoutMs,90000],[pollIntervalMs,5000],[requestTimeoutMs,15000],[connectTimeoutMs,40000]])if(!Number.isFinite(value)||value<1||value>max)fail('INVALID_OPTIONS');
 const binding={peer,model,kind,protocol:PROTOCOLS[kind]??'openai-chat-completions',unitPriceUsd:service?.unitPriceUsd};
 if(['image','edit','video'].includes(kind)&&(!Number.isFinite(binding.unitPriceUsd)||binding.unitPriceUsd<=0))fail('INVALID_OPTIONS');
 const deadline=now()+timeoutMs;
 const check=()=>{if(signal?.aborted)fail('ABORTED');if(now()>=deadline)fail('DEADLINE_EXCEEDED');};

 async function request(path,connect=false){
  check();
  const controller=new AbortController(),limit=now()+(connect?connectTimeoutMs:requestTimeoutMs),end=Math.min(limit,deadline);
  const timeoutCode=()=>now()>=deadline?'DEADLINE_EXCEEDED':connect?'CONNECT_TIMEOUT':'REQUEST_TIMEOUT';
  let reader,response,finished=false,timer,rejectBound;
  const expired=new Promise((_,reject)=>{rejectBound=reject;});
  const abort=code=>{controller.abort();cancel(reader??response?.body);rejectBound(new ReadinessError(code));};
  const onAbort=()=>abort('ABORTED');
  const checkRequest=()=>{check();if(now()>=limit)fail(connect?'CONNECT_TIMEOUT':'REQUEST_TIMEOUT');};
  signal?.addEventListener('abort',onAbort,{once:true});
  timer=setTimeout(()=>abort(timeoutCode()),Math.max(1,end-now()));
  const operation=(async()=>{
   checkRequest();
   response=await fetchImpl(new URL(path,url.origin).href,{method:connect?'POST':'GET',headers:{accept:'application/json',...(connect?{'content-type':'application/json'}:{})},...(connect?{body:JSON.stringify({peerId:binding.peer})}:{}),redirect:'error',credentials:'omit',signal:controller.signal});
   // A fetch implementation that ignores abort may resolve after our race.
   if(finished){cancel(response?.body);return;}
   checkRequest();
   if(!response.ok)fail(connect?'CONNECT_FAILED':'REQUEST_FAILED');
   if(Number(response.headers.get('content-length'))>MAX_RESPONSE_BYTES)fail('RESPONSE_TOO_LARGE');
   if(!response.body)fail(connect?'CONNECT_FAILED':'REQUEST_FAILED');
   reader=response.body.getReader();const parts=[];let size=0;
   for(;;){
    checkRequest();
    const {done,value}=await reader.read();
    if(finished)return;
    checkRequest();
    if(done)break;
    size+=value.byteLength;if(size>MAX_RESPONSE_BYTES)fail('RESPONSE_TOO_LARGE');parts.push(value);
   }
   reader.releaseLock();reader=undefined;
   checkRequest();
   let body;
   try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts,size)));}catch{fail(connect?'CONNECT_FAILED':'REQUEST_FAILED');}
   checkRequest();return body;
  })();
  try{return await Promise.race([operation,expired]);}
  catch(error){
   controller.abort();cancel(reader??response?.body);
   if(error instanceof ReadinessError)throw error;
   fail(connect?'CONNECT_FAILED':'REQUEST_FAILED');
  }finally{
   finished=true;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);
   // Release ownership even when cancel never settles. Promise.race already
   // observes any pending read rejection caused by releasing the lock.
   try{reader?.releaseLock();}catch{}
  }
 }
 async function waitForDiscovery(){
  check();
  await new Promise((resolve,reject)=>{
   let timer;
   const onAbort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);reject(new ReadinessError('ABORTED'));};
   signal?.addEventListener('abort',onAbort,{once:true});
   timer=setTimeout(()=>{signal?.removeEventListener('abort',onAbort);resolve();},Math.min(pollIntervalMs,Math.max(1,deadline-now())));
   if(signal?.aborted)onAbort();
  });
 }
 for(;;){
  if(signal?.aborted)fail('ABORTED');
  if(now()>=deadline)fail('PEER_UNAVAILABLE');
  if(exactCatalog(await request('/_antseed/peers'),binding,true))break;
  await waitForDiscovery();
 }
 const connected=await request('/_antseed/connect',true);
 if(!object(connected)||connected.ok!==true)fail('CONNECT_FAILED');
 exactCatalog(await request('/_antseed/peers'),binding,false);
 check();return {peer:binding.peer,provider:'surplus',model:binding.model,protocol:binding.protocol,connected:true};
}

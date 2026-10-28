import {createHash} from 'node:crypto';
import {open,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {inflateSync} from 'node:zlib';

export const CONTENT_KINDS=Object.freeze(['image','edit','video','decision','vision','responses','messages','audio-input','file-input','video-input','text']);
const TOKEN_PRICE_KEYS=['inputUsdPerMillion','outputUsdPerMillion','cachedInputUsdPerMillion'];
const MAX_INPUT_BYTES=1024*1024;
const MAX_RESULT_BYTES=128*1024*1024;
const TEXT='antseed content probe works';
const requiredInput=new Set(['edit','video','vision','audio-input','file-input','video-input']);
const expectedInput={'edit':'image','video':'image','vision':'image','audio-input':'audio','file-input':'file','video-input':'video'};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const object=value=>value!==null && typeof value==='object' && !Array.isArray(value);
const budgetGuardInstalled=Symbol.for('antseed.contentProbe.reserveBudgetGuard');
/** Pinned CLI config limits are replenishable windows, NOT run spending caps.
 * Guard the real manager's sole ReserveAuth signing choke point in the isolated
 * child: sum each channel's high-water authorization, never release/reuse it.
 * With no reserve authorization above that sum, settlement cannot spend more.
 * This includes automatic top-ups and additional one-off video channels.
 */
export function installProbeBudgetGuard(Manager,{budgetMicros}) {
 if(typeof budgetMicros!=='bigint'||budgetMicros<1n||budgetMicros>5000000n)throw Error('Invalid hard probe budget');
 const prototype=Manager?.prototype,original=prototype?._signReserveAuth;
 if(typeof original!=='function'||prototype[budgetGuardInstalled])throw Error('Unsupported/already guarded AntSeed payment manager');
 const highwater=new Map();let total=0n;
 prototype._signReserveAuth=async function(channelId,amount,deadline){
  if(typeof channelId!=='string'||!/^0x[a-fA-F0-9]{64}$/.test(channelId)||typeof amount!=='bigint'||amount<0n)throw Error('Invalid hard-budget reserve authorization');
  const key=channelId.toLowerCase(),previous=highwater.get(key)??0n,next=amount>previous?amount:previous;
  const increase=next-previous;
  if(total+increase>budgetMicros)throw Error('Hard content-probe budget exceeded: reserve authorization denied');
  // Reserve synchronously before awaiting a signature; concurrent requests and
  // failed/ambiguous signatures may never reclaim already committed headroom.
  total+=increase;highwater.set(key,next);
  return original.call(this,channelId,amount,deadline);
 };
 Object.defineProperty(prototype,budgetGuardInstalled,{value:true,configurable:true});
 return {authorizedMicros:()=>total,restore(){prototype._signReserveAuth=original;delete prototype[budgetGuardInstalled];}};
}
const dispatchGuardInstalled=Symbol.for('antseed.contentProbe.exactDispatchGuard');
const probePaths=Object.freeze({image:'/v1/images/generations',edit:'/v1/images/edits',video:'/api/v1/video/queue',decision:'/v1/systemone',responses:'/v1/responses',messages:'/v1/messages'});
function probeBinding(binding){
 if(!object(binding)||!CONTENT_KINDS.includes(binding.kind)||typeof binding.model!=='string'||!/^[A-Za-z0-9_.:/-]+$/.test(binding.model)||typeof binding.peer!=='string'||!/^[a-f0-9]{40}$/.test(binding.peer))throw Error('Invalid exact-model dispatch binding');
 return Object.freeze({kind:binding.kind,model:binding.model,peer:binding.peer});
}
function pinDenied(){throw Error('Exact-model content-probe dispatch pin denied');}
function singleHeader(headers,name,required=true){
 const values=Object.entries(headers??{}).filter(([key])=>key.toLowerCase()===name).map(([,value])=>value);
 if(values.length>1||(required&&values.length!==1)||values.some(value=>typeof value!=='string'))pinDenied();
 return values[0];
}
/** Inspect every selector, not the upstream parser's first/last-wins projection.
 * This parser intentionally accepts only the bounded forms this probe emits.
 */
function pinnedBodySelectors(request,model){
 const type=singleHeader(request.headers,'content-type'),bytes=request.body;
 if(!(bytes instanceof Uint8Array)||bytes.length>2*MAX_INPUT_BYTES)pinDenied();
 const selectors=new Map();
 const add=(name,value)=>{if(!['model','service'].includes(name)||selectors.has(name)||value!==model)pinDenied();selectors.set(name,value);};
 if(type==='application/json'){
  let text,fields;
  try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);fields=JSON.parse(text);}catch{pinDenied();}
  if(!object(fields))pinDenied();
  // JSON.parse alone erases duplicate keys, including escaped spellings.
  // Tokenize only after syntax validation; track nesting so content strings and
  // nested provider data are not mistaken for top-level model/service keys.
  const tokens=/"(?:\\.|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,"]+/g;let depth=0,token;
  while((token=tokens.exec(text))){
   const value=token[0];
   if(value==='{'||value==='[')depth++;
   else if(value==='}'||value===']')depth--;
   else if(depth===1&&value.startsWith('"')&&/^\s*:/.test(text.slice(tokens.lastIndex))){
    const key=JSON.parse(value);
    if(['model','service'].includes(key.toLowerCase()))add(key,fields[key]);
   }
  }
 }else{
  const match=/^multipart\/form-data; boundary=([A-Za-z0-9_-]{1,70})$/.exec(type);
  if(!match)pinDenied();
  const delimiter=`--${match[1]}`,text=Buffer.from(bytes).toString('latin1'),parts=text.split(delimiter);
  if(parts[0]!==''||!/^--(?:\r\n)?$/.test(parts.at(-1))||parts.length>32)pinDenied();
  for(const part of parts.slice(1,-1)){
   if(!part.startsWith('\r\n')||!part.endsWith('\r\n'))pinDenied();
   const end=part.indexOf('\r\n\r\n');if(end<0||end>8192)pinDenied();
   const headers=part.slice(2,end).split('\r\n'),dispositions=headers.filter(line=>/^content-disposition:/i.test(line));
   if(dispositions.length!==1)pinDenied();
   const disposition=/^content-disposition: form-data; name="([A-Za-z0-9_]+)"(?:; filename="[^"\r\n]*")?$/i.exec(dispositions[0]);
   if(!disposition)pinDenied();
   const name=disposition[1];
   if(['model','service'].includes(name.toLowerCase())){
    if(/; filename=/i.test(dispositions[0]))pinDenied();
    add(name,part.slice(end+4,-2));
   }
  }
 }
 if(!selectors.has('model'))pinDenied();
}
function checkPinnedRequest(request,binding,outbound=false){
 const expectedPath=probePaths[binding.kind]??'/v1/chat/completions';
 const textPaths=['/v1/chat/completions','/v1/responses','/v1/messages'];
 const transformedText=outbound&&textPaths.includes(expectedPath)&&textPaths.includes(request?.path);
 if(request?.method!=='POST'||(request.path!==expectedPath&&!transformedText&&!(binding.kind==='video'&&request.path==='/api/v1/video/retrieve')))pinDenied();
 if(singleHeader(request.headers,'x-antseed-service')!==binding.model)pinDenied();
 const peer=singleHeader(request.headers,'x-antseed-pin-peer',false);
 if(peer!==undefined&&peer!==binding.peer)pinDenied();
 pinnedBodySelectors(request,binding.model);
}
/** Two real choke points: reject the CLI's selected plan (multipart is not
 * rewritten there), then recheck FINAL wire selectors and current exact offers
 * before the common buyer handler can connect, negotiate or dispatch. Snapshots
 * prevent a connection await from mutating already-authorized request/catalog.
 * No canonical/date/vendor/case normalization, rerouting or retries are added.
 */
export function installProbeDispatchGuard({BuyerProxy,BuyerRequestHandler,resolvePeerRoutePlan,buildNetworkServiceOffers},binding){
 binding=probeBinding(binding);
 const proxy=BuyerProxy?.prototype,handler=BuyerRequestHandler?.prototype;
 const dispatch=proxy?._dispatchToPeer,send=handler?.sendRequest;
 if(typeof dispatch!=='function'||typeof send!=='function'||typeof resolvePeerRoutePlan!=='function'||typeof buildNetworkServiceOffers!=='function'||proxy[dispatchGuardInstalled]||handler[dispatchGuardInstalled])throw Error('Unsupported/already guarded AntSeed exact-model dispatch');
 const checkOffer=(peer,provider)=>{
  // The installed buyer/seller select the first case-insensitive registered
  // name (without trimming), not necessarily the literal catalog offer below.
  // Require literal registration and reject every case-colliding alternative,
  // regardless of order; never normalize or rewrite the peer's metadata.
  const providers=peer?.providers;
  if(!Array.isArray(providers)||!providers.includes('surplus')||providers.some(candidate=>typeof candidate==='string'&&candidate!=='surplus'&&candidate.toLowerCase()==='surplus'))pinDenied();
  // Fixed registered AntSeed provider, not the seller's inner upstream API.
  if(peer?.peerId!==binding.peer||provider!=='surplus'||!buildNetworkServiceOffers([peer]).some(offer=>offer.serviceId===binding.model&&offer.provider===provider))pinDenied();
 };
 proxy._dispatchToPeer=async function(...args){
  const [,request,peer,plans,protocol,service,provider]=args;
  checkPinnedRequest(request,binding);
  const plan=plans.get(peer.peerId)??resolvePeerRoutePlan(peer,protocol,service,provider,'lenient');
  if(service!==binding.model||plan?.serviceId!==binding.model)pinDenied();
  checkOffer(peer,plan.provider);
  return dispatch.apply(this,args);
 };
 handler.sendRequest=async function(peer,request,...args){
  // Clone before checking; pass exactly those bytes and metadata to the real
  // handler. No awaits occur between snapshot, validation and the invocation.
  peer=structuredClone(peer);request={...request,headers:{...request.headers},body:Buffer.from(request.body)};
  checkPinnedRequest(request,binding,true);
  checkOffer(peer,singleHeader(request.headers,'x-antseed-provider'));
  return send.call(this,peer,request,...args);
 };
 Object.defineProperty(proxy,dispatchGuardInstalled,{value:true});Object.defineProperty(handler,dispatchGuardInstalled,{value:true});
}
export function probeBudgetPreload(budget,binding) {
 binding=probeBinding(binding);
 const micros=BigInt(Math.floor(budget*1e6));if(micros<1n||micros>5000000n)throw Error('Invalid hard probe budget');
 const managerUrl=import.meta.resolve('@antseed/buyer-core/buyer-payment-manager');
 const handlerUrl=import.meta.resolve('@antseed/buyer-core/buyer-request-handler');
 const cliUrl=new URL('../node_modules/@antseed/cli/package.json',import.meta.url).href;
 const proxyUrl=new URL('./dist/proxy/buyer-proxy.js',cliUrl).href,routingUrl=new URL('./dist/proxy/routing.js',cliUrl).href;
 const nodeUrl=import.meta.resolve('@antseed/node'),adapterUrl=import.meta.resolve('@antseed/api-adapter');
 const versions=[[new URL('../package.json',managerUrl).href,'0.1.28'],[cliUrl,'0.1.208'],[new URL('../package.json',nodeUrl).href,'0.2.154'],[new URL('../package.json',adapterUrl).href,'0.1.53']];
 const source=[
  `import {readFile} from 'node:fs/promises';import {readFileSync} from 'node:fs';import {findPackageJSON} from 'node:module';import {pathToFileURL} from 'node:url';`,
  `import {installProbeBudgetGuard,installProbeDispatchGuard} from ${JSON.stringify(import.meta.url)};`,
  `for(const [url,version] of ${JSON.stringify(versions)}){if(JSON.parse(await readFile(new URL(url),'utf8')).version!==version)throw Error('Unreviewed AntSeed content-probe guard version');}`,
  // Bind the guard to the actual CLI -> node -> buyer-core startup graph.
  // Equal version labels alone do not prove equal ESM constructor instances.
  // These reviewed packages expose import-only exports: require.resolve would
  // check the wrong condition and cannot resolve them. Fail on other shapes.
  `const resolveFrom=(parent,spec)=>{const packageUrl=pathToFileURL(findPackageJSON(spec,parent)),pkg=JSON.parse(readFileSync(packageUrl,'utf8')),subpath=spec.split('/').slice(2).join('/'),target=pkg.exports?pkg.exports[subpath?'./'+subpath:'.']?.import:(!subpath&&typeof pkg.main==='string'?'./'+pkg.main:undefined);if(typeof target!=='string'||!target.startsWith('./'))throw Error('AntSeed content-probe module graph identity unsupported');return new URL(target,packageUrl).href;};`,
  `const actualNode=resolveFrom(${JSON.stringify(new URL('./dist/cli/index.js',cliUrl).href)},'@antseed/node'),actualManager=resolveFrom(actualNode,'@antseed/buyer-core/buyer-payment-manager'),actualHandler=resolveFrom(actualNode,'@antseed/buyer-core/buyer-request-handler');`,
  `if(actualNode!==${JSON.stringify(nodeUrl)}||actualManager!==${JSON.stringify(managerUrl)}||actualHandler!==${JSON.stringify(handlerUrl)}||resolveFrom(actualHandler,'@antseed/buyer-core/buyer-payment-manager')!==actualManager||resolveFrom(actualNode,'@antseed/api-adapter')!==${JSON.stringify(adapterUrl)}||resolveFrom(actualHandler,'@antseed/api-adapter')!==${JSON.stringify(adapterUrl)}||resolveFrom(${JSON.stringify(proxyUrl)},'@antseed/api-adapter')!==${JSON.stringify(adapterUrl)})throw Error('AntSeed content-probe module graph identity mismatch');`,
  `const {BuyerPaymentManager}=await import(${JSON.stringify(managerUrl)});`,
  `const {BuyerProxy}=await import(${JSON.stringify(proxyUrl)}),{BuyerRequestHandler}=await import(${JSON.stringify(handlerUrl)}),{resolvePeerRoutePlan}=await import(${JSON.stringify(routingUrl)}),{buildNetworkServiceOffers}=await import(${JSON.stringify(nodeUrl)});`,
  `if((await import(actualManager)).BuyerPaymentManager!==BuyerPaymentManager||(await import(actualHandler)).BuyerRequestHandler!==BuyerRequestHandler)throw Error('AntSeed content-probe module constructor identity mismatch');`,
  `installProbeBudgetGuard(BuyerPaymentManager,{budgetMicros:${micros}n});installProbeDispatchGuard({BuyerProxy,BuyerRequestHandler,resolvePeerRoutePlan,buildNetworkServiceOffers},${JSON.stringify(binding)});`,
  `process.stdout.write('CONTENT_PROBE_BUDGET_GUARD_READY\\nCONTENT_PROBE_DISPATCH_GUARD_READY\\n');`,
 ].join('\n');
 return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
}
export function parseContentArgs(args) {
 const out={execute:false};
 for(let i=0;i<args.length;i++) {
  const key=args[i];
  if(key==='--execute'){if(out.execute)throw Error('Duplicate --execute');out.execute=true;continue;}
  if(!['--env','--kind','--model','--input'].includes(key))throw Error(`Unknown argument ${key}`);
  const name=key.slice(2);if(out[name]!==undefined || !args[i+1] || args[i+1].startsWith('--'))throw Error(`Invalid/duplicate ${key}`);
  out[name]=args[++i];
 }
 if(!CONTENT_KINDS.includes(out.kind))throw Error('Specify a supported --kind');
 if(!out.model || !/^[A-Za-z0-9_.:/-]+$/.test(out.model))throw Error('Specify --model EXACT');
 return out;
}
export function probeBudget(kind,env=process.env) {
 const raw=env.TEST_MAX_COST_USD??'1';
 if(!/^\d+(?:\.\d{1,6})?$/.test(raw))throw Error('Invalid TEST_MAX_COST_USD (decimal USD, up to six places)');
 const value=Number(raw),max=kind==='video'?5:1;
 if(!Number.isFinite(value)||value<.000001||value>max)throw Error(`TEST_MAX_COST_USD must be positive and <= ${max}`);
 return value;
}
export function validateProbeQuote(settings,quotes,kind,model,budget,now=Date.now()) {
 const expected=kind==='edit'?'image':['image','video','decision'].includes(kind)?kind:'text';
 const allowed=settings.models.includes(model)||settings.mediaConfig?.services?.some(entry=>entry.model===model&&entry.kind===expected);
 if(!CONTENT_KINDS.includes(kind)||!allowed||!Object.hasOwn(quotes?.services??{},model))throw Error('Exact model is not allowed/quoted');
 const age=now-Date.parse(quotes.generatedAt);
 if(!Number.isFinite(age)||age < -60000||age>settings.quoteMaxAgeMs)throw Error('Missing/stale quote snapshot');
 const service=quotes.services[model];
 // Bind controlled understanding envelopes to their reviewed upstream contract,
 // not a provider family/model-name guess. AI Studio and Vertex are distinct.
 if(kind==='file-input'&&service.provider!=='api.openai.com')throw Error('file-input requires quoted provider api.openai.com');
 if(kind==='video-input'&&service.provider!=='aiplatform.googleapis.com')throw Error('video-input requires quoted provider aiplatform.googleapis.com');
 if((service.kind??'text')!==expected)throw Error('Requested kind does not match quoted service kind');
 if(service.policyExpiresAt!==undefined && (!Number.isFinite(Date.parse(service.policyExpiresAt))||Date.parse(service.policyExpiresAt)<=now))throw Error('Quoted policy expired');
 for(const key of TOKEN_PRICE_KEYS)if(!Number.isFinite(service.pricing?.[key])||service.pricing[key]<0)throw Error('Invalid quoted token pricing');
 if(['image','video'].includes(expected) && (!Number.isFinite(service.unitPriceUsd)||service.unitPriceUsd<=0||service.unitPriceUsd>budget))throw Error('Media unit price exceeds budget or is invalid');
 if(kind==='edit' && !service.media?.inputs?.includes('image'))throw Error('Quoted model does not support edit input');
 if(kind==='image' && service.media?.inputs?.includes('image'))throw Error('Edit-input model cannot be used as generation kind');
 if(kind==='video' && !service.media?.inputs?.includes('image'))throw Error('Only reviewed image-input native video is supported');
 if(expectedInput[kind] && expected==='text' && service.media?.inputs && !service.media.inputs.includes(expectedInput[kind]))throw Error('Quoted model does not support requested input');
 return service;
}
export function buildBuyerConfig(settings,service,model,budget,port,peer) {
 if(!Number.isFinite(budget)||budget<=0||budget>5||!Number.isSafeInteger(port)||port<1024||port>65535||!/^[a-f0-9]{40}$/.test(peer))throw Error('Invalid buyer limits');
 const maxPricing=Object.fromEntries(TOKEN_PRICE_KEYS.map(key=>[key,service.pricing[key]]));
 const units=String(Math.floor(budget*1e6));
 // This pinned AntSeed release has token maxPricing only: no maxUnitPriceUsd.
 // Payment settings below are replenishable windows, not absolute run caps.
 // The mandatory child preload imposes the aggregate ReserveAuth ceiling;
 // video additionally uses x-antseed-max-video-usdc on the create only.
 return {buyer:{maxPricing:{defaults:maxPricing},routingPreferences:{allowedPeerIds:[peer],blockedPeerIds:[]},minPeerReputation:0,proxyPort:port,metadataFetchTimeoutMs:15000,autoSweep:false},payments:{maxPerRequestUsdc:units,maxReserveAmountUsdc:units,maxVideoRequestUsdc:units,crypto:{rpcUrl:settings.rpcUrl}}};
}
function checkInput(kind,input) {
 if(requiredInput.has(kind)&&!input)throw Error(`${kind} requires --input`);
 if(!input)return;
 if(!Buffer.isBuffer(input.bytes)||!input.bytes.length||input.bytes.length>MAX_INPUT_BYTES)throw Error('Input must be 1 byte to 1 MiB');
 const allowed=kind==='audio-input'?['audio/wav','audio/mpeg']:kind==='file-input'?['application/pdf']:kind==='video-input'?['video/mp4']:['image/png'];
 if(!allowed.includes(input.mime))throw Error('Unsupported input MIME for kind');
 if(['image','text','responses','messages','decision'].includes(kind))throw Error('--input is not supported for this kind');
}
export function buildContentRequest(kind,model,input) {
 if(!CONTENT_KINDS.includes(kind)||!/^[A-Za-z0-9_.:/-]+$/.test(model))throw Error('Invalid kind/model');
 checkInput(kind,input);
 const json=(path,body)=>({path,headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const uri=input?`data:${input.mime};base64,${input.bytes.toString('base64')}`:undefined;
 if(kind==='image')return json('/v1/images/generations',{model,prompt:'A plain red square on a white background.',n:1,size:'1024x1024',response_format:'b64_json'});
 if(kind==='edit'){
  const body=new FormData();body.set('model',model);body.set('prompt','Change the red square to a blue square.');body.set('n','1');body.set('response_format','b64_json');body.set('image',new Blob([input.bytes],{type:input.mime}),'input.png');
  return {path:'/v1/images/edits',headers:{},body};
 }
 if(kind==='video')return json('/api/v1/video/queue',{model,duration:'5s',resolution:'720p',prompt:'A red square slowly moving to the right on a plain background.',image_url:uri});
 // Historical SI decisions-probe.ts fixture (2207d607e747f487a4d83e60c7f24ad677a55a7f),
 // not current-upstream certification; retain the probe's requested answer id ok.
 if(kind==='decision')return json('/v1/systemone',{model,state:{ticket_summary:'Card charged twice for the June invoice; the customer asked for a refund 38 hours ago.',account_tier:'pro',messages_waiting:2},questions:{ok:{type:'noul',instructions:'Answer whether this ticket is urgent enough to page the on-call engineer within the hour with a calibrated probability.',criteria:{urgent:{allow:[0,1]}}}}});
 const prompt=`Return exactly: ${TEXT}`;
 if(kind==='responses')return json('/v1/responses',{model,input:prompt,max_output_tokens:64});
 if(kind==='messages')return json('/v1/messages',{model,max_tokens:64,messages:[{role:'user',content:prompt}]});
 let content=prompt;
 if(input){
  const blocks={vision:{type:'image_url',image_url:{url:uri}},'audio-input':{type:'input_audio',input_audio:{data:input.bytes.toString('base64'),format:input.mime==='audio/wav'?'wav':'mp3'}},'file-input':{type:'file',file:{filename:'fixture.pdf',file_data:uri}},'video-input':{type:'input_audio',input_audio:{format:'video/mp4',data:input.bytes.toString('base64')}}};
  const question=kind==='vision'?'What is the predominant color of the square? Answer with only the color name.':kind==='audio-input'?'Transcribe the spoken words in this short audio.':kind==='file-input'?'Read the text in this short document.':'Describe the predominant color and motion in this short video.';
  content=[{type:'text',text:question},blocks[kind]];
 }
 return json('/v1/chat/completions',{model,messages:[{role:'user',content}],max_tokens:64,temperature:0});
}
export async function readPrivateJson(path) {
 if(!path)throw Error('Missing private wallet file path');
 let file;
 try{file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(error){if(error.code==='ELOOP')throw Error('Wallet must be a private regular file, not symlink');throw error;}
 try {
  const info=await file.stat();if(!info.isFile()||(info.mode&0o077)||info.size>65536)throw Error('Wallet must be a private regular file (0600)');
  return JSON.parse(await file.readFile('utf8'));
 } catch(error){if(error.code==='ELOOP')throw Error('Wallet must be a private regular file, not symlink');throw error;} finally{await file.close();}
}
export async function readProbeInput(path,kind) {
 if(!path){checkInput(kind);return undefined;}
 const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size>MAX_INPUT_BYTES||!info.size)throw Error('Input must be a regular file, 1 byte to 1 MiB');
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 let bytes;try{bytes=await file.readFile();}finally{await file.close();}
 let mime;
 if(bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))mime='image/png';
 else if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WAVE')mime='audio/wav';
 else if(bytes.subarray(0,3).toString()==='ID3'||bytes[0]===255&&(bytes[1]&224)===224)mime='audio/mpeg';
 else if(bytes.subarray(0,5).toString()==='%PDF-')mime='application/pdf';
 else if(bytes.subarray(4,8).toString()==='ftyp')mime='video/mp4';
 else throw Error('Unrecognized input magic bytes');
 const input={bytes,name:'fixture',mime};checkInput(kind,input);return input;
}
async function boundedBytes(response,limit=MAX_RESULT_BYTES) {
 if(Number(response.headers.get('content-length'))>limit){await response.body?.cancel();throw Error('Content response exceeds byte limit');}
 if(!response.body)return Buffer.alloc(0);
 const reader=response.body.getReader(),parts=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw Error('Content response exceeds byte limit');parts.push(value);}}catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
 return Buffer.concat(parts,size);
}
function parseJson(bytes){try{return JSON.parse(bytes.toString('utf8'));}catch{throw Error('Invalid native JSON response');}}
function safeCode(value){return typeof value==='string'?value.replace(/[^A-Za-z0-9_.-]/g,'').slice(0,80):'native_error';}
function checkHttp(response,body) {
 if(!response.ok||body?.error){const status=response.status;const error=Error(`Paid content failed HTTP ${status}: ${safeCode(body?.error?.code??body?.code)}`);error.status=status;throw error;}
}
function nativeJson(response,bytes){
 if(!response.ok){let body;try{body=JSON.parse(bytes.toString('utf8'));}catch{}checkHttp(response,body);}
 const body=parseJson(bytes);checkHttp(response,body);return body;
}
function usageOnly(value,depth=0){
 if(depth>5)return undefined;
 if(typeof value==='number'&&Number.isFinite(value))return value;
 if(typeof value==='string'&&/^\d+(?:\.\d+)?$/.test(value)&&value.length<=40)return value;
 if(!object(value))return undefined;
 return Object.fromEntries(Object.entries(value).slice(0,80).filter(([key])=>/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)).map(([key,item])=>[key,usageOnly(item,depth+1)]).filter(([,item])=>item!==undefined));
}
const PNG_SIGNATURE=Buffer.from('89504e470d0a1a0a','hex');
const PNG_MAX_PIXELS=16*1024*1024,PNG_MAX_DECODED_BYTES=64*1024*1024;
const PNG_CRC_TABLE=Uint32Array.from({length:256},(_,value)=>{
 for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0xedb88320:0);
 return value>>>0;
});
function pngCrc(bytes,start,end){
 let crc=0xffffffff;for(let at=start;at<end;at++)crc=(crc>>>8)^PNG_CRC_TABLE[(crc^bytes[at])&255];
 return (crc^0xffffffff)>>>0;
}
function pngPaeth(a,b,c){
 const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);
 return pa<=pb&&pa<=pc?a:pb<=pc?b:c;
}
/** Bounded genuine sample decode to RGBA8, not a header/inflate-only check.
 * Supports static non-interlaced 8-bit PNG color types 0/2/3/4/6, all filters,
 * PLTE and tRNS. Packed/16-bit, Adam7 and APNG fail closed explicitly.
 * Ancillary metadata is CRC/boundary checked but not interpreted/color-managed.
 */
export function decodeProbePng(bytes){
 if(!Buffer.isBuffer(bytes)||bytes.length<45||bytes.length>MAX_RESULT_BYTES||!bytes.subarray(0,8).equals(PNG_SIGNATURE))throw Error('Invalid PNG bytes/size limit');
 let width,height,color,channels,rowBytes,decodedLength,palette,transparency;
 let at=8,chunks=0,seenData=false,dataClosed=false,ended=false;
 const compressed=[];
 while(at<bytes.length){
  if(++chunks>20000||bytes.length-at<12)throw Error('Invalid PNG chunk boundary/count limit');
  const length=bytes.readUInt32BE(at),type=bytes.toString('latin1',at+4,at+8),end=at+8+length;
  if(length>bytes.length-at-12||! /^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type))throw Error('Invalid PNG chunk length/type');
  if(pngCrc(bytes,at+4,end)!==bytes.readUInt32BE(end))throw Error('Invalid PNG chunk CRC');
  const data=bytes.subarray(at+8,end);
  if(chunks===1&&type!=='IHDR')throw Error('PNG IHDR must be first');
  if(type==='IHDR'){
   if(chunks!==1||length!==13)throw Error('Invalid PNG IHDR structure');
   width=data.readUInt32BE(0);height=data.readUInt32BE(4);color=data[9];
   channels=({0:1,2:3,3:1,4:2,6:4})[color];
   if(!channels||data[8]!==8)throw Error('Unsupported PNG color/bit depth layout: require 8-bit color type 0/2/3/4/6');
   if(data[10]!==0||data[11]!==0)throw Error('Invalid PNG compression/filter method');
   if(data[12]!==0)throw Error('Unsupported PNG interlace: require non-interlaced image');
   rowBytes=width*channels;decodedLength=(rowBytes+1)*height;
   // Enforce all size bounds BEFORE concatenation, inflation or pixel allocation.
   if(!width||!height||width>16384||height>16384||width*height>PNG_MAX_PIXELS||decodedLength>PNG_MAX_DECODED_BYTES||width*height*4>PNG_MAX_DECODED_BYTES)throw Error('PNG dimensions/decoded byte limit exceeded');
  }else if(type==='PLTE'){
   if(palette||seenData||transparency||color===0||color===4||!length||length%3||length>768)throw Error('Invalid PNG palette structure/order');
   palette=data;
  }else if(type==='tRNS'){
   if(transparency||seenData||![0,2,3].includes(color)||(color===3&&(!palette||!length||length>palette.length/3))||(color===0&&(length!==2||data.readUInt16BE(0)>255))||(color===2&&(length!==6||[0,2,4].some(offset=>data.readUInt16BE(offset)>255))))throw Error('Invalid PNG transparency structure/order');
   transparency=data;
  }else if(type==='IDAT'){
   if(dataClosed||(color===3&&!palette))throw Error('Invalid PNG IDAT/palette order');
   seenData=true;compressed.push(data);
  }else if(type==='IEND'){
   if(length||!seenData||end+4!==bytes.length)throw Error('Invalid PNG IEND structure/trailing bytes');
   ended=true;break;
  }else{
   if(['acTL','fcTL','fdAT'].includes(type))throw Error('PNG unsupported animated image');
   if(type[0]===type[0].toUpperCase())throw Error('Unsupported PNG critical chunk');
  }
  if(seenData&&type!=='IDAT')dataClosed=true;
  at=end+4;
 }
 if(!ended)throw Error('Incomplete PNG image');
 const packed=Buffer.concat(compressed);let inflated;
 try{inflated=inflateSync(packed,{maxOutputLength:decodedLength,info:true});}catch{throw Error('Invalid PNG pixel scanline stream/length');}
 if(inflated.engine.bytesWritten!==packed.length)throw Error('Invalid PNG compressed stream trailing bytes');
 const scanlines=inflated.buffer;
 if(scanlines.length!==decodedLength)throw Error('Invalid PNG pixel scanline length');
 const pixels=Buffer.alloc(width*height*4);
 // Reconstruct in place; previous rows remain available, with no second full
 // sample allocation. Filters operate on bytes (channels bytes per pixel).
 for(let y=0;y<height;y++){
  const start=y*(rowBytes+1)+1,previous=start-(rowBytes+1),filter=scanlines[start-1];
  if(filter>4)throw Error('Invalid PNG scanline filter');
  for(let x=0;x<rowBytes;x++){
   const a=x>=channels?scanlines[start+x-channels]:0,b=y?scanlines[previous+x]:0,c=y&&x>=channels?scanlines[previous+x-channels]:0;
   const predictor=filter===0?0:filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):pngPaeth(a,b,c);
   scanlines[start+x]=(scanlines[start+x]+predictor)&255;
  }
  for(let x=0;x<width;x++){
   const sample=start+x*channels,out=(y*width+x)*4,v=scanlines[sample];
   let r,g,b,alpha=255;
   if(color===3){
    if(v>=palette.length/3)throw Error('Invalid PNG reconstructed palette index');
    r=palette[v*3];g=palette[v*3+1];b=palette[v*3+2];alpha=transparency?.[v]??255;
   }else if(color===0||color===4){
    r=g=b=v;alpha=color===4?scanlines[sample+1]:transparency&&v===transparency.readUInt16BE(0)?0:255;
   }else{
    r=v;g=scanlines[sample+1];b=scanlines[sample+2];
    alpha=color===6?scanlines[sample+3]:transparency&&r===transparency.readUInt16BE(0)&&g===transparency.readUInt16BE(2)&&b===transparency.readUInt16BE(4)?0:255;
   }
   pixels[out]=r;pixels[out+1]=g;pixels[out+2]=b;pixels[out+3]=alpha;
  }
 }
 return {width,height,pixels};
}
function imageInfo(bytes) {
 let width,height,mime;
 if(bytes.subarray(0,8).equals(PNG_SIGNATURE)) {
  ({width,height}=decodeProbePng(bytes));mime='image/png';
 }else if(bytes.length>4&&bytes[0]===255&&bytes[1]===216&&bytes[bytes.length-2]===255&&bytes[bytes.length-1]===217){
  // JPEG and WebP below inspect container metadata only, NOT decoded pixels.
  mime='image/jpeg';let at=2;
  while(at+4<bytes.length){if(bytes[at++]!==255)continue;const marker=bytes[at++];if(marker===218)break;if(marker===216||marker===217)continue;const size=bytes.readUInt16BE(at);if(size<2||at+size>bytes.length)throw Error('Truncated JPEG image');if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){height=bytes.readUInt16BE(at+3);width=bytes.readUInt16BE(at+5);break;}at+=size;}
 }else if(bytes.length>=30&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'){
  mime='image/webp';if(bytes.readUInt32LE(4)+8!==bytes.length)throw Error('Truncated WebP image');
  const type=bytes.toString('ascii',12,16);
  if(type==='VP8X'){width=1+bytes.readUIntLE(24,3);height=1+bytes.readUIntLE(27,3);}
  else if(type==='VP8 '&&bytes.subarray(23,26).equals(Buffer.from([157,1,42]))){width=bytes.readUInt16LE(26)&16383;height=bytes.readUInt16LE(28)&16383;}
  else if(type==='VP8L'&&bytes[20]===47){const bits=bytes.readUInt32LE(21);width=(bits&16383)+1;height=((bits>>>14)&16383)+1;}
 }
 if(!mime||!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width>16384||height>16384||width*height>32*1024*1024)throw Error('Invalid image bytes/dimensions');
 return {mime,width,height,bytes:bytes.length,sha256:digest(bytes)};
}
async function extractImage(body,options) {
 if(!Array.isArray(body.data)||body.data.length!==1)throw Error('Expected exactly one output image');
 const item=body.data[0];let bytes;
 let b64=item?.b64_json;
 if(!b64&&typeof item?.url==='string'&&item.url.startsWith('data:')){const match=/^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(item.url);if(!match)throw Error('Invalid image data URI');b64=match[1];}
 if(b64!==undefined){if(typeof b64!=='string'||!b64.length||b64.length>MAX_RESULT_BYTES*1.4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64))throw Error('Invalid image base64');bytes=Buffer.from(b64,'base64');}
 else {
  let url;try{url=new URL(item?.url);}catch{throw Error('Invalid image asset URL');}
  if(url.protocol!=='https:'||url.username||url.password||url.port||!(options.assetHosts??[]).includes(url.hostname)||/^(?:localhost|[\d.:]+)$/.test(url.hostname))throw Error('Unapproved image asset host/URL');
  const remote=await (options.fetchImpl??fetch)(url.href,{redirect:'error',credentials:'omit',signal:AbortSignal.timeout(60000)});
  if(!remote.ok){await remote.body?.cancel();throw Error(`Image asset HTTP ${remote.status}`);}bytes=await boundedBytes(remote);
 }
 return {bytes,media:imageInfo(bytes)};
}
export async function inspectVideoBytes(bytes) {
 // Dependency-free ISO BMFF metadata validation, NOT a decoded-frame assertion.
 // ffmpeg/ffprobe can independently inspect the saved artifact when installed.
 if(!Buffer.isBuffer(bytes)||bytes.length<24||bytes.length>MAX_RESULT_BYTES)throw Error('Invalid MP4 bytes');
 let count=0;
 function boxes(start,end){
  const found=[];
  while(start<end){
   if(++count>20000||end-start<8)throw Error('Invalid MP4 box boundary');
   let size=bytes.readUInt32BE(start),head=8;
   const type=bytes.toString('ascii',start+4,start+8);
   if(size===1){if(end-start<16)throw Error('Truncated MP4 extended box');const big=bytes.readBigUInt64BE(start+8);if(big>BigInt(MAX_RESULT_BYTES))throw Error('MP4 box exceeds limit');size=Number(big);head=16;}
   else if(size===0)size=end-start;
   if(size<head||size>end-start)throw Error('Invalid/truncated MP4 box size');
   found.push({type,start:start+head,end:start+size});start+=size;
  }
  return found;
 }
 const top=boxes(0,bytes.length),moov=top.find(b=>b.type==='moov');
 if(!top.some(b=>b.type==='ftyp')||!top.some(b=>b.type==='mdat'&&b.end>b.start)||!moov)throw Error('Missing MP4 metadata/media boxes');
 const movie=boxes(moov.start,moov.end);
 for(const track of movie.filter(b=>b.type==='trak')){
  const mdia=boxes(track.start,track.end).find(b=>b.type==='mdia');if(!mdia)continue;
  const media=boxes(mdia.start,mdia.end),handler=media.find(b=>b.type==='hdlr');
  if(!handler||handler.end-handler.start<12||bytes.toString('ascii',handler.start+8,handler.start+12)!=='vide')continue;
  const mdhd=media.find(b=>b.type==='mdhd'),minf=media.find(b=>b.type==='minf');if(!mdhd||!minf)throw Error('Missing MP4 video metadata');
  const version=bytes[mdhd.start],offset=mdhd.start+(version===1?20:12);
  if(version>1||offset+(version===1?12:8)>mdhd.end)throw Error('Invalid MP4 duration metadata');
  const timescale=bytes.readUInt32BE(offset),ticks=version===1?Number(bytes.readBigUInt64BE(offset+4)):bytes.readUInt32BE(offset+4);
  if(!timescale||!Number.isSafeInteger(ticks))throw Error('Invalid MP4 timescale');
  const stbl=boxes(minf.start,minf.end).find(b=>b.type==='stbl');if(!stbl)throw Error('Missing MP4 sample metadata');
  const stsd=boxes(stbl.start,stbl.end).find(b=>b.type==='stsd');
  if(!stsd||stsd.end-stsd.start<8||bytes.readUInt32BE(stsd.start+4)!==1)throw Error('Invalid MP4 codec metadata');
  const entry=boxes(stsd.start+8,stsd.end)[0];
  if(!entry||entry.end-entry.start<78||!['avc1','avc3','hvc1','hev1','av01','vp09','mp4v'].includes(entry.type))throw Error('Unsupported/missing MP4 video codec');
  let duration=ticks/timescale;
  // Fragmented MP4s commonly keep mdhd duration zero. Sum explicit/default
  // trun sample durations, bounded by the box and count limits above.
  if(duration===0){
   let total=0;
   for(const moof of top.filter(b=>b.type==='moof'))for(const traf of boxes(moof.start,moof.end).filter(b=>b.type==='traf')){
    const fragments=boxes(traf.start,traf.end),tfhd=fragments.find(b=>b.type==='tfhd');
    if(!tfhd||tfhd.end-tfhd.start<8)throw Error('Invalid MP4 fragment metadata');
    const flags=bytes.readUIntBE(tfhd.start+1,3);let at=tfhd.start+8;
    if(flags&1)at+=8;if(flags&2)at+=4;
    let defaultDuration=0;if(flags&8){if(at+4>tfhd.end)throw Error('Invalid MP4 fragment duration');defaultDuration=bytes.readUInt32BE(at);}
    for(const run of fragments.filter(b=>b.type==='trun')){
     if(run.end-run.start<8)throw Error('Invalid MP4 sample run');
     const flags=bytes.readUIntBE(run.start+1,3),samples=bytes.readUInt32BE(run.start+4);if(samples>100000)throw Error('MP4 sample count limit');
     let at=run.start+8;if(flags&1)at+=4;if(flags&4)at+=4;
     const stride=4*([256,512,1024,2048].filter(flag=>flags&flag).length);
     if(at+stride*samples>run.end)throw Error('Truncated MP4 sample run');
     if(!(flags&256)&&!defaultDuration)throw Error('Missing MP4 sample duration');
     for(let n=0;n<samples;n++){total+=(flags&256)?bytes.readUInt32BE(at):defaultDuration;at+=stride;}
    }
   }
   duration=total/timescale;
  }
  const width=bytes.readUInt16BE(entry.start+24),height=bytes.readUInt16BE(entry.start+26);
  if(!width||!height||!Number.isFinite(duration)||duration<=0||duration>3600)throw Error('Invalid MP4 dimensions/duration');
  return {codec:entry.type,width,height,duration,validation:'mp4-container-metadata'};
 }
 throw Error('MP4 has no video track metadata');
}
export async function inspectContentResponse(kind,response,options={}) {
 const bytes=await boundedBytes(response,kind==='video'?MAX_RESULT_BYTES:32*1024*1024);
 const type=response.headers.get('content-type')??'';
 if(kind==='video'&&response.ok&&type.split(';')[0].trim()==='video/mp4'){
  if(bytes.length<24||bytes.toString('ascii',4,8)!=='ftyp')throw Error('Invalid MP4 bytes');
  const info=await (options.inspectVideo??inspectVideoBytes)(bytes);
  if(!info.codec||!Number.isFinite(info.duration)||info.duration<4.5)throw Error('Delivered video duration below 90% of requested 5 seconds');
  // Fixed 5s request: inclusive ±10% tolerance; metadata is not a full decode.
  if(info.duration>5.5)throw Error('Delivered video duration above 110% of requested 5 seconds');
  if(!Number.isInteger(info.width)||!Number.isInteger(info.height)||Math.min(info.width,info.height)<720||Math.max(info.width,info.height)>4096)throw Error('Invalid delivered video dimensions (requested 720p)');
  return {bytes,media:{mime:'video/mp4',...info,bytes:bytes.length,sha256:digest(bytes)},usage:null};
 }
 const body=nativeJson(response,bytes);
 if(kind==='video')throw Error('Native retrieve did not deliver MP4 bytes');
 const usage=usageOnly(body.usage)??null;
 if(['image','edit'].includes(kind))return {...await extractImage(body,options),usage};
 if(kind==='decision'){
  const answer=body.answers?.ok;
  const number=answer?.noul??answer?.probability;
  // Native gateway semantics permit omitted type and any finite scalar; the
  // fixture's [0,1] criteria are not an additional response protocol constraint.
  if(!object(answer)||(answer.type!==undefined&&answer.type!=='noul')||typeof number!=='number'||!Number.isFinite(number))throw Error('Missing/invalid numeric decision answer ok');
  return {usage,answer:{type:'noul',noul:number}};
 }
 let text;
 if(kind==='responses')text=body.output?.flatMap(item=>item.type==='message'?(item.content??[]).filter(part=>part.type==='output_text').map(part=>part.text):[]).join('\n');
 else if(kind==='messages')text=body.content?.filter(item=>item.type==='text').map(item=>item.text).join('\n');
 else text=body.choices?.[0]?.message?.content;
 const expected=kind==='vision'?'red':['audio-input','file-input','video-input'].includes(kind)?options.expectedContains:TEXT;
 if(typeof expected!=='string'||!expected.trim())throw Error('Understanding input requires TEST_EXPECT_CONTAINS');
 if(typeof text!=='string'||!text.toLowerCase().includes(expected.toLowerCase()))throw Error('Content did not contain expected objective answer');
 return {usage,answerMatched:true,textSha256:digest(Buffer.from(text))};
}
export async function executeContentRequest({kind,model,input,baseUrl,peer,budget,fetchImpl=fetch,pollIntervalMs=5000,timeoutMs=1800000,...options}) {
 const url=new URL(baseUrl);
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/'||url.username||url.password||url.search||url.hash)throw Error('Buyer proxy must be loopback HTTP');
 if(!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>1800000||!Number.isFinite(pollIntervalMs)||pollIntervalMs<1||pollIntervalMs>30000)throw Error('Invalid bounded timeout/poll interval');
 const request=buildContentRequest(kind,model,input),deadline=Date.now()+timeoutMs;
 const send=async request=>{
  const remaining=deadline-Date.now();if(remaining<=0)throw Error('Content probe deadline exceeded; accepted video may still incur charge');
  return await fetchImpl(new URL(request.path,baseUrl).href,{method:'POST',headers:{...request.headers,...(peer?{'x-antseed-pin-peer':peer}:{}),'x-antseed-service':model,...(kind==='video'&&request.path.endsWith('/queue')?{'x-antseed-max-video-usdc':String(Math.floor(budget*1e6))}:{})},body:request.body,redirect:'error',signal:AbortSignal.timeout(Math.min(remaining,180000))});
 };
 const first=await send(request);
 if(kind!=='video')return {status:first.status,...await inspectContentResponse(kind,first,{...options,fetchImpl})};
 const created=nativeJson(first,await boundedBytes(first,1024*1024));
 if(typeof created.queue_id!=='string'||!/^[A-Za-z0-9_.:-]{1,256}$/.test(created.queue_id))throw Error('Native video creation missing queue_id');
 const createUsage=usageOnly(created.usage)??null;
 for(;;){
  if(Date.now()+pollIntervalMs>=deadline)throw Error('Video polling deadline exceeded; accepted render is not canceled');
  await sleep(pollIntervalMs);
  const response=await send({path:'/api/v1/video/retrieve',headers:{'content-type':'application/json'},body:JSON.stringify({model,queue_id:created.queue_id})});
  if(response.headers.get('content-type')?.split(';')[0].trim()==='video/mp4')return {status:response.status,...await inspectContentResponse('video',response,options),createUsage};
  const body=nativeJson(response,await boundedBytes(response,1024*1024));
  const state=typeof body.status==='string'?body.status.toLowerCase():body.status;
  if(['failed','canceled','cancelled','expired','error'].includes(state))throw Error(`Native video terminal status: ${state}`);
  if(!['queued','submitted','running','pending','processing'].includes(state)&&state!==202)throw Error('Unexpected native video poll JSON; MP4 delivery required');
 }
}
export async function stopBuyer(child,{graceMs=3000,killMs=2000,processGroup=false}={}) {
 if(!child)return;
 const exited=()=>child.exitCode!==null||child.signalCode!==null;
 const kill=signal=>{try{if(processGroup&&child.pid)process.kill(-child.pid,signal);else if(!exited())child.kill(signal);}catch(error){if(error.code!=='ESRCH')throw error;}};
 const wait=ms=>new Promise(resolve=>{
  if(exited())return resolve(true);
  const done=()=>{clearTimeout(timer);child.off('exit',done);child.off('close',done);resolve(true);};
  const timer=setTimeout(()=>{child.off('exit',done);child.off('close',done);resolve(false);},ms);
  child.once('exit',done);child.once('close',done);
 });
 try{
  if(!exited()){kill('SIGINT');if(!await wait(graceMs)){kill('SIGKILL');if(!await wait(killMs))throw Error('Buyer did not exit after SIGKILL');}}
 }finally{
  // A detached descendant can outlive the CLI leader and keep stdio open.
  // The group is ours alone; kill remaining descendants even after leader exit.
  if(processGroup&&child.pid)kill('SIGKILL');
  child.stdout?.destroy();child.stderr?.destroy();child.unref?.();
 }
}

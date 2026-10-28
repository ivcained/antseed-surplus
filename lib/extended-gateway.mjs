import {randomUUID} from 'node:crypto';
import {isIP} from 'node:net';
import {once} from 'node:events';
import {isDeepStrictEqual} from 'node:util';

const ORIGIN='https://api.surplusintelligence.ai';
const NATIVE_HOSTS=new Set(['api.venice.ai','api.typesafe.ai','api.groq.com','api.openai.com','api.anthropic.com','generativelanguage.googleapis.com']);
const ROUTES=new Set(['/v1/images/generations','/v1/images/edits','/v1/systemone','/v1/responses','/v1/messages','/api/v1/video/queue','/api/v1/video/retrieve']);
const IMAGE_LIMIT=32*1024*1024;
const ROUTING=new Set(['model','service','provider','providers','provider_order','provider_base_url','provider_url','base_url','api_key','apiKey','authorization','headers','extra_body','si_route','providers_blocked','max_price_per_1m','min_discount','routing','route','webhook_url','metadata']);
const hostFor=provider=>({venice:'api.venice.ai',typesafe:'api.typesafe.ai'}[provider]??provider);
class GatewayError extends Error {constructor(status,code){super(code);this.status=status;this.code=code;}}
function fail(status,code){throw new GatewayError(status,code);}
function object(value){return value!==null && typeof value==='object' && !Array.isArray(value);}
function send(res,status,value){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));}
function serviceConfig(settings,model){const services=settings.mediaConfig?.services;return Array.isArray(services)?services.find(s=>s.model===model):Object.hasOwn(services??{},model)?services[model]:undefined;}
function quoteFor(settings,book,model,kind){
 const age=Date.now()-Date.parse(book?.generatedAt);if(!Number.isFinite(age)||age<0||age>settings.quoteMaxAgeMs)fail(503,'quote_unavailable');
 const quote=Object.hasOwn(book?.services??{},model)?book.services[model]:undefined;
 if(!quote||quote.upstreamModel!==model||!NATIVE_HOSTS.has(quote.provider))fail(503,'quote_unavailable');
 if(quote.policyExpiresAt!==undefined&&(!Number.isFinite(Date.parse(quote.policyExpiresAt))||Date.parse(quote.policyExpiresAt)<=Date.now()))fail(503,'pricing_consent_expired');
 if(kind==='image'||kind==='video'||kind==='decision'){
  const config=serviceConfig(settings,model),media=quote.media;
  if(!config||quote.kind!==kind||media?.kind!==kind||media.model!==model||hostFor(media.provider)!==quote.provider||hostFor(config.provider)!==quote.provider||config.kind!==kind||!object(media.parameters)||!Array.isArray(config.inputs)||!isDeepStrictEqual(media.parameters,config.parameters)||!Array.isArray(media.inputs)||!isDeepStrictEqual([...media.inputs].sort(),[...config.inputs].sort())||!quote.policyExpiresAt||(settings.mediaConfig.expiresAt!==undefined&&quote.policyExpiresAt!==settings.mediaConfig.expiresAt))fail(503,'quote_unavailable');
 }
 if(kind==='image'||kind==='video'){
  if(!(quote.unitPriceUsd>0)||!Number.isFinite(quote.unitPriceUsd)||!(quote.estimatedUpstreamUsd>0)||!Number.isFinite(quote.estimatedUpstreamUsd)||quote.unitPriceUsd<quote.estimatedUpstreamUsd)fail(503,'quote_unavailable');
 } else {
  if(kind==='decision'?(quote.kind!=='decision'||!serviceConfig(settings,model)):(quote.kind!==undefined&&quote.kind!=='text'))fail(503,'quote_unavailable');
  for(const key of ['inputUsdPerMillion','outputUsdPerMillion','cachedInputUsdPerMillion']){const p=quote.pricing?.[key],u=quote.upstreamPricing?.[key];if(typeof p!=='number'||typeof u!=='number'||!Number.isFinite(p)||!Number.isFinite(u)||p<0||u<0||p<u)fail(503,'quote_unavailable');}
  if(!(quote.upstreamPricing.inputUsdPerMillion>0)||(kind!=='decision'&&!(quote.upstreamPricing.outputUsdPerMillion>0))||!Number.isFinite(quote.maxPricePer1m)||quote.maxPricePer1m<Math.max(...Object.values(quote.upstreamPricing)))fail(503,'quote_unavailable');
 }
 return quote;
}
async function readBytes(stream,limit){let size=0;const chunks=[];for await(const chunk of stream){size+=chunk.length;if(size>limit)fail(413,'body_too_large');chunks.push(Buffer.from(chunk));}return Buffer.concat(chunks);}
async function readJson(req,limit){if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??''))fail(415,'json_required');let value;try{value=JSON.parse((await readBytes(req,limit)).toString('utf8'));}catch(e){if(e instanceof GatewayError)throw e;fail(400,'invalid_json');}if(!object(value))fail(400,'invalid_request');return value;}
async function readMultipart(req,limit){
 const bytes=await readBytes(req,limit);let form;try{form=await new Response(bytes,{headers:{'content-type':req.headers['content-type']}}).formData();}catch{fail(400,'invalid_multipart');}
 const body={},files=[];let fields=0;
 for(const [key,value]of form.entries()){
  if(key==='mask'||key==='mask_url')fail(400,'mask_not_supported');
  if(typeof value==='string'){
   if(++fields>16||Buffer.byteLength(value)>1024*1024)fail(413,'multipart_field_limit');
   if(Object.hasOwn(body,key))fail(400,'duplicate_multipart_field');
   body[key]=value;
  }else{
   if(!['image','image[]'].includes(key)||files.length>=8||value.size>8*1024*1024||value.size===0)fail(400,'invalid_image_file');
   validateImageBytes(Buffer.from(await value.arrayBuffer()),value.type);files.push({key,value});
  }
 }
 if(body.n!==undefined){if(body.n!=='1')fail(400,'image_count_limit');body.n=1;}
 if(!files.length)fail(400,'image_required');return {body,files};
}
function validateImageBytes(bytes,mime){
 const dimensions=(w,h)=>Number.isInteger(w)&&Number.isInteger(h)&&w>0&&h>0&&w<=8192&&h<=8192&&w*h<=16777216;
 let valid=false;
 if(mime==='image/png'&&bytes.length>=45&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){
  let pos=8,header=false,data=false;
  while(pos+12<=bytes.length){const length=bytes.readUInt32BE(pos),type=bytes.toString('ascii',pos+4,pos+8);if(length>bytes.length-pos-12)break;
   if(!header){if(type!=='IHDR'||length!==13||!dimensions(bytes.readUInt32BE(pos+8),bytes.readUInt32BE(pos+12)))break;header=true;}
   else if(type==='IHDR'||type==='acTL')break;
   if(type==='IDAT'&&length>0)data=true;pos+=length+12;
   if(type==='IEND'){valid=length===0&&header&&data&&pos===bytes.length;break;}
  }
 }else if(mime==='image/jpeg'&&bytes.length>=16&&bytes[0]===255&&bytes[1]===216&&bytes.at(-2)===255&&bytes.at(-1)===217){
  let pos=2,frame=false;
  while(pos+4<=bytes.length){if(bytes[pos++]!==255)break;while(bytes[pos]===255)pos++;const marker=bytes[pos++];if(marker===0||marker===0xd8||marker===0xd9)break;if(marker===1||marker>=0xd0&&marker<=0xd7)continue;
   const length=bytes.readUInt16BE(pos);if(length<2||pos+length>bytes.length)break;
   if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){if(length<8||!dimensions(bytes.readUInt16BE(pos+5),bytes.readUInt16BE(pos+3)))break;frame=true;}
   if(marker===0xda){valid=frame&&pos+length<bytes.length-2;break;}pos+=length;
  }
 }else if(mime==='image/webp'&&bytes.length>=30&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.readUInt32LE(4)===bytes.length-8&&bytes.toString('ascii',8,12)==='WEBP'){
  const kind=bytes.toString('ascii',12,16),length=bytes.readUInt32LE(16);if(length<=bytes.length-20){
   if(kind==='VP8X'&&length===10&&(bytes[20]&2)===0)valid=dimensions(1+bytes.readUIntLE(24,3),1+bytes.readUIntLE(27,3))&&bytes.length>30;
   else if(kind==='VP8L'&&length>=5&&bytes[20]===0x2f){const bits=bytes.readUInt32LE(21);valid=dimensions((bits&0x3fff)+1,((bits>>>14)&0x3fff)+1);}
   else if(kind==='VP8 '&&length>=10&&bytes.subarray(23,26).equals(Buffer.from([0x9d,1,0x2a])))valid=dimensions(bytes.readUInt16LE(26)&0x3fff,bytes.readUInt16LE(28)&0x3fff);
  }
 }
 if(!valid)fail(400,'invalid_image_file');
}
function base64Image(value,mime){if(typeof value!=='string'||!value.length||value.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))fail(400,'invalid_image_data');const bytes=Buffer.from(value,'base64');if(bytes.length>8*1024*1024||bytes.toString('base64')!==value)fail(400,'invalid_image_data');if(mime)validateImageBytes(bytes,mime);else{let valid=false;for(const type of ['image/png','image/jpeg','image/webp'])try{validateImageBytes(bytes,type);valid=true;}catch{}if(!valid)fail(400,'invalid_image_data');}}
function safeImage(value){
 if(typeof value!=='string'||value.length>12*1024*1024)fail(400,'invalid_image_url');
 if(value.startsWith('data:')){const m=/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value);if(!m)fail(400,'invalid_image_url');base64Image(m[2],m[1]);return value;}
 let url;try{url=new URL(value);}catch{fail(400,'invalid_image_url');}
 const host=url.hostname.toLowerCase();
 // Fail closed for literal IPs/local names; the gateway never downloads buyer URLs.
 if(url.protocol!=='https:'||url.username||url.password||url.hash||(url.port&&url.port!=='443')||isIP(host)||host.includes(':')||host.startsWith('[')||!host.includes('.')||/(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)||[...url.searchParams.keys()].some(key=>/api.?key|authorization|access.?token|password/i.test(key)))fail(400,'invalid_image_url');
 return value;
}
const IMAGE_INPUTS=['input_images','images','image_url','image','input_image'];
function editInputs(body){
 const aliases=IMAGE_INPUTS.filter(k=>body[k]!==undefined);if(aliases.length!==1)fail(400,'image_required');
 const raw=body[aliases[0]],values=Array.isArray(raw)?raw:[raw];if(!values.length||values.length>8)fail(400,'image_count_limit');
 return values.map(value=>{if(typeof value==='string')return safeImage(value);if(!object(value))fail(400,'invalid_image_url');const url=value.url??value.image_url;if(Object.keys(value).some(k=>!['url','image_url','role'].includes(k))||(value.role!==undefined&&!['base','reference'].includes(value.role)))fail(400,'invalid_image_url');const safe=safeImage(url);return value.role?{url:safe,role:value.role}:safe;});
}
function imagePayload(body,quote,edit=false,files=[]){
 if(typeof body.prompt!=='string'||!body.prompt.trim()||body.prompt.length>2000)fail(400,'invalid_prompt');
 if(body.n!==undefined&&body.n!==1)fail(400,'image_count_limit');
 const inputs=quote.media.inputs;const editing=inputs.includes('image');if(edit!==editing)fail(400,'incompatible_image_operation');
 const payload={prompt:body.prompt,n:1};const parameters=quote.media.parameters??{};
 const allowed=new Set(['prompt','n','response_format',...Object.keys(parameters),...(edit?IMAGE_INPUTS:[])]);
 for(const [key,value] of Object.entries(body)){
  if(ROUTING.has(key))continue;
  if(!allowed.has(key))fail(400,'unsupported_image_parameter');
  if(Object.hasOwn(parameters,key)&&value!==parameters[key])fail(400,'unpriced_image_parameter');
 }
 if(body.response_format!==undefined&&!['url','b64_json'].includes(body.response_format))fail(400,'invalid_response_format');
 if(body.response_format!==undefined)payload.response_format=body.response_format;
 if(edit){if(files.length){if(IMAGE_INPUTS.some(k=>body[k]!==undefined))fail(400,'ambiguous_image_inputs');}else payload.input_images=editInputs(body);}
 Object.assign(payload,parameters);pin(payload,quote);
 if(!files.length)return payload;
 const form=new FormData();for(const [key,value]of Object.entries(payload))form.set(key,typeof value==='object'?JSON.stringify(value):String(value));for(const {key,value}of files)form.append(key,value,'image.'+({'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[value.type]));return form;
}
function pin(payload,quote){payload.model=quote.upstreamModel;payload.provider=quote.provider;payload.providers_blocked=['antseed'];if(quote.maxPricePer1m!==undefined)payload.max_price_per_1m=quote.maxPricePer1m;payload.si_route={objective:'price_without_cache',cache:false};return payload;}
function hasError(value,depth=0){if(!object(value)&&!Array.isArray(value))return false;if(depth>64)return true;return Object.entries(value).some(([k,v])=>(k==='error'&&v!=null&&v!==false)||hasError(v,depth+1));}
async function readResponseBytes(response,limit,signal){
 if(!response.body)fail(502,'upstream_invalid_response');const reader=response.body.getReader();const chunks=[];let size=0;
 const cancel=()=>{void reader.cancel().catch(()=>{});};signal?.addEventListener('abort',cancel,{once:true});
 try{for(;;){const {value,done}=await wait(reader.read(),signal);if(done)break;size+=value.byteLength;if(size>limit)fail(502,'upstream_invalid_response');chunks.push(Buffer.from(value));}return Buffer.concat(chunks);}finally{signal?.removeEventListener('abort',cancel);void reader.cancel().catch(()=>{});}
}
async function responseJson(response,limit=IMAGE_LIMIT,signal){const bytes=await readResponseBytes(response,limit,signal);let value;try{value=JSON.parse(bytes.toString('utf8'));}catch{fail(502,'upstream_invalid_response');}if(!object(value)||hasError(value))fail(502,'upstream_invalid_response');return value;}
function imageResponse(value){
 if(!Array.isArray(value.data)||value.data.length!==1||!object(value.data[0]))fail(502,'upstream_invalid_response');
 const item=value.data[0];try{if(item.b64_json!==undefined)base64Image(item.b64_json);else safeImage(item.url);}catch{fail(502,'upstream_invalid_response');}return value;
}
function tokenBudget(body,settings,key){for(const field of ['max_tokens','max_completion_tokens','max_output_tokens'])if(body[field]!==undefined&&(!Number.isSafeInteger(body[field])||body[field]<1||body[field]>settings.maxTokens))fail(400,'token_limit');return body[key]??settings.maxTokens;}
function decisionPayload(body,settings,quote){
 if(!Object.hasOwn(body,'state')||body.state===null||!['string','object'].includes(typeof body.state)||!object(body.questions)||!Object.keys(body.questions).length||Object.keys(body.questions).length>128||Object.values(body.questions).some(q=>!object(q)||(q.type!==undefined&&!['noul','choice','score'].includes(q.type))))fail(400,'invalid_decision_request');
 if(body.stream!==undefined&&body.stream!==false)fail(400,'invalid_stream');
 const payload={};for(const [key,value]of Object.entries(body))if(!ROUTING.has(key)&&!['max_completion_tokens','max_output_tokens','stream'].includes(key))payload[key]=value;
 payload.max_tokens=tokenBudget(body,settings,'max_tokens');return pin(payload,quote);
}
function decisionResponse(value,body){
 if(!object(value.answers))fail(502,'upstream_invalid_response');
 for(const [id,question]of Object.entries(body.questions)){
  const answer=value.answers[id];if(!object(answer))fail(502,'upstream_invalid_response');const type=question.type??'noul';if(answer.type!==undefined&&answer.type!==type)fail(502,'upstream_invalid_response');
  if(type==='noul'){const n=answer.noul??answer.probability;if(typeof n!=='number'||!Number.isFinite(n))fail(502,'upstream_invalid_response');}
  else if(type==='score'){if(typeof answer.score!=='number'||!Number.isFinite(answer.score))fail(502,'upstream_invalid_response');}
  else if(!['string','number','boolean'].includes(typeof answer.choice)||(typeof answer.choice==='number'&&!Number.isFinite(answer.choice)))fail(502,'upstream_invalid_response');
 }
 return value;
}
function textPayload(body,settings,quote,kind){
 if(body.stream!==undefined&&typeof body.stream!=='boolean')fail(400,'invalid_stream');
 let keys;
 if(kind==='responses'){
  for(const key of ['previous_response_id','conversation','background'])if(body[key]!==undefined)fail(400,'unsupported_stateful_request');
  if(!(typeof body.input==='string'||Array.isArray(body.input))||!body.input.length)fail(400,'invalid_input');
  if(body.tools!==undefined&&(!Array.isArray(body.tools)||body.tools.some(t=>!object(t)||t.type!=='function'||typeof t.name!=='string')))fail(400,'unsupported_tools');
  keys=['input','instructions','stream','temperature','top_p','tools','tool_choice','parallel_tool_calls','text','reasoning','truncation'];
 }else{
  if(!Array.isArray(body.messages)||!body.messages.length||body.messages.some(m=>!object(m)||!['user','assistant'].includes(m.role)||!(typeof m.content==='string'||Array.isArray(m.content))))fail(400,'invalid_messages');
  if(body.tools!==undefined&&(!Array.isArray(body.tools)||body.tools.some(t=>!object(t)||t.type!==undefined||typeof t.name!=='string'||!object(t.input_schema))))fail(400,'unsupported_tools');
  keys=['messages','system','stream','temperature','top_p','top_k','stop_sequences','tools','tool_choice'];
 }
 const payload={};for(const key of keys)if(Object.hasOwn(body,key))payload[key]=body[key];const tokenKey=kind==='responses'?'max_output_tokens':'max_tokens';payload[tokenKey]=tokenBudget(body,settings,tokenKey);return pin(payload,quote);
}
function textResponse(value,kind){if(kind==='responses'){if(!Array.isArray(value.output)||value.status!=='completed'||!value.output.length)fail(502,'upstream_invalid_response');}else if(value.type!=='message'||!Array.isArray(value.content)||!value.content.length)fail(502,'upstream_invalid_response');return value;}
function usageSummary(value){if(!object(value))return;const out={};for(const [key,v]of Object.entries(value)){if(!/^(prompt_tokens|completion_tokens|total_tokens|input_tokens|output_tokens|cached_tokens|buyer_cost_micro|buyer_cost_usdc|seller_cost_usdc|buyer_cost)$/.test(key))continue;if((typeof v==='number'&&Number.isFinite(v)&&v>=0)||(typeof v==='string'&&/^\d+(?:\.\d+)?$/.test(v)))out[key]=v;}return Object.keys(out).length?out:undefined;}

function wait(promise,signal){
 if(!signal)return Promise.resolve(promise);if(signal.aborted)return Promise.reject(signal.reason);
 return new Promise((resolve,reject)=>{const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});
}
async function writeStream(res,frame,signal,type='text/event-stream'){
 signal.throwIfAborted();if(!res.headersSent){res.setHeader('content-type',type);res.writeHead(200,{'cache-control':'no-cache, no-transform','x-accel-buffering':'no'});}if(!res.write(frame))await once(res,'drain',{signal});
}
async function streamResponse(response,res,signal,kind,onUsage){
 if(!response.body||!/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('content-type')??''))fail(502,'upstream_invalid_response');
 const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let pending='',terminal=false,started=false,total=0;
 const cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
 const process=async frame=>{
  const lines=frame.split(/\r?\n/);const data=lines.filter(l=>l.startsWith('data:')).map(l=>l.slice(5).replace(/^ /,'')).join('\n');
  if(data){
   if(terminal)fail(502,'upstream_invalid_stream');let value;try{value=JSON.parse(data);}catch{fail(502,'upstream_invalid_stream');}
   const named=lines.filter(l=>l.startsWith('event:'));if(named.length>1)fail(502,'upstream_invalid_stream');const event=named.length?named[0].slice(6).trim():value.type;
   if(!object(value)||typeof event!=='string'||value.type!==event||hasError(value)||['error','response.failed','response.incomplete'].includes(event))fail(502,'upstream_stream_error');
   if(kind==='responses'){
    if(!event.startsWith('response.'))fail(502,'upstream_invalid_stream');
    if(event==='response.completed'){textResponse(value.response,kind);terminal=true;}onUsage(usageSummary(value.response?.usage??value.usage));
   }else{
    if(!['message_start','message_delta','message_stop','content_block_start','content_block_delta','content_block_stop','ping'].includes(event))fail(502,'upstream_invalid_stream');
    if(event==='message_start'){if(started||value.message?.type!=='message')fail(502,'upstream_invalid_stream');started=true;}
    else if(event!=='ping'&&!started)fail(502,'upstream_invalid_stream');
    if(event==='message_stop')terminal=true;onUsage(usageSummary(value.message?.usage??value.usage));
   }
  }
  await writeStream(res,frame,signal);
 };
 try{
  for(;;){const {value,done}=await wait(reader.read(),signal);if(!done){total+=value.byteLength;if(total>IMAGE_LIMIT)fail(502,'upstream_invalid_stream');}pending+=done?decoder.decode():decoder.decode(value,{stream:true});
   for(;;){const m=/\r?\n\r?\n/.exec(pending);if(!m)break;const end=m.index+m[0].length;if(end>1024*1024)fail(502,'upstream_invalid_stream');const frame=pending.slice(0,end);pending=pending.slice(end);await process(frame);}if(pending.length>1024*1024)fail(502,'upstream_invalid_stream');if(done)break;
  }
  signal.throwIfAborted();if(pending.trim()||!terminal)fail(502,'upstream_incomplete_stream');res.end();
 }finally{signal.removeEventListener('abort',cancel);void reader.cancel().catch(()=>{});}
}
function videoPayload(body,quote){
 if(typeof body.prompt!=='string'||!body.prompt.trim()||body.prompt.length>2000)fail(400,'invalid_prompt');
 const payload={model:quote.upstreamModel,prompt:body.prompt},parameters=quote.media.parameters??{};const allowed=new Set(['prompt','duration','image_url',...Object.keys(parameters)]);
 for(const [key,value]of Object.entries(body)){if(ROUTING.has(key))continue;if(!allowed.has(key))fail(400,'unsupported_video_parameter');if(Object.hasOwn(parameters,key)&&value!==parameters[key])fail(400,'unpriced_video_parameter');}
 if(body.duration!==undefined){const duration=typeof body.duration==='string'&&/^\d+s?$/.test(body.duration)?Number(body.duration.replace(/s$/,'')):body.duration;if(duration!==parameters.duration_seconds)fail(400,'unpriced_video_parameter');}
 if(quote.media.inputs.includes('image'))payload.image_url=safeImage(body.image_url);else if(body.image_url!==undefined)fail(400,'incompatible_video_input');Object.assign(payload,parameters);payload.duration=parameters.duration_seconds;return payload;
}
async function relayVideo(response,res,signal,retrieve){
 if(!response||!response.ok){void response?.body?.cancel().catch(()=>{});fail(response?.status>=400&&response.status<=599?response.status:502,'video_request_failed');}
 const type=response.headers.get('content-type')??'';
 if(retrieve&&/^video\/mp4(?:\s*;|$)/i.test(type)){
  if(!response.body)fail(502,'video_invalid_response');const reader=response.body.getReader();let seen=false;const cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
  try{for(;;){const {value,done}=await wait(reader.read(),signal);if(done)break;if(value.byteLength){seen=true;await writeStream(res,value,signal,'video/mp4');}}if(!seen)fail(502,'video_invalid_response');res.end();}finally{signal.removeEventListener('abort',cancel);void reader.cancel().catch(()=>{});}return response.status;
 }
 const value=await responseJson(response,1024*1024,signal);
 if(['job_token','poll_url','cancel_url','served_by','provider_family','marketplace_attempts'].some(k=>Object.hasOwn(value,k)))fail(502,'video_invalid_response');
 if(!retrieve&&(typeof value.queue_id!=='string'||!value.queue_id))fail(502,'video_invalid_response');send(res,response.status,value);return response.status;
}

// The parent owns loopback and local authorization, and invokes this only after both.
export function createExtendedHandler({settings,apiKey,getQuotes,fetchImpl=fetch,onEvent=()=>{},videoBridge}){
 const base=new URL(settings.surplusBaseUrl);if(base.origin!==ORIGIN||!/^\/v1\/?$/.test(base.pathname)||base.username||base.password||base.search||base.hash)throw new Error('Untrusted Surplus origin');
 if(typeof apiKey!=='string'||!apiKey||/[\r\n]/.test(apiKey))throw new Error('Invalid gateway credential');
 for(const key of ['maxTokens','maxInputBytes','maxConcurrent','quoteMaxAgeMs'])if(!Number.isSafeInteger(settings[key])||settings[key]<1)throw new Error(`Invalid ${key}`);
 const mediaLimit=settings.mediaMaxInputBytes??12*1024*1024;
 if(!Number.isSafeInteger(mediaLimit)||mediaLimit<1||mediaLimit>IMAGE_LIMIT)throw new Error('Invalid mediaMaxInputBytes');
 const timeout=settings.requestTimeoutMs??300000;if(!Number.isSafeInteger(timeout)||timeout<1)throw new Error('Invalid requestTimeoutMs');
 let active=0;
 return async(req,res)=>{
  if(!ROUTES.has(req.url))return false;
  let reserved=false,dispatched=false,status=500,model,usage,upstreamRequestId;const requestId=randomUUID();
  const abort=new AbortController(),signal=abort.signal;
  const disconnected=()=>{if(!res.writableFinished)abort.abort(new GatewayError(499,'client_disconnected'));};
  const onAborted=()=>abort.abort(new GatewayError(499,'client_disconnected'));
  res.on('close',disconnected);req.on('aborted',onAborted);
  const timer=setTimeout(()=>abort.abort(new GatewayError(504,'request_timeout')),timeout);timer.unref();
  try{
   if(req.method!=='POST')fail(405,'method_not_allowed');
   if(active>=settings.maxConcurrent)fail(429,'concurrency_limit');active++;reserved=true;
   const isEdit=req.url==='/v1/images/edits',isRetrieve=req.url==='/api/v1/video/retrieve';
   const kind=req.url.startsWith('/v1/images/')?'image':req.url.startsWith('/api/v1/video/')?'video':req.url==='/v1/systemone'?'decision':req.url==='/v1/responses'?'responses':'messages';
   const limit=kind==='image'||kind==='video'?mediaLimit:settings.maxInputBytes;
   if(Number(req.headers['content-length'])>limit)fail(413,'body_too_large');
   const multipart=isEdit&&/^multipart\/form-data(?:\s*;|$)/i.test(req.headers['content-type']??'');
   const {body,files=[]}=await wait(multipart?readMultipart(req,limit):readJson(req,limit).then(body=>({body})),signal);model=isRetrieve?req.headers['x-antseed-service']:body.model;
   if(typeof model!=='string'||(!settings.models.includes(model)&&!serviceConfig(settings,model)))fail(400,'model_not_allowed');
   if(isRetrieve){
    if(!videoBridge||serviceConfig(settings,model)?.kind!=='video')fail(503,'video_unavailable');
    if(typeof body.queue_id!=='string'||!/^[A-Za-z0-9_-]{1,256}$/.test(body.queue_id)||Object.keys(body).some(k=>!['queue_id','model','service'].includes(k))||['model','service'].some(k=>body[k]!==undefined&&body[k]!==model))fail(400,'invalid_queue_id');
    // Retrieval is bound by the durable bridge record, not a newly priced job.
    const response=await wait(videoBridge.retrieve(body.queue_id,model),signal);status=await relayVideo(response,res,signal,true);return true;
   }
   const quoteKind=kind==='responses'||kind==='messages'?'text':kind;
   let quote=quoteFor(settings,await wait(getQuotes(),signal),model,quoteKind);
   const build=()=>kind==='image'?imagePayload(body,quote,isEdit,files):kind==='video'?videoPayload(body,quote):kind==='decision'?decisionPayload(body,settings,quote):textPayload(body,settings,quote,kind);
   build();
   quote=quoteFor(settings,await wait(getQuotes(),signal),model,quoteKind);const payload=build();signal.throwIfAborted();
   if(kind==='video'){
    if(!videoBridge)fail(503,'video_unavailable');const stableId=req.headers['x-surplus-request-id'];
    if(typeof stableId!=='string'||!/^[A-Za-z0-9_.:-]{1,256}$/.test(stableId))fail(400,'invalid_request_id');
    dispatched=true;const response=await wait(videoBridge.queue(payload,quote,{requestId:stableId}),signal);status=await relayVideo(response,res,signal,false);return true;
   }
   const headers={authorization:`Bearer ${apiKey}`};if(!(payload instanceof FormData))headers['content-type']='application/json';
   if(quote.minDiscountPct!==undefined){if(!Number.isInteger(quote.minDiscountPct)||quote.minDiscountPct<0||quote.minDiscountPct>100)fail(503,'invalid_discount_bound');headers['x-min-discount']=String(quote.minDiscountPct);}
   const rawPath=kind==='decision'?'/v1/decisions':kind==='messages'?'/anthropic/v1/messages':req.url;
   const path=quote.minDiscountPct===undefined?rawPath:`/min${quote.minDiscountPct}${rawPath}`;
   dispatched=true;const pending=Promise.resolve(fetchImpl(ORIGIN+path,{method:'POST',headers,redirect:'error',body:payload instanceof FormData?payload:JSON.stringify(payload),signal}));
   void pending.then(response=>{if(signal.aborted)void response.body?.cancel().catch(()=>{});},()=>{});
   const response=await wait(pending,signal);const id=response.headers.get('x-request-id');if(id&&/^[A-Za-z0-9_-]{1,128}$/.test(id))upstreamRequestId=id;
   if(!response.ok){void response.body?.cancel().catch(()=>{});fail(502,'upstream_request_failed');}
   if(payload.stream){await streamResponse(response,res,signal,kind,value=>{if(value)usage={...usage,...value};});status=200;}
   else{const raw=await responseJson(response,kind==='image'?IMAGE_LIMIT:8*1024*1024,signal);const value=kind==='image'?imageResponse(raw):kind==='decision'?decisionResponse(raw,body):textResponse(raw,kind);usage=usageSummary(value.usage);status=200;send(res,status,value);}
  }catch(error){
   const failure=signal.aborted?signal.reason:error;status=failure instanceof GatewayError?failure.status:502;
   if(!res.destroyed){if(res.headersSent){if(res.getHeader('content-type')==='video/mp4')res.destroy();else res.end('event: error\ndata: '+JSON.stringify({type:'error',error:{code:'upstream_stream_failed',message:'Upstream stream failed'}})+'\n\n');}else send(res,status,{error:{code:failure instanceof GatewayError?failure.code:'gateway_request_failed',request_id:requestId}});}
  }finally{
   clearTimeout(timer);res.removeListener('close',disconnected);req.removeListener('aborted',onAborted);if(reserved)active--;
   if(dispatched)try{onEvent({requestId,model,status,...(usage?{usage}:{}),...(upstreamRequestId?{upstreamRequestId}:{})});}catch{/* telemetry cannot change outcome */}
  }
  return true;
 };
}

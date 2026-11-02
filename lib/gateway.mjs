import { createServer } from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rmdir, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { once } from 'node:events';

const PARAMS = ['model','messages','stream','temperature','top_p','max_tokens','max_completion_tokens','stop','seed','tools','tool_choice','parallel_tool_calls','response_format','reasoning_effort','frequency_penalty','presence_penalty'];
const PRICE_KEYS = ['inputUsdPerMillion','outputUsdPerMillion','cachedInputUsdPerMillion'];
const FRAME_LIMIT = 1024 * 1024;
const ERROR_BODY_LIMIT = 16 * 1024;
const ERROR_READ_LIMIT = 256;
const ERROR_READ_TIMEOUT_MS = 50;
const ERROR_CODES = new Set(['INVALID_ARGUMENT','RESOURCE_EXHAUSTED','PERMISSION_DENIED','invalid_request_error','server_error']);
class GatewayError extends Error { constructor(status, code) { super(code); this.status=status; this.code=code; } }
function fail(status,code) { throw new GatewayError(status,code); }
function authorize(value, token) {
  const actual=Buffer.from(value ?? '');const expected=Buffer.from(`Bearer ${token}`);
  return actual.length===expected.length && timingSafeEqual(actual,expected);
}
function json(res,status,value) {
  res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));
}
function usageSummary(value) {
  if(!value || typeof value!=='object') return undefined;
  const result={};
  for(const key of ['prompt_tokens','completion_tokens','total_tokens','buyer_cost_micro']) if(Number.isSafeInteger(value[key]) && value[key]>=0) result[key]=value[key];
  return Object.keys(result).length ? result : undefined;
}
function hasError(value,depth=0) {
  if(!value || typeof value!=='object') return false;
  if(depth>32) return true;
  return Object.entries(value).some(([key,entry])=>(key==='error' && entry!=null && entry!==false) || (typeof entry==='object' && hasError(entry,depth+1)));
}
function quoteFor(settings,quotes,model) {
  const age=Date.now()-Date.parse(quotes?.generatedAt);
  if(!Number.isFinite(age) || age<0 || age>settings.quoteMaxAgeMs) fail(503,'quote_unavailable');
  const quote=Object.hasOwn(quotes?.services??{},model) ? quotes.services[model] : undefined;
  if(!quote || quote.upstreamModel!==model || typeof quote.provider!=='string' || !/^[a-z0-9][a-z0-9.-]{0,127}$/.test(quote.provider)) fail(503,'quote_unavailable');
  if(quote.policyExpiresAt!==undefined && (!Number.isFinite(Date.parse(quote.policyExpiresAt)) || Date.parse(quote.policyExpiresAt)<=Date.now()))fail(503,'pricing_consent_expired');
  for(const key of PRICE_KEYS) {
    if(typeof quote.pricing?.[key]!=='number' || !Number.isFinite(quote.pricing[key]) || quote.pricing[key]<0 || typeof quote.upstreamPricing?.[key]!=='number' || !Number.isFinite(quote.upstreamPricing[key]) || quote.upstreamPricing[key]<0) fail(503,'quote_unavailable');
    if(!settings.lossTest && quote.pricing[key]<quote.upstreamPricing[key]) fail(503,'unprofitable_quote');
  }
  if(!(quote.upstreamPricing.inputUsdPerMillion>0) || !(quote.upstreamPricing.outputUsdPerMillion>0)) fail(503,'quote_unavailable');
  const bound=quote.maxPricePer1m;
  if(typeof bound!=='number' || !Number.isFinite(bound) || bound<=0 || bound<Math.max(...PRICE_KEYS.map(key=>quote.upstreamPricing[key]))) fail(503,'invalid_cost_bound');
  return quote;
}
function quoteForDiscovery(settings,quotes,model) {
 const quote=quotes?.services?.[model];
 if(!quote?.kind)return quoteFor(settings,quotes,model);
 const entry=settings.mediaConfig?.services?.find(service=>service.model===model);
 const host={venice:'api.venice.ai',typesafe:'api.typesafe.ai'}[entry?.provider];
 const age=Date.now()-Date.parse(quotes.generatedAt),expires=Date.parse(quote.policyExpiresAt);
 if(!entry || entry.kind!==quote.kind || !host || quote.provider!==host || quote.upstreamModel!==model || !Number.isFinite(age) || age<0 || age>settings.quoteMaxAgeMs || !Number.isFinite(expires) || expires<=Date.now())fail(503,'quote_unavailable');
 if(['image','video'].includes(quote.kind)) {
  if(!Number.isFinite(quote.unitPriceUsd)||quote.unitPriceUsd<=0||!Number.isFinite(quote.estimatedUpstreamUsd)||quote.estimatedUpstreamUsd<=0||quote.unitPriceUsd<quote.estimatedUpstreamUsd)fail(503,'quote_unavailable');
 } else if(quote.kind==='decision') {
  for(const key of PRICE_KEYS)if(!Number.isFinite(quote.pricing?.[key])||quote.pricing[key]<0||!Number.isFinite(quote.upstreamPricing?.[key])||quote.upstreamPricing[key]<0||quote.pricing[key]<quote.upstreamPricing[key])fail(503,'quote_unavailable');
  if(!(quote.upstreamPricing.inputUsdPerMillion>0))fail(503,'quote_unavailable');
 } else fail(503,'quote_unavailable');
 return quote;
}
function lossExpiry(settings) {
  const until=typeof settings.lossUntil==='number' ? settings.lossUntil : Date.parse(settings.lossUntil);
  if(!Number.isFinite(until) || until<=Date.now() || !Number.isSafeInteger(settings.lossMaxRequests) || settings.lossMaxRequests<1 || settings.lossMaxRequests>100) fail(503,'loss_budget_unavailable');
  return until;
}
// Reserve before dispatch; failures/aborts consume a request because spend may be uncertain.
// An abandoned lock after a crash intentionally fails closed rather than resetting budget.
async function reserveLoss(settings) {
  const until=lossExpiry(settings), dir=resolve(settings.stateDir ?? '.state');
  await mkdir(dir,{recursive:true,mode:0o700});
  const lock=join(dir,'loss-budget.lock'), path=join(dir,'loss-budget.json');
  await mkdir(lock,{mode:0o700});
  let temporary;
  try {
    let state;
    try {
      const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
      try { state=JSON.parse(await file.readFile('utf8')); } finally { await file.close(); }
    } catch(error) { if(error.code!=='ENOENT') throw error;state={version:1,until,maxRequests:settings.lossMaxRequests,used:0}; }
    if(state.version!==1 || state.until!==until || state.maxRequests!==settings.lossMaxRequests || !Number.isSafeInteger(state.used) || state.used<0 || state.used>=state.maxRequests) fail(503,'loss_budget_exhausted');
    lossExpiry(settings);state.used++;
    temporary=join(dir,`.loss-budget-${randomUUID()}.tmp`);
    const file=await open(temporary,'wx',0o600);
    try { await file.writeFile(JSON.stringify(state)+'\n');await file.sync(); } finally { await file.close(); }
    await rename(temporary,path);temporary=undefined;
    const directory=await open(dir,'r');try { await directory.sync(); } finally { await directory.close(); }
    const saved=JSON.parse(await readFile(path,'utf8'));
    if(saved.used!==state.used || saved.until!==until || saved.maxRequests!==state.maxRequests) fail(503,'loss_budget_unavailable');
  } finally {
    if(temporary) await unlink(temporary).catch(()=>{});
    await rmdir(lock);
  }
}
async function readBody(req,limit) {
  let size=0;const chunks=[];
  for await(const chunk of req) {size+=chunk.length;if(size>limit) fail(413,'body_too_large');chunks.push(chunk);}
  let value;try {value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail(400,'invalid_json');}
  if(!value || typeof value!=='object' || Array.isArray(value)) fail(400,'invalid_request');
  return value;
}
function buildPayload(body,settings,quote) {
  if(!Array.isArray(body.messages)) fail(400,'invalid_messages');
  if(body.stream!==undefined && typeof body.stream!=='boolean') fail(400,'invalid_stream');
  // Fork: no buyer token caps. The caller decides max_tokens; anything that is not a
  // positive safe integer is still rejected, and transport/usage guards stay in place.
  for(const key of ['max_tokens','max_completion_tokens']) if(body[key]!==undefined && (!Number.isSafeInteger(body[key]) || body[key]<1)) fail(400,'token_limit');
  if(body.tools!==undefined && (!Array.isArray(body.tools) || body.tools.some(tool=>!tool || tool.type!=='function' || !tool.function || typeof tool.function.name!=='string'))) fail(400,'unsupported_tools');
  if(body.tool_choice && typeof body.tool_choice==='object' && body.tool_choice.type!=='function') fail(400,'unsupported_tools');
  const payload={};for(const key of PARAMS) if(Object.hasOwn(body,key)) payload[key]=body[key];
  // Fork: when the buyer sets no limit, forward the request uncapped instead of injecting the old default.
  if(payload.max_tokens!==undefined || payload.max_completion_tokens!==undefined) void 0; // explicit buyer limit passes through above; otherwise forward uncapped
  payload.model=quote.upstreamModel;payload.provider=quote.provider;payload.max_price_per_1m=quote.maxPricePer1m;
  payload.providers_blocked=['antseed'];payload.si_route={objective:'price_without_cache',cache:false};
  if(payload.stream)payload.stream_options={include_usage:true};
  return payload;
}
async function limitedResponse(response,limit) {
  if(!response.body) fail(502,'upstream_invalid_response');
  const reader=response.body.getReader();let size=0;const chunks=[];
  try {for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit)fail(502,'upstream_invalid_response');chunks.push(Buffer.from(value));}} finally {await reader.cancel().catch(()=>{});}
  let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail(502,'upstream_invalid_response');}
  if(hasError(value) || !Array.isArray(value?.choices) || !value.choices.some(choice=>choice?.message && typeof choice.message==='object')) fail(502,'upstream_invalid_response');
  return value;
}
// Diagnostic bodies are untrusted: retain only a fixed vocabulary, never messages.
async function upstreamErrorCode(response,signal,secrets,requestDeadline) {
  const deadline=Math.min(performance.now()+ERROR_READ_TIMEOUT_MS,requestDeadline);
  const expired=()=>signal.aborted || performance.now()>=deadline;
  let reader,timer,stop;
  const stopped=new Promise(resolve=>{stop=()=>resolve(undefined);});
  try {
    if(!response.body || expired())return;
    reader=response.body.getReader();
    signal.addEventListener('abort',stop,{once:true});
    timer=setTimeout(stop,ERROR_READ_TIMEOUT_MS);
    let size=0;const chunks=[];
    for(let reads=0;;reads++) {
      // Ready reads can starve timers; check elapsed time whenever JS regains control.
      if(reads>=ERROR_READ_LIMIT || expired())return;
      const result=await Promise.race([reader.read(),stopped]);
      if(!result || expired())return;
      if(result.done)break;
      size+=result.value.byteLength;if(size>ERROR_BODY_LIMIT)return;
      chunks.push(Buffer.from(result.value));
    }
    const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
    if(expired())return;
    const value=JSON.parse(text);
    if(expired())return;
    for(const code of [value?.error?.code,value?.error?.status]) {
      if(typeof code==='string' && ERROR_CODES.has(code) && !secrets.some(secret=>code.includes(secret)))return code;
    }
  } catch {/* Diagnostics cannot change inference outcome. */}
  finally {
    clearTimeout(timer);signal.removeEventListener('abort',stop);
    // A broken/never-settling cancel must not hold a completion event or slot open.
    if(reader){void reader.cancel().catch(()=>{});reader.releaseLock();}
    else if(response.body)void response.body.cancel().catch(()=>{});
  }
}
async function streamResponse(response,res,signal,onUsage) {
  if(!response.body || !response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) fail(502,'upstream_invalid_response');
  const reader=response.body.getReader(), decoder=new TextDecoder();let pending='',doneSeen=false;
  const cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
  const write=async frame=>{
    if(signal.aborted) fail(499,'client_disconnected');
    if(!res.headersSent) res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache, no-transform','x-accel-buffering':'no'});
    if(!res.write(frame)) await once(res,'drain',{signal});
  };
  const process=async frame=>{
    const data=frame.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).replace(/^ /,'')).join('\n');
    if(data){
      if(doneSeen) fail(502,'upstream_invalid_stream');
      if(data==='[DONE]') doneSeen=true;
      else {let value;try{value=JSON.parse(data);}catch{fail(502,'upstream_invalid_stream');}if(hasError(value))fail(502,'upstream_stream_error');onUsage(usageSummary(value.usage));}
    }
    await write(frame);
  };
  try {
    for(;;) {
      const {value,done}=await reader.read();
      pending+=done ? decoder.decode() : decoder.decode(value,{stream:true});
      for(;;){const match=/\r?\n\r?\n/.exec(pending);if(!match)break;const end=match.index+match[0].length;if(end>FRAME_LIMIT)fail(502,'upstream_invalid_stream');const frame=pending.slice(0,end);pending=pending.slice(end);await process(frame);}
      if(pending.length>FRAME_LIMIT)fail(502,'upstream_invalid_stream');
      if(done)break;
    }
    if(signal.aborted) fail(499,'client_disconnected');
    if(pending.trim() || !doneSeen) fail(502,'upstream_incomplete_stream');
    res.end();
  } finally {signal.removeEventListener('abort',cancel);await reader.cancel().catch(()=>{});}
}

export function createGateway({settings,apiKey,localToken,getQuotes,fetchImpl=fetch,onEvent=()=>{},extendedHandler}) {
  const upstream=new URL(settings.surplusBaseUrl);
  if(upstream.origin!=='https://api.surplusintelligence.ai' || !/^\/v1\/?$/.test(upstream.pathname) || upstream.search || upstream.hash || upstream.username || upstream.password) throw new Error('Untrusted Surplus origin');
  if(typeof apiKey!=='string' || !apiKey || /[\r\n]/.test(apiKey) || typeof localToken!=='string' || !localToken || /[\r\n]/.test(localToken)) throw new Error('Missing or invalid gateway credential');
  for(const key of ['maxTokens','maxInputBytes','maxConcurrent','quoteMaxAgeMs']) if(!Number.isSafeInteger(settings[key]) || settings[key]<1) throw new Error(`Invalid ${key}`);
  let active=0,extendedPromise;
  const extendedPaths=new Set(['/v1/images/generations','/v1/images/edits','/v1/systemone','/v1/responses','/v1/messages','/api/v1/video/queue','/api/v1/video/retrieve']);
  const getExtended=()=>extendedHandler ? Promise.resolve(extendedHandler) : (extendedPromise??=Promise.all([import('./extended-gateway.mjs'),import('./video-bridge.mjs')]).then(([{createExtendedHandler},{createVideoBridge}])=>createExtendedHandler({settings,apiKey,getQuotes,fetchImpl,onEvent,videoBridge:settings.mediaConfig?.services?.some(s=>s.kind==='video')?createVideoBridge({settings,apiKey,fetchImpl,onEvent}):undefined})));
  const server=createServer(async(req,res)=>{
    const requestId=randomUUID();res.setHeader('x-request-id',requestId);
    let model,usage,upstreamRequestId,upstreamStatus,providerErrorCode,status=500,reserved=false,paid=false;
    const abort=new AbortController();const disconnected=()=>{if(!res.writableFinished)abort.abort();};
    res.on('close',disconnected);req.on('aborted',()=>abort.abort());
    const requestTimeoutMs=settings.requestTimeoutMs??300000,requestDeadline=performance.now()+requestTimeoutMs;
    const timer=setTimeout(()=>abort.abort(),requestTimeoutMs);timer.unref();
    try {
      if(req.socket.remoteAddress!=='127.0.0.1' && req.socket.remoteAddress!=='::ffff:127.0.0.1') fail(403,'loopback_only');
      if(req.method==='GET' && req.url==='/health'){status=200;json(res,200,{ok:true});return;}
      if(req.method==='POST' && extendedPaths.has(req.url)) {
        if(!authorize(req.headers.authorization,localToken))fail(401,'unauthorized');
        if(active>=settings.maxConcurrent)fail(429,'concurrency_limit');
        active++;reserved=true;
        if(await (await getExtended())(req,res))return;
        fail(404,'not_found');
      }
      if(!((req.method==='POST' && req.url==='/v1/chat/completions') || (req.method==='GET' && req.url==='/v1/models'))) fail(404,'not_found');
      if(!authorize(req.headers.authorization,localToken)) fail(401,'unauthorized');
      if(req.method==='GET') {
        const quotes=await getQuotes();const data=[];
        const models=new Set([...settings.models,...(settings.mediaConfig?.services??[]).map(service=>service.model)]);
        for(const id of models) {try{quoteForDiscovery(settings,quotes,id);data.push({id,object:'model',owned_by:'local-gateway'});}catch{/* Only currently serviceable models. */}}
        status=200;json(res,200,{object:'list',data});return;
      }
      if(active>=settings.maxConcurrent) fail(429,'concurrency_limit');
      active++;reserved=true;
      if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??'')) fail(415,'json_required');
      if(Number(req.headers['content-length'])>settings.maxInputBytes) fail(413,'body_too_large');
      const body=await readBody(req,settings.maxInputBytes);model=body.model;
      if(typeof model!=='string' || !settings.models.includes(model)) {model=undefined;fail(400,'model_not_allowed');}
      let quote=quoteFor(settings,await getQuotes(),model);let payload=buildPayload(body,settings,quote);
      if(settings.lossTest) {try{await reserveLoss(settings);}catch(error){if(error instanceof GatewayError)throw error;fail(503,'loss_budget_unavailable');}}
      // Recheck freshness and consent after disk/network waits, immediately before spend.
      quote=quoteFor(settings,await getQuotes(),model);payload=buildPayload(body,settings,quote);
      if(settings.lossTest)lossExpiry(settings);
      if(abort.signal.aborted)fail(499,'client_disconnected');
      paid=true;
      const headers={authorization:`Bearer ${apiKey}`,'content-type':'application/json'};
      if(quote.minDiscountPct!==undefined){if(!Number.isInteger(quote.minDiscountPct)||quote.minDiscountPct<0||quote.minDiscountPct>100)fail(503,'invalid_discount_bound');headers['x-min-discount']=String(quote.minDiscountPct);}
      const path=quote.minDiscountPct===undefined?'/v1/chat/completions':`/min${quote.minDiscountPct}/v1/chat/completions`;
      const response=await fetchImpl(`${upstream.origin}${path}`,{method:'POST',redirect:'error',headers,body:JSON.stringify(payload),signal:abort.signal});
      const upstreamId=response.headers.get('x-request-id');if(upstreamId && /^[a-zA-Z0-9_-]{1,128}$/.test(upstreamId) && ![apiKey,localToken].some(secret=>upstreamId.includes(secret)))upstreamRequestId=upstreamId;
      if(!response.ok){
        if(Number.isInteger(response.status) && response.status>=100 && response.status<=599)upstreamStatus=response.status;
        // Complete the same generic public failure before best-effort diagnostics.
        status=502;json(res,status,{error:{code:'upstream_request_failed',message:'upstream_request_failed',request_id:requestId}});
        providerErrorCode=await upstreamErrorCode(response,abort.signal,[apiKey,localToken],requestDeadline);
        return;
      }
      if(payload.stream) {await streamResponse(response,res,abort.signal,value=>{if(value)usage=value;});status=200;}
      else {const value=await limitedResponse(response,8*1024*1024);usage=usageSummary(value.usage);status=200;json(res,200,value);}
    } catch(error) {
      status=abort.signal.aborted ? 499 : error instanceof GatewayError ? error.status : 502;
      const code=error instanceof GatewayError ? error.code : 'gateway_request_failed';
      if(!res.destroyed) {
        if(res.headersSent){res.end(`data: ${JSON.stringify({error:{code:'upstream_stream_failed',message:'Upstream stream failed'}})}\n\n`);}
        else json(res,status,{error:{code,message:code,request_id:requestId}});
      }
    } finally {
      clearTimeout(timer);res.removeListener('close',disconnected);if(reserved)active--;
      if(paid)try{onEvent({requestId,model,status,...(usage?{usage}:{}),...(upstreamRequestId?{upstreamRequestId}:{}),...(upstreamStatus===undefined?{}:{upstreamStatus}),...(providerErrorCode?{upstreamErrorCode:providerErrorCode}:{})});}catch{/* Observability cannot change inference outcome. */}
    }
  });
  server.requestTimeout=30000;server.headersTimeout=10000;
  // Prevent accidental wildcard exposure even when a caller omits host.
  const listen=server.listen.bind(server);
  server.listen=(...args)=>{
    if(typeof args[0]==='object' && args[0]!==null) {if(args[0].path || (args[0].host && args[0].host!=='127.0.0.1')) throw new Error('Gateway must bind 127.0.0.1');args[0]={...args[0],host:'127.0.0.1'};}
    else {if(typeof args[0]!=='number')throw new Error('Gateway requires a TCP port');if(typeof args[1]==='string'){if(args[1]!=='127.0.0.1')throw new Error('Gateway must bind 127.0.0.1');}else args.splice(1,0,'127.0.0.1');}
    return listen(...args);
  };
  return server;
}

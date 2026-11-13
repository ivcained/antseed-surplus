// Immutable contract audit: surplus-intelligence 2207d607e747f487a4d83e60c7f24ad677a55a7f.
// /api/markets/:model omits per-offer cache rates and the account fee multiplier.
// max_price_per_1m is ignored when minimum-discount routing is enabled, and
// /minN is a relative request-estimate gate, NOT an absolute per-class ceiling.
// Never turn that public information into a fictional guaranteed-profit quote.
import {fetchMediaQuotes,validateMediaPolicy,ConsentExpiredError} from './media-pricing.mjs';
export class PricingConsentExpiredError extends ConsentExpiredError {
 constructor(){super('Expired reviewed pricing policy');this.name='PricingConsentExpiredError';}
}
const ORIGIN='https://api.surplusintelligence.ai';
// Closed native-provider host map, deliberately excluding aggregators/AntSeed.
const DIRECT_HOSTS=new Map([
 ['openai',new Set(['api.openai.com'])],
 ['anthropic',new Set(['api.anthropic.com'])],
 ['google',new Set(['generativelanguage.googleapis.com'])],
 ['mistral',new Set(['api.mistral.ai'])],
 ['deepseek',new Set(['api.deepseek.com'])],
 ['groq',new Set(['api.groq.com'])],
 ['cerebras',new Set(['api.cerebras.ai'])],
]);
// Reviewed estimate endpoints are narrower than the discovery-only native map.
// Defaults are explicit: adding Vertex must never switch Google's default pin.
const REVIEWED_ENDPOINTS=new Map([
 ['venice',{host:'api.venice.ai',hosts:new Set(['api.venice.ai'])}],
 ['groq',{host:'api.groq.com',hosts:new Set(['api.groq.com'])}],
 ['google',{host:'generativelanguage.googleapis.com',hosts:new Set(['generativelanguage.googleapis.com','aiplatform.googleapis.com'])}],
 ['openai',{host:'api.openai.com',hosts:new Set(['api.openai.com'])}],
]);
// Live-book estimates are allowed for reviewed native providers only.
// cache-at-input stays mandatory: cache reads bill at the full input
// envelope, so providers without cache rate transparency can never
// produce a cheaper sell class than the input class.
const LIVE_BOOK_PROVIDERS=new Set(['groq','venice','google','openai']);
function validate(settings) {
 let url;try{url=new URL(settings.surplusBaseUrl);}catch{throw Error('Untrusted Surplus origin');}
 if(url.origin!==ORIGIN || !/^\/v1\/?$/.test(url.pathname) || url.username || url.password || url.search || url.hash) throw Error('Untrusted Surplus origin');
 if(!Array.isArray(settings.models) || !settings.models.length || new Set(settings.models).size!==settings.models.length || settings.models.some(model=>typeof model!=='string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]*$/.test(model) || model.split('/').some(part=>part==='.' || part==='..')))throw Error('Invalid models');
 for(const name of ['marginBps','safetyBps'])if(!Number.isSafeInteger(settings[name]) || settings[name]<0 || settings[name]>=10000)throw Error(`Invalid ${name}`);
 if(settings.lossTest ? settings.lossPriceFactor!==0.1 : settings.lossPriceFactor!==undefined && settings.lossPriceFactor!==1)throw Error('Invalid loss pricing');
}
function nativeRoute(offer) {
 const hosts=DIRECT_HOSTS.get(offer.provider_id);if(!hosts)return false;
 try{const url=new URL(offer.seller_base_url);return url.protocol==='https:' && !url.username && !url.password && hosts.has(url.hostname) && !url.port;}catch{return false;}
}
function pinnedHost(value,host){try{const url=new URL(value);return url.protocol==='https:'&&url.hostname===host&&!url.port&&!url.username&&!url.password;}catch{return false;}}
function record(value){return value!==null&&typeof value==='object'&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);}
function validatePolicy(policy,models){
 if(policy.modelRoutes!==undefined){
  if(!record(policy.modelRoutes))throw Error('Invalid model route policy');
  for(const model of Reflect.ownKeys(policy.modelRoutes)){
   const route=policy.modelRoutes[model];
   if(!models.includes(model)||!record(route)||Reflect.ownKeys(route).length!==2||!Object.hasOwn(route,'provider')||!Object.hasOwn(route,'host')||!REVIEWED_ENDPOINTS.get(route.provider)?.hosts.has(route.host))throw Error('Invalid model route policy');
   if(policy.basis==='live-book'&&!LIVE_BOOK_PROVIDERS.has(route.provider))throw Error('Live-book estimates require a reviewed native provider route (groq/venice/google/openai) with cache-at-input consent');
  }
 }
 if(policy.referenceProvider!==undefined && (policy.referenceFallback!==true || !REVIEWED_ENDPOINTS.has(policy.referenceProvider)))throw Error('Invalid reference provider policy');
 if(policy.basis!==undefined && !['reference-envelope','live-book'].includes(policy.basis))throw Error('Invalid pricing policy basis');
 if(policy.modelBasis!==undefined){
  if(!record(policy.modelBasis))throw Error('Invalid model basis policy');
  for(const model of Reflect.ownKeys(policy.modelBasis)){
   if(!models.includes(model)||!['live-book','reference-envelope'].includes(policy.modelBasis[model]))throw Error('Invalid model basis policy');
   if(policy.modelBasis[model]==='live-book'){
    const route=Object.hasOwn(policy.modelRoutes??{},model)?policy.modelRoutes[model]:{provider:policy.provider};
    if(!LIVE_BOOK_PROVIDERS.has(route.provider) || policy.cacheAtInput!==true)throw Error('Live-book estimates require a reviewed native provider route (groq/venice/google/openai) with cache-at-input consent');
   }
  }
 }
 if(policy.basis==='live-book' && (!LIVE_BOOK_PROVIDERS.has(policy.provider) || policy.cacheAtInput!==true))throw Error('Live-book estimates require a reviewed native default provider (groq/venice/google/openai) with cache-at-input consent');
 const now=Date.now(),reviewed=Date.parse(policy.reviewedAt),expires=Date.parse(policy.expiresAt);
 if(policy.version!==1 || policy.allowEstimates!==true || !REVIEWED_ENDPOINTS.has(policy.provider) || !/^[a-f0-9]{40}$/.test(policy.sourceRevision??'') || !Number.isFinite(reviewed) || reviewed>now+60000 || !Number.isFinite(expires) || expires<=reviewed || expires-reviewed>86400_000 || !Number.isSafeInteger(policy.feeCushionBps) || policy.feeCushionBps<0 || policy.feeCushionBps>100000 || typeof policy.offerMultiplierCeiling!=='number' || !Number.isFinite(policy.offerMultiplierCeiling) || policy.offerMultiplierCeiling<2 || policy.offerMultiplierCeiling>10)throw Error('Invalid/expired reviewed pricing policy');
 if(expires<=now)throw new PricingConsentExpiredError();
}
async function publicBook(model,fetchImpl) {
 const response=await fetchImpl(`${ORIGIN}/api/markets/${encodeURIComponent(model)}`,{method:'GET',redirect:'error',headers:{accept:'application/json'},signal:AbortSignal.timeout(15000)});
 if(!response.ok){await response.body?.cancel().catch(()=>{});throw Error(`Public orderbook HTTP ${response.status}`);}
 // Bound parse allocation and do not print untrusted response bodies.
 const text=await response.text();if(text.length>8*1024*1024)throw Error('Public orderbook exceeds limit');
 let book;try{book=JSON.parse(text);}catch{throw Error('Invalid public orderbook JSON');}
 if(book?.model!==model || !Array.isArray(book.offers))throw Error('Public orderbook model/schema mismatch');
 return book;
}

/**
 * By default return only verifiably bounded executable services; missing public
 * evidence leaves services empty. An explicit reviewed expiring pricingPolicy
 * may opt into operational estimates, always labeled guaranteedBound:false.
 * Such estimates are not a guaranteed-profit configuration.
 *
 * Public SI APIs cannot prove an absolute upstream bound. Keep an explicit
 * per-model reason unless an operator authorizes the documented reference
 * envelope, never guessing cache is free or composing unrelated price minima.
 * Groq cache-at-input and catalog-reference fallback require policy consent.
 * Estimates require live catalogs/books, native host pinning and fee cushion.
 *
 * apiKey is accepted for interface compatibility but never sent to public books.
 * No inference, receiver allocation, key creation or transaction occurs here.
 */
async function fetchTextQuotes(settings,apiKey,fetchImpl=fetch) {
 validate(settings);
 const policy=settings.pricingPolicy;
 if(policy)validatePolicy(policy,settings.models);
 const services=Object.create(null),unavailable=Object.create(null);
 let catalog;
 if(policy){
  const response=await fetchImpl(`${ORIGIN}/v1/prices`,{method:'GET',redirect:'error',headers:{accept:'application/json'},signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error('Pricing catalog unavailable');
  try{catalog=await response.json();}catch{throw Error('Invalid pricing catalog');}
  const age=Date.now()-Date.parse(catalog.updated_at);
  if(!Array.isArray(catalog.models)||!Number.isFinite(age)||age< -60000||age>86400_000)throw Error('Stale/invalid pricing catalog');
 }
 for(const model of settings.models){
  try {
   const route=policy&&(Object.hasOwn(policy.modelRoutes??{},model)?policy.modelRoutes[model]:{provider:policy.provider,host:REVIEWED_ENDPOINTS.get(policy.provider).host});
   const book=await publicBook(model,fetchImpl);
   const supply=book.offers.filter(o=>o?.healthy===true && o.available===true && (o.cap_remaining===null || o.cap_remaining===undefined || typeof o.cap_remaining==='number' && Number.isFinite(o.cap_remaining) && o.cap_remaining>0));
   if(!supply.length){unavailable[model]='No healthy available non-exhausted supply';continue;}
   const direct=supply.filter(o=>policy ? o.provider_id===route.provider && pinnedHost(o.seller_base_url,route.host) : nativeRoute(o));
   if(!direct.length){unavailable[model]='No verified non-returning direct-provider route; loop prevention fails closed';continue;}
   if(policy){
    const rows=catalog.models.filter(row=>row.model===model);
    if(rows.length!==1)throw Error('Model missing/ambiguous in catalog');
    let cards=rows[0].providers.filter(p=>p.provider===route.provider).map(p=>p.pricing);
    if(!cards.length&&policy.referenceFallback===true)cards=rows[0].providers.filter(p=>policy.referenceProvider===undefined || p.provider===policy.referenceProvider).map(p=>p.pricing);
    if(!cards.length || cards.some(c=>!c || typeof c!=='object'))throw Error('Provider rate card missing/ambiguous');
    // Reference fallback is explicit and uses a component-wise MAXIMUM envelope,
    // never a fabricated selectable composite cheapest offer.
    const card={};for(const c of cards)for(const [key,value] of Object.entries(c)){
     if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw Error('Invalid rate dimension');
     card[key]=Math.max(card[key]??0,value);
    }
    if(Object.keys(card).some(k=>!['input','output','cacheRead','cacheWrite','reasoning'].includes(k)) || !['input','output',...(route.provider==='groq'&&policy.cacheAtInput===true?[]:['cacheRead'])].every(k=>typeof card[k]==='number'&&Number.isFinite(card[k])&&card[k]>=0) || !(card.input>0&&card.output>0))throw Error('Incomplete/unsupported rate dimensions');
    for(const k of ['cacheWrite','reasoning'])if(card[k]!==undefined&&!(typeof card[k]==='number'&&Number.isFinite(card[k])&&card[k]>=0))throw Error('Invalid optional rate');
    const m=policy.offerMultiplierCeiling;
    const inputs=direct.map(o=>o.effective_input_per_1m/1e6),outputs=direct.map(o=>o.effective_output_per_1m/1e6);
    if([...inputs,...outputs].some(n=>!Number.isFinite(n)||n<0))throw Error('Invalid book rates');
    // Charge ALL input classes at the largest input/cache class envelope, so
    // cache writes or cache misses never silently receive a cheaper sell class.
    // Missing cacheWrite uses source-proven legacy fallback input, NOT zero.
    const input=Math.max(card.input,card.cacheRead??card.input,card.cacheWrite??card.input)*m;
    const basis=policy.modelBasis?.[model]??policy.basis;
    const rawInput=basis==='live-book'?Math.max(...inputs):Math.max(input,...inputs);
    const rawOutput=basis==='live-book'?Math.max(...outputs):Math.max(card.output*m,(card.reasoning??0)*m,...outputs);
    let minDiscountPct;
    if(basis==='live-book') {
      const discounts=direct.map(o=>o.discount_pct);
      if(discounts.some(n=>!Number.isFinite(n)||n<0||n>100))throw Error('Live-book discount evidence missing');
      minDiscountPct=Math.floor(Math.min(...discounts));
    }
    const cushion=1+policy.feeCushionBps/10000;
    const round=n=>Math.ceil((n-Number.EPSILON)*1e9)/1e9;
    const upstreamPricing={inputUsdPerMillion:round(rawInput*cushion),outputUsdPerMillion:round(rawOutput*cushion),cachedInputUsdPerMillion:round(rawInput*cushion)};
    const antseedFeeBps=settings.antseedFeeBps ?? 400;
    if(!Number.isSafeInteger(antseedFeeBps)||antseedFeeBps<0||antseedFeeBps>=10000)throw Error('Invalid AntSeed protocol fee');
    const factor=(1+settings.safetyBps/10000)/((1-settings.marginBps/10000)*(1-antseedFeeBps/10000));
    const pricing=Object.fromEntries(Object.entries(upstreamPricing).map(([k,v])=>[k,round(v*factor)*(settings.lossTest?0.1:1)]));
    services[model]={upstreamModel:model,provider:route.host,pricing,upstreamPricing,maxPricePer1m:Math.max(...Object.values(upstreamPricing)),...(minDiscountPct!==undefined?{minDiscountPct}:{}),guaranteedBound:false,priceBasis:basis==='live-book'?'live-book-maximum-estimate':'reviewed-reference-envelope-estimate',policyExpiresAt:policy.expiresAt,policySourceRevision:policy.sourceRevision,feeCushionBps:policy.feeCushionBps,antseedFeeBps,warnings:['Public cache/tier/fee omissions remain; this is not an absolute charge ceiling','max_price_per_1m may be ignored; provider pin is not an exact-offer pin']};
    continue;
   }
   unavailable[model]='No executable all-in bound: public book omits per-offer cache rates/account fees and API has no enforceable per-class ceiling';
  }catch(error){
   // Never propagate transport messages: implementations can embed credentials.
   const message=String(error?.message??'');
   unavailable[model]=/^(Public orderbook HTTP \d{3}|Public orderbook exceeds limit|Invalid public orderbook JSON|Public orderbook model\/schema mismatch)$/.test(message) ? message : 'Public orderbook unavailable';
  }
 }
 return {generatedAt:new Date().toISOString(),services:{...services},unavailable:{...unavailable}};
}

export async function fetchQuotes(settings,apiKey,fetchImpl=fetch) {
 if(settings.mediaConfig===undefined)return fetchTextQuotes(settings,apiKey,fetchImpl);
 if(Array.isArray(settings.mediaConfig.services) && settings.mediaConfig.services.some(entry=>settings.models?.includes(entry?.model)))throw Error('Duplicate token/unit model configuration collision');
 // Validate every non-expiry policy condition before classifying consent expiry;
 // an expired media policy must not hide a malformed text/economics policy.
 validate(settings);let expiry;
 for(const check of [()=>{if(settings.pricingPolicy)validatePolicy(settings.pricingPolicy,settings.models);},()=>validateMediaPolicy(settings)]){
  try{check();}catch(error){if(!(error instanceof ConsentExpiredError))throw error;expiry=error;}
 }
 if(expiry)throw expiry;
 const [text,media]=await Promise.all([fetchTextQuotes(settings,apiKey,fetchImpl),fetchMediaQuotes(settings,fetchImpl)]);
 // The media discovery API keeps per-model diagnostics. Promote only its exact
 // expiry outcome to the typed lifecycle signal; source/config errors stay fatal.
 const reasons=Object.values(media.unavailable??{});
 if(reasons.length && reasons.every(reason=>reason==='Reviewed media consent expired during public discovery')){
  // A concurrent text discovery failure is not a clean consent-only expiry.
  if(Object.keys(text.unavailable??{}).length)throw Error('Text pricing discovery unavailable during media consent expiry');
  validateMediaPolicy(settings);
 }
 return mergeContentQuotes(text,media);
}

export function mergeContentQuotes(text,media) {
 const timestamps=[text,media].map(quote=>Date.parse(quote?.generatedAt));
 if(timestamps.some(time=>!Number.isFinite(time)))throw Error('Invalid combined quote timestamp');
 for(const name of Object.keys(media.services??{}))if(Object.hasOwn(text.services??{},name))throw Error(`Duplicate token/unit service collision: ${name}`);
 return {generatedAt:new Date(Math.min(...timestamps)).toISOString(),services:{...text.services,...media.services},unavailable:{...text.unavailable,...media.unavailable}};
}

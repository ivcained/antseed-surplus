// Reviewed against surplus-intelligence 2207d607e747f487a4d83e60c7f24ad677a55a7f.
// Public media tariffs do NOT prove a whole-render charge ceiling or deployed
// routing enforcement. These quotes are always explicitly consented estimates.
const ORIGIN='https://api.surplusintelligence.ai';
const DAY=86400_000;
const REVIEWED=new Map([
 ['venice-sd35',{kind:'image',provider:'venice',inputs:['text'],parameters:{n:1,size:'1024x1024'}}],
 ['muse-image-edit',{kind:'image',provider:'venice',inputs:['text','image'],parameters:{n:1}}],
 ['longcat-distilled-image-to-video',{kind:'video',provider:'venice',inputs:['text','image'],parameters:{duration_seconds:5,resolution:'720p'}}],
 ['jev-1.13',{kind:'decision',provider:'typesafe',inputs:['text'],parameters:{}}],
]);
const object=value=>value!==null && typeof value==='object' && !Array.isArray(value);
const positive=value=>typeof value==='number' && Number.isFinite(value) && value>0;
function exactKeys(value,allowed) {return object(value) && Object.keys(value).every(key=>allowed.includes(key));}
export class ConsentExpiredError extends Error {}
export class MediaConsentExpiredError extends ConsentExpiredError {
 constructor(){super('Expired reviewed media configuration');this.name='MediaConsentExpiredError';}
}
export function validateMediaPolicy(settings) {
 let url;try{url=new URL(settings.surplusBaseUrl);}catch{throw Error('Untrusted Surplus origin');}
 if(url.origin!==ORIGIN || !/^\/v1\/?$/.test(url.pathname) || url.username || url.password || url.search || url.hash)throw Error('Untrusted Surplus origin');
 for(const name of ['marginBps','safetyBps','antseedFeeBps']) {
  const value=name==='antseedFeeBps' ? settings[name]??400 : settings[name];
  if(!Number.isSafeInteger(value) || value<0 || value>=10000)throw Error(`Invalid ${name}`);
 }
 const config=settings.mediaConfig,now=Date.now();
 if(!exactKeys(config,['version','reviewedAt','expiresAt','feeCushionBps','services']))throw Error('Invalid media configuration');
 const reviewed=Date.parse(config.reviewedAt),expires=Date.parse(config.expiresAt);
 if(config.version!==1 || typeof config.reviewedAt!=='string' || typeof config.expiresAt!=='string' || !Number.isFinite(reviewed) || !Number.isFinite(expires) || reviewed>now+60000 || expires<=reviewed || expires-reviewed>DAY || !Number.isSafeInteger(config.feeCushionBps) || config.feeCushionBps<1000 || config.feeCushionBps>100000 || !Array.isArray(config.services))throw Error('Invalid/expired reviewed media configuration');
 const models=new Set();
 for(const entry of config.services) {
  if(!exactKeys(entry,['model','kind','provider','inputs','parameters','estimatedCostUsd','pricingBasis']))throw Error('Invalid media service');
  const spec=REVIEWED.get(entry.model);
  if(!spec || entry.kind!==spec.kind || entry.provider!==spec.provider || models.has(entry.model) || entry.pricingBasis!=='operator-estimate')throw Error('Invalid/unsupported reviewed media service');
  models.add(entry.model);
  if(!Array.isArray(entry.inputs) || entry.inputs.length!==spec.inputs.length || new Set(entry.inputs).size!==entry.inputs.length || entry.inputs.some(input=>!spec.inputs.includes(input)))throw Error('Invalid media inputs');
  if(!exactKeys(entry.parameters,Object.keys(spec.parameters)) || Object.keys(entry.parameters).length!==Object.keys(spec.parameters).length || Object.entries(spec.parameters).some(([key,value])=>entry.parameters[key]!==value))throw Error('Unsupported media parameters');
  if(entry.kind!=='decision' ? !positive(entry.estimatedCostUsd) : entry.estimatedCostUsd!==undefined && !positive(entry.estimatedCostUsd))throw Error('Invalid estimated media cost');
 }
 // Only fully valid reviewed policy may take the nonfatal retrieval-only path.
 if(expires<=now)throw new MediaConsentExpiredError();
}

const HOSTS={venice:'api.venice.ai',typesafe:'api.typesafe.ai'};
const RATE_KEYS=['perImageUsd','per1kCharsUsd','perMinuteUsd','per1MTokensUsd','inputPer1MUsd','outputPer1MUsd','outputPerMpUsd'];
const nonnegative=value=>typeof value==='number' && Number.isFinite(value) && value>=0;
const zeroRates=()=>({inputUsdPerMillion:0,outputUsdPerMillion:0,cachedInputUsdPerMillion:0});
const rates=(input,output)=>({inputUsdPerMillion:input,outputUsdPerMillion:output,cachedInputUsdPerMillion:input});
class EvidenceError extends Error {}
function fail(message){throw new EvidenceError(message);}
// Remove only multiplication's floating-point fuzz, then round upward to a nano-dollar.
function round(value) {
 const scaled=value*1e9;
 if(!nonnegative(value) || !Number.isFinite(scaled))fail('Derived price overflow/out of range');
 return Math.ceil(scaled-Number.EPSILON*scaled)/1e9;
}
async function publicJson(path,fetchImpl) {
 const response=await fetchImpl(`${ORIGIN}${path}`,{method:'GET',redirect:'error',headers:{accept:'application/json'},signal:AbortSignal.timeout(15000)});
 if(!response.ok){await response.body?.cancel().catch(()=>{});fail('Public pricing source HTTP failure');}
 const reader=response.body?.getReader();
 if(!reader)fail('Public pricing source missing body');
 const chunks=[];let bytes=0;
 try{
  for(;;){
   const {done,value}=await reader.read();if(done)break;
   bytes+=value.byteLength;
   if(bytes>8*1024*1024){await reader.cancel().catch(()=>{});fail('Public pricing source exceeds size limit');}
   chunks.push(Buffer.from(value));
  }
 }finally{reader.releaseLock();}
 try{return JSON.parse(Buffer.concat(chunks,bytes).toString('utf8'));}catch{fail('Public pricing source invalid JSON');}
}
function reference(catalog,entry) {
 const age=Date.now()-Date.parse(catalog?.updated_at);
 if(!Array.isArray(catalog?.models) || !Number.isFinite(age) || age < -60000 || age>DAY)fail('Stale/invalid pricing catalog');
 const rows=catalog.models.filter(row=>row?.model===entry.model);
 if(rows.length!==1)fail('Model missing/ambiguous in pricing catalog');
 const row=rows[0],card=row.mediaPricing;
 if(row.mediaType!==(entry.kind==='decision'?'decisions':entry.kind) || !exactKeys(card,RATE_KEYS) || !RATE_KEYS.every(key=>nonnegative(card[key])))fail('Invalid media catalog reference schema');
 const allowed=entry.kind==='image'?['perImageUsd']:entry.kind==='decision'?['inputPer1MUsd','outputPer1MUsd']:[];
 if(RATE_KEYS.some(key=>!allowed.includes(key) && card[key]!==0))fail('Unsupported media reference rate dimension');
 if(entry.kind==='image' && !positive(card.perImageUsd) || entry.kind==='decision' && !positive(card.inputPer1MUsd))fail('Missing positive media reference rate');
 return card;
}
function nativeSupply(book,entry) {
 if(book?.model!==entry.model || !Array.isArray(book.offers))fail('Public orderbook model/schema mismatch');
 const supply=book.offers.filter(offer=>offer?.healthy===true && offer.available===true && (offer.cap_remaining===null || offer.cap_remaining===undefined || positive(offer.cap_remaining)) && offer.provider_id===entry.provider && nativeHost(offer.seller_base_url,HOSTS[entry.provider]));
 if(!supply.length)fail('No healthy available non-exhausted native supply/route');
 return supply;
}
function nativeHost(value,host) {
 try{const url=new URL(value);return url.protocol==='https:' && url.hostname===host && !url.port && !url.username && !url.password;}catch{return false;}
}
function quote(entry,card,supply,settings) {
 const config=settings.mediaConfig,cushion=1+config.feeCushionBps/10000,antseedFeeBps=settings.antseedFeeBps??400;
 const factor=(1+settings.safetyBps/10000)/((1-settings.marginBps/10000)*(1-antseedFeeBps/10000));
 const common={upstreamModel:entry.model,provider:HOSTS[entry.provider],kind:entry.kind,media:entry,guaranteedBound:false,policyExpiresAt:config.expiresAt,feeCushionBps:config.feeCushionBps,antseedFeeBps,warnings:['Operator estimates only: public pricing data does not prove an all-in charge ceiling; routing enforcement requires separate verification','Provider host pin is not an exact-offer pin; preserve a separate maximum spend budget']};
 if(entry.kind==='decision') {
  if(supply.some(offer=>['media_unit','media_unit_price','direct_media_unit_price'].some(key=>offer[key]!==null && offer[key]!==undefined)))fail('Unexpected decision media tariff dimension');
  if(supply.some(offer=>!positive(offer.effective_input_per_1m) || !nonnegative(offer.effective_output_per_1m) || ['direct_input_per_1m','direct_output_per_1m'].some(key=>offer[key]!==undefined && !nonnegative(offer[key]))))fail('Invalid decision token price rate');
  const input=Math.max(card.inputPer1MUsd,...supply.map(offer=>Math.max(offer.effective_input_per_1m,offer.direct_input_per_1m??0)/1e6));
  const output=Math.max(card.outputPer1MUsd,...supply.map(offer=>Math.max(offer.effective_output_per_1m,offer.direct_output_per_1m??0)/1e6));
  const upstreamPricing=rates(round(input*cushion),round(output*cushion));
  const pricing=Object.fromEntries(Object.entries(upstreamPricing).map(([key,value])=>[key,round(value*factor)]));
  return {...common,pricing,upstreamPricing,maxPricePer1m:Math.max(...Object.values(upstreamPricing)),priceBasis:'reviewed-reference-envelope-estimate'};
 }
 const unit=entry.kind==='image'?'image':'job';
 if(supply.some(offer=>offer.effective_input_per_1m!==0 || offer.effective_output_per_1m!==0 || ['direct_input_per_1m','direct_output_per_1m'].some(key=>offer[key]!==undefined && offer[key]!==0)))fail('Unexpected/missing media token price dimension');
 if(supply.some(offer=>offer.media_unit!==unit || !positive(offer.media_unit_price) || offer.direct_media_unit_price!==undefined && !positive(offer.direct_media_unit_price)))fail('Missing/invalid media tariff price unit');
 const tariff=Math.max(card.perImageUsd,...supply.map(offer=>Math.max(offer.media_unit_price,offer.direct_media_unit_price??offer.media_unit_price)/1e6));
 if(entry.estimatedCostUsd<tariff)fail('Operator estimate below maximum eligible visible media tariff');
 const estimatedUpstreamUsd=round(entry.estimatedCostUsd*cushion);
 return {...common,pricing:zeroRates(),upstreamPricing:zeroRates(),maxPricePer1m:0,unitPriceUsd:round(estimatedUpstreamUsd*factor),estimatedUpstreamUsd,priceBasis:'reviewed-operator-estimate',warnings:[...common.warnings,'Public video job tariff is not a whole-render cost ceiling; actual settlement may differ']};
}

/**
 * Discover only reviewed image/video/decision candidates using anonymous GETs.
 * Media is sold per output image/video; decision pricing is USD/million tokens.
 * Zero token-shaped media fields are compatibility metadata, NEVER free media.
 * The explicit operator estimate and expiring policy do not guarantee a bound.
 */
export async function fetchMediaQuotes(settings, fetchImpl=fetch) {
 const empty=()=>({generatedAt:new Date().toISOString(),services:{},unavailable:{}});
 if(settings.mediaConfig===undefined)return empty();
 // Snapshot only public policy/economics before any await; caller mutation must
 // not change a request profile after validation or alias returned metadata.
 settings={surplusBaseUrl:settings.surplusBaseUrl,marginBps:settings.marginBps,safetyBps:settings.safetyBps,antseedFeeBps:settings.antseedFeeBps,mediaConfig:structuredClone(settings.mediaConfig)};
 validateMediaPolicy(settings);
 if(!settings.mediaConfig.services.length)return empty();
 const services=Object.create(null),unavailable=Object.create(null);
 let catalog;
 try{catalog=await publicJson('/v1/prices',fetchImpl);}catch{
  for(const entry of settings.mediaConfig.services)unavailable[entry.model]='Public pricing catalog unavailable';
  return {generatedAt:new Date().toISOString(),services:{},unavailable:{...unavailable}};
 }
 for(const entry of settings.mediaConfig.services) {
  try{
   const card=reference(catalog,entry);
   const book=await publicJson(`/api/markets/${encodeURIComponent(entry.model)}`,fetchImpl);
   // Validate source schema and candidate economics before expiry-only classification.
   // A valid candidate is still never published after consent expires.
   const candidate=quote(entry,card,nativeSupply(book,entry),settings);
   if(Date.now()>=Date.parse(settings.mediaConfig.expiresAt))fail('Reviewed media consent expired during public discovery');
   services[entry.model]=candidate;
  }catch(error){unavailable[entry.model]=error instanceof EvidenceError?error.message:'Public pricing source unavailable';}
 }
 if(Date.now()>=Date.parse(settings.mediaConfig.expiresAt)) {
  for(const entry of settings.mediaConfig.services){
   delete services[entry.model];
   // Expiry cannot launder a source/evidence failure into a safe drain signal.
   unavailable[entry.model]??='Reviewed media consent expired during public discovery';
  }
 }
 return {generatedAt:new Date().toISOString(),services:{...services},unavailable:{...unavailable}};
}

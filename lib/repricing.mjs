export function keepAdvertisedPrices(advertised,fresh,settings) {
 const services={};
 for(const [model,old] of Object.entries(advertised.services)) {
  const current=fresh.services[model];
  if(!current) throw new Error(`Upstream model missing: ${model}`);
  if(current.provider!==old.provider || current.upstreamModel!==old.upstreamModel) throw new Error(`Upstream provider changed: ${model}; restart to consent to new routing`);
  if(current.kind!==old.kind)throw Error(`Billing kind changed: ${model}`);
  if(['image','video'].includes(old.kind)) {
   if(JSON.stringify(current.media)!==JSON.stringify(old.media))throw Error(`Media configuration changed: ${model}; restart for new parameters`);
   if(!Number.isFinite(current.unitPriceUsd)||current.unitPriceUsd<=0||current.unitPriceUsd>old.unitPriceUsd)throw Error(`Media unit price increased: ${model}`);
  }
  if(!settings.lossTest) for(const f of ['inputUsdPerMillion','outputUsdPerMillion','cachedInputUsdPerMillion']) {
   // Fresh prices already include configured risk padding and gross markup.
   if(!Number.isFinite(current.pricing?.[f]) || current.pricing[f]>old.pricing[f]) throw new Error(`Upstream price increased beyond advertised safety margin: ${model}/${f}; rerun prices and restart`);
  }
  services[model]={...current,pricing:{...old.pricing},...(['image','video'].includes(old.kind)?{unitPriceUsd:old.unitPriceUsd}:{})};
 }
 return {...fresh,services};
}

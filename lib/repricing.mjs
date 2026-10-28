export function keepAdvertisedPrices(advertised,fresh,settings) {
 const services={};
 for(const [model,old] of Object.entries(advertised.services)) {
  const current=fresh.services[model];
  if(!current) throw new Error(`Upstream model missing: ${model}`);
  if(current.provider!==old.provider || current.upstreamModel!==old.upstreamModel) throw new Error(`Upstream provider changed: ${model}; restart to consent to new routing`);
  if(!settings.lossTest) for(const f of ['inputUsdPerMillion','outputUsdPerMillion','cachedInputUsdPerMillion']) {
   // Fresh prices already include configured risk padding and gross markup.
   if(!Number.isFinite(current.pricing?.[f]) || current.pricing[f]>old.pricing[f]) throw new Error(`Upstream price increased beyond advertised safety margin: ${model}/${f}; rerun prices and restart`);
  }
  services[model]={...current,pricing:{...old.pricing}};
 }
 return {...fresh,services};
}

export function keepAdvertisedPrices(advertised,fresh,settings) {
 // Economic changes are de-listed per model for the cycle (recorded in
 // `unavailable`) instead of killing the whole seller: a missing upstream or a
 // rising estimate means "stop selling this model now", never "serve it at a
 // stale price". Consent boundaries (provider/kind/media-config drift) stay
 // fatal: serving them would be stale consent, and restart must be explicit.
 const services={},delisted={};
 for(const [model,old] of Object.entries(advertised.services)) {
  const current=fresh.services[model];
  if(!current){delisted[model]='upstream missing from refreshed quotes';continue;}
  if(current.provider!==old.provider || current.upstreamModel!==old.upstreamModel) throw new Error(`Upstream provider changed: ${model}; restart to consent to new routing`);
  if(current.kind!==old.kind)throw Error(`Billing kind changed: ${model}`);
  if(['image','video'].includes(old.kind)) {
   if(JSON.stringify(current.media)!==JSON.stringify(old.media))throw Error(`Media configuration changed: ${model}; restart for new parameters`);
   if(!Number.isFinite(current.unitPriceUsd)||current.unitPriceUsd<=0||current.unitPriceUsd>old.unitPriceUsd){delisted[model]='media unit price increased beyond advertised';continue;}
  }
  if(!settings.lossTest) {
   let rose;
   for(const f of ['inputUsdPerMillion','outputUsdPerMillion','cachedInputUsdPerMillion']) {
    // Fresh prices already include configured risk padding and gross markup.
    if(!Number.isFinite(current.pricing?.[f]) || current.pricing[f]>old.pricing[f]){delisted[model]=`upstream estimate for ${f} rose beyond advertised`;rose=true;break;}
   }
   if(rose)continue;
  }
  services[model]={...current,pricing:{...old.pricing},...(['image','video'].includes(old.kind)?{unitPriceUsd:old.unitPriceUsd}:{})};
 }
 const unavailable={...(fresh.unavailable??{})};
 for(const [m,reason] of Object.entries(delisted))unavailable[m]=`de-listed: ${reason}`;
 return {...fresh,services,unavailable};
}

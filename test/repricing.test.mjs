import test from 'node:test';
import assert from 'node:assert/strict';
import {keepAdvertisedPrices} from '../lib/repricing.mjs';
const service=(i,o,c)=>({provider:'venice',upstreamModel:'test',pricing:{inputUsdPerMillion:i,outputUsdPerMillion:o,cachedInputUsdPerMillion:c},upstreamPricing:{inputUsdPerMillion:i/1.1,outputUsdPerMillion:o/1.1,cachedInputUsdPerMillion:c/1.1},maxPricePer1m:o/1.1});
test('refresh keeps published rates and fresh upper bound when cost remains safe',()=>{
 const old={generatedAt:'old',services:{test:service(1.1,2.2,1.1)}};const fresh={generatedAt:'new',services:{test:service(1,2,1)}};
 const r=keepAdvertisedPrices(old,fresh,{lossTest:false});
 assert.deepEqual(r.services.test.pricing,old.services.test.pricing);
 assert.equal(r.generatedAt,'new');
 assert.equal(r.services.test.maxPricePer1m,fresh.services.test.maxPricePer1m);
});
test('cost increases beyond advertised rates, provider drift or missing model fail closed',()=>{
 const old={services:{test:service(1,2,1)}};
 assert.throws(()=>keepAdvertisedPrices(old,{services:{test:service(2,4,2)}},{lossTest:false}),/price/);
 const drift=service(1,2,1);drift.provider='antseed';
 assert.throws(()=>keepAdvertisedPrices(old,{services:{test:drift}},{lossTest:false}),/provider/);
 assert.throws(()=>keepAdvertisedPrices(old,{services:{}},{lossTest:false}),/missing/);
});
test('loss mode is explicit and does not weaken provider pin',()=>{
 const old={services:{test:service(.1,.2,.1)}};const fresh={services:{test:service(1,2,1)}};
 assert.equal(keepAdvertisedPrices(old,fresh,{lossTest:true}).services.test.pricing.inputUsdPerMillion,.1);
});

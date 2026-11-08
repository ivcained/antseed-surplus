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
test('cost increases or a missing upstream de-list only that model, with reasons recorded',()=>{
 const old={services:{test:service(1,2,1),kept:service(1.1,2.2,1.1)}};
 const risen={services:{test:service(2,4,2),kept:service(1,2,1)}};
 const r=keepAdvertisedPrices(old,risen,{lossTest:false});
 assert.ok(!r.services.test);assert.ok(r.services.kept);
 assert.match(r.unavailable.test,/rose beyond advertised/i);
 const missing=keepAdvertisedPrices(old,{services:{kept:service(1,2,1)}},{lossTest:false});
 assert.ok(!missing.services.test);assert.match(missing.unavailable.test,/missing/i);
 const back=keepAdvertisedPrices(old,{services:{test:service(1,2,1),kept:service(1,2,1)}},{lossTest:false});
 assert.ok(back.services.test);assert.ok(!back.unavailable.test);
});
test('provider drift stays fatal: serving stale consent is never allowed',()=>{
 const old={services:{test:service(1,2,1)}};
 const drift=service(1,2,1);drift.provider='antseed';
 assert.throws(()=>keepAdvertisedPrices(old,{services:{test:drift}},{lossTest:false}),/provider/);
});
test('media unit price increase de-lists the service instead of failing the seller',()=>{
 const a={provider:'venice',upstreamModel:'venice-sd35',kind:'image',media:{parameters:{size:'1024x1024'}},unitPriceUsd:.03,
  pricing:{inputUsdPerMillion:1,outputUsdPerMillion:2,cachedInputUsdPerMillion:1}};
 const old={services:{'venice-sd35':a}};
 const r=keepAdvertisedPrices(old,{services:{'venice-sd35':{...a,unitPriceUsd:.04}}},{lossTest:false});
 assert.ok(!r.services['venice-sd35']);assert.match(r.unavailable['venice-sd35'],/media unit price/i);
});
test('loss mode is explicit and does not weaken provider pin',()=>{
 const old={services:{test:service(.1,.2,.1)}};const fresh={services:{test:service(1,2,1)}};
 assert.equal(keepAdvertisedPrices(old,fresh,{lossTest:true}).services.test.pricing.inputUsdPerMillion,.1);
});

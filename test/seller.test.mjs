import test from 'node:test';
import assert from 'node:assert/strict';
import {sellerEnvironment} from '../lib/seller.mjs';
test('AntSeed child receives local gateway token but never the Surplus credential',()=>{
 const e=sellerEnvironment({stateDir:'/state',rpcUrl:'https://rpc.test'}, {home:'/state/home',configPath:'/state/config.json'}, {privateKey:'0x'+'a'.repeat(64)}, 'localtoken', {PATH:'/bin',SURPLUS_API_KEY:'inf_secret',UNRELATED_SECRET:'private'});
 assert.equal(e.SURPLUS_API_KEY,undefined);assert.equal(e.UNRELATED_SECRET,undefined);
 assert.equal(e.SURPLUS_GATEWAY_TOKEN,'localtoken');assert.equal(e.HOME,'/state/home');
 assert.equal(e.ANTSEED_DATA_DIR,'/state');
 assert.equal(e.ANTSEED_SKIP_PLUGIN_UPDATE_CHECK,'1');
});

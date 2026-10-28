import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAntseedConfig, readSellerWallet, prepareRuntime} from '../lib/runtime.mjs';
import {mkdtemp,writeFile,readFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Wallet} from 'ethers';
const settings={stateDir:'/private/state',gatewayPort:18789,maxConcurrent:2,rpcUrl:'https://base.gateway.tenderly.co',dhtPort:6881,signalingPort:6882};
const quotes={services:{'gpt-oss-120b':{upstreamModel:'gpt-oss-120b',provider:'venice',pricing:{inputUsdPerMillion:1,outputUsdPerMillion:2,cachedInputUsdPerMillion:1}}}};
test('config advertises paid services only through loopback gateway with complete prices',()=>{
 const c=buildAntseedConfig(settings,quotes);
 assert.equal(c.seller.providers.surplus.baseUrl,'http://127.0.0.1:18789');
 assert.equal(c.seller.providers.surplus.apiKeyEnv,'SURPLUS_GATEWAY_TOKEN');
 assert.deepEqual(c.seller.providers.surplus.services['gpt-oss-120b'].pricing,quotes.services['gpt-oss-120b'].pricing);
 assert.equal(c.seller.healthCheck.enabled,false);
 assert.equal(JSON.stringify(c).includes('inf_'),false);
 assert.equal(c.seller.freeTier,undefined);
});
test('wallet signer must match declared address and owner-only secret file',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'seller-wallet-')); const file=join(dir,'wallet.json'); const w=Wallet.createRandom();
 await writeFile(file,JSON.stringify({private_key:w.privateKey,address:w.address}),{mode:0o600});
 assert.equal((await readSellerWallet({ANTSEED_WALLET_FILE:file})).address,w.address);
 await writeFile(file,JSON.stringify({private_key:w.privateKey,address:Wallet.createRandom().address}));
 await assert.rejects(readSellerWallet({ANTSEED_WALLET_FILE:file}),/address mismatch/);
});
test('runtime plugin tree is isolated from user global antseed state',async()=>{
 const stateDir=await mkdtemp(join(tmpdir(),'seller-runtime-')); const s={...settings,stateDir};
 const runtime=await prepareRuntime(s,quotes);
 const config=JSON.parse(await readFile(runtime.configPath,'utf8'));
 assert.match(await readFile(runtime.cliPath,'utf8'),/node|import/);
 assert.equal(config.seller.providers.surplus.plugin,'openai');
 assert.equal((await lstat(join(runtime.home,'.antseed/plugins/node_modules'))).isSymbolicLink(),true);
 assert.equal((await lstat(stateDir)).mode & 0o077,0);
});

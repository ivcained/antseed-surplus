import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {Wallet} from 'ethers';
test('treasury accepts the same wallet JSON variants as the seller and rejects a declared-address mismatch',async t=>{
 const {credentials}=await import('../scripts/topup.mjs');assert.equal(typeof credentials,'function');
 const dir=await mkdtemp(join(process.env.TMPDIR,'treasury-wallet-format-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const wallet=Wallet.createRandom(),file=join(dir,'wallet.json');const env={ANTSEED_WALLET_FILE:file,SURPLUS_API_KEY:'inf_fixture_inference'};
 await writeFile(file,JSON.stringify({address:wallet.address,privateKey:wallet.privateKey}),{mode:0o600});
 assert.equal(credentials(env).privateKey,wallet.privateKey);
 await writeFile(file,JSON.stringify({address:Wallet.createRandom().address,private_key:wallet.privateKey}),{mode:0o600});
 assert.throws(()=>credentials(env),/address mismatch/);
});

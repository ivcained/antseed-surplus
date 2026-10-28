import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Wallet} from 'ethers';

test('registration preview is isolated, key-free and never spawns or fetches',async t=>{
 const dir=await mkdtemp(join(process.env.TMPDIR,'antseed-register-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const {registerSeller}=await import('../scripts/register.mjs');
 const key=Wallet.createRandom().privateKey;let spawned=0;
 const result=await registerSeller({env:{ANTSEED_PRIVATE_KEY:key,STATE_DIR:dir},execute:false,spawnImpl:()=>{spawned++;throw Error('network action forbidden');}});
 assert.equal(spawned,0);assert.equal(result.status,'dry-run');assert.equal(JSON.stringify(result).includes(key),false);
 const config=JSON.parse(await readFile(join(dir,'registration-config.json')));assert.equal(config.payments.crypto.rpcUrl,'https://base.gateway.tenderly.co');
 assert.ok(result.args.includes('register'));assert.equal(result.home,join(dir,'home'));
});
test('registration help does not require keys or invoke chain operations',async()=>{
 const {spawnSync}=await import('node:child_process');const r=spawnSync(process.execPath,['scripts/register.mjs','--help'],{encoding:'utf8',env:{PATH:process.env.PATH}});assert.equal(r.status,0);assert.match(r.stdout,/--execute/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,symlink,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {Wallet} from 'ethers';
import {readCredential} from '../lib/settings.mjs';
import {readSellerWallet} from '../lib/runtime.mjs';
import {spawnSync} from 'node:child_process';
import {loadEnvFile} from '../lib/settings.mjs';
test('all seller CLIs reject a public dotenv file before reading credentials',async t=>{
 const dir=await mkdtemp(join(process.env.TMPDIR,'seller-env-permissions-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=join(dir,'public.env');await writeFile(file,'SURPLUS_API_KEY=inf_fixture_only\n',{mode:0o644});
 const script="import {loadEnvFile} from './lib/settings.mjs';process.argv.push('--env',process.env.TEST_ENV_FILE);loadEnvFile();";
 const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:process.cwd(),env:{PATH:process.env.PATH,TEST_ENV_FILE:file},encoding:'utf8'});
 assert.notEqual(result.status,0);assert.match(result.stderr,/private.*0600/);assert.equal(result.stderr.includes('inf_fixture_only'),false);
});
test('seller rejects symlinked API and wallet files rather than following credential indirection',async t=>{
 const dir=await mkdtemp(join(process.env.TMPDIR,'seller-secret-files-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await writeFile(join(dir,'key'),'inf_fixture_secret',{mode:0o600});await symlink(join(dir,'key'),join(dir,'key-link'));
 const wallet=Wallet.createRandom();await writeFile(join(dir,'wallet'),JSON.stringify({address:wallet.address,private_key:wallet.privateKey}),{mode:0o600});await symlink(join(dir,'wallet'),join(dir,'wallet-link'));
 await assert.rejects(()=>readCredential({SURPLUS_API_KEY_FILE:join(dir,'key-link')}),/regular file/);
 await assert.rejects(()=>readSellerWallet({ANTSEED_WALLET_FILE:join(dir,'wallet-link')}),/regular file/);
});

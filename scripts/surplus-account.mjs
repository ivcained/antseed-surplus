#!/usr/bin/env node
import {open,mkdir,lstat} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Wallet,getAddress} from 'ethers';
import {randomUUID} from 'node:crypto';
import {readSellerWallet} from '../lib/runtime.mjs';
import {readCredential,redactError} from '../lib/settings.mjs';
import {loadSetupEnv} from '../lib/bootstrap.mjs';
import {validateDeposit} from '../lib/topup.mjs';
const API='https://api.surplusintelligence.ai/v1';
const HELP=`Surplus buyer-key and deposit onboarding (never sends funds)
Usage:
  node scripts/surplus-account.mjs create-key --wallet FILE --out FILE --execute [--generate-wallet] [--label NAME]
  node scripts/surplus-account.mjs deposit --env FILE [--allocate]

create-key signs a strictly validated Surplus SIWE login message, not a transaction.
--generate-wallet explicitly creates a new dedicated local wallet if FILE is absent.
The inference key is saved once to a new private dotenv file; never printed.
Existing wallet/key files are never overwritten. A reserved output file after a
failure means inspect account keys before any fresh issuance; do not blindly retry.
This wallet authenticates the Surplus account and need not be your AntSeed wallet.

deposit reads existing receiver metadata from balance by default. --allocate
explicitly calls the receiver allocator; it may create an address. Neither command
transfers USDC, stakes, starts a seller or runs paid inference.
`;
function options(argv){
 if(argv.includes('--help')||argv.includes('-h'))return {help:true};
 const command=argv[0];if(!['create-key','deposit'].includes(command))throw Error('Choose create-key or deposit; use --help');
 const result={command};const values=command==='create-key'?['--wallet','--out','--label']:['--env'];
 const flags=command==='create-key'?['--execute','--generate-wallet']:['--allocate'];
 for(let i=1;i<argv.length;i++){
  const arg=argv[i];if(values.includes(arg)){if(!argv[i+1]||argv[i+1].startsWith('--')||result[arg]!==undefined)throw Error('Invalid/duplicate option');result[arg]=argv[++i];}
  else if(flags.includes(arg)){if(result[arg])throw Error('Duplicate option');result[arg]=true;}
  else throw Error('Unknown option; use --help');
 }
 return result;
}
async function jsonRequest(fetchImpl,path,init={}){
 let response;try{response=await fetchImpl(API+path,{...init,redirect:'error',signal:AbortSignal.timeout(15000)});}catch{throw Error('Surplus request failed; do not blindly repeat key issuance');}
 if(!response.ok){await response.body?.cancel();throw Error(`Surplus HTTP ${response.status}; inspect account before retrying key issuance`);}
 try{return await response.json();}catch{throw Error('Invalid Surplus JSON response; inspect account before retrying key issuance');}
}
function validateChallenge(challenge,address,now){
 const {message,nonce,expires_at:expiry}=challenge??{};
 const dates=typeof message==='string'&&message.match(/\nIssued At: ([^\n]+)\nExpiration Time: ([^\n]+)$/);
 const issued=dates?Date.parse(dates[1]):NaN,expires=dates?Date.parse(dates[2]):NaN;
 if(typeof nonce!=='string'||!/^[A-Za-z0-9]{8,128}$/.test(nonce)||!Number.isSafeInteger(expiry)||!Number.isFinite(issued)||!Number.isFinite(expires)||expiry!==expires||expiry<=now||issued>now+60000||issued<now-300000||expires<=issued||expires-issued>600000)throw Error('Untrusted/expired Surplus challenge');
 const expected=`surplusintelligence.ai wants you to sign in with your Ethereum account:\n${address}\n\nSign in to Surplus Intelligence Marketplace\n\nURI: https://surplusintelligence.ai\nVersion: 1\nChain ID: 8453\nNonce: ${nonce}\nIssued At: ${dates[1]}\nExpiration Time: ${dates[2]}`;
 if(message!==expected)throw Error('Untrusted Surplus challenge domain/address/chain/content');
 return message;
}
async function persist(handle,text){await handle.truncate(0);await handle.write(Buffer.from(text),0,Buffer.byteLength(text),0);await handle.sync();}
async function syncDirectory(path){const handle=await open(dirname(path),'r');try{await handle.sync();}finally{await handle.close();}}
async function createKey(o,fetchImpl,now){
 if(!o['--execute'])throw Error('Creating a buyer key requires --execute');
 if(!o['--wallet']||!o['--out'])throw Error('Set --wallet and --out explicitly');
 const walletFile=resolve(o['--wallet']),keyFile=resolve(o['--out']);
 const label=o['--label']??'antseed-surplus';if(label.length>100||/[\r\n]/.test(label))throw Error('Invalid key label');
 await mkdir(dirname(keyFile),{recursive:true,mode:0o700});
 const output=await open(keyFile,'wx',0o600).catch(()=>{throw Error('Key output already exists or cannot be reserved; never overwrite or blindly remint');});
 try{
  await persist(output,'# Reserved key issuance output. If empty of a key after failure, inspect the account before retrying.\n');await syncDirectory(keyFile);
  if(o['--generate-wallet']){
   try{await lstat(walletFile);}catch(error){
    if(error.code!=='ENOENT')throw error;
    await mkdir(dirname(walletFile),{recursive:true,mode:0o700});const wallet=Wallet.createRandom();
    const file=await open(walletFile,'wx',0o600);try{await persist(file,JSON.stringify({address:wallet.address,private_key:wallet.privateKey})+'\n');}finally{await file.close();}await syncDirectory(walletFile);
   }
  }
  const wallet=await readSellerWallet({ANTSEED_WALLET_FILE:walletFile});
  const challenge=await jsonRequest(fetchImpl,`/buyer/auth/challenge?address=${wallet.address}`,{method:'GET'});
  const message=validateChallenge(challenge,wallet.address,now());
  const signature=await wallet.signMessage(message);
  const result=await jsonRequest(fetchImpl,'/buyer/auth/keys',{method:'POST',headers:{'content-type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify({message,signature,label})});
  if(typeof result.key!=='string'||!/^inf_[A-Za-z0-9_-]+$/.test(result.key)||result.key.startsWith('inf_admin_'))throw Error('Unexpected key type; inspect issued account keys');
  // Save the one-time secret before any optional metadata validation can fail.
  await persist(output,`SURPLUS_API_KEY=${result.key}\n`);await syncDirectory(keyFile);
  if(getAddress(result.wallet)!==wallet.address)throw Error('Issued key wallet mismatch; key retained privately for inspection');
  return {status:'key-saved',wallet:wallet.address,walletFile,keyFile,keyId:result.id};
 }finally{await output.close();}
}
async function deposit(o,fetchImpl,env){
 const loaded=await loadSetupEnv(o['--env']??'.env',env,Boolean(o['--env']));const key=await readCredential(loaded);
 const headers={authorization:`Bearer ${key}`,accept:'application/json'};
 const allocated=o['--allocate']?validateDeposit(await jsonRequest(fetchImpl,'/payments/deposit-address',{method:'GET',headers})):undefined;
 const b=await jsonRequest(fetchImpl,'/payments/balance',{method:'GET',headers});
 if(![b.credit_balance_usdc,b.pending_deposit_usdc].every(v=>typeof v==='string'&&/^(0|[1-9][0-9]*)$/.test(v)))throw Error('Invalid Surplus balance');
 const existing=b.deposit_address?validateDeposit({address:b.deposit_address,chain_id:b.deposit_chain_id,token_address:b.deposit_token_address}):undefined;
 if(allocated&&existing&&allocated.address!==existing.address)throw Error('Deposit receiver changed; do not send funds');
 const receiver=allocated??existing;
 if(b.deposit_min_confirmations!==undefined&&(!Number.isSafeInteger(b.deposit_min_confirmations)||b.deposit_min_confirmations<1))throw Error('Invalid deposit confirmation requirement');
 return {status:receiver?'deposit-address':'no-receiver-reported',...(receiver??{}),minConfirmations:b.deposit_min_confirmations,creditBalanceMicro:b.credit_balance_usdc,pendingDepositMicro:b.pending_deposit_usdc,allocated:o['--allocate']===true};
}
export async function main(argv=process.argv.slice(2),adapters={}){
 const o=options(argv);if(o.help)return {help:HELP};const fetchImpl=adapters.fetchImpl??fetch;
 return o.command==='create-key'?createKey(o,fetchImpl,adapters.now??Date.now):deposit(o,fetchImpl,adapters.env??process.env);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 main().then(result=>console.log(result.help??JSON.stringify(result,null,2))).catch(error=>{console.error(`Surplus onboarding stopped: ${redactError(error)}`);process.exitCode=1;});
}

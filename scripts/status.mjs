import { loadEnvFile, loadSettings, readCredential, redactError } from '../lib/settings.mjs';
import { JsonRpcProvider, Contract, formatEther, formatUnits } from 'ethers';
import { readSellerWallet } from '../lib/runtime.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
loadEnvFile();
const settings=await loadSettings();
const key=await readCredential();
let rpc;
try {
 const response=await fetch(settings.surplusBaseUrl+'/payments/balance',{headers:{authorization:`Bearer ${key}`},signal:AbortSignal.timeout(20_000),redirect:'error'});
 if(!response.ok) throw new Error(`Surplus balance HTTP ${response.status}`);
 const b=await response.json();const w=await readSellerWallet();
 rpc=new JsonRpcProvider(settings.rpcUrl,8453,{staticNetwork:true});
 if(Number((await rpc.getNetwork()).chainId)!==8453)throw new Error('RPC is not Base');
 const usdc=new Contract('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',['function balanceOf(address) view returns(uint256)'],rpc);
 let gateway;try{gateway=await (await fetch(`http://127.0.0.1:${settings.gatewayPort}/health`,{signal:AbortSignal.timeout(2000)})).json();}catch{gateway={running:false};}
 let quote;try{const q=JSON.parse(await readFile(join(settings.stateDir,'quotes.json'),'utf8'));quote={generatedAt:q.generatedAt,models:Object.keys(q.services),ageSeconds:Math.floor((Date.now()-Date.parse(q.generatedAt))/1000)};}catch{quote=null;}
 console.log(JSON.stringify({seller:w.address,chainId:8453,walletUsdc:formatUnits(await usdc.balanceOf(w.address),6),walletEth:formatEther(await rpc.getBalance(w.address)),surplusCreditMicro:b.credit_balance_usdc,surplusDepositedUsdcMicro:b.usdc_available_usdc,pendingDepositMicro:b.pending_deposit_usdc,depositAddress:b.deposit_address,depositConfirmations:b.deposit_min_confirmations,gateway,quote},null,2));
}catch(e){console.error(redactError(e));process.exitCode=1;}finally{rpc?.destroy();}

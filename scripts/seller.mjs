import {loadEnvFile,loadSettings,readCredential,redactError} from '../lib/settings.mjs';
import {readSellerWallet} from '../lib/runtime.mjs';
import {fetchQuotes} from '../lib/pricing.mjs';
import {createGateway} from '../lib/gateway.mjs';
import {runSeller} from '../lib/seller.mjs';
try {
 loadEnvFile();
 const settings=await loadSettings();const apiKey=await readCredential();const wallet=await readSellerWallet();
 process.exitCode=await runSeller({settings,apiKey,wallet,fetchQuotes,createGateway});
}catch(error){console.error(redactError(error));process.exitCode=1;}

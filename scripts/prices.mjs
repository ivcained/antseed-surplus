import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {loadEnvFile,readCredential,loadSettings,redactError} from '../lib/settings.mjs';
import {atomicJson,buildAntseedConfig} from '../lib/runtime.mjs';
import {fetchQuotes} from '../lib/pricing.mjs';
try {
 loadEnvFile();
 const settings=await loadSettings();
 const apiKey=await readCredential();
 // Explicit policy only. Never auto-authorize an estimate or invent fee rates.
 if(process.env.PRICING_POLICY_FILE)settings.pricingPolicy=JSON.parse(await readFile(process.env.PRICING_POLICY_FILE,'utf8'));
 const quotes=await fetchQuotes(settings,apiKey);
 await atomicJson(join(settings.stateDir,'quotes.json'),quotes);
 if(Object.keys(quotes.services).length)await atomicJson(join(settings.stateDir,'config.json'),buildAntseedConfig(settings,quotes));
 console.log(JSON.stringify({generatedAt:quotes.generatedAt,services:Object.keys(quotes.services),unavailable:quotes.unavailable,estimated:!!settings.pricingPolicy,configPath:join(settings.stateDir,'config.json'),restartRequired:true}));
 if(!Object.keys(quotes.services).length)process.exitCode=2;
}catch(error){console.error(redactError(error));process.exitCode=1;}

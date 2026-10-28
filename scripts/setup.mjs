#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bootstrap, loadSetupEnv, parseSetupArgs } from '../lib/bootstrap.mjs';
import { redactError } from '../lib/settings.mjs';

const HELP = `Read-only seller setup
Usage: node scripts/setup.mjs [--env FILE] [--generate-wallet] [--accept-estimated-pricing]

Reads Base wallet and Surplus credit balances. Creates a private immutable
revenue-checkpoint.json and bootstrap-identity.json in STATE_DIR (.state).
No registration, staking, paid inference, or transfer is performed.
--generate-wallet explicitly permits creation of a new private wallet file.
--accept-estimated-pricing explicitly creates a 24-hour Groq estimate policy;
public prices do not prove guaranteed profit. Existing policy files are preserved.
Credentials: SURPLUS_API_KEY(_FILE), ANTSEED_PRIVATE_KEY or ANTSEED_WALLET_FILE.
Existing env values override the private 0600 env file (default .env).
`;
export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseSetupArgs(argv);
  if (options.help) { console.log(HELP); return; }
  const settings = await loadSetupEnv(options.envFile, env, options.explicitEnv);
  const result = await bootstrap({ env: settings, generateWallet: options.generateWallet, acceptEstimatedPricing: options.acceptEstimatedPricing });
  console.log(JSON.stringify(result, null, 2));
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`Setup stopped: ${error?.code ? 'Operation failed; inspect private setup files and RPC availability' : redactError(error)}`);
    process.exitCode = 1;
  });
}

# AntSeed seller backed by Surplus Intelligence

A standalone AntSeed text-inference seller with a loopback OpenAI-compatible gateway to Surplus Intelligence (SI). Default model: **`openai-gpt-oss-120b`**. The seller and the balance/topup monitor are separate processes. This project does not modify another AntSeed/Venice installation.

**Pricing is an explicitly accepted estimate, not a guaranteed-profit strategy.** SI's public orderbook omits full per-offer cache rates and account fees. Provider pinning is not exact-offer pinning, and `max_price_per_1m` may be ignored with minimum-discount routing. Without a reviewed pricing policy the application fails closed rather than inventing a safe price.

## Install and configure

Use **Node 22** consistently for installation and execution. AntSeed has native SQLite dependencies; mixing Node versions can produce an ABI mismatch. Use an absolute Node 22 executable in service definitions/background jobs, not whichever `node` a supervisor happens to find.

```sh
# Public clone over HTTPS; no Gitlawb identity is needed to read it.
git clone https://node.gitlawb.com/z6MkoyCVwBq8br8JaUfqTMpnMZMDgByyurJ9Wtoc8rdXj14f/antseed-surplus.git
cd antseed-surplus
# If you use nvm: nvm install && nvm use
node --version # tested with the version pinned in .nvmrc
npm ci
npm test
cp .env.example .env
chmod 600 .env
```

With Gitlawb's remote helper installed, the equivalent clone is:

```sh
git clone gitlawb://did:key:z6MkoyCVwBq8br8JaUfqTMpnMZMDgByyurJ9Wtoc8rdXj14f/antseed-surplus
```

Only source and sanitized evidence are published. Never push your populated `.env`, wallet, `.state`, payment databases or signed treasury journal.

Edit `.env` privately before running commands:

- Set a **user inference key**, `SURPLUS_API_KEY=inf_…`, or remove that variable and set `SURPLUS_API_KEY_FILE` to a private raw-key/dotenv file. Never use an `inf_admin_` key.
- Set `ANTSEED_WALLET_FILE` to a private JSON file containing `address` and `private_key`, or use `ANTSEED_PRIVATE_KEY`. All secret files must be regular files with mode `0600`.
- Set `ANTSEED_BASE_RPC_URL` to a trusted Base mainnet RPC; the example uses `https://base.gateway.tenderly.co` because short public-RPC failures can disable AntSeed payments.
- Set `PRICING_POLICY_FILE=.state/pricing-policy.json` and keep `STATE_DIR=.state` unless using absolute paths consistently.
- Set the public/reachable AntSeed address with `ANTSEED_PUBLIC_ADDRESS` as appropriate for your network. The SI gateway itself binds only to `127.0.0.1`.

All commands below run from the project directory. `--env FILE` selects another private env file. Existing process-environment variables take precedence over the file; do not leave unrelated wallet/key variables exported in your shell.

## Create your Surplus inference key and find its deposit address

This seller is a **buyer of Surplus inference**. It needs an `inf_...` buyer/inference key, not an `inf_admin_...` management key or a `si_seller_...` provider key. Never send keys or wallet private material through chat or commit them to Git.

### Dashboard option

Sign in at [surplusintelligence.ai](https://surplusintelligence.ai/), select the intended personal/team account, and create a buyer/inference API key in its key-management screen. Save the one-time secret privately. For a team, create the key in the intended workspace; the wallet-based helper below creates a **personal-account** key, not a key for an arbitrary team. Use the account's Crypto funding screen or the authenticated deposit helper below to obtain the receiver. If activation requirements are shown, complete them before serving; `/v1/account/activation` reports outstanding requirements.

### Browser-free key creation

After `npm ci`, this creates a **new dedicated local wallet** if absent, signs Surplus's validated SIWE login challenge, and saves the returned inference key directly into a new `0600` dotenv file. It does not send an on-chain transaction, transfer funds or need ETH merely to sign the login message.

```sh
node scripts/surplus-account.mjs create-key \
  --wallet .state/surplus-wallet.json --generate-wallet \
  --out .state/surplus-key.env --label antseed-surplus --execute
```

To use an existing dedicated local wallet instead, supply its private JSON path with `--wallet` and omit `--generate-wallet`. Supported wallet fields are `address` plus `private_key` or `privateKey`; the file must have mode `0600`. Do not export your main browser-wallet key just for this helper. The Surplus login wallet and AntSeed seller wallet may be different.

The helper validates the exact Surplus domain, URI, wallet, Base chain, nonce, statement and short expiry before signing. It prints only paths/public metadata, never the key. It refuses to overwrite the output or existing wallet. If issuance fails, the output may contain a reserved marker: **inspect the account's keys before creating another key**. A timed-out mint may have succeeded remotely; there is no automatic mint retry. Back up both private files: the wallet controls account access, and the inference key spends shared account credit. This helper does not create a spend budget or automatic key expiry; configure restrictions through the dashboard if required.

In your private `.env`, **remove** the example `SURPLUS_API_KEY=inf_REPLACE_ME` line and use:

```dotenv
SURPLUS_API_KEY_FILE=.state/surplus-key.env
```

An inline `SURPLUS_API_KEY` takes precedence over the file. Run the following commands from the repository directory.

### Discover the receiver and check funding

```sh
# Reads existing receiver metadata and balances; does not allocate an address.
node scripts/surplus-account.mjs deposit --env .env

# Explicitly create/find the receiver for the account authenticated by that key.
node scripts/surplus-account.mjs deposit --env .env --allocate
```

`--allocate` calls `GET /v1/payments/deposit-address`. Despite being a GET, it can lazily allocate/register a receiver. The helper validates the receiver, chain and token, then reads `/v1/payments/balance`. No funds are sent. `no-receiver-reported` from a balance-only read is not proof that no receiver exists; the allocation endpoint is the authoritative provisioning step.

Send **native USDC on Base (chain 8453)** to the returned `address` only:

- Native USDC contract: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.
- Do not send ETH, bridged USDC or another token/network to this receiver. Fund the **AntSeed seller wallet** separately with Base ETH for gas.
- The receiver is account-scoped, not a private balance exclusively for this API key; other keys drawing on the same billing account can spend the credit. Do not use the login wallet address as a substitute.
- Initial Surplus credit must be funded before inference can bootstrap AntSeed revenue. The monitor cannot fund a zero-credit account without eligible earnings.
- Rerun the balance-only command until credit is available. Amounts are integer micro-USDC (`1000000 = 1 USDC`). `creditBalanceMicro` is already combined spendable credit; do not add another credit component. Pending deposits are not yet spendable.
- Honor the returned `minConfirmations`/API `deposit_min_confirmations`; do not assume a fixed count. An undeployed receiver (`deployed: false`) is normal before its first sweep.

Equivalent raw API calls, if `SURPLUS_API_KEY` is already loaded into your environment privately:

```sh
# No literal key in shell history. Do not enable shell tracing (set -x).
curl --fail-with-body --silent --show-error \
  https://api.surplusintelligence.ai/v1/payments/deposit-address \
  -H "Authorization: Bearer $SURPLUS_API_KEY"

curl --fail-with-body --silent --show-error \
  https://api.surplusintelligence.ai/v1/payments/balance \
  -H "Authorization: Bearer $SURPLUS_API_KEY"
```

These are deposit-credit calls, not ERC-20 approval or x402 per-request payments. See the [official API guide](https://surplusintelligence.ai/llms.txt) for the SIWE endpoints and activation/budget controls. Help: `node scripts/surplus-account.mjs --help`.

## Read-only setup, then review prices

```sh
node scripts/setup.mjs --env .env
```

Setup checks the real chain ID and reads wallet native-USDC, wallet ETH, and SI balances. It creates a private immutable `.state/revenue-checkpoint.json` at the confirmed Base head (12 confirmations by default), plus `.state/bootstrap-identity.json` binding that checkpoint to the seller. It does **not** register, stake, pay for inference, sign a transaction, or send funds. Repeating setup preserves the checkpoint; changing the seller/treasury identity is refused. Legacy checkpoints are preserved and checked against an existing treasury journal before adoption.

To generate a wallet **only if needed**, explicitly opt in:

```sh
node scripts/setup.mjs --env .env --generate-wallet
```

An absent `ANTSEED_WALLET_FILE` uses `.state/seller-wallet.json`; an explicit file path is also supported. Existing files are never overwritten. Output includes the address/path, never the private key. Save the reported wallet path in `.env` before running the seller or monitor. A new wallet is unfunded: separately arrange any AntSeed protocol prerequisites and Base ETH gas, plus initial SI inference credit. Setup does not perform those spending actions. Zero starting SI credit cannot bootstrap inference merely by starting the monitor.

After reviewing the pricing limitations, authorize the default **24-hour** estimate policy:

```sh
node scripts/setup.mjs --env .env --accept-estimated-pricing
node scripts/prices.mjs --env .env
```

The default policy pins Groq's native host and explicitly accepts cache-at-input estimation and catalog-reference fallback. It uses the largest relevant catalog input/cache/reasoning dimensions, an offer multiplier ceiling of 2, live-book checks, and a 10% account-fee cushion. Catalog-reference fallback is a conservative envelope, **not the cheapest currently executable offer**. The resulting advertised price may be materially above the lowest SI book price. Review the private `.state/quotes.json` before serving; `guaranteedBound` remains `false`.

For a tighter, explicitly estimated native-Groq quote, add `"basis": "live-book"` to the private pricing policy. This prices each class from the **maximum healthy available pinned-provider offer**, then adds the configured SI fee cushion, safety allowance, AntSeed fee and target margin. It also sends an unconditional `/minN/v1/chat/completions` route floor derived from those offers. It is still not an exact-offer/final-charge guarantee. The more conservative default basis is `reference-envelope`.

`npm run prices` writes both `quotes.json` and the AntSeed `config.json`. **Restart the seller to publish changed rates**; this is not a hot-reload API. While running, automatic quote refresh retains the already advertised sell prices and stops service if refreshed estimates make those prices unsafe.

For each token class the normal price guard is:

```text
advertised = round_up(estimated_upstream × (1 + safety)
                      / ((1 - target_margin) × (1 - AntSeed_protocol_fee)))
```

Defaults are `SAFETY_BPS=500`, `MARGIN_BPS=500`, and AntSeed protocol fee **400 bps**. The upstream estimate already includes the policy's SI fee cushion. This aims at a small margin **relative to the estimate after AntSeed's fee**, not proven realized profit. Unmodeled upstream charges, token accounting differences, rounding, settlement/topup gas, and fixed operating costs can erase it. Keep `LOSS_TEST=false`; loss-test mode is not a production pricing strategy.

## Register a new seller, then start seller and monitor separately

A brand-new wallet needs Base ETH for ERC-8004 identity registration, recognized-usage seller binding, and later settlement gas. Registration is separate from setup and may broadcast transactions. It never stakes ANTS or claims rewards. An already registered wallet normally requires no new registration transaction.

```sh
# Key-free preview; no network or signing:
npm run register -- --env .env
# Explicitly authorize the registration/binding transactions when ready:
npm run register -- --env .env --execute
```

The wrapper supplies the configured wallet and isolated HOME/config/data directory; do not run a global AntSeed CLI against an unrelated default wallet. Forward inbound **TCP 6881 and 6882**, fill `ANTSEED_PUBLIC_ADDRESS=your-public-ip-or-domain:6882`, and verify that `http://your-public-address/metadata` is reachable. Do not expose loopback port 18791. An address in metadata alone does not prove internet reachability.

```sh
# Foreground seller; paid buyer requests may consume SI credit.
node scripts/seller.mjs --env .env
```

In another terminal, first inspect a single dry-run treasury iteration:

```sh
node scripts/monitor.mjs --env .env --once
# Continuous dry-run (no signing/sending):
node scripts/monitor.mjs --env .env --interval-seconds 60
```

Only after inspecting the plan and reserves, explicitly authorize revenue-funded transfers:

```sh
node scripts/monitor.mjs --env .env --execute --interval-seconds 60
```

`TOPUP_EXECUTE=true` **does not authorize spending**. Only the CLI `--execute` flag does. A single iteration is also available as `node scripts/topup.mjs --env .env` (dry-run), or with `--execute` to authorize a transfer.

The monitor waits for each treasury iteration to finish before waiting the configured interval (30–86400 seconds); calls never overlap. It continues known pending states only through the treasury's exact transaction-journal reconciliation. It stops on safety/configuration/network errors or unknown statuses rather than blindly retrying. `SIGINT`/`SIGTERM` cancel the wait and stop scheduling; an already-running treasury operation finishes safely. Exit code `2` signals an uncertain broadcast or mined transfer awaiting SI credit; a nonzero treasury code is not silently cleared by later iterations. Safety failures exit `1`.

### Revenue eligibility and limits

Only **new, confirmed AntSeed settlement revenue** from after the checkpoint funds refills. Native-USDC transfers must be accompanied by a same-receipt `ChannelSettled` proof whose net seller amount exactly matches the payout. Ordinary wallet deposits, starting balances, and AntSeed deposit withdrawals are **not revenue**. Self-buyer settlement can exercise the path but is not evidence of organic demand or economic earnings.

Verified Base contracts used by the treasury:

- Native USDC: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- AntSeed deposits / payout source: `0x0F7a3a8f4Da01637d1202bb5443fcF7F88F99fD2`
- AntSeed channels / settlement event: `0xBA66d3b4fbCf472F6F11D6F9F96aaCE96516F09d`

Setup supplies the immutable start block and payout source through `revenue-checkpoint.json`; manual `TOPUP_START_BLOCK`/`ANTSEED_PAYOUT_CONTRACTS` configuration is not needed. Do not override them after ledger initialization.

All amounts below are integer native-USDC micros (`1000000 = 1 USDC`), except the explicitly named wei settings:

| Variable | Default | Purpose |
|---|---:|---|
| `TOPUP_THRESHOLD_MICRO` | `200000` | Refill only below this effective SI balance |
| `TOPUP_TARGET_MICRO` | `1000000` | Desired SI balance, not a guaranteed refill amount |
| `TOPUP_MAX_MICRO` | `1000000` | Per-transaction cap; **1 USDC is a hard maximum** |
| `TOPUP_DAILY_CAP_MICRO` | `1000000` | Conservative daily spending cap; configurable |
| `TOPUP_WALLET_RESERVE_MICRO` | `0` | USDC retained in the seller wallet |
| `TOPUP_ETH_RESERVE_WEI` | `100000000000000` | ETH reserve required in addition to gas allowance |
| `TOPUP_MAX_FEE_PER_GAS_WEI` | `100000000` | Reject excessive fee rate |
| `TOPUP_MAX_GAS_COST_WEI` | `50000000000000` | Reject excessive estimated gas cost |
| `TOPUP_L1_FEE_RESERVE_WEI` | `10000000000000` | Additional Base L1-fee reserve |
| `TOPUP_CONFIRMATIONS` | `12` | Required chain confirmations |

The example `.env` deliberately overrides the bare CLI defaults: threshold **1 USDC**, target **2 USDC**, daily cap **2 USDC**, **20 confirmations**, and 30 receipt/credit polling attempts. The actual Surplus API's `deposit_min_confirmations` is also honored during reconciliation, even if higher than configured.

The actual transfer is capped by fresh unspent revenue, wallet funds after reserve, daily allowance, per-transaction maximum, and target gap. Pending SI deposits suppress another refill. `credit_balance_usdc` already represents combined spendable credit: `usdc_available_usdc` must not be added again. The monitor cannot invent revenue or pay ETH gas from a USDC budget.

## Policy expiry and recovery

The pricing policy expires after 24 hours. The gateway rejects expired/stale quotes and the seller stops on policy-refresh failure. The monitor does not renew policy or restart the seller. After independently reviewing the upstream contract/rates again, stop the seller if it is still running, move **only the pricing policy** aside, then explicitly renew and review prices:

```sh
mv .state/pricing-policy.json .state/pricing-policy.previous.json
node scripts/setup.mjs --env .env --accept-estimated-pricing
node scripts/prices.mjs --env .env
# Restart the seller only after inspecting the renewed quotes.
```

Use your configured policy path if different. Setup refuses to overwrite an existing policy; merely rerunning setup without consent does not extend it. No automatic consent renewal is enabled.

Preserve and back up the entire private `.state` directory, especially the revenue checkpoint, identity binding, AntSeed payment database, and `topup-journal.json`. The treasury journal may contain **replayable signed transaction bytes**. Never publish, paste, archive publicly, reset, or delete it to clear an error. Inspect existing receipts/journal before restarting after an uncertain broadcast. A lock requires checking the owning process first; do not blindly remove it. If native SQLite cannot load, reinstall with the same Node 22 executable used to run the seller.

For read-only status, use `node scripts/status.mjs --env .env`. Help is available with `node scripts/setup.mjs --help`, `node scripts/monitor.mjs --help`, and `node scripts/topup.mjs --help`.

## Optional paid acceptance probe

This uses a **separate funded AntSeed buyer**, not the seller wallet, and spends real buyer deposits. It does not fund, sweep, or register that buyer for you. Point `TEST_BUYER_WALLET_FILE` at an owner-only JSON buyer wallet. The AntSeed buyer needs sufficient already deposited USDC; on the audited deployment its first deposit minimum was 1 USDC net, and the optional gasless sweep fee was 0.05 USDC.

```sh
TEST_BUYER_WALLET_FILE=/private/path/buyer-wallet.json npm run probe -- --env .env
TEST_STREAM=true TEST_BUYER_WALLET_FILE=/private/path/buyer-wallet.json npm run probe -- --env .env
```

The probe pins this seller, uses an isolated buyer HOME/state, sends one token-bounded request, checks the exact expected response, then cooperatively closes the channel. Its local evidence is controlled traffic, not organic demand. `TEST_BUYER_PORT` defaults to loopback 8378. Do not run simultaneous probes against that same port/state.

## Verification scope

Fresh public-repository clone, setup, paid inference and on-chain settlement results are documented in [GITLAWB-CLONE-VERIFICATION.md](docs/GITLAWB-CLONE-VERIFICATION.md). Both normal and streaming requests were exercised using a separate funded controlled buyer; this is not organic demand.

`npm test` runs offline tests with synthetic signers and mocked external reads/sends, including checkpoint preservation, explicit wallet/pricing consent, treasury settlement proofs, exact-transaction recovery, and serialized monitor behavior. Help/error CLI smokes need no credentials. Running setup or `monitor --once` against a real configured account performs network reads and private state initialization, but no transfer unless `--execute` is supplied.

A controlled **self-buyer** live smoke previously returned `antseed surplus resale works` through AntSeed → this seller → SI: 677 micros AntSeed gross, 650 micros net after the 4% protocol fee, and 2 micros SI cost. Settlement: [`0x3e9e38e50d2b44ae5e2e42dd16d40f0480204e1c5accc123a2bd8782b380b5d9`](https://basescan.org/tx/0x3e9e38e50d2b44ae5e2e42dd16d40f0480204e1c5accc123a2bd8782b380b5d9). A 100-micro refill from that fresh revenue was confirmed on-chain and observed as SI credit: [`0xb5cf68937eb56c9b84885afde8055f26295baf9df4777854edd9e7e8a828bf4f`](https://basescan.org/tx/0xb5cf68937eb56c9b84885afde8055f26295baf9df4777854edd9e7e8a828bf4f). This proves the controlled routing/settlement/refill path, **not organic buyer traffic, ongoing availability, or net profit after gas**. Private request evidence and signed journals are intentionally excluded from the public project.

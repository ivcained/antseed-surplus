# Live verification — 2026-10-28 UTC

This is a real **controlled, separately funded AntSeed buyer** test, not organic third-party demand. No simulated API response or fabricated chain transaction was used. The historical Venice container/config were not modified or restarted.

## Paid inference

- CLI: `@antseed/cli@0.1.208`; provider: `@antseed/provider-openai@0.2.53`.
- Buyer: `0x66fC6ca3CBC768B5d889e77Bc75eD1a79683DEC9`.
- Seller: `0x0e49122e76bD8B9ccb2FE10c0088C41Ceb608927`.
- Model: `openai-gpt-oss-120b`; Surplus upstream pinned to native Groq.
- HTTP 200 through the AntSeed buyer proxy, response: `antseed surplus resale works`.
- Provider-reported usage: 3,594 input tokens, 89 output tokens; Surplus `buyer_cost_micro=2`.
- AntSeed delivered and authorized **677 micro-USDC**. On-chain native-USDC transfer to the seller: **650 micro-USDC**, after the **27-micro protocol fee**.
- Channel: `0xa5082c4fe98edb5bfcffc71fd71db8c5e51130a122136f15b51e4e8f26a3df0a`. Full nine-field on-chain read returned `settled=677`, `status=2` (closed).
- Settlement: https://basescan.org/tx/0x3e9e38e50d2b44ae5e2e42dd16d40f0480204e1c5accc123a2bd8782b380b5d9

## Revenue-funded credit refill

- Treasury checkpoint excluded preexisting seller holdings.
- A dry run recognized **650 micro-USDC of newly settled, confirmed AntSeed revenue** and proposed a **100-micro** refill.
- Exact native Base USDC transfer: seller → authenticated Surplus account receiver `0xe7e539CBaaf854A3C753610b1A9DbF8Aa03C6C12`, amount **100 micro-USDC ($0.000100)**.
- Transaction: https://basescan.org/tx/0xb5cf68937eb56c9b84885afde8055f26295baf9df4777854edd9e7e8a828bf4f
- Receipt succeeded and its native-USDC Transfer log matched exact token, sender, receiver and amount.
- The Surplus balance API first reported `pending_deposit_usdc=100`, then `pending_deposit_usdc=0`; spendable combined credit increased by **100 micros**. The script recorded `credit-observed` for this exact transaction, after the API's **20 required confirmations**.
- Reconciliation retained the same transaction hash and did not broadcast a duplicate.
- The public balance API exposes aggregate credit, not a transaction-specific credit ledger. Attribution uses the exact on-chain receiver transfer, matching 100-micro pending-deposit progression, and the observed 100-micro credit delta; concurrent account activity remains a limitation of this public verification surface.
- A separate authorized, strongly consistent production read resolved that exact transaction/log index in `surplus.usdc-deposits`: **`status=credited`, `amountMicro=100`, `confirmations=20`**, with the matching sender/receiver and permanent deposit `ledgerRef`. Credited timestamp: **2026-10-28T11:35:18.393Z**. This independent check establishes transaction-specific credit application; the downloadable seller itself does **not** require AWS access.
- Both paid channels were independently re-read as status **2 (closed)** before the temporary seller was stopped. No production seller or refill daemon is left enabled by the verification.

## Streaming and clean-copy acceptance

- A second controlled paid request passed with real SSE deltas, usage and `[DONE]` under the tighter live-book estimate and unconditional `/minN` floor.
- AntSeed gross charge: **282 micros**; native-USDC seller receipt: **271 micros**; Surplus buyer charge: **2 micros**.
- Streaming settlement: https://basescan.org/tx/0xeb6acd7b4b6b740fd3569bea11001997f6d54f1530bc3c0cc25d488caa4a2579
- Both requests together received **921 micros net**, spent **4 micros on inference**, and funded the **100-micro** refill. **821 micros** of that controlled net revenue remained unspent by the refill script.
- A fresh source-only copy installed **323 locked packages** using Node **22.22.0**, then passed **95 tests**. Native SQLite executed `SELECT 1`; new unfunded-wallet setup, real public pricing, registration preview and a real authenticated balance-monitor dry run all passed. No registration, stake or transfer was attempted from that new wallet.

## Economic and verification limits

The request had positive **inference trading spread**: 650 micros received versus 2 micros paid for inference. That is not proof of net operating profit: Base reserve/close and refill gas, hosting, failed requests, rounding and idle traffic must also be covered. A dust refill deliberately costs more in gas than the transferred amount; use larger production batches.

Public Surplus books do not expose a complete executable per-class/account-fee quote. The deprecated request price ceiling may be ignored. The operational pricing mode therefore uses an explicitly accepted conservative reference envelope, not a guaranteed-profit claim. Default rates are padded and may be substantially higher than the cheapest offer.

The public-address metadata endpoint was reachable, and an AntSeed buyer connected through the peer protocol. These facts do **not** independently prove unrelated external demand or successful inference from every internet/network location. No organic traffic is claimed here.

`live-verification.json` contains the sanitized machine-readable proof. Private runtime logs, wallet/API credentials, signed treasury journal, and account balance totals are intentionally excluded.

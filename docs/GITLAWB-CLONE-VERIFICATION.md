# Public Gitlawb clone acceptance

Verified on 2026-10-28 using Node 22.22.0 and published implementation commit `a691004b64719a984367a42881444c2b70653de9`.

## Public source and clean onboarding

- Public repository: `did:key:z6MkoyCVwBq8br8JaUfqTMpnMZMDgByyurJ9Wtoc8rdXj14f/antseed-surplus`.
- A fresh HTTPS clone from `https://node.gitlawb.com/z6MkoyCVwBq8br8JaUfqTMpnMZMDgByyurJ9Wtoc8rdXj14f/antseed-surplus.git` succeeded with Git credential helpers disabled and interactive credential prompts disabled. The cloned HEAD matched the published commit above.
- Fresh `npm ci --no-audit --no-fund`: 323 packages installed.
- Fresh `npm test`: **111 passed, 0 failed, 0 skipped**.
- Private configuration supplied the existing funded SI inference key and an existing registered seller wallet. No previous runtime, database, pricing policy, revenue checkpoint or treasury journal was copied into the checkout.
- `node scripts/setup.mjs --env .env --accept-estimated-pricing`, `node scripts/prices.mjs --env .env`, registration preview, and `node scripts/monitor.mjs --env .env --once` succeeded. The default reference-envelope pricing policy was used without loss-test overrides.
- The checkout's seller started successfully with native metering/payment SQLite storage and the payment manager enabled. Both SQLite integrity checks returned `ok`.

This verifies clone-to-running-seller with an already provisioned identity and funded accounts. It is not a claim that a brand-new wallet can skip registration, funding, gas or network reachability prerequisites.

## Fresh controlled paid volume

The separate funded buyer was pinned to this seller. The repository's probe ran once normally and once with `TEST_STREAM=true`. Both returned HTTP 200 and `antseed surplus resale works` through AntSeed -> this seller -> Surplus, with 3,594 input and 89 output tokens each. Each reported SI inference charge was 2 micro-USDC.

Seller: `0x0e49122e76bD8B9ccb2FE10c0088C41Ceb608927`.

- Nonstream settlement: [`0x023f88d8d86d351bdc4841b90d49c94f462d8f50103514039d4c74e384397728`](https://basescan.org/tx/0x023f88d8d86d351bdc4841b90d49c94f462d8f50103514039d4c74e384397728), block 53202739: 705 micro-USDC gross, 28 protocol fee, **677 net**.
- Streaming settlement: [`0x9c93d9d920cc814c0be63120eede71a932b793569158b51f87bccc7810229ce7`](https://basescan.org/tx/0x9c93d9d920cc814c0be63120eede71a932b793569158b51f87bccc7810229ce7), block 53202761: 705 micro-USDC gross, 28 protocol fee, **677 net**.

Both receipts succeeded, matched canonical Channels settlement events and native-USDC payouts from the deposits contract, had at least 20 confirmations, and reported closed channel status `2` using the full nine-field contract ABI. The fresh local payment database independently recorded both as settled.

Totals: **2 requests; 7,366 tokens; 1,410 micro-USDC gross settled volume; 1,354 micro-USDC net seller receipts; 4 micro-USDC reported SI inference cost**. Gas and hosting are excluded; these figures are not a net business-profit calculation.

This is authentic **controlled self-buyer volume**, not evidence of organic third-party demand. It does not establish inference from an independently operated external network. Earlier exact revenue-funded SI refill evidence remains in `LIVE-VERIFICATION.md`; this clone test did not send another refill.

## Shutdown and private state

The temporary clone's seller was stopped with SIGINT after settlement. It exited zero, finalized channels, removed its lock and closed its listeners. No seller or spending monitor is intentionally left running by this test. Live credentials, wallets, databases, request logs, account balances and signed journals are excluded from this repository. Preserve private operational state separately; never publish it.

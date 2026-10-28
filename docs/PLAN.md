# Delivery plan

## Scope
Standalone folder; no dependencies on existing Mac project paths. Node 22+, locked npm dependencies, README, example environment, ignored private runtime state. Old Venice seller remains off/untouched. User authorizes seller live test, existing SI inference key, low test prices, revenue-funded SI credits.

## Acceptance gates
1. Pin and inspect current AntSeed CLI/provider/settlement source and Surplus pricing/balance/deposit contracts.
2. Implement a Surplus-backed provider configuration/gateway, price generation with conservative all-in component bounds, balance monitor and bounded revenue-only native-Base-USDC replenishment.
3. Unit/integration tests first: fail closed on invalid/stale rates, wrong chain/token/receiver, low gas/reserve, concurrent/uncertain sends, lack of proven new settlement, and unsafe loss pricing.
4. Run seller, prove request arrives via AntSeed buyer protocol, SI useful inference succeeds and AntSeed records and settles nonzero revenue. Label controlled self-buyer separately from organic third-party traffic.
5. Fund SI receiver from freshly settled AntSeed revenue, verify exact USDC receipt and API credit application. Never equate pending/authenticated earnings with spendable revenue.
6. Restore profitable prices; independent specification then quality/security review; fix important findings; fresh install/test/start documentation verification. Deliver cloneable folder plus sanitized evidence.

## Financial test bounds
Use existing seller signer only after verifying its derived address. Do not stake, unlock, claim unrelated rewards or move historical/passive holdings. Use at most 1 USDC of buyer-paid controlled test and at most 1 USDC of fresh AntSeed seller receipts for replenishment; gas strictly bounded. Loss pricing test mode must be explicit/time-limited/request-budgeted. Do not silently claim synthetic buyer revenue is organic demand or economic profit.

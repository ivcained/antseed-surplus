# Release validation

## Scope and verdict

- Specification review: **PASS**, with real controlled traffic explicitly separated from organic demand.
- Quality/security review: three reproduced lifecycle defects were repaired; independent re-review **APPROVED** the fixes and adjacent regressions. No critical payment-journal or credential-containment issue was found within the bounded review.
- Final full suite on Node **22.22.0**: **111 passed, 0 failed, 0 skipped/cancelled**, independently repeated by the parent and reviewer.
- The source-only ZIP was freshly extracted, installed from the lockfile (**323 packages**), and passed the same **111 tests**. Initial clean-wallet setup, public-price fetch, registration preview, native SQLite and authenticated balance-monitor dry run were also exercised without relying on the old project.

## Final runner acceptance

The repaired runner was started against the real configured account after the lifecycle changes. Metering storage, ChannelStore, deposits/channels clients and payment manager initialized; direct peer metadata advertised the configured Surplus-backed service. An intentional SIGINT then exited **0**, closed both listener ports and removed its seller lock. The payment databases and signed refill journal remain private and preserved.

Lifecycle tests use real disposable Node children and loopback HTTP servers. They cover signal-terminated child cleanup, fatal safety stops when the child exits zero, occupied runtime non-mutation, quote/native/gateway startup failure, child launch error, repeated signals and bounded TERM/KILL escalation.

No seller or spending monitor is left running by the release verification. The old Venice installation was not changed or restarted.

## Reviewed code identity

- `lib/seller.mjs` SHA-256: `404b69011b56fefe2f9daf4fbb60c2a039edb3f8cf7b775e1d7292a79a5b169b`.
- `test/seller-lifecycle.test.mjs` SHA-256: `a0cb3c3cb60c91ae90cdc553efeb625e843c34ddf6bd8e32a58e78a14e9bdf72`.
- Reviewed staged source candidate SHA-256: `516dca5cf8dcf78c2e7963301bb034637b5ea494a01be2058a65e7104344ca14`. This document was added after that review and does not modify the reviewed implementation.

## Financial proof and limits

See [LIVE-VERIFICATION.md](LIVE-VERIFICATION.md) and [live-verification.json](live-verification.json) for the two real paid AntSeed requests, native-USDC settlements, and exact Surplus deposit row credited from fresh seller revenue. These are functional integration proofs, not organic demand or net operating-profit guarantees.

Only source, lockfile, examples, tests and sanitized documentation are distributed. Exact live inference/private keys, signed transaction bytes and private runtime paths were scanned out of the staged release. Credentials, payment databases, journals, account balance totals, logs and `.state` are not packaged.

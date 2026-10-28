# Shared AntSeed / Surplus content implementation plan

> **For Hermes:** Use subagent-driven-development to implement this plan task-by-task with strict RED -> GREEN tests and specification review before security review.

**Goal:** Extend the public cloneable seller to every content family actually shared by AntSeed and Surplus, then prove paid content delivery and confirmed AntSeed settlement from a fresh public clone.

**Architecture:** Keep treasury and lifecycle safeguards intact. Add explicit modality-aware quotes/configuration and a credential-isolated gateway adapter for synchronous image generation/editing and durable asynchronous video jobs. Preserve chat and determine whether additional decision/text API families are genuinely compatible before advertising them. Never equate catalog presence or HTTP202 with usable supply or paid delivery.

**Tech stack:** Node22.22.0 ESM, locked official AntSeed plugins, ethers6.15.0, Node HTTP/fetch, SQLite/private fsynced journals, node:test.

## Acceptance boundary

- Enumerate every shared content family with API compatibility and current-supply evidence; distinguish unsupported protocols from temporarily empty supply.
- Cover text/chat (including streaming), image generation, image editing, video generation, and any additional genuinely shared content family discovered (for example decisions). Audio/music/embeddings require proof of an AntSeed protocol before inclusion.
- A paid live case must produce useful content, a valid downloaded artifact for media, local persistent metering and payment records, a successful canonical Channels settlement and exact native-USDC seller payout. Buyer traffic is controlled, never organic demand.
- Fresh public clone must install dependencies and run documented setup/config/price/seller/probe commands without accessing another project's runtime. Existing funded test wallets may be configured privately; never run concurrent sellers with the same identity.
- Bound live spend; use cheapest representative healthy models/settings, single output/minimum duration and a low number of calls. Do not repeatedly submit uncertain async jobs or create unrelated credentials.
- Preserve original disabled Venice seller, all private state and existing treasury checkpoints/journals. No private keys, API keys, tokens, raw signed bytes, private URLs or account-wide balances in public artifacts.

## Task 1: Pin contracts and content intersection

Read-only research owns no implementation files. Inspect installed/current AntSeed protocols/plugins and public Surplus docs/catalog/immutable source. Resolve exact request/response paths, unit-pricing metadata, job ownership, job authorization, poll/artifact origin rules, delivery billing and source attribution. Save a concise supported-content matrix in docs/MEDIA.md after verification.

## Task 2: Modality configuration and pricing (test-first)

Create `lib/media-pricing.mjs`, `test/media-pricing.test.mjs`, and example non-secret config. Validate explicit per-model modality, provider/host, supported request dimensions and expiring estimate consent. Read healthy non-AntSeed supply and correct media pricing units; do not treat reference zero/missing dimensions as free. Separate per-image/per-video/per-second prices from token rates. Preserve explicit AntSeed fee, fee cushion and safety/margin. Output metadata sufficient for runtime and gateway checks; fail closed on unpriced parameters or stale/missing evidence.

Run focused tests RED before implementation; then GREEN and the current full `npm test` suite.

## Task 3: Image proxy (test-first)

Create `lib/media-gateway.mjs` and `test/media-gateway.test.mjs` or bounded modality modules. Support OpenAI generations and multipart edits only for configured models and parameter combinations. Enforce private local auth, body/output/concurrency limits, exact routing pin, fresh quotes/consent, stripped caller routing/headers and idempotency. Validate response images and safe output handling. Do not expose the SI credential or accept arbitrary artifact fetch URLs. Test mock upstream payloads and actual local HTTP behavior.

## Task 4: Durable video adapter (test-first)

Add an AntSeed-supported queue/retrieve adapter over Surplus async generation. Journal exact submission intent/idempotency before submitting, save job/token/owner privately, bind retrieve/cancel to correct configured model and owner, and survive restart without duplicate submit. Translate nonterminal/terminal states; return MP4 only after bounded approved-origin download and content validation. Avoid forwarding raw job tokens, signed URLs or arbitrary provider URLs. Cover abandoned/failed/canceled jobs, repeated polling/download and uncertain submissions. Payment authorization must precede expensive work within the actual AntSeed plugin/buyer contract; disclose remaining upstream-incurred/undelivered risk.

## Task 5: Runtime integration and probes (test-first)

Parent integrates settings, combined quote fetching, runtime provider/plugin registration and lifecycle repricing without overlapping implementer ownership. Add pinned dependencies only as needed. Add `scripts/probe-media.mjs` for controlled separate buyer, content family selection, artifact validation, safe channel close, bounded timeout and private evidence. Preserve existing chat/proxy tests and add config/regression coverage. Determine whether Anthropic/Responses translation and decisions require separate adapters or are unsupported/empty-supply.

## Task 6: Reviews, publication and live clone gates

1. Independently rerun unit/integration suites and exact payload smokes without paid external effects.
2. Specification review PASS, then security/quality review APPROVED; repair important findings with regressions.
3. Scan explicit source changes for live secrets and runtime paths; commit and push source/README/examples to existing public Gitlawb repo. Verify exact remote head by readback.
4. Clone anonymously to a fresh directory, install locked dependencies, run full tests and documented setup. Configure private test keys/registered wallet without copying old runtime.
5. Start seller and run one bounded request per supported content family, downloading/validating artifacts and polling to terminal state. Persist private evidence after every case.
6. Verify confirmed canonical settlements + payout logs; aggregate counts/tokens/images/video seconds/costs in code, not mentally. Clearly separate reported SI charges, AntSeed gross/net revenue and gas.
7. Stop test seller/monitor cleanly, check removed ownership lock/closed listeners and intact journals. Add sanitized verification docs and publish them; read exact target back.
8. State completion only if every shared supported content family's acceptance gate passes; otherwise report the precise retrievable/operational blocker without fabricated content or volume.

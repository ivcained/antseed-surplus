# Shared content services

> Controlled public-clone delivery evidence currently covers **10 of 11 cases**, with separate settlement and revenue-refill records below. [PDF input through OpenAI passed with a canonical payout](evidence/pdf-input-and-vertex-attempt.json); video understanding remains unaccepted after an upstream HTTP 400. Catalog presence is not proof of delivered or paid media.

## Scope

The integration targets content families, not every catalog model or every equivalent API spelling. Reviewed media profiles currently cover:

- **Image generation:** `venice-sd35`, one output, `1024x1024`, through OpenAI Images.
- **Image editing:** `muse-image-edit`, one output, through OpenAI Images edits. Masks/inpainting are not part of this profile.
- **Image-to-video:** `longcat-distilled-image-to-video`, five seconds, `720p`, through AntSeed's native Venice-video queue/retrieve protocol. Do not add audio or aspect-ratio controls: this model does not accept them.
- **Structured decisions:** `jev-1.13`, native question-map/state requests, through AntSeed `/v1/systemone` translated to Surplus `/v1/decisions`. Zero output-token pricing is valid; it does not mean the request is free.
- **Text and media understanding:** separately configured text models can receive supported image/audio/video/file blocks through Chat. A model's catalog declaration is only a candidate: the chosen upstream wire must preserve the blocks and the live test must return a semantically correct answer.

With the local extension provider selected, text services have explicit Chat, Responses and Anthropic Messages protocol metadata. Responses and Messages use their own wire formats; they are not parsed as Chat responses. The default, text-only configuration retains the original official OpenAI provider path.

Surplus also exposes audio generation, transcription, embeddings and music generation. The inspected AntSeed paid API surface does not expose corresponding content routes, so those generation families are outside the current intersection. Audio **input to a text model** is distinct from audio generation/transcription APIs.

The inspected AntSeed API adapter recognizes legacy `/v1/completions`, but its installed buyer CLI proxy rejects that path. It is not advertised as working buyer-CLI support. Venice-video and Fal-video are alternative video protocols, not separate content families; this adapter uses Venice-video.

## Enable reviewed media profiles

Keep the normal README setup, private key handling, seller registration and public-network prerequisites. Do not put media models into `MODELS`: that variable remains the token-billed text allowlist. A model cannot be configured in both lists.

1. Copy `examples/media.config.json` to `.state/media.config.json`.
2. Review each model's fixed parameters and `estimatedCostUsd`. Remove any service you do not wish to offer.
3. Replace `reviewedAt` with the current ISO timestamp and `expiresAt` with a later timestamp no more than 24 hours after review. The placeholder dates intentionally fail validation. At least a 10% upstream fee cushion is required.
4. Add to your private `.env`:

   ```dotenv
   MEDIA_CONFIG_FILE=.state/media.config.json
   MEDIA_MAX_INPUT_BYTES=12582912
   ```

5. Run `npm run prices`. Check the exact `services` and `unavailable` results before starting. A missing, unhealthy, exhausted, unreviewed-host or unpriced service must not be advertised.
6. Start with `npm start`. Restart after changing configuration or advertised prices; quote refresh is not hot publication.

For video artifact redirects, the bridge denies external hosts by default. Approve only the actual exact public artifact hostname(s) you have reviewed:

```dotenv
# Replace this placeholder; do not approve an arbitrary caller-provided URL.
MEDIA_ARTIFACT_HOSTS=your-reviewed-public-artifact-host.example
```

The allowlist accepts hostnames, not URLs, IPs, ports, credentials or wildcards. The Surplus credential must remain attached only to the fixed Surplus API origin; external downloads must not receive it.

## Pricing and safety boundaries

- Images bill `output_images`; video bills `video_generations` for the fixed-duration profile. Zero token-shaped metadata on these services is compatibility metadata, **not free media**.
- Decisions are token-billed and permit a genuine zero output price.
- Upstream media cost is an explicit operator estimate, checked against the maximum eligible visible native tariff and padded for the configured fee cushion. A public video `job` tariff is not a whole-render ceiling.
- Sell-side pricing includes safety, target margin and the configured AntSeed protocol fee. Quotes retain `guaranteedBound:false`. Estimates do not guarantee profit after provider adjustments, failures, gas or hosting.
- Requests pin the reviewed native provider and block AntSeed upstream routes. A host pin is not an exact-offer pin. Media routing controls must actually be enforced by the deployed Surplus service; merely submitting the field does not prove enforcement.
- Review expiry is checked at dispatch. Refresh must not extend consent or quietly change a request profile. A price increase beyond advertised safety causes shutdown rather than silently serving at an unsafe rate.
- Consent expiry is distinct from a pricing outage: with valid preserved video metadata, the seller disables **all new work**, keeps existing paid-job retrieval alive, and can restart in video-only retrieval mode. Keep `.state/retrieval-runtime.json`, the unchanged policies/economics it binds, the private video journal and AntSeed payment/ownership databases. The snapshot preserves the original positive video unit tariff; it is not executable fresh pricing, renewed consent or permission for another render. Missing/invalid recovery state and unrelated safety failures fail closed.
- Synchronous image requests are not automatically retried: Surplus's image route does not promise idempotency, so retrying can charge again.
- Video submission requires a durable private intent and stable idempotency key. An uncertain submission is not permission to create another render. Job tokens and provider URLs are private, not returned as the native public queue ID.
- Preserve the hidden `.state/.video-bridge-initialized` marker **together with** `.state/video-bridge/`. The marker is outside the component directory so loss of that directory fails closed instead of resetting deduplication. Never remove the marker to bypass a recovery error; stop and inspect/restore a known-complete backup. Interrupted initialization also fails closed. This protects partial component-state loss while the outer root/marker survive, not deletion of every durable record or independently proven hardware power-loss recovery.
- AntSeed payment authorization does not eliminate every business risk: an accepted upstream render may incur cost before the buyer retrieves a deliverable. Failed or abandoned renders are not evidence of settled seller revenue.

The original revenue-only Surplus refill policy is unchanged. Preserve its immutable checkpoint, wallet binding, payment databases and private signed-intent journal. Do not use starting wallet funds or arbitrary receipts as newly earned AntSeed revenue.

## Bounded controlled buyer probes

The probe runner is implemented and offline-tested; it is not itself proof of successful paid delivery. Independent review and live acceptance remain release gates.

Run this **offline** to inspect a plan without loading a wallet, reading `.env`, starting a buyer or making a network request:

```sh
npm run content-probe -- --kind image --model venice-sd35
```

For an authorized paid test, start your seller first and use a **different, explicitly funded buyer wallet**. Its JSON file must be a private regular file (0600), not a symlink. The seller wallet remains `ANTSEED_WALLET_FILE`. Configure the buyer in your private `.env`:

```dotenv
TEST_BUYER_WALLET_FILE=/absolute/private/path/to/buyer-wallet.json
TEST_MAX_COST_USD=1
TEST_BUYER_PORT=8378
```

Only the following explicit command sends a paid request:

```sh
npm run content-probe -- --kind image --model venice-sd35 --execute
```

Use one run per kind, **serially when reusing the same buyer wallet**. Different ports and state directories do not create different AntSeed peer identities; concurrent buyer processes with the same identity can replace each other's connection and interrupt payment authorization. Let the video probe finish before starting another kind with that wallet. Other fixed-profile examples are:

```sh
npm run content-probe -- --kind edit --model muse-image-edit --input /absolute/path/to/input.png --execute
npm run content-probe -- --kind video --model longcat-distilled-image-to-video --input /absolute/path/to/input.png --execute
npm run content-probe -- --kind decision --model jev-1.13 --execute
```

Inputs must be regular files no larger than 1 MiB; the reviewed image-input probes accept PNG. Text-protocol probes use `--kind text`, `responses`, or `messages`, and an exact configured text model. Media understanding uses `vision`, `audio-input`, `file-input`, or `video-input`, with a supported configured text model and `--input`; audio/file/video understanding also requires an objective `TEST_EXPECT_CONTAINS` value. See the [endpoint-specific PDF/OpenAI and video/Vertex setup](ENDPOINT_INPUTS.md) for exact host selection and native input envelopes; PDF passed paid acceptance, while video understanding did not. Discovery is not proof that any particular native protocol or input family works for a given upstream model.

The default budget is $1 per isolated run; non-video cannot exceed $1 and video cannot exceed $5. `TEST_MAX_COST_USD` sets the explicit budget. AntSeed payment config values alone are **replenishable windows, not hard spending caps**. The runner additionally installs a mandatory guard on the pinned buyer-core 0.1.28 payment manager before startup, limiting the sum of channel authorization high-water marks across ordinary, automatic top-up and one-off video channels. It fails closed if the pinned version or guard startup is unavailable. Authorization limits do not guarantee an upstream render-cost ceiling or seller profitability.

Each execution binds the exact content kind, model and seller peer in its mandatory child preload. Dispatch guards reject canonical/date/vendor/case alias substitutions and recheck final JSON/multipart selectors and the exact advertised service before connection/payment negotiation; merely sending a model header is not sufficient. The guard requires the reviewed CLI 0.1.208, node 0.2.154, buyer-core 0.1.28 and api-adapter 0.1.53 versions and verifies the actual CLI→node→buyer-core module identities before reporting readiness. It fails closed rather than silently choosing another model.

The runner creates fresh private buyer state under `.state/content-probe/<kind>/<run>/`, dispatches once, and performs bounded shutdown. Video queues once, then polls until an actual MP4 is delivered. A timed-out accepted request may still incur a charge; do not blindly retry it. Evidence is private and excludes raw job tokens and upstream URLs. PNG validation reconstructs pixels for static, non-interlaced, 8-bit grayscale/RGB/indexed/grayscale-alpha/RGBA images. Packed depths, 16-bit PNG, Adam7 and APNG fail closed. Pixel/scanline/RGBA and encoded-size bounds are enforced before inflation/allocation; these are per-buffer bounds, not a total process-memory cap. JPEG/WebP inspection is metadata-only. Saved MP4 inspection validates container metadata, **not decoded frames**; independently decode/inspect saved artifacts before declaring delivery accepted. The fixed-5s generated-video probe additionally requires an inclusive 4.5–5.5s duration (explicit ±10% tolerance); useful playable output outside that interval fails profile acceptance and must not be trimmed or relabeled as a passing render.

External image URLs are denied unless their exact reviewed HTTPS hostname is explicitly in `TEST_ASSET_HOSTS`; this buyer-side allowlist is separate from the seller's `MEDIA_ARTIFACT_HOSTS`. No wildcard, redirect-following or credential-bearing download is implied. Final usage supplied in a response is not independent settlement reconciliation, and these tests are controlled traffic, not organic demand.

## Acceptance evidence

Latest controlled public-clone delivery coverage is **10 of 11 cases**, not full acceptance. [PDF input](evidence/pdf-input-and-vertex-attempt.json) now passes through OpenAI with native metering and a confirmed canonical seller payout; the same serial batch's Vertex video-input request failed upstream with HTTP 400 and is not accepted. Its unspent native buyer channel deposit had not been refunded at the recorded observation. [Native decisions and image edits](evidence/native-decisions-and-edits.json), [audio understanding](evidence/audio-understanding.json), and [revenue-funded replenishment](evidence/revenue-refill.json) have separate evidence. [Previously paid cached-video retrieval after seller/buyer restart](evidence/video-restart-retrieval.json) passes through AntSeed without another render or new ReserveAuth signature; this is not an additional sale. Generated-video duration/profile fidelity remains open. [In-flight interruption and later retrieval](evidence/video-inflight-recovery.json) recovered the same accepted job and confirmed its seller payout without another render; the first recovery session failed closed on an unrelated Muse supply outage, so this is not continuous-availability proof. Earlier [media results](evidence/media-progress.json) are historical attempts, not the latest status. These are controlled tests, not organic demand or profitability proof.

A completed content test must establish all of the following:

1. A clean anonymous clone installs the locked source and starts its own isolated seller runtime.
2. A separate, funded, seller-pinned AntSeed buyer sends the request; no direct Surplus call is substituted for AntSeed traffic.
3. The returned text/decision is meaningful, or the generated image/video is downloaded and validated. HTTP 202, status JSON, URLs and nonempty arbitrary bytes do not constitute video delivery.
4. Persistent metering and payment records agree with the request's token or unit billing.
5. The canonical AntSeed channel settlement succeeds and the native-USDC seller payout is confirmed on-chain.
6. Actual Surplus charges, AntSeed gross/net settlement and gas are distinguished. Controlled test volume is not organic external demand.
7. Temporary services shut down cleanly with state, checkpoints and journals intact.

The final verification report must list unsupported families and live-route failures honestly; it must not infer success from public discovery alone.

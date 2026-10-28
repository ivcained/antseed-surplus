# Endpoint-specific PDF and video understanding

> PDF input passed a paid seller-pinned AntSeed request from a fresh anonymous clone, with native metering and confirmed canonical payout. Vertex video input remains unaccepted: the original data-URI attempt returned upstream HTTP 400, and the [raw-Base64 retest](evidence/vertex-video-raw-base64-attempt.json) returned HTTP 200 but failed its objective answer check; see [current endpoint evidence](evidence/pdf-input-and-vertex-attempt.json). The earlier [predispatch catalog mismatch](evidence/endpoint-input-predispatch.json) was repaired and independently reviewed before this batch. Overall controlled delivery coverage is 10/11, not full acceptance. See [contract research](research/endpoint-input-contracts.md) and [current acceptance evidence](MEDIA.md#acceptance-evidence).

## Why exact endpoints matter

AI Studio and Vertex both use marketplace provider ID `google`, but their documented Chat media envelopes differ. A generic Google pin is not sufficient.

- PDF input uses OpenAI Chat `file.file_data`, pinned to `api.openai.com`.
- The controlled video-input candidate uses Vertex Chat `input_audio`, with `format: "video/mp4"` and raw Base64 MP4 bytes in `data`, pinned to `aiplatform.googleapis.com`. The original data-URI variant failed live parsing; raw Base64 is a scoped compatibility correction, not yet paid acceptance or a claim that Vertex universally rejects data URIs.
- The existing AI Studio WAV/MP3 input keeps raw Base64 and `format: "wav"` or `"mp3"`, pinned to `generativelanguage.googleapis.com`.

No text extraction, video-frame extraction, transcoding, or Gemini-native request rewrite is performed. Original binary input bytes are preserved in Chat; the PDF keeps its full data URI, while this controlled video candidate uses raw Base64. The gateway forwards the selected envelope without a global prefix-stripping rule.

## Configure the exact model routes

Follow the README wallet/key/network setup first. Never place credentials in these examples.

1. Copy `examples/endpoint-pricing-policy.json` to `.state/endpoint-pricing-policy.json`.
2. Review the provider contracts, live healthy supply, reference cards, fee assumptions and estimates. Replace the intentionally expired timestamps with your current review time and an expiry no more than 24 hours later. Do not treat the example's source revision as proof of equality with deployed Surplus code.
3. Set these private `.env` fields:

   ```dotenv
   MODELS=gpt-4o,gemini-2.5-flash,gemini-2.5-pro
   PRICING_POLICY_FILE=.state/endpoint-pricing-policy.json
   ```

   Retain any independently reviewed `MEDIA_CONFIG_FILE` for unit-billed image/video generation; these three models belong in the token-billed `MODELS` list, not the media list. Remove routes from `modelRoutes` if removing their exact models from `MODELS`.
4. Run `npm run prices` before starting. Confirm the emitted `services` entries pin:
   - `gpt-4o` → `api.openai.com`.
   - `gemini-2.5-flash` → `generativelanguage.googleapis.com`.
   - `gemini-2.5-pro` → `aiplatform.googleapis.com`.
5. Start the seller with `npm start`; restart after configuration changes. Do not run another seller with the same identity concurrently.

The example deliberately uses different exact Gemini model identifiers for AI Studio audio and Vertex video. One exact model has one quoted endpoint in a seller. Changing an existing model's route does not preserve its previously tested input contract automatically.

A nonempty reviewed `modelRoutes` profile selects the local Surplus provider and injects its explicit protocol map even if all services are token-billed. You do not need to enable a dummy image/video service or `MEDIA_CONFIG_FILE` just to obtain the literal registered `surplus` identity. An absent or empty route map retains the legacy text-only plugin behavior. Do not weaken readiness checks to accept `openai` when they require `surplus`.

`modelRoutes` entries accept only `{ "provider", "host" }` for exact configured models and reviewed provider/hostname pairs. No wildcard, arbitrary URL, suffix, port or per-route expiry/economics override is allowed. Without an explicit Google route, Google retains the AI Studio default. Live-book pricing remains limited to the separately reviewed Groq cache-at-input policy.

### Reference estimates, not guaranteed costs

At the observed public-book check, `gpt-4o` had direct OpenAI supply but no OpenAI reference card in `/v1/prices`. The example explicitly permits a Venice reference-card fallback while retaining the actual OpenAI execution host. This is an operator-consented reference envelope, not an OpenAI tariff or an exact-offer charge ceiling. If you do not accept this fallback, remove it: the route must remain unavailable when required reference/cache evidence is missing. Never substitute zero for missing evidence.

Public supply changes. Missing/unhealthy/exhausted supply or incomplete rate evidence must leave the service unavailable. Quotes remain `guaranteedBound:false`; provider pins do not select an exact offer or guarantee profitability.

## Bounded paid checks

Use a distinct funded buyer wallet and the existing mandatory ReserveAuth budget guard. Commands without `--execute` remain offline plans; explicit execution is required for payment. Start the seller first and run shared-wallet buyers serially.

For a PDF whose visible text includes `Antseed content probe works.`, set `TEST_EXPECT_CONTAINS=Antseed content probe works.` and an explicit small `TEST_MAX_COST_USD` in the private `.env`, then:

```sh
npm run content-probe -- --kind file-input --model gpt-4o --input /absolute/path/to/fixture.pdf --execute
```

For an MP4 with an unambiguous red scene, set `TEST_EXPECT_CONTAINS=red` and the explicit budget, then:

```sh
npm run content-probe -- --kind video-input --model gemini-2.5-pro --input /absolute/path/to/red.mp4 --execute
```

The PDF command has a controlled passing public-clone record; the video-input command remains a candidate after an upstream HTTP 400, not a passing example. Read-only diagnosis identified Vertex `INVALID_ARGUMENT` rejecting the original data-URI string as invalid Base64 in `input_audio.data`; the narrowly scoped raw-Base64 correction passed parent and independent source review, but still requires paid public-clone acceptance. The original HTTP 400 attempt had zero recorded Surplus charge and a released credit hold; this does not describe the later HTTP 200 attempt's charge. Its separate native buyer reserve was subsequently [released to Deposits availability by a confirmed seller zero-close](evidence/failed-video-reserve-release.json), with operator permissions unchanged. Inputs must satisfy the existing regular-file, format and 1 MiB probe limits. An expected substring is only a bounded semantic check for a controlled known fixture; do not treat an arbitrary substring as general media-understanding certification. A failed semantic check may still incur a charge.

The raw-Base64 candidate has now been exercised once from a fresh anonymous clone: HTTP 200 and native settlement succeeded, but the expected `red` answer check failed and native metering recorded zero output tokens. See the [retained attempt](evidence/vertex-video-raw-base64-attempt.json). The read-only audit verified 168 micro-USDC captured and an explicit 60 reasoning tokens, with no remaining open reservation for this request. It could not recover the original answer or finish reason. A 64-token-cap explanation remains a hypothesis; the next scoped source candidate raises only that cap and adds bounded private diagnostics before the assertion. It is not yet a passing modality test or permission for automatic retries.

Both controlled probes reject missing, wrong or malformed quoted endpoints before buyer startup and recheck quotes immediately before dispatch. The existing exact AntSeed registered-provider/model/peer, module-version and cumulative authorization guards remain required. Confirm persisted metering, canonical channel settlement and seller payout separately from HTTP/content success. Controlled self-buyer traffic is not organic demand or actual profit.

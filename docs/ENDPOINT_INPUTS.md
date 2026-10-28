# Endpoint-specific PDF and video understanding

> PDF input and [Vertex video understanding](evidence/video-input-token-budget-acceptance.json) passed controlled paid AntSeed requests from fresh anonymous clones, with objective answers, native metering and confirmed canonical seller payouts. Overall controlled delivery coverage is **11/11**, and the [agreed seller-bridge goal is complete](evidence/integration-completion.json). Generated-video fixed-duration fidelity remains an upstream caveat outside this completion scope; it is not relabeled as conforming output or conclusively attributed to Venice. Earlier parsing and semantic failures remain separately retained. See [contract research](research/endpoint-input-contracts.md) and [current acceptance evidence](MEDIA.md#acceptance-evidence).

## Why exact endpoints matter

AI Studio and Vertex both use marketplace provider ID `google`, but their documented Chat media envelopes differ. A generic Google pin is not sufficient.

- PDF input uses OpenAI Chat `file.file_data`, pinned to `api.openai.com`.
- The controlled video-input profile uses Vertex Chat `input_audio`, with `format: "video/mp4"` and raw Base64 MP4 bytes in `data`, pinned to `aiplatform.googleapis.com`. The 1024-token profile passed a bounded paid objective test; this is scoped compatibility evidence, not a claim that Vertex universally rejects data URIs or every model/offer works.
- The existing AI Studio WAV/MP3 input keeps raw Base64 and `format: "wav"` or `"mp3"`, pinned to `generativelanguage.googleapis.com`.

No text extraction, video-frame extraction, transcoding, or Gemini-native request rewrite is performed. Original binary input bytes are preserved in Chat; the PDF keeps its full data URI, while this controlled video profile uses raw Base64. The gateway forwards the selected envelope without a global prefix-stripping rule.

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

The source-reviewed and paid-tested video-input profile requests `max_tokens: 1024` instead of 64; other controlled text/input profiles stay unchanged. Keep the seller's `MAX_OUTPUT_TOKENS` at least 1024 (the default is 4096). Its conservative local estimate reads the actual generated request cap while the cumulative ReserveAuth budget guard remains mandatory. This is a discriminating cap experiment, not proof that the previous cap caused the failure. The probe also writes bounded private `response-inspection.json` diagnostics before objective validation: recognized finish reason, original text length/hash and at most a 4096-byte UTF-8 prefix, plus allowlisted token/reasoning usage. Missing values remain unknown; raw response objects and headers are not dumped. Keep this file private and do not treat successful diagnostic persistence as modality acceptance. Parent and independent source review, publication, a fresh public clone's 692 tests and one bounded paid objective test with canonical payout passed; a new operator must still verify their own configuration and route.

```sh
npm run content-probe -- --kind video-input --model gemini-2.5-pro --input /absolute/path/to/red.mp4 --execute
```

Both commands now have controlled passing public-clone records. Historically, read-only diagnosis identified Vertex `INVALID_ARGUMENT` rejecting the original data-URI string as invalid Base64 in `input_audio.data`; the raw-Base64 correction removed that parsing error, but a subsequent 64-token attempt still failed its semantic objective. The 1024-token profile subsequently passed the original red-scene check, private response inspection, native metering and canonical payout without changing the MP4, prompt, temperature, model or route. The original HTTP 400 attempt had zero recorded Surplus charge and a released credit hold; this does not describe the later HTTP 200 attempt's charge. Its separate native buyer reserve was subsequently [released to Deposits availability by a confirmed seller zero-close](evidence/failed-video-reserve-release.json), with operator permissions unchanged. Inputs must satisfy the existing regular-file, format and 1 MiB probe limits. An expected substring is only a bounded semantic check for a controlled known fixture; do not treat an arbitrary substring as general media-understanding certification. A failed semantic check may still incur a charge.

The [retained 64-token attempt](evidence/vertex-video-raw-base64-attempt.json) remains a failure: 168 micro-USDC captured, explicit 60 reasoning tokens and zero recorded output, with no recoverable original answer or finish reason. The [latest 1024-token acceptance](evidence/video-input-token-budget-acceptance.json) returned HTTP 200, `finish_reason: stop`, the correct static red-scene answer and 61 output tokens, with an explicit 404 reasoning tokens recorded separately. Upstream credit capture was 473 micro-USDC; native settlement paid 2302 micro-USDC net and released the unspent buyer reserve. The cap experiment succeeded, but the original missing evidence prevents proof of historical cap exhaustion. Neither result permits automatic paid retries or establishes organic demand/profit.

Both controlled probes reject missing, wrong or malformed quoted endpoints before buyer startup and recheck quotes immediately before dispatch. The existing exact AntSeed registered-provider/model/peer, module-version and cumulative authorization guards remain required. Confirm persisted metering, canonical channel settlement and seller payout separately from HTTP/content success. Controlled self-buyer traffic is not organic demand or actual profit.

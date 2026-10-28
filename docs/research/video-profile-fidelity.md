# Generated-video profile fidelity: unresolved duration mismatch

This is a read-only investigation of the existing controlled paid AntSeed video run. No additional render was submitted. Delivery and cached retrieval passed; requested-duration fidelity has not passed.

## Independently rechecked artifact

Full ffmpeg decoding returned exit 0:

- Bytes: `1534746`
- SHA-256: `a811024cece251e6eb93bcb9c5ec84beb0cc5eb4e03a5a1667fe836d7c646550`
- Duration: `8.08` seconds
- Dimensions: `960 × 960`
- Decoded video frames: `202`

The request was for `5` seconds at `720p`. Square dimensions alone do not establish a resolution-tier failure: pixel count and provider interpretation must be evaluated separately. Do not crop, rescale, trim, or relabel this output as proof that the upstream honored the requested profile.

## Exact stored-job boundary

An exact-job, read-only production lookup, followed by reads of that job's stored request and retained policy pin, established:

- Job status: `succeeded`.
- Standard and provider model: `longcat-distilled-image-to-video`.
- Selected provider origin: `https://api.venice.ai/api/v1`.
- Endpoint path: `/video/generations`.
- Stored submit request explicitly contains `duration_seconds: 5`, `resolution: "720p"`, and a source image.
- Retained policy media contract declares durations `[5, 10, 15, 20, 30]` and resolutions `["720p"]`.
- Retained media adapter profile: `media:venice-video-v1`, version `1.0.0`.

Private job identifiers, metadata references, source image bytes, credential references, and provider authorization are deliberately excluded. These observations prove what Surplus persisted, not the exact outbound provider request or the provider's internal behavior.

## Immutable implementation comparison

At Surplus commit `2207d607e747f487a4d83e60c7f24ad677a55a7f`:

- `apps/serverless/media.generation/src/adapters/normalize.ts:97–104` maps stored `duration_seconds` to normalized `durationSeconds` and preserves `resolution`.
- `libs/domain.providers/src/lib/venice-video-payload.ts:61–67` builds `duration: "5s"` when supplied the observed request and declared duration contract.
- The same builder at lines `83–93` permits the explicit `resolution: "720p"` under the observed resolution contract.

This immutable source comparison does **not** establish equality with the deployed Lambda bundle and is **not** a captured outbound wire request. The existing evidence does not localize the mismatch to the provider, the deployed adapter, or artifact selection.

## Public provider contract

The [Venice Longcat Distilled page](https://venice.ai/models/longcat-distilled) lists the image-to-video variant with 5–30 second clips at 720p. That supports the intended request, but it is documentation rather than execution evidence.

## Acceptance consequence

Keep native video delivery marked as passed and duration fidelity marked unresolved. Do not silently change the requested duration or count an altered/transcoded output as acceptance. The next useful localization evidence is the deployed adapter's exact sanitized outbound parameter projection or a separately budgeted controlled comparison—not repeated uninstrumented renders. No production policy or code was changed by this investigation.

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

This immutable source comparison alone does **not** establish equality with the deployed Lambda bundle and is **not** a captured outbound wire request.

## Downloaded deployed-bundle replay

A later no-network replay used the downloaded deployed submit bundle, SHA-256 `15fb655d9707d3bd28f0e09ca122cc7210d6a06f2e2a4fa223429c48689a6a3b`, with the exact retained request and policy. AWS clients were inert and the provider transport captured a synthetic response; no real credential or paid render was used. The parent independently reran this replay with summary-file writes disabled and explicit assertions for the final submitted prompt and image.

The executed normalization, payload builder, retained request-policy transform, and actual deployed `VeniceVideoAdapter.submit()` serializer produced:

```json
{"url":"https://api.venice.ai/api/v1/video/queue","method":"POST","duration":"5s","resolution":"720p"}
```

The original prompt/image were unchanged, no request-policy adaptation occurred, and blocked network attempts remained zero. See [sanitized replay evidence](../evidence/video-profile-replay.json).

This narrows the issue beyond an immutable-source comparison, but is still **not a historical packet capture**. It does not prove provider fault or rule out historical bundle differences or artifact/job association defects. There is no demonstrated reason to change the Surplus duration mapping.

Separately, the probe's fixed-5s acceptance check had a 4.5s lower bound but no upper bound. The repaired probe rejects durations outside the inclusive 4.5–5.5s interval, preserving the existing lower bound as an explicit ±10% tolerance. Parent verification also replayed the actual previously paid 8.08s artifact: full ffmpeg decoding passed, while the corrected probe rejected its duration. See [duration acceptance evidence](../evidence/video-duration-acceptance.json). A metadata-bound regression is not a newly generated profile-conforming video.

## Public provider contract

The [Venice Longcat Distilled page](https://venice.ai/models/longcat-distilled) lists the image-to-video variant with 5–30 second clips at 720p. That supports the intended request, but it is documentation rather than execution evidence.

## Acceptance consequence and agreed scope

Keep native video delivery marked as passed and duration fidelity marked unresolved. Do not silently change the requested duration or count an altered/transcoded output as acceptance. The operator subsequently clarified that repairing this apparent upstream issue is outside the seller-bridge scope; the [integration completion record](../evidence/integration-completion.json) therefore treats it as a known caveat, not a completion blocker. The two follow-up investigations were stopped, with no further paid render authorized by that scope decision. The downloaded-bundle replay supplies the code-generated outbound projection, not historical wire evidence or conclusive provider-fault attribution. The strict duration check remains unchanged; no production policy or source code was changed to make the artifact pass.

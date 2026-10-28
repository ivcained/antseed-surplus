# Endpoint-specific file/video understanding completion

## Evidence and remaining scope

Live public-clone coverage is 9/11; PDF and video input are not yet accepted. Existing AI Studio Chat handles image/audio but the linked official Google cookbook explicitly says its OpenAI compatibility surface supports inline images/audio only, not video. PDF Chat is documented by OpenAI; Vertex separately documents generic multimodal blobs through its OpenAI-compatible Chat API. Do not conflate AI Studio and Vertex because both have marketplace provider ID `google`.

Parent independently fetched the following contracts:
- https://developers.openai.com/api/docs/guides/file-inputs.md — Chat supports PDF `file` parts with `file_data`; not external file URLs.
- https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/migrate/openai/overview — `input_audio.data` accepts URI/blob types including video; `format` supports valid MIME types.
- https://raw.githubusercontent.com/google-gemini/cookbook/main/quickstarts/Get_started_OpenAI_Compatibility.ipynb — cell 17 excludes video on AI Studio compatibility; its PDF example extracts text instead of sending a PDF.

## Task A: Explicit endpoint-specific token pricing (strict TDD)

Own `lib/pricing.mjs`, `test/pricing.test.mjs`, and new `test/provider-endpoint-compat.test.mjs`.

Preserve existing version-1 reviewed pricing policies. Add optional `modelRoutes` keyed only by configured exact text models. Each value has exactly `provider` and `host`; `provider` is one of the currently reviewed text providers plus direct OpenAI, and `host` must be the exact allowlisted hostname for that provider. Google may explicitly select `generativelanguage.googleapis.com` or `aiplatform.googleapis.com`; default Google behavior stays AI Studio when there is no explicit route. No new arbitrary host, suffix, URL, port, credential, or wildcard route is permitted.

Allow explicit reviewed OpenAI reference-envelope pricing, preserving existing economic/cache evidence requirements. Do not broaden live-book beyond the existing reviewed Groq policy. Per-model routes inherit base consent expiry/source/economics/reference rules; they cannot override these fields. Validate every route before requests and before treating an expired policy as harmless consent expiry. Filter live supply by exact provider ID AND selected hostname, then emit that exact hostname in the quote. Never derive the selected host from insertion order in a multi-host provider set.

Test mixed-model OpenAI/AI Studio/Vertex selection, no cross-host economic contamination, unhealthy/unavailable offers, malformed routes, expiry ordering, no credentials on public discovery, and unchanged native Chat body forwarding/provider overwrite at the credential-isolated gateway. Missing reference/cache evidence remains failure, not zero.

## Task B: Exact provider-bound content probes (strict TDD)

Own `lib/content-probe.mjs` and `test/content-probe.test.mjs`.

Keep PDF bytes as the existing OpenAI Chat `file.file_data` data URI, and allow the controlled PDF probe only when the quote pins `api.openai.com`. Replace the unproved `video_url` input with Vertex's documented multimodal blob envelope: `type: input_audio`, `input_audio: {format: video/mp4, data: data:video/mp4;base64,...}`. Allow the controlled video-understanding probe only when its quote pins `aiplatform.googleapis.com`. Reject mismatched/unknown hosts before buyer startup or dispatch. Preserve AI Studio audio's existing raw Base64 + wav/mp3 format; do not globally transform it. Preserve exact AntSeed registered-provider/model/peer and ReserveAuth guards.

Test exact bytes/MIME/envelope, wrong host negative controls, no conversion/transcoding/frame extraction, and existing text/image/decision/video-generation behavior.

## Task C: Endpoint-only registered-provider runtime seam (strict TDD)

The first public-clone PDF and Vertex attempts stopped before inference with `CATALOG_MISMATCH`; the installed official OpenAI plugin advertised `openai` even though configuration used `surplus`. There were zero paid gateway events. The endpoint-only quote set had no media `kind`, so runtime selection still chose the official plugin. Do not weaken the literal registered-provider guard or add a dummy media service to force plugin selection.

Own `lib/runtime.mjs` and `test/runtime.test.mjs`. For a nonempty explicitly reviewed `pricingPolicy.modelRoutes`, select the existing local Surplus provider and inject the same explicit protocol map used by media mode, even when every quote is token-billed with no `kind`. Keep existing media selection and default legacy text selection unchanged. Test both the generated config and actual prepared runtime/plugin load path, protocol map presence, exact `surplus` registration, no credential leakage, and legacy/media controls. Parent spec review and independent security/quality review must precede publication and another paid attempt.

## Task D: Generated-video duration acceptance bound (strict TDD)

A separate read-only investigation replayed the deployed Surplus submit bundle against the exact retained request/policy and captured `duration: "5s"`, `resolution: "720p"`, unchanged image/prompt, and no policy adaptation. This is deployed-code replay, not historical wire capture or proof of provider fault. Existing generated outputs remain 8.08s versus requested 5s. Independently, `inspectContentResponse` only enforces a 4.5s minimum for its fixed 5s probe and has no upper bound.

Own `lib/content-probe.mjs` and `test/content-probe.test.mjs`. Add the missing 5.5s maximum for the probe's fixed 5s request, preserving the existing 4.5s minimum (explicit ±10% acceptance tolerance). Keep metadata inspection distinct from full-frame decode and preserve profile mismatch as failure even for useful paid output. Regress both exact boundaries, just-outside values, 8.08s, nonfinite durations, and a real no-network `executeContentRequest` queue/poll/MP4 path with one queue only. Do not change request duration, trim/transcode outputs, loosen budgets/provider pins, modify gateway retrieval/billing, or make network/paid calls. Parent spec review and independent review precede publication.

## Integration and live gates

1. Parent spec review, then independent security/quality review of each task and the combined routing/input seams.
2. Verify current healthy direct supply and complete reference cards for `gpt-4o`/OpenAI and a documented Gemini Vertex model. Use a distinct exact Gemini model if preserving the current AI Studio audio model in the same seller.
3. Add sanitized endpoint-profile docs and policy example; never publish private configured policy or credential/state values.
4. Full clean-source tests; publish to existing Gitlawb repository; anonymous clone readback and documented setup.
5. Only then run one bounded controlled paid PDF call and one bounded controlled video-input call against exact declared providers, validating objective content and canonical payouts separately.
6. Retain unresolved video-generation duration fidelity and in-flight restart acceptance. Catalog health/docs alone are not live modality proof.

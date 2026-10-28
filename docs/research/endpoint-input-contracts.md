# Endpoint-specific PDF and video input contracts

This is contract and public-supply evidence, **not live paid acceptance**. Google AI Studio and Google Vertex both use marketplace provider ID `google`, but their OpenAI-compatible input contracts are not interchangeable.

## PDF: direct OpenAI Chat

[Official file-input guide](https://developers.openai.com/api/docs/guides/file-inputs.md): Chat Completions accepts PDF `file` content parts, using inline `file_data` or uploaded file IDs. External `file_url` is not supported in Chat. The existing probe shape is already appropriate for this endpoint:

```json
{"type":"file","file":{"filename":"fixture.pdf","file_data":"data:application/pdf;base64,<PDF_BYTES>"}}
```

Pin the direct upstream host `api.openai.com`, not a provider family selected only by model name. Preserve original PDF bytes; extracting text would test ordinary text instead of PDF understanding.

## Video: Google Vertex's OpenAI-compatible Chat

[Official Vertex compatibility overview](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/migrate/openai/overview) states that `input_audio.data` accepts any URI or valid blob format, including image, audio and video; `input_audio.format` accepts valid MIME types. Blob syntax is `data:<MIME-TYPE>;base64,<BASE64-ENCODED-BYTES>`.

The following original video envelope was **derived from that documented generic blob contract**, not copied from a verbatim video example. It is preserved here as the initial proposal, not a working example: the controlled paid attempt subsequently failed provider parsing.

```json
{"type":"input_audio","input_audio":{"format":"video/mp4","data":"data:video/mp4;base64,<MP4_BYTES>"}}
```

Pin `aiplatform.googleapis.com`. Retain Chat's ordinary message envelope; do not inject native Gemini `contents`/`inlineData`, transcode the video, or substitute extracted frames. The upstream Vertex model and project-scoped endpoint are the selected seller's responsibility; a host pin is not an exact seller/project/offer pin.

### Observed rejection and scoped source-correction candidate

The [retained controlled attempt](../evidence/pdf-input-and-vertex-attempt.json) returned Vertex HTTP 400 / `INVALID_ARGUMENT`: `Invalid base64-encoded blob data found in an 'input_audio' 'data' field.` The retained buyer request supplied the full MIME data URI above. This is request/log evidence, not a historical capture of every outbound provider byte or proof that Vertex rejects all data URIs.

The controlled probe now tests the smallest compatibility change: raw Base64 of the same original MP4 bytes in `input_audio.data`, with unchanged `format: "video/mp4"`, Chat envelope and exact Vertex gate. Builder and actual-builder-to-loopback-gateway regressions compare the entire envelope, strict canonical Base64 and original bytes, while preserving PDF data URIs, AI Studio audio and credential isolation. No global gateway rewrite is introduced. The [source-correction record](../evidence/vertex-video-raw-base64-candidate.json) contains parent and independent offline approval. Anonymous public-clone verification and a new bounded paid AntSeed request with objective output, native metering and canonical seller payout remain acceptance gates; offline preservation tests alone cannot establish provider compatibility.

The failed request had zero recorded Surplus charge and a released temporary credit hold. Its separate native AntSeed reserve was [subsequently released](../evidence/failed-video-reserve-release.json); cleanup is not a successful video-understanding result.

## Why the original AI Studio route is not a sufficient candidate

The [official linked Google compatibility notebook](https://github.com/google-gemini/cookbook/blob/main/quickstarts/Get_started_OpenAI_Compatibility.ipynb), cell 17, explicitly states: “The OpenAI SDK compatibility only supports inline images and audio files. For videos support, use the Gemini API's Python SDK.” The notebook's PDF example extracts text before sending it, so it is not evidence for inline PDF input. The compatibility page's cached-content video example does not establish a direct video-byte input contract.

Earlier generic upstream 502s do not retroactively prove their exact rejection reason. These documented alternatives need explicit endpoint-specific quote policy, byte-preserving tests, and paid smoke verification before they may be labeled working.

## Independently rechecked public supply snapshot

Observed `2026-10-28T18:58:24.352634+00:00`; `/v1/prices` updated `2026-10-28T18:58:24.322Z`. Each count uses exact upstream hostname, `healthy === true`, `available === true`, and non-exhausted capacity.

- [`gpt-4o`](https://api.surplusintelligence.ai/api/markets/gpt-4o), `api.openai.com`: 363 healthy/available of 384 listed offers, provider ID `openai`. Public reference card was **Venice**, not OpenAI: input 2.5, output 10, cache-read 1.25 USD/million. An explicitly reviewed Venice-reference fallback is necessary for the current estimate policy; never silently invent an OpenAI card.
- [`gemini-2.5-flash`](https://api.surplusintelligence.ai/api/markets/gemini-2.5-flash): AI Studio 150 healthy/available of 186; Vertex 2 of 5. Google reference input 0.3, output 2.5, cache-read 0.03, cache-write 0.0833 USD/million.
- [`gemini-2.5-pro`](https://api.surplusintelligence.ai/api/markets/gemini-2.5-pro): AI Studio 4 healthy/available of 9; Vertex 1 of 2. Google reference input 1.25, output 10, cache-read 0.125, cache-write 0.375 USD/million.

These are host-specific supply counts, not per-modality execution proof. A distinct Vertex model can coexist with the existing AI Studio audio model. Exact-host book filtering is required even though both Google endpoints share a provider ID.

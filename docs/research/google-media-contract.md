# Google OpenAI-compatible media: verified contract boundary

Source: <https://ai.google.dev/gemini-api/docs/openai>, **Audio understanding**. Inspected the rendered page and the code-tab `pre.textContent` examples; `innerText` alone omitted those examples.

## Confirmed documentation match

Google documents audio understanding on the OpenAI-compatible Chat endpoint at `https://generativelanguage.googleapis.com/v1beta/openai/` with a user content block shaped as:

```json
{"type":"input_audio","input_audio":{"data":"BASE64_AUDIO_BYTES","format":"wav"}}
```

The standalone `buildContentRequest('audio-input', ...)` already uses that shape. Do not change it into Gemini-native `contents` or `inlineData` merely because the selected provider is Google.

The currently rendered example names `gemini-3.8-flash`, whereas the controlled seller test selected `gemini-2.5-flash`. Documentation establishes this wire shape exists, **not** current support or successful semantic understanding for the tested model, route, account or deployed request policy.

The inspected page did not contain `video_url` or `file_data` examples. Their absence on this one page is not proof those inputs are universally unsupported; PDF and video inputs remain unverified and must not be silently rewritten into image blocks.

## Next acceptance gate

- Keep failed semantic checks as failures, including HTTP 200 responses.
- Use a generic spoken fixture without a project-specific proper noun and retain an absent-audio negative control.
- Capture bounded private diagnostics before another paid experiment: allowlisted upstream error classification for non-2xx and, if explicitly enabled for a synthetic fixture, a bounded response excerpt for semantic mismatches.
- Require exact model/peer dispatch, the existing aggregate authorization guard, local metering and canonical settlement evidence. Do not infer successful media understanding from an accepted schema or a settled charge.

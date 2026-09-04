# Providers

A provider turns a ChatInput (messages + tools) into a stream of ChatChunk.
Step 1 ships the OpenAI-compatible provider.

Files:
- src/providers/openai.ts — OpenAI chat-completions streaming (SSE)
- src/core/provider.ts — interface

## OpenAI provider

`POST {baseURL}/v1/chat/completions` with `stream: true` and
`stream_options: {"include_usage": true}` — without the second one OpenAI sends
no usage at all and every turn records zero tokens. Servers that do not know
the field ignore it. SSE lines
(`data: ...`), tool-call arguments arrive as fragments and are accumulated
per call index. Usage maps `prompt_tokens_details.cached_tokens` to
`cacheRead` and `completion_tokens_details.reasoning_tokens` to `reasoning`.

Key: passed via `Authorization: Bearer`. Environment variables used by
`src/main/index.ts`: `OPENAI_API_KEY` (required), `OPENAI_BASE_URL` and
`OPENAI_MODEL` (optional). Keys come from the environment, never the repo.
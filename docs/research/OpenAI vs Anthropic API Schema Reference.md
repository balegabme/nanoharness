## Scope and sources

This catalogs the exact request/response schemas needed to build a minimal harness for OpenAI-compatible and Anthropic-compatible chat APIs, based on official docs as of September 2026. It covers endpoints, auth, model listing, streaming, tool calling, vision, reasoning controls, usage/cache accounting, and a compatibility quirk matrix for third-party OpenAI-compatible gateways.[^1][^2][^3]

## OpenAI: endpoints and auth

OpenAI exposes two generation surfaces. `POST /v1/chat/completions` is the legacy-but-still-current message-array endpoint; `POST /v1/responses` is OpenAI's newer, recommended unified endpoint for text/tool/multimodal generation, and is what OpenAI now tells new projects to use. Both accept `model` and either `messages` (Chat Completions) or `input` (Responses). Auth for both is a bearer header: `Authorization: Bearer $OPENAI_API_KEY`, with optional `OpenAI-Organization` and `OpenAI-Project` headers for multi-org/multi-project accounts. Chat Completions also supports `GET/POST/DELETE /v1/chat/completions/{id}` for stored completions when `store: true` is set.[^4][^5][^6][^7][^1]

Model discovery uses `GET /v1/models`, returning `{"object": "list", "data": [{"id", "created", "object": "model", "owned_by", "shutdown_date"}]}`.[^8]

## Anthropic: endpoints and auth

Anthropic has a single generation endpoint, `POST /v1/messages`, plus `POST /v1/messages/count_tokens` for pre-flight token counting. Required headers are `x-api-key: $ANTHROPIC_API_KEY`, `anthropic-version: 2023-06-01`, and `Content-Type: application/json`; beta features are opt-in via `anthropic-beta` header values (e.g. `interleaved-thinking-2025-05-14`, `context-1m-2025-08-07`). Model listing is `GET /v1/models` (paginated via `before_id`/`after_id`/`limit`, default 20, max 1000), returning `{"data": [{"id", "display_name", "created_at", "max_input_tokens", "max_tokens", "capabilities": {...}, "type": "model"}], "first_id", "has_more", "last_id"}`, where `capabilities` reports per-model support for thinking, effort levels, image/PDF input, structured outputs, and context management.[^2][^9]

## Request/response schema comparison

| Aspect | OpenAI Chat Completions | OpenAI Responses | Anthropic Messages |
|---|---|---|---|
| Endpoint | POST /v1/chat/completions[^1] | POST /v1/responses[^7] | POST /v1/messages[^2] |
| Auth header | Authorization: Bearer key[^5] | Authorization: Bearer key[^7] | x-api-key + anthropic-version[^2] |
| Conversation field | messages[] (role: system/user/assistant/tool)[^10] | input[] (typed items)[^7] | messages[] (role: user/assistant only) + top-level system[^2] |
| Required fields | model, messages | model, input | model, max_tokens, messages[^11] |
| Non-stream response wrapper | object: "chat.completion", choices[].message | object: "response", output[] | type: "message", content[] |
| Tool call location | message.tool_calls[] | output[] items type "function_call"[^12] | content[] blocks type "tool_use" |

## Streaming (SSE) chunk shapes

### OpenAI Chat Completions streaming

Setting `stream: true` returns a sequence of `data: {...}` lines typed `chat.completion.chunk`, terminated by a literal `data: [DONE]` sentinel (not valid JSON). Each chunk has `choices[].delta`: the first chunk carries `delta.role: "assistant"`, subsequent chunks carry `delta.content` text fragments or `delta.tool_calls` fragments, and `finish_reason` is `null` until the terminal chunk (`"stop"`, `"tool_calls"`, `"length"`, etc.). Tool-call deltas are list-indexed: the first delta for a call carries `id`, `type: "function"`, `function.name`; subsequent deltas carry only `function.arguments` as partial JSON string fragments that must be concatenated per index and parsed once complete. With `stream_options: {"include_usage": true}`, a final chunk carries full `usage`.[^13][^14][^15][^16]

### OpenAI Responses streaming

Instead of untyped chunks ending in `[DONE]`, each SSE event carries a distinct `type` field closer to Anthropic's model: `response.created`, `response.output_item.added`, `response.output_text.delta` (text fragment in `delta`), `response.output_text.done`, `response.output_item.done`, and `response.completed`/`response.failed`/`error`. Tool-call arguments stream via `response.function_call_arguments.delta` events keyed by `output_index`, finalized on `response.function_call_arguments.done` or `response.completed`.[^13]

### Anthropic Messages streaming

Anthropic streams named SSE events (`event: <type>` plus matching `data.type`) in a strict sequence: `message_start` (Message object with empty content) → for each content block: `content_block_start`, one or more `content_block_delta`, `content_block_stop` → one or more `message_delta` (top-level stop_reason/usage updates) → `message_stop`; `ping` and `error` events can appear anywhere. `content_block_delta.delta.type` is one of: `text_delta` (`delta.text`), `input_json_delta` (`delta.partial_json`, a partial JSON string for `tool_use.input`, to be concatenated and parsed at `content_block_stop`), `thinking_delta` (`delta.thinking`), and `signature_delta` (final `delta.signature`, sent immediately before `content_block_stop` on a thinking block).[^17][^3][^18][^19]

## Tool/function-calling shapes

**OpenAI Chat Completions** request: `tools: [{"type": "function", "function": {"name", "description", "parameters": <JSON Schema>, "strict": true}}]`, with `tool_choice` as `"auto"`, `"none"`, `"required"`, or `{"type": "function", "function": {"name": ...}}`. Response carries calls in `message.tool_calls[]`, each `{"id", "type": "function", "function": {"name", "arguments": <JSON string>}}`; `finish_reason` becomes `"tool_calls"`. For Structured Outputs strict mode: every property must be `required`, `additionalProperties: false` must be set, and `$ref`/recursion are disallowed.[^20][^21]

**OpenAI Responses** uses a flatter tool schema — `name`, `description`, `parameters` sit at the top level of the tool object rather than nested under `function` — and the model emits `output[]` items of `type: "function_call"` carrying `call_id`, `name`, and JSON-encoded `arguments`; results are returned via a `function_call_output` item referencing the same `call_id`.[^12][^22]

**Anthropic Messages** request: `tools: [{"name", "description", "input_schema": <JSON Schema>}]`, with `tool_choice` as `{"type": "auto"|"any"|"tool", "name": ...}`[^2]. Response content includes a `tool_use` block: `{"type": "tool_use", "id": "toolu_...", "name", "input": <object>}`; the client replies with a user-turn `tool_result` block referencing that `id`[^2].

## Image input encoding

**OpenAI** (both endpoints) accepts an `image_url` content part: `{"type": "image_url", "image_url": {"url": <http(s) URL or base64 data URI>, "detail": "auto"|"low"|"high"}}`, where base64 images are passed as data URIs (`data:image/png;base64,<data>`) inside the same `url` field rather than a separate field[^23][^24][^25]. `detail` controls resolution/token cost trade-off: `low` fixes cost at 85 tokens on a 512x512 downscale, `high` tiles the image at higher token cost, `auto` lets the model choose[^26][^27].

**Anthropic** uses a distinct typed block: `{"type": "image", "source": {"type": "base64", "media_type": "image/jpeg"|"image/png"|"image/gif"|"image/webp", "data": <base64 string, no data-URI prefix>}}`; Anthropic also supports `source.type: "url"` for HTTP(S) images and a parallel `Base64PDFSource` for `application/pdf` documents[^2][^2].

## Reasoning controls

**OpenAI**: the `reasoning_effort` (Chat Completions) or `reasoning.effort` (Responses) parameter takes model-dependent values from `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Coverage varies sharply by family: original GPT-5 supports `minimal`/`low`/`medium`(default)/`high`; GPT-5.1 drops `minimal` and adds `none`(default); GPT-5.1-codex-max introduces `xhigh`; GPT-5.2+ keep `none`(default)/`low`/`medium`/`high`/`xhigh`; GPT-5.4 adds `xhigh` as standard; GPT-5.6 is the only family to add `max` and restores `none` as combinable with function tools on Chat Completions. O-series models (o1, o3, o3-mini, o4-mini, o1-pro, o3-pro) generally support only `low`/`medium`/`high`, with `o1-mini` supporting no `reasoning_effort` at all. Sending an unsupported value (e.g., `minimal` on GPT-5.6+) causes the API to drop or reject the field, so harnesses should gate by exact model ID via a static compatibility table rather than assuming universality.[^28][^29][^30][^31][^32]

**Anthropic**: extended thinking is enabled via `thinking: {"type": "enabled", "budget_tokens": <int>}`. The documented minimum is 1,024 tokens; there is no universal hard maximum, but `budget_tokens` must be less than `max_tokens` in standard mode (Claude 3.7 Sonnet's practical ceiling with extended output is 128,000 tokens), except under interleaved thinking with tools where the effective ceiling becomes the full context window (up to 200K tokens). Newer models (Opus 4.5+) separate a standalone `reasoning`-style effort control from `thinking.budget_tokens`, so both can be set independently.[^33][^34][^35][^36]

## Usage/token accounting and prompt caching

**OpenAI** usage object: `{"prompt_tokens", "completion_tokens", "total_tokens"}` at top level, plus a nested `prompt_tokens_details.cached_tokens` field reporting how many prompt tokens hit the automatic cache (Responses API uses `usage.input_tokens_details.cached_tokens`). Caching is fully automatic, requires no request changes, applies to prompts ≥1,024 tokens, and extends in 128-token increments (1024, 1152, 1280...); cache entries persist roughly 5–10 minutes idle and are evicted within an hour, though gpt-5.1+ non-ZDR orgs default to 24-hour retention.[^37][^38][^39]

**Anthropic** usage object: `{"input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "cache_creation": {"ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"}}`. Anthropic requires explicit opt-in via `cache_control` blocks (or automatic caching via a single top-level `cache_control` field). Placement rules: cache prefixes form in strict order `tools → system → messages`; you can mark up to 4 explicit breakpoints on individual content blocks (last tool in `tools[]`, a `system[]` text block, or the final block of `messages[].content`); a lookback window of 20 blocks is checked per breakpoint; minimum cacheable length is model-dependent (512–4,096 tokens); default TTL is 5 minutes, with an optional 1-hour TTL at 2x base write cost via `cache_control: {"type": "ephemeral", "ttl": "1h"}`. Thinking blocks cannot carry `cache_control` directly but are cached incidentally as part of surrounding content on tool-use turns.[^1]

## Integration Checklist 1: OpenAI-compatible harness

- [ ] Base URL `https://api.openai.com/v1`; header `Authorization: Bearer $OPENAI_API_KEY` (+ optional `OpenAI-Organization`, `OpenAI-Project`)[^5][^6]
- [ ] Choose endpoint: `/v1/chat/completions` for broad SDK/tool compatibility, or `/v1/responses` for native structured multimodal/tool-loop support and stateful conversation IDs[^7][^1]
- [ ] Model discovery via `GET /v1/models`; parse `data[].id` for the exact model string to send back in requests[^8]
- [ ] Build `messages[]` with `role` in `system|user|assistant|tool`; for tool replies, use `role: "tool"` with `tool_call_id` (Chat Completions) or a `function_call_output` item keyed on `call_id` (Responses)[^10][^12]
- [ ] Implement SSE parser: accumulate `delta.content` (text) and `delta.tool_calls[].function.arguments` (by index) until `finish_reason` is set; stop on literal `[DONE]` line (Chat Completions) or `response.completed`/`response.failed` event (Responses)[^14][^13]
- [ ] Tool schema: Chat Completions nests under `function`; Responses is flat (`name`/`parameters` top-level) — do not reuse the same tool object across both endpoints without transformation[^22][^12]
- [ ] Vision: embed images as `{"type": "image_url", "image_url": {"url": "data:<mime>;base64,<data>", "detail": "auto|low|high"}}`; default to `low` for cost-sensitive high-volume calls[^23][^26]
- [ ] Reasoning: maintain a per-model-ID allow-list of valid `reasoning_effort` values (do not assume `minimal`/`none`/`xhigh`/`max` are universally accepted — many combinations 400 or are silently dropped)[^31][^32][^28]
- [ ] Usage/cost tracking: read `usage.prompt_tokens_details.cached_tokens` for cache hits; caching is automatic and requires prompts ≥1,024 tokens with no client-side flag[^38][^37]
- [ ] Error handling: gracefully handle 400s from unsupported params, since many gateways silently drop or hard-error on OpenAI fields not in their subset[^40][^41]

## Integration Checklist 2: Anthropic-compatible harness

- [ ] Base URL `https://api.anthropic.com/v1`; headers `x-api-key: $ANTHROPIC_API_KEY`, `anthropic-version: 2023-06-01`, `Content-Type: application/json`; add `anthropic-beta` for opt-in features[^9][^2]
- [ ] Endpoint: `POST /v1/messages`; required body fields are `model`, `max_tokens`, `messages[]`; system prompt is a top-level `system` field/array, never a message entry[^11][^2]
- [ ] Model discovery via `GET /v1/models` (paginated with `before_id`/`after_id`/`limit`); inspect `data[].capabilities` to detect per-model support for thinking, effort levels, and multimodal input before sending requests[^9]
- [ ] Content blocks: `text`, `image` (`source.type: "base64"`, `media_type`, `data` — no data-URI prefix), `document` (PDF via `Base64PDFSource`), `tool_use`, `tool_result`[^2]
- [ ] Tool schema: `tools: [{"name", "description", "input_schema"}]`; `tool_choice: {"type": "auto"|"any"|"tool", "name"}`; parse `content[]` for `tool_use` blocks and reply with a `tool_result` block referencing the same `id`[^2]
- [ ] SSE parser: handle named events in strict order — `message_start` → (`content_block_start`, N×`content_block_delta`, `content_block_stop`) per block → `message_delta` → `message_stop`; also handle `ping` and `error` events at any point[^3][^18]
- [ ] Delta types: `text_delta.text`, `input_json_delta.partial_json` (concatenate then parse at `content_block_stop`), `thinking_delta.thinking`, `signature_delta.signature` (arrives just before `content_block_stop` on thinking blocks)[^19][^17]
- [ ] Reasoning: to enable, send `thinking: {"type": "enabled", "budget_tokens": N}` with N ≥ 1024 and (in non-interleaved mode) N < `max_tokens`; start at the 1,024 minimum and tune upward[^34][^33]
- [ ] Prompt caching: place `cache_control: {"type": "ephemeral"}` (optionally `"ttl": "1h"`) on the last block of a stable prefix, respecting cache order `tools → system → messages`, max 4 explicit breakpoints, 20-block lookback window[^1]
- [ ] Usage tracking: read `usage.cache_creation_input_tokens` and `usage.cache_read_input_tokens`; both being 0 means the prompt was not cached (often because it's below the model's minimum cacheable length)[^1]

## Quirk matrix: third-party OpenAI-compatible endpoints

| Provider | Endpoint base | Reasoning param | Tool calling | Vision/images | Notable dropped/altered params |
|---|---|---|---|---|---|
| OpenRouter | api-compatible, unified `reasoning` object | Normalizes to unified `reasoning: {effort\|max_tokens}`; also accepts OpenAI-style `reasoning_effort`; some upstreams (Gemini) get remapped, losing native params like `thinking_level`[^42][^43][^44] | Passes through OpenAI tool schema; supports `reasoning_details` for cross-provider reasoning continuity[^43] | Standard `image_url` content parts; adds non-standard `detail: "original"` extension[^45] | Omits absent sampling params rather than substituting defaults, so provider-side defaults apply silently[^42] |
| Groq | `https://api.groq.com/openai/v1` | Supports standard `reasoning_effort` string[^46] | Full OpenAI tool schema support | **No image input support at all** (URL or base64) — errors if attempted[^46] | Errors 400 on `logprobs`, `logit_bias`, `top_logprobs`, `messages[].name`, `n≠1`; silently drops `prompt_cache_key`, `verbosity`, `store`, `service_tier`; `temperature: 0` is silently converted to `1e-8`[^47][^46][^48] |
| Together AI | `https://api.together.ai/v1` | Not standardized; model-dependent | Full OpenAI `tools`/`tool_choice` schema, incl. `strict` mode[^21] | Vision supported per-model | `service_tier`, `store`, `metadata`, `prediction` accepted but silently ignored (no error, no effect); `assistants.*`/`threads.*`/OpenAI-shape fine-tuning unsupported[^40] |
| vLLM (self-hosted) | user-defined, `/v1/chat/completions`, `/v1/responses` | Requires explicit server flags: `--reasoning-parser {deepseek_r1,granite,qwen3}`; not a request-time toggle — behavior is fixed by deployment config[^49][^50] | Requires `--enable-auto-tool-choice --tool-call-parser <parser>` at server startup; model-specific chat templates often required (e.g., Mistral, Hermes)[^51][^50] | Model-dependent; no universal guarantee | `user` param silently ignored; `suffix` unsupported on completions; `parallel_tool_calls: false` caps output to 0–1 tool calls, `true` allows more but isn't guaranteed model-dependent[^50] |
| Ollama | `http://localhost:11434/v1` | Supports `reasoning_effort`/`reasoning`/`effort` with values `high/medium/low/max/none` for thinking-capable models[^52][^53] | `tools` supported; **`tool_choice` explicitly unsupported** — no way to force/forbid a specific tool[^53][^52] | Base64 image content supported; **image URL NOT supported** — must pre-fetch and base64-encode[^52][^54] | No `logprobs`, `logit_bias`, `user`, `n`; `prompt_cache_key`, `verbosity`, `store`, `service_tier` dropped for compatibility layers[^41][^52] |

**Key takeaway:** do not treat `reasoning_effort` or `tool_choice` as universally portable — OpenAI's own family-by-family support matrix varies release to release, and gateways like Ollama and vLLM either drop `tool_choice` outright or require build-time server flags rather than accepting it as a request parameter.

---

## References

1. [Chat Completions | OpenAI API Reference](https://platform.openai.com/docs/api-reference/chat)

2. [CLASP/docs/api-reference/anthropic-messages.md at main - GitHub](https://github.com/jedarden/CLASP/blob/main/docs/api-reference/anthropic-messages.md) - Run Claude Code with any LLM provider — drop-in proxy for OpenAI, Gemini, and more. Go. - jedarden/C...

3. [Streaming Messages - Anthropic](https://docs.anthropic.com/en/api/messages-streaming?debug_url=1&debug=1&debug=true)

4. [ChatCompletions](https://platform.openai.com/docs/api-reference/chat/object) - Complete reference documentation for the OpenAI API, including examples and code snippets for our en...

5. [API key authentication - OpenAI Platform](https://platform.openai.com/docs/api-reference/authentication) - Complete reference documentation for the OpenAI API, including examples and code snippets for our en...

6. [OpenAI Platform](https://platform.openai.com/docs/api-reference/api-keys) - Explore developer resources, tutorials, API docs, and dynamic examples to get the most out of OpenAI...

7. [Responses | OpenAI API Reference](https://developers.openai.com/api/reference/python/resources/responses)

8. [List models | OpenAI API Reference](https://developers.openai.com/api/reference/resources/models/methods/list/) - Lists the currently available models, and provides basic information about each one such as the owne...

9. [Budget tokens (thinking.budget_tokens) parameter — defaults ...](https://modelparams.dev/parameters/thinking-budget_tokens) - Budget tokens (thinking.budget_tokens) is an LLM reasoning parameter. Compare its type, default, and...

10. [/v1/chat/completions - docs.apigo.ai](https://docs.apigo.ai/en/api-reference/endpoints/openai/chat-completions)

11. [Anthropic Messages API Documentation: Real Examples 2026](https://tokenmix.ai/blog/anthropic-messages-api-documentation-examples-2026) - Anthropic Messages API documentation 2026: full request/response schema, rate limits, max tokens, st...

12. [Function calling | OpenAI API](https://developers.openai.com/api/docs/guides/function-calling) - Learn how function calling enables large language models to connect to external data and systems.

13. [Streaming Responses for Agents - ChangeGamer](https://changegamer.ai/resources/streaming-for-agents) - Transport formats, provider event schemas, and practical concerns for consuming streamed LLM respons...

14. [Streaming | AICredits Docs](https://aicredits.in/docs/streaming) - Stream LLM responses in real time using Server-Sent Events (SSE). Full OpenAI-compatible streaming a...

15. [OpenAI Chat - AIsa](https://aisa.one/docs/api-reference/chat/createchatcompletion)

16. [Streaming Architecture | jamesrochabrun/SwiftOpenAI | DeepWiki](https://deepwiki.com/jamesrochabrun/SwiftOpenAI/6.2-streaming-architecture) - This document provides a comprehensive technical overview of the streaming architecture in SwiftOpen...

17. [Messages en streaming - Anthropic](https://docs.anthropic.com/fr/api/messages-streaming)

18. [Anthropic Asyncapi | APIs.io AsyncAPI](https://apis.io/asyncapis/anthropic/anthropic-asyncapi/) - Anthropic Messages Streaming API is an event-driven AsyncAPI specification published by Anthropic on...

19. [Thinking - Claude Platform Docs](https://platform.claude.com/docs/en/build-with-claude/thinking) - Understand how Claude's thinking works: turn it on, read thinking output, steer thinking depth with ...

20. [OpenAI Function Calling: The Complete Guide to Structured ...](https://jsonkit.co/blog/openai-function-calling-guide/) - Everything you need to know about OpenAI function calling and Structured Outputs in 2026 — schemas, ...

21. [Function calling best practices](https://docs.together.ai/docs/inference/function-calling/best-practices)

22. [Responses API Function Calling Tool Specs vs Completions API](https://community.openai.com/t/responses-api-function-calling-tool-specs-vs-completions-api/1324866) - So, I have been using a tool spec format for Completions API whihc works fantastical, but is throwin...

23. [Create chat completion | OpenAI API Reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)

24. [content "type"/"image_url"/"detail": "high" property - API](https://community.openai.com/t/missing-reference-in-chat-completions-api-content-type-image-url-detail-high-property/902959) - Hi all, I’m following this cookbook - h*tps://cookbook.openai.com/examples/data_extraction_transform...

25. [openai-python/src/openai/types/chat/chat_completion_content_part_image_param.py at main · openai/openai-python](https://github.com/openai/openai-python/blob/main/src/openai/types/chat/chat_completion_content_part_image_param.py) - The official Python library for the OpenAI API. Contribute to openai/openai-python development by cr...

26. [[Responses API] GPT 5 ignores the detail parameter on ...](https://community.openai.com/t/responses-api-gpt-5-ignores-the-detail-parameter-on-image-inputs/1344058) - Since yesterday it seems that the “gpt-5” model ignores setting “detail”: “low” on the input_image c...

27. [How to use vision-enabled chat models - Azure OpenAI in Azure AI Foundry Models](https://learn.microsoft.com/nb-no/azure/ai-foundry/openai/how-to/gpt-with-vision?tabs=rest) - Learn how to use vision-enabled chat models in Azure OpenAI, including how to call the Chat Completi...

28. [Azure OpenAI reasoning models - GPT-5 series, o3-mini ...](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/reasoning) - The reasoning_effort parameter tells the model how much to think before it answers. Supported values...

29. [Reasoning models | OpenAI API](https://developers.openai.com/api/docs/guides/reasoning) - Learn how to use OpenAI reasoning models in the Responses API, choose a reasoning effort, manage rea...

30. [Using GPT-5.4 | OpenAI API](https://platform.openai.com/docs/guides/latest-model) - Learn about how to use and migrate to GPT-5.4 and the GPT-5 model family, the latest models in the O...

31. [OpenAI | Docker Docs](https://docs.docker.com/ai/docker-agent/providers/openai/) - Use GPT-5.6, GPT-4o, GPT-5, GPT-5-mini, and other OpenAI models with Docker Agent.

32. [Reasoning Effort & Sampling Parameters across GPT-5 ...](https://community.openai.com/t/request-for-compatibility-matrix-reasoning-effort-sampling-parameters-across-gpt-5-series/1371738) - Is there a definitive table that outlines the support for reasoning_effort levels across various mod...

33. [Разработка с расширенным мышлением - Anthropic](https://docs.anthropic.com/ru/docs/build-with-claude/extended-thinking)

34. [Extended thinking](https://docs.aws.amazon.com/he_il/bedrock/latest/userguide/claude-messages-extended-thinking.html) - Learn how to use Anthropic Claude's extended thinking capabilities for complex reasoning tasks, with...

35. [ThinkingSettings](https://docs.ascend.io/reference/resource/thinking-settings/) - Settings for extended thinking in Anthropic models.

36. [Claude 3.7 Sonnet, extended thinking and long output, llm- ...](https://simonwillison.net/2025/Feb/25/llm-anthropic-014/) - The budget_tokens defines how many tokens Claude can spend “thinking” about your prompt. 1,024 is th...

37. [Prompt caching - OpenAI API](https://platform.openai.com/docs/guides/prompt-caching/how-it-works) - Learn how prompt caching reduces latency and cost for long prompts in OpenAI's API.

38. [OpenAI Prompt Caching Billing Guide - API易文档中心](https://docs.apiyi.com/en/api-capabilities/openai/prompt-caching)

39. [Prompt Caching in the API - OpenAI](https://openai.com/index/api-prompt-caching/) - Offering automatic discounts on inputs that the model has recently seen

40. [OpenAI compatibility](https://docs.together.ai/docs/inference/openai-compatibility)

41. [Ollama - Bifrost](https://docs.getbifrost.ai/providers/supported-providers/ollama)

42. [API Parameters - Complete Guide to Request Configuration](https://openrouter.ai/docs/api_reference/parameters) - Controls reasoning behavior for models that support thinking tokens, including whether reasoning is ...

43. [Reasoning Tokens - Improve AI Model Decision Making](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens) - OpenRouter normalizes the different ways of customizing the amount of reasoning tokens that the mode...

44. [[BUG] Gemini 3 Pro on OpenRouter: No thinking_level ...](https://github.com/enricoros/big-AGI/issues/893) - OpenRouter doesn't support the native Gemini thinking parameters; OpenRouter uses its own reasoning ...

45. [Create a chat completion - OpenRouter | Documentation](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion)

46. [Groq - Bifrost](https://docs.getbifrost.ai/providers/supported-providers/groq)

47. [OpenAI Compatibility - GroqDocs](https://console.groq.com/docs/openai) - Learn how to use OpenAI's client libraries with Groq API, including configuration, supported feature...

48. [Use Groq GPT-OSS 120B with the OpenAI SDK - Claude5](https://claude5.net/blog/groq-gpt-oss-120b-openai-sdk-base-url-pricing-guide) - Swap one OpenAI SDK base URL to run GPT-OSS 120B on Groq, estimate cached token costs, and avoid too...

49. [OpenAI-Compatible Server — vLLM](https://docs.vllm.ai/en/v0.8.3/serving/openai_compatible_server.html)

50. [OpenAI-Compatible Server - vLLM docs](https://docs.vllm.ai/en/latest/serving/online_serving/openai_compatible_server/)

51. [OpenAI Chat Completion Client With Tools - vLLM](https://docs.vllm.ai/en/v0.6.1/getting_started/examples/openai_chat_completion_client_with_tools.html)

52. [docs.ollama.com](https://docs.ollama.com/llms-full.txt)

53. [Ollama's OpenAI-Compatible Endpoint in Practice](https://computefit.dev/ollama-openai-compatible-endpoint/) - Ollama v1 explained for agent-framework users: which OpenAI request fields are actually honored, too...

54. [OpenAI Compatibility - Ollama English Documentation](https://ollama.readthedocs.io/en/openai/) - ollama 的中英文文档，中文文档由 llamafactory.cn 翻译


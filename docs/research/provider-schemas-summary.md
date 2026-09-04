I've put together the full schema catalog and quirk matrix as a research report. It covers:

- **Endpoints & auth**: `/v1/chat/completions` vs `/v1/responses` vs Anthropic's single `/v1/messages`, plus their respective bearer/`x-api-key` header requirements and model-listing shapes.
- **Streaming**: exact SSE event sequences for both — OpenAI's untyped `chat.completion.chunk` + `[DONE]` sentinel vs the Responses API's typed `response.*` events vs Anthropic's `message_start → content_block_* → message_delta → message_stop` flow, including tool-call/thinking delta accumulation rules.
- **Tool calling**: the nested (`function.*`) vs flat (Responses) vs Anthropic's `tool_use`/`tool_result` block shapes.
- **Vision**: OpenAI's `image_url` data-URI approach vs Anthropic's typed `source.base64` blocks.
- **Reasoning controls**: the model-by-model `reasoning_effort` support matrix across GPT-5.x/o-series, and Anthropic's `thinking.budget_tokens` min (1,024) and practical ceilings.
- **Usage/caching**: exact field names for cached-token accounting on both sides, and Anthropic's cache_control placement/ordering rules vs OpenAI's fully automatic caching.
- **Quirk matrix**: OpenRouter, Groq, Together, vLLM, and Ollama — what each drops, errors on, or requires special server config for.

Two integration checklists and the quirk matrix table are included at the end for direct use by a coding agent implementing the harness.
Here's the evidence-ranked catalog of token-saving techniques for nanoharness's harness layer, covering all 10 requested areas plus counter-evidence.

**Key findings worth highlighting:**

- **Prompt caching is the single biggest lever** — Anthropic offers a flat 90% discount on cache reads (with a 1.25–2x write premium), and OpenAI's newest models (GPT-5.4+) now match that 90% discount, up from 50% on older models. Both are strict byte-prefix matches, so cache invalidation from stray timestamps, reordered tool schemas, or mid-session tool-set changes is the most common silent cost leak.
- **Subagents are a double-edged sword**: they can burn 15x more tokens than single-agent sessions because each spawns a fresh, uncached context — unless structured as cache-inheriting clones rather than distinct `subagent_type`s. Best reserved for genuinely parallel, independent work.
- **Code-execution/programmatic tool calling for your MCP (Tavily) integration** is unusually cheap to adopt given nanoharness already has a `bash` tool — Anthropic, Cloudflare, and independent replications all show 78–99.9% token reductions by wrapping MCP tools as code APIs instead of flat schemas.
- **Terse-output prompting is overhyped**: a viral benchmark claimed 65% output-token savings, but an independent 86-task replication found only ~8.5% — a caution against trusting small-benchmark claims without your own eval harness.
- **File-reading and edit-format economics** matter more than expected: search/replace edits beat full-file rewrites by 3.5–6.5x on realistic multi-change tasks, with the crossover point around 300–400 lines.

The report includes a ranked top-10 subset for v1 with rationale and expected combined savings — caching infrastructure, measurement instrumentation, and file-read discipline top the list as foundational, cheap-to-build wins that everything else compounds on.
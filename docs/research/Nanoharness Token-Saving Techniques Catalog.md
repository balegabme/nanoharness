## Scope and Method

This catalog covers harness-layer (not model-layer) token-saving techniques for a minimal TypeScript coding harness ("nanoharness") running planner/builder/harness-editor agents against OpenAI-compatible and Anthropic-compatible providers, with bash/read/write/web tools via MCP. Each entry states mechanism, quantified or flagged-estimate savings, implementation cost, risks, and provider notes, drawn from primary provider docs and measured engineering reports.

## 1. Prompt Caching

### 1.1 Anthropic `cache_control` breakpoints

**Mechanism:** Mark up to 4 content blocks (system, tools, or message content) with `cache_control: {type: "ephemeral"}`. Render order is tools → system → messages; a breakpoint on the last system block caches both tools and system together. On an exact-byte prefix match, Anthropic serves cached KV state instead of recomputing.[^1][^2]

**Savings:** Cache writes cost 1.25x base input (5-min TTL) or 2x (1-hour TTL); cache reads cost 0.1x base input — a 90% discount. Break-even is one cache hit for a 5-minute write, two hits for a 1-hour write. Combined with Batch API, discounts can reach ~95%.[^3][^4][^5][^6]

**Implementation cost:** Low — add `cache_control` fields; requires prompt-assembly refactor to guarantee byte-stable prefixes.

**Risks/failure modes:** A single byte difference anywhere in the prefix (reordered JSON key, timestamp, different tool) invalidates the cache for everything at or after that position. Minimum cacheable length varies by model: 1024 tokens (Sonnet 4.5/4.1, Haiku 3/3.5, Sonnet 4.6), 2048 tokens (Sonnet 4.6/Haiku 3.5 per some docs), 4096 tokens (Opus 4.5+, Haiku 4.5). Default TTL is only 5 minutes, refreshed on each hit; idle sessions lose the cache.[^2][^7][^3]

**Provider notes:** Anthropic requires explicit breakpoints (opt-in); OpenAI is automatic (see 1.2). Anthropic's discount converged with OpenAI's newest models at 90% for cache reads as of 2026.[^8]

### 1.2 OpenAI automatic caching

**Mechanism:** Fully automatic — no code changes. Caching activates for prompts ≥1024 tokens; the API matches the longest previously-cached prefix, working backward through eligible breakpoints, in 128-token increments. Static content (instructions, tool defs) must precede variable content for cache hits.[^9][^10][^11]

**Savings:** Historically a 50% discount on cached input tokens for GPT-4o/4.1-era models; the newest GPT-5.4/5.5-class models now offer a 90% discount matching Anthropic. Reported latency reduction up to 80% on cache hits.[^12][^10][^8]

**Implementation cost:** Near zero — architectural discipline only (stable prefix ordering); monitor `usage.prompt_tokens_details.cached_tokens`.[^13][^14]

**Risks/failure modes:** Cache-miss silently reverts to full price with no error; infrequently-used prompts get evicted automatically. Cache typically clears after 5–10 minutes idle, always within 1 hour; extended retention up to 24 hours available on some models.[^10][^14][^9]

**Provider notes:** OpenAI's minimum cacheable length is model-dependent: 1024 tokens for GPT-5.6+, 2048 tokens for older models.[^11]

### 1.3 What invalidates caches — cross-provider

Both providers key on exact-byte prefix match. Confirmed invalidators: tool-schema edits/reordering, system-prompt text changes (including injected timestamps/UUIDs), reordered JSON keys, and — per Anthropic's own engineering skill docs — any per-request random ID interpolated into the prefix. The fix pattern: classify every prompt input by stability (never-changes / per-session / per-turn / per-request) and place volatile fields strictly after the last breakpoint.[^2]

## 2. Context Management

### 2.1 Auto-compaction (full, model-driven summarization)

**Mechanism:** When token usage nears the context limit, older messages are summarized into a compact block and dropped from context; Anthropic's Messages API now supports this natively via `context_management.edits` with `compact_20260112` strategy and an `input_tokens` trigger (minimum 50,000 tokens). Claude Code implements a three-tier system: microcompaction → session-memory compaction (zero-API-cost) → full API-based compaction.[^15][^16]

**Savings:** Not independently quantified for generic tasks, but enables indefinite session length without hitting hard context ceilings; Claude Code triggers full compaction only when reserved headroom (~13K-token buffer under a 20K reserved-summary budget on a 200K model) is breached.[^17][^15]

**Implementation cost:** Medium — requires a summarization prompt, a trigger policy, and careful selection of what to preserve (recent files, todos, continuation instructions).[^18]

**Risks:** Over-aggressive or poorly-scoped summarization can lose task state (see Section 10); full compaction is API-billed (an extra model call) unless using the zero-cost session-memory variant.[^15]

### 2.2 Microcompaction

**Mechanism:** Lightweight, continuous trimming that runs before full compaction is needed. Two modes: time-based (content-clears all but the most recent N compactable tool results) and cache-aware (uses `cache_edits` to strip old tool results from the cached prefix without invalidating the cache — the cheapest possible compression). Applies only to compactable tool types: file read, bash, grep, glob, web search/fetch, edit, write.[^19][^15]

**Savings:** Runs "before full compaction is needed," reducing the frequency and size of expensive full-compaction calls; specific token numbers are not published by Anthropic but the mechanism is described as the cheapest possible compression path.[^15]

**Implementation cost:** Medium-high — requires tracking a "hot tail" of recent tool results kept fully visible vs. "cold storage" referenced by path.[^18]

**Risks:** If stale-result eviction removes content the agent still needs (e.g., a file it will edit again), it must re-read, costing tokens back.

### 2.3 Hierarchical summarization / turn truncation

**Mechanism:** Replace old turns with progressively coarser summaries rather than deleting outright; Claude Code preserves system prompt, most recent N messages, and pinned context explicitly during `autoCompact()`.[^20]

**Implementation cost:** Medium. **Risk:** compounding summarization errors across many compaction cycles can drift from ground truth.

### 2.4 Academic context-compression results (agent-specific)

Three peer-reviewed/arXiv systems give quantified, task-verified compression:
- **ACON** (Microsoft): reduces peak token usage 26–54% while improving task success on AppWorld, OfficeBench, and multi-objective QA by optimizing compression guidelines in natural language space and distilling the compressor into smaller models.[^21]
- **SWE-Pruner**: 23–54% token reduction on SWE-Bench Verified-style coding-agent tasks, up to 14.8x compression in some cases, while maintaining comparable success rates.[^22]
- **Focus** (Active Context Compression, arXiv 2601.07190): agent-driven consolidation + pruning achieves 22.7% token reduction (14.9M→11.5M tokens) with identical accuracy on SWE-bench Lite using Claude Haiku 4.5, with per-instance savings up to 57%.[^23]
- **TACO**: self-evolving compression rules cut token overhead ~10% on terminal-agent benchmarks while improving accuracy 1–4%.[^24]

These all point to the same conclusion for nanoharness: verified, task-outcome-preserving compression in the 20–50% range is achievable, but requires evaluation harnesses to confirm no accuracy regression (see Section 9).

## 3. File-Reading Economics

**Mechanism:** Default file reads should be capped (Claude Code caps at 2,000 lines / 2,000 chars per line, plus a 256KB pre-read size gate). Agents should measure size first (`wc -l`), locate targets via `grep -n`, then read only the needed range via `offset`/`limit`. Claude Code deliberately throws an error rather than silently truncating past the size gate — a reverted truncation path produced ~25K-token wasted responses vs. a ~100-byte error.[^25][^26][^27][^28]

**Savings:** Not separately quantified, but the mechanism prevents worst-case full-file reads on multi-thousand-line files from consuming tens of thousands of tokens; a 10,000-line document can be handled in ~230 total tokens (30 tokens of grep output + 200 lines of targeted read) versus reading the whole file.[^27]

**Implementation cost:** Low — implement `offset`/`limit` params on the read tool (nanoharness's `read` tool should mirror this); add a pre-check size gate.

**Risks/failure modes:** Silent truncation without clear signaling causes agents to hallucinate unseen content or miss guardrails embedded later in a file — a documented Claude Code bug class where truncated previews were treated as complete. Always surface an explicit "truncated, use offset=N to continue" marker.[^29][^30][^31][^25]

### 3.1 Line-anchored patches vs. full rewrites

**Mechanism/data:** Independent benchmarking of 5 file-editing strategies on a 1,053-line file with 10 changes found: script generation 7,000 tokens/10s, unified diff 8,500 tokens/12s, sequential/bottom-up edit 25,000 tokens/65s, atomic (full) rewrite 43,000 tokens/50s. Script generation was 3.5x cheaper and 6.5x faster than sequential edit on the same task.[^32]

A separate breakeven analysis puts the crossover around ~400 lines: below that, full-file rewrites have higher apply-success and the extra token cost is small enough that reliability wins; above it, diff/search-replace format wins on token economics despite a 20–30% higher patch-failure rate. Function-level benchmarks (arXiv 2604.27296) show full rewrite is cheapest for 50–60% of small edits, while a structure-aware diff (AdaEdit) cuts cost/latency >30% versus full rewrite on edits >300 tokens while matching accuracy.[^33][^34][^35]

**Recommendation for nanoharness:** Use `str_replace`-style search/replace blocks (Claude Code's `str_replace_based_edit_tool` pattern) as default for the builder agent; fall back to full rewrite only for small files (<~300–400 lines).

**Implementation cost:** Medium — requires reliable anchor-matching and a retry-with-more-context path when anchors aren't unique.

**Risks:** Search/replace fails silently or ambiguously when anchor text isn't unique in the file; diffs can mis-locate if the model's memory of file state has drifted (stale-read problem, see snapshot tags below).

### 3.2 Snapshot tags to avoid re-reads after edits

**Mechanism:** After a write/edit, cache a hash or version tag of the resulting file content so the agent's own memory of the file (already in context from the write call's echoed diff) is trusted without a fresh read. This avoids a redundant `read` call purely to "confirm" a write that succeeded.

**Implementation cost:** Low — track `{path: contentHash}` in harness state; invalidate on any external file change (detected via mtime/hash check before next tool use).

**Risk:** If external processes modify files outside the harness (e.g., linters, formatters, git hooks), stale snapshot tags cause the agent to operate on outdated assumptions — must re-validate hash before trusting cached content.

## 4. Subagent / Offload Patterns

**Mechanism:** Delegate exploration (large file reads, broad greps, web research) to a subagent that returns a compressed summary rather than raw output flowing into the main context.

**Quantified costs and break-even:**
- Subagents do not inherit the parent's context or prompt cache; each spins up a fresh context window with its own system prompt and tool schemas, paying full uncached price for everything.[^36][^37][^38]
- Subagent-heavy sessions can represent up to 85% of total token bill; multi-agent systems overall can consume ~15x more tokens than a single-agent chat.[^39][^36]
- **Critical distinction — three delegation patterns ranked by cost**:[^39]
  1. Custom `subagent_type` (distinct system prompt/tools): no cache sharing with parent, full price every spawn — most expensive, use only when isolation is essential.
  2. Clone that inherits the parent's exact prompt/tools/history: clones 2 through N can hit the parent's cache at ~10% rate — e.g., 5 clones reading files in parallel run ~5x faster at only ~1.5x cost.
  3. No subagent (stay in main agent): cheapest per-turn; best for tightly sequential/dependent work (refactoring, bug fixes) where step N depends on step N−1.[^39]
- Breaking tightly-coupled sequential work into subagents can inflate costs 15x with zero benefit.[^39]

**When subagent overhead exceeds savings:** When the restated system prompt + tool schemas for the subagent are comparable in size to what would have been read directly, or when the task is sequential/dependent (each step needs the prior step's live context) rather than genuinely parallel/independent.[^37][^39]

**Mitigation:** Route worker subagents to cheaper models (Haiku-class) while keeping the planner on a frontier model — reported as the single biggest cost lever, "close to 5x on routine tasks". Scope each subagent narrowly (point at specific files, not "the codebase").[^40][^36][^37]

**Implementation cost:** Medium — nanoharness must decide per-task whether to spawn a fresh-context subagent, a cache-sharing clone, or keep work in the main agent loop.

## 5. System-Prompt & Tool-Schema Diet

**Mechanism:** Minimize tool JSON schema size (short names/descriptions, flattened parameters, fewer enums), and dynamically load only the tool subset relevant to the current agent/phase.

**Quantified overhead:** A typical 5-tool schema set costs ~445–535 tokens total overhead across models (≈90–107 tokens/tool) at baseline verbosity. Structured-output/tool-calling schemas in production extraction tasks commonly run 300–1,800 tokens for schema alone, plus 300–1,500 tokens per tool definition. At scale (12 tools × 3,000 tokens, 1M requests/month) this becomes a large recurring "invisible tax" that grows linearly with tool count and traffic.[^41][^42][^43]

**Progressive disclosure — Tool Search Tool (Anthropic):** Marking infrequently-used tools with `defer_loading: true` excludes them from initial context; Claude discovers them on-demand via a search tool, yielding an ~85% reduction in tool-definition tokens in Anthropic's benchmark (77K→8.7K tokens).[^44][^45]

**Dynamic tool subsets and cache impact:** Because caches are keyed on exact byte prefixes and tools render first (before system, before messages), switching which tools are loaded between calls invalidates the cached prefix for everything after it. This is a direct tension: dynamic tool subsets save schema tokens per call but can destroy cache-hit rates if the subset changes mid-session. Anthropic's advice: batch tool availability decisions at session start; avoid mid-session tool-set changes.[^2][^39]

**Implementation cost:** Low (schema minimization) to medium (progressive disclosure / on-demand tool loading via a search-tool pattern).

**Risks:** Overly terse tool descriptions increase misuse/hallucinated-parameter rates (accuracy risk); dynamic tool sets that change per-turn will "cache-thrash" and negate caching savings entirely (see Section 10).

## 6. Output-Side Controls

### 6.1 Max-token budgets & reasoning effort

**Mechanism:** OpenAI's `reasoning.effort` parameter (`none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`) controls internal reasoning-token spend; reasoning tokens are billed and count toward context even though invisible in the response.[^46][^47][^48]

**Quantified cost/quality curve** (GPT-5.5-class, 200 math word problems):[^46]

| Effort | Accuracy | Avg reasoning tokens | Latency |
|---|---|---|---|
| low | 82% | ~150 | 1.2s |
| medium | 91% | ~400 | 2.8s |
| high | 96% | ~900 | 5.1s |
| xhigh | 97% | ~2,100 | 9.4s |

The low→medium jump gives the best ROI (9 points accuracy for ~2.5x tokens); high→xhigh gives only 1 point for 2.3x tokens — rarely justified. OpenAI's own guidance: use `low` for extraction/routing/classification, `medium` as default for agentic coding, `high` for hard debugging/planning, reserve `xhigh`/`max` for cases where evals show clear benefit.[^47][^48][^46]

**Implementation cost:** Trivial — one request parameter; requires per-agent-role tuning (planner may warrant `high`, harness-editor `low`).

**Anthropic equivalent:** "Thinking budget" tokens function analogously (not detailed in retrieved sources with the same granularity, but the same effort/cost tradeoff logic applies via `budget_tokens` on extended thinking).

### 6.2 Terse-output prompting

**Mechanism:** Instruct the model to produce compressed, low-verbosity output ("Caveman"-style prompting removing articles/filler).

**Measured, conflicting results:**
- Original Caveman benchmark (10 prompts): 65% mean output-token reduction, range 22–87%.[^49]
- Independent JetBrains replication using the Harbor framework and SkillsBench across 86 real-world SWE tasks in Claude Code found only ~8.5% output-token reduction — far below the claimed 65%; an initial 10-task sample showed ~30% savings that regressed as the sample broadened to a representative workload.[^50]
- A fine-tuned "CaveGemma" model reproduces a weaker 27% output-token reduction with no prompt overhead at all.[^49]

**Takeaway:** Terse-output prompting delivers real but modest savings (single-digit to ~10% on realistic coding workloads) rather than the dramatic headline numbers from small benchmarks — measure on your own task mix before relying on it.

**Risk:** Over-compressed output can drop necessary code comments, error context, or explanations the harness UI needs to render to the user.

## 7. Images

**OpenAI tile-based formula (legacy models — GPT-4o, GPT-4.1, o1, o3):** `tokens = base + tiles × tile_tokens`, where the image is scaled to fit 2048×2048, shortest side scaled to 768px, then divided into 512×512 tiles. Example: GPT-4o = 85 base + 170/tile (1024×1024 → 765 tokens); GPT-5 = 70 base + 140/tile (1024×1024 → 630 tokens). `detail: "low"` mode is a flat cost regardless of size (85 tokens for GPT-4o).[^51][^52][^53][^54][^55]

**OpenAI patch-based formula (GPT-5.6+ / newer models):** `patch_count = ceil(width/32) × ceil(height/32)`, with an optional resize to a patch budget, then `tokens = patch_count × model_multiplier` (multiplier ~1.2 for GPT-5.x).[^52]

**Anthropic formula:** `tokens = (width × height) / 750`, applied after downscaling to fit within roughly 1568px long edge (~1.15 megapixels). Reference points: 200×200px ≈ 53 tokens; 1000×1000px ≈ 1,334 tokens; 1092×1092px ≈ 1,590 tokens.[^56][^54][^57][^58]

**Optimization implications for nanoharness:** Since Claude's formula is purely quadratic in pixel area with no tiling discontinuity, downscaling images before sending (e.g., screenshots, diagrams) linearly cuts token cost — halving both dimensions cuts image tokens to 25%. For OpenAI's tile-based models, cropping/resizing to just fit fewer 512px tiles (e.g., staying under a single 512×512 boundary) gives step-function savings. For text-heavy images (code screenshots, terminal output), OCR/text-extraction before sending will almost always beat sending pixels, since a screenshot of a 50-line terminal output can cost 700–1,500+ image tokens versus ~200–400 tokens if extracted as plain text.

**Implementation cost:** Medium — requires an image-preprocessing step (resize/compress) and a fallback OCR/text-extraction path for terminal/log screenshots, relevant if nanoharness ever surfaces screenshots to agents.

## 8. Orchestration-Level Techniques

### 8.1 Programmatic tool calling / code execution with MCP

**Mechanism:** Instead of the model calling each MCP tool directly (schema + result round-tripping through context every time), the model writes code that calls tools programmatically inside a sandbox; only the code and final summarized output enter the model's context, while tool schemas are discovered on-demand (filesystem-style) rather than all loaded upfront.[^59][^45]

**Quantified savings (multiple independent measurements):**
- Anthropic's own benchmark: a Google Drive→Salesforce workflow dropped from 150,000 to 2,000 tokens (98.7% reduction).[^60][^61][^59]
- Anthropic's Programmatic Tool Calling (PTC) alone (without full code-mode): average tokens on complex research tasks dropped from 43,588 to 27,297, a 37% reduction.[^45]
- AIMultiple's independent GPT-4.1 replication against a live MCP server: 78.5% input-token reduction (771K→165K across a task set), 100% success rate maintained.[^62][^63]
- Cloudflare's Code Mode against a 2,500-endpoint API: 99.9% token reduction (1.17M tokens → ~1,000 tokens) by exposing the API as two meta-tools (`search`, `execute`) instead of individually-schematized tools.[^63]
- Bifrost gateway scaling test: token reduction grows with tool-catalog size — 58% at 96 tools, 84% at 251 tools, 93% at 508 tools.[^64]

**Implementation cost:** High — requires a sandboxed code-execution environment (relevant for nanoharness given it already has a `bash` tool) and a filesystem-style tool registry the model can import from rather than a flat schema list.

**Risk:** Adds a sandboxing/security surface; debugging failures is harder when tool orchestration logic lives in generated code rather than explicit tool_use blocks.

**Relevance to nanoharness:** Given nanoharness already exposes `bash`, this pattern is unusually cheap to adopt — MCP tool calls (Tavily search/fetch) could be wrapped as importable functions the builder/planner agent calls via a short script rather than via native tool-call JSON, especially valuable if more MCP servers are added later.

### 8.2 Cache-aware message ordering

Already covered in Section 1; the orchestration-level version is: canonicalize the full prompt-assembly pipeline (system → tools → fixed context → conversation history → current turn) so that every code path that builds a request produces byte-identical prefixes. For multi-agent nanoharness, share one canonical system preamble across agents where possible, with a short role-specific suffix appended after the cache breakpoint, so the expensive shared part stays cacheable across the planner/builder/harness-editor.[^65][^66]

### 8.3 Batching independent tool calls

**Mechanism:** Instruct the model (via system prompt) to emit multiple independent tool calls in a single turn; the harness executes them concurrently (Promise.all-equivalent) and returns all results together.

**Quantified savings:** One production case study: 12s→3s planning latency, ~40K→~16K input tokens (4x faster, ~60% fewer input tokens) after adding a system-prompt instruction to batch independent calls. A general estimate: collapsing a 10-round-trip workflow to 2–3 turns cuts latency 60–80% and token cost proportionally, because each round-trip re-sends the entire growing conversation history and tool schemas. An MCP-multiplexer analysis found 7 sequential `get_issue` calls cost ~1,425 tokens of structural overhead + reasoning versus ~75 tokens when batched (~19:1 reduction in context pollution, though this excludes the actual data payload).[^67][^68][^69][^70]

**Implementation cost:** Low — one system-prompt instruction + concurrent execution in the harness's tool-runner; nanoharness's bash/read/write/web tools are naturally parallelizable when independent (e.g., reading three files at once).

**Risk:** None significant if dependency-checking is correct; the only failure mode is executing calls in parallel that actually depend on each other's output — harness must verify true independence before dispatching concurrently.[^71][^72]

## 9. Measurement

**Usage fields to capture per call:**
- OpenAI: `usage.prompt_tokens_details.cached_tokens` (cache hits), `usage.completion_tokens_details.reasoning_tokens` (reasoning-token spend).[^73][^74][^13]
- Anthropic: `usage.cache_creation_input_tokens` (cache writes) and `usage.cache_read_input_tokens` (cache hits).[^75][^76][^77]

**Derived metrics nanoharness should track per session/task:**
- Cache hit rate = cache_read_input_tokens / (cache_read + input_tokens) — flags broken caching (stuck at zero) versus working caching (non-zero, growing).[^77]
- Per-phase cost attribution: separate token/cost accounting per agent (planner vs. builder vs. harness-editor) and per tool call type, since subagent-heavy phases can dominate the bill (Section 4).
- Cost-per-completed-task: total ($ cost, tokens) ÷ successful task completions — the primary optimization metric per the user's stated goal; requires an eval harness that runs representative tasks with and without each optimization to isolate effect size, since real-workload results (JetBrains' Caveman test) can diverge sharply from small-benchmark claims (Section 6.2).

**Implementation cost:** Low-medium — instrument the harness's provider-adapter layer to log usage fields from every response, aggregate by agent/phase/task, and store cache-hit-rate time series to catch silent cache breakage from unnoticed prefix drift.

## 10. Counter-Evidence: Techniques That Backfire

- **Over-aggressive compaction losing task state:** Compaction that drops "pinned" context, in-progress todos, or file-content the agent will need again forces costly re-reads and can silently degrade correctness; Claude Code explicitly preserves system prompt, recent N messages, and pinned context specifically to avoid this failure mode. Nanoharness should whitelist categories (recent file reads, active plan, error state) as compaction-exempt.[^20][^18]
- **Cache-hostile dynamic prefixes:** Any per-request timestamp, UUID, or reordered JSON key interpolated near the front of the prompt invalidates the cache for everything after it, silently reverting to full-price billing with no error surfaced — this is called out explicitly in Anthropic's own engineering guidance as the most common silent invalidator.[^2]
- **Tool-subset switching breaking caches:** Because tools render first in the prefix (before system, before messages), dynamically swapping which tools are available between calls in the same session invalidates the cached prefix for that call and possibly the whole session going forward — directly conflicting with the "tool-schema diet" goal of loading only needed tools per phase (Section 5). The safe pattern is to fix the tool set for the life of a session/agent-role, not per-turn.
- **Subagent fan-out on sequential work:** Delegating a tightly-coupled, step-dependent task (e.g., a multi-step refactor) to parallel subagents can inflate cost up to 15x with zero throughput benefit, since subagents can't share intermediate reasoning and each pays full uncached price.[^39]
- **Terse-output prompting overclaiming savings:** Headline numbers (e.g., 65% output-token reduction) from small, non-representative benchmarks collapsed to ~8.5% on a broad, realistic 86-task suite — a reminder to validate every "savings" claim against nanoharness's actual task distribution before committing to a technique.[^50]
- **Truncation without explicit signaling:** Silent tool-output truncation (rather than an explicit error or continuation marker) causes agents to treat partial content as complete, missing guardrails or logic in the unread tail — a documented failure class in Claude Code.[^30][^31]

## Ranked Top-10 Recommended Subset for Nanoharness v1

| Rank | Technique | Rationale | Expected combined impact |
|---|---|---|---|
| 1 | Cache-aware prompt assembly (stable-prefix ordering, fixed tool set per session, append-only messages) | Foundational — nearly free to build correctly from scratch, and every other technique's savings compound on top of a working cache. Anthropic 90% / OpenAI up to 90% discount on cache reads[^3][^8]. | 40–70% input-token cost reduction on repeated-context turns |
| 2 | Provider usage-field instrumentation (cached_tokens, cache_read_input_tokens, reasoning_tokens) per agent/phase | Without measurement, every other technique is unverifiable; required before tuning anything else[^13][^77]. | Enables accurate cost-per-task tracking; no direct token savings but prerequisite |
| 3 | Offset/limit file reads with explicit truncation markers + grep-first exploration | Cheap to implement in the `read` tool; prevents worst-case full-file-read blowouts and the silent-truncation failure mode[^25][^27][^31]. | Avoids multi-thousand-token reads on large files; ~10x reduction on targeted lookups |
| 4 | Search/replace (str_replace-style) edits as builder's default, full rewrite only for small files (<~300–400 lines) | Directly measured 3.5–6.5x token/latency savings vs. full rewrite or sequential edits on realistic files[^32][^34]. | Cuts builder-agent output tokens substantially on medium/large file edits |
| 5 | Batch independent tool calls in one turn (parallel bash/read/web calls) | Low implementation cost, no accuracy risk when dependency-checked correctly; measured 60% input-token reduction and 4x latency improvement in production case[^69]. | ~30–60% fewer input tokens on multi-step information-gathering turns |
| 6 | Reasoning-effort tuning per agent role (planner=medium/high, builder=low/medium, harness-editor=low) | Trivial parameter change with measured, quantified cost/quality curve[^46][^48]. | 2–3x reduction in reasoning-token spend on routine subtasks vs. blanket "high" |
| 7 | Model routing for subagents (cheap model for narrow workers, frontier model for planner) | Single biggest dollar-cost lever reported in practice, ~5x on routine subagent tasks[^36][^40]. | Largest $-cost reduction of any technique on this list, if subagents are used at all |
| 8 | Microcompaction (drop/elide stale tool results with hot-tail/cold-storage split) before full compaction | Zero-API-cost tier; keeps context small without the correctness risk of aggressive summarization[^15][^18]. | Delays/reduces frequency of expensive full-compaction calls; frees 20–40% of working context on long sessions |
| 9 | Progressive tool disclosure for MCP/web tools (defer_loading + on-demand tool search, or code-execution wrapper for Tavily search/fetch) | Directly addresses the multi-tool-schema tax; measured 85–99% reduction in tool-definition tokens at scale[^44][^63]. Especially cheap for nanoharness since it already has `bash` for a code-execution-style wrapper. | Removes essentially all per-call tool-schema overhead once tool count grows beyond ~5–10 |
| 10 | Fixed compaction-exempt whitelist (pinned plan/todos/recent files) + eval-harness-gated deployment of any compression technique | Directly mitigates the top counter-evidence failure mode (state loss from over-compaction) and enforces that every technique above is validated on nanoharness's real task mix before trusting headline numbers[^20][^50]. | Prevents correctness regressions that would otherwise negate the token savings from items 1–9 |

**Expected combined savings:** Items 1–3 (caching + measurement + file economics) are foundational and largely additive with everything else, typically delivering the largest single block of savings (cache-hit-rate-dependent, often 40–70% on repeated-context input tokens per the provider-level 90% cache discount applied to a large stable prefix). Items 4–6 (edit format, batching, reasoning effort) compound on top, each contributing roughly 20–60% reduction within their specific cost category (output tokens for edits, turn-count for batching, reasoning tokens for effort tuning). Item 7 (model routing) is the dominant dollar-cost lever if/when subagents are used. Items 8–10 are risk-management and scaling techniques that protect the gains from 1–7 as nanoharness's tool count and session length grow, without which real-world savings frequently underperform benchmark claims by an order of magnitude, as demonstrated by the Caveman prompting case (65% claimed vs. 8.5% measured).[^3][^8][^50]

---

## References

1. [Prompt Caching Tutorial Anthropic: Cut API Costs 90% with ...](https://aipromptshub.co/blog/prompt-caching-anthropic-tutorial) - How to use Anthropic prompt caching: cache_control syntax, 5-min vs 1-hour TTL, pricing math, and co...

2. [skills/skills/claude-api/shared/prompt-caching.md at main](https://github.com/anthropics/skills/blob/main/skills/claude-api/shared/prompt-caching.md) - Public repository for Agent Skills. Contribute to anthropics/skills development by creating an accou...

3. [Prompt caching - Anthropic](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching?c=acatex)

4. [Anthropic API Pricing 2026: Official Per-Model Rates](https://pecollective.com/tools/anthropic-api-pricing/) - Official Anthropic API rates per model. Haiku 3.5 at $0.25/1M input, Sonnet 4 at $3, Opus 4 at $15. ...

5. [Anthropic Launch Batch API - up to 95% discount](https://llmindset.co.uk/posts/2024/10/anthropic-batch-pricing/) - Anthropic introduces batch pricing for Claude models, offering up to 95% discounts when combined wit...

6. [Prompt Caching Calculator — Anthropic Claude Savings, 2026](https://hcodx.com/tools/prompt-caching-calculator) - Calculate savings from Anthropic Claude prompt caching. 5-min cache write (1.25x base input), 1-hour...

7. [Orq.ai Documentation - AI Gateway & LLM Collaboration Platform](https://docs.orq.ai/docs/proxy/providers/anthropic/prompt-caching) - Orq.ai - The AI Gateway & Collaboration Platform for building, deploying, and managing LLM applicati...

8. [Anthropic vs OpenAI Prompt Caching 2026: Cost Math + 3 ...](https://ofox.ai/blog/prompt-caching-cost-math-anthropic-vs-openai-2026/) - Both Anthropic and OpenAI's newest flagships now bill cached reads at 10% of the standard input rate...

9. [Prompt caching | OpenAI API](https://platform.openai.com/docs/guides/prompt-caching) - Learn how prompt caching reduces latency and cost for long prompts in OpenAI's API.

10. [Prompt Caching in the API - OpenAI](https://openai.com/index/api-prompt-caching/) - Offering automatic discounts on inputs that the model has recently seen

11. [Prompt caching | OpenAI API](https://developers.openai.com/api/docs/guides/prompt-caching) - Learn how prompt caching reduces latency and cost for long prompts in OpenAI's API.

12. [OpenAI Prompt Caching Billing Guide - API易文档中心](https://docs.apiyi.com/en/api-capabilities/openai/prompt-caching)

13. [Prompt Caching 201](https://developers.openai.com/cookbook/examples/prompt_caching_201) - Note: This guide applies only to models before GPT-5.6. For GPT-5.6 and later, see the Prompt Cachin...

14. [Prompt Caching 101](https://developers.openai.com/cookbook/examples/prompt_caching101) - OpenAI offers discounted prompt caching for prompts exceeding 1024 tokens, resulting in up to an 80%...

15. [Auto-Compact - Claude Wiki](https://claude-wiki.com/auto-compact.html)

16. [Compaction - Claude Platform Docs](https://platform.claude.com/docs/en/build-with-claude/compaction) - It handles context management automatically, without client-side summarization code. Compaction exte...

17. [Claude Code Pattern 6: Context Management at Scale](https://kenhuangus.substack.com/p/claude-code-pattern-6-context-management) - Auto-compact is the primary proactive context management strategy. When token usage exceeds the auto...

18. [Inside Claude Code's Compaction System](https://decodeclaude.com/compaction-deep-dive/) - Claude Code manages context through three user-facing mechanisms: Microcompaction — offload bulky to...

19. [07-context-compaction-family.md](https://ithub.global.ssl.fastly.net/luyao618/Claude-Code-Source-Study/blob/main/docs-en/07-context-compaction-family.md) - Deep dive into Claude Code's source code— learn from the best agent implementation out there. - luya...

20. [Context Management & Compaction | g29times/claude-code-source-code | DeepWiki](https://deepwiki.com/g29times/claude-code-source-code/2.3-context-management-and-compaction) - Claude Code manages the context window of the underlying LLM through a sophisticated multi-tier comp...

21. [[2510.00615] ACON: Optimizing Context Compression for Long ...](https://arxiv.org/abs/2510.00615) - Large language models (LLMs) are increasingly deployed as agents in dynamic real-world environments,...

22. [[PDF] SWE-Pruner: Self-Adaptive Context Pruning for Coding Agents](https://openreview.net/pdf/70c8654781be52c592fca8ca7fd2aa924f7231c1.pdf)

23. [[2601.07190] Active Context Compression: Autonomous Memory ...](https://arxiv.org/abs/2601.07190) - Large Language Model (LLM) agents struggle with long-horizon software engineering tasks due to "Cont...

24. [A Self-Evolving Framework for Efficient Terminal Agents via ...](https://huggingface.co/papers/2604.19572) - Join the discussion on this paper page

25. [Lesson 18 — File Tools: Read, Write, Edit - Markdown Engineering](https://www.markdown.engineering/learn-claude-code/18-file-tools) - Lesson 18: mdENG — Lesson 18 — File Tools: Read, Write, Edit. Part of the 50-lesson Claude Code arch...

26. [File Reading Tools | powerjiayun/claude-code-reverse | DeepWiki](https://deepwiki.com/powerjiayun/claude-code-reverse/5.3-file-reading-tools) - This page documents the file reading tools available in Claude Code's tool system. These tools enabl...

27. [Offset/limit when Claude Code's Read cuts off at 2000 lines](https://note.com/kludgelog/n/n9ef885ae4576?hl=en) - Prerequisites Target audience: People who have thrown a large file at Claude Code with the instructi...

28. [Internal claude code tools implementaion - GitHub Gist](https://gist.github.com/bgauryy/0cdb9aa337d01ae5bd0c803943aa36bd) - Internal claude code tools implementaion. GitHub Gist: instantly share code, notes, and snippets.

29. [Aparna Dhinakaran (@aparnadhinak) on X](https://x.com/aparnadhinak/status/2048492731929149929)

30. [Claude Code Fixes — 7 Hidden Limits and How to Override Them ...](https://www.verified-skill.com/insights/claude-code-fixes) - 7 verified limitations in Claude Code's source and the CLAUDE.md configuration to bypass them.

31. [[BUG] Read tool truncation causes agents to silently lose guardrails ...](https://github.com/anthropics/claude-code/issues/28783) - Preflight Checklist I have searched existing issues and this hasn't been reported yet This is a sing...

32. [I Benchmarked 5 File Editing Strategies for AI Coding ...](https://dev.to/ceaksan/i-benchmarked-5-file-editing-strategies-for-ai-coding-agents-heres-what-actually-works-1855) - Read once, rewrite entire file. File content never enters the token stream. Unified Diff: Agent gene...

33. [How AI Coding Agents Edit Code: Diff vs Whole-File vs Search ...](https://dreaming.press/posts/coding-agent-edit-formats-diff-vs-whole-file.html) - Everyone argues about which model to use. The under-discussed variable is how the agent writes its c...

34. [Why AI coding tools rewrite full files instead of using diffs](https://anishgandhi.com/why-ai-tools-dont-use-diffs/) - Cursor fast apply, Morph, and Aider all converge: full-file rewrites beat diffs under 400 lines. Thr...

35. [Edit Format Selection: Diff vs. Search-Replace vs. Full Rewrite](https://agentpatterns.ai/tool-engineering/llm-edit-format-selection/) - How to pick an output format for LLM code edits — line-based diffs, search-replace blocks, structure...

36. [Why Claude Code Subagents Burn So Many Tokens](https://youcanbuildthings.com/articles/claude-code-subagents-token-usage) - Claude code subagents cost up to 85% of a heavy session. Route workers to cheaper models, audit the ...

37. [Claude Code Sub-Agents: The Hidden Token Cost (2026)](https://extraheadroom.com/blog/claude-code-subagents-token-costs) - Sub-agents spin up fresh contexts that don't inherit the prompt cache, so multi-agent runs re-buy co...

38. [Why Claude Code Sub-Agents Cost 7x More Tokens (And ...](https://www.mindstudio.ai/blog/claude-code-subagents-cost-tokens) - Anthropic's docs confirm Claude Code sub-agents can burn 7x more tokens than a normal session. Here'...

39. [When parallel sub-agents in Claude Code actually save money and when they burn it](https://www.reddit.com/r/ClaudeAI/comments/1tdorkr/when_parallel_subagents_in_claude_code_actually/) - When parallel sub-agents in Claude Code actually save money and when they burn it

40. [Reduce Claude Code Token Usage: 8 Proven Ways (2026)](https://app.stationx.net/articles/reduce-claude-code-token-usage) - Discover 8 proven ways to cut Claude Code token usage and costs: model routing, prompt caching, loca...

41. [Function Calling Token Calculator - Tool Schema Overhead](https://tokencalc.dev/tools/function-tokens/) - Calculate how many tokens your function/tool definitions consume in the LLM context. Paste a schema ...

42. [Tool Calling Token Overhead Calculator | KickLLM](https://kickllm.com/tools/tool-calling-overhead-calculator.html) - Calculate the token and cost overhead of function/tool definitions in your system prompt across LLM ...

43. [AI Structured Output Costs in 2026: JSON Mode, Tool Calling ...](https://aicostcheck.com/blog/ai-structured-output-costs-2026) - Structured AI outputs add schema, tool, and retry costs. See 2026 JSON mode pricing math and routing...

44. [Anthropic's Advanced Tool Calling: Programmatic, Dynamic Filtering ...](https://www.linkedin.com/posts/jasonzhoudesign_anthropics-new-advanced-tool-calling-is-activity-7431270645885284352-jSGo) - Anthropic’s new advanced tool calling is gold and I’m surprised not many people talk about it - Prog...

45. [Introducing advanced tool use on the Claude Developer ...](https://www.anthropic.com/engineering/advanced-tool-use) - Claude can now discover, learn, and execute tools dynamically to enable agents that take action in t...

46. [OpenAI SDK Track Part 11: Reasoning Systems - Wasil Zafar](https://www.wasilzafar.com/pages/series/ai-app-dev-xtreme/ai-app-dev-sdk-openai-part11-reasoning-systems.html) - Reasoning models, effort parameter, reasoning items, tool calling with reasoning, and multi-step pat...

47. [API deployment checklist - OpenAI Developers](https://developers.openai.com/api/docs/guides/deployment-checklist) - Review commonly underused Responses API design choices that improve deployment quality, speed, cost,...

48. [Reasoning models | OpenAI API](https://developers.openai.com/api/docs/guides/reasoning) - The reasoning.effort parameter guides the model on how much to think when performing a task. Support...

49. [The caveman phenomenon](https://getcaveman.dev/labs/articles/caveman-phenomenon) - 72,800 stars for a prompt that drops articles.

50. [‘Talk like a caveman’ prompts save tokens, but far less than promised](https://www.infoworld.com/article/4193775/talk-like-a-caveman-prompts-save-tokens-but-far-less-than-promised.html) - JetBrains found that the popular AI coding optimization reduced output token consumption without hur...

51. [How do I calculate image tokens in GPT4 Vision? - #2 by Locust2520](https://community.openai.com/t/how-do-i-calculate-image-tokens-in-gpt4-vision/492318/2) - According to the pricing page, every image is resized (if too big) in order to fit in a 1024x1024 sq...

52. [Images and vision | OpenAI API](https://developers.openai.com/api/docs/guides/images-vision) - The estimate is ceil(2500 × 1.2) = 3000 tokens. Each square uses the model's tile tokens. the base c...

53. [How Images Are Tokenized in Multimodal Models](https://howmanytokens.app/articles/image-tokens-multimodal.html) - Learn how GPT-4o, Claude, and Gemini convert images to tokens. Understand resolution-to-token mappin...

54. [Image Token Calculator | Count Vision Tokens for GPT-4o ...](https://www.tokencalc.org/image-token-calculator) - Free online image token calculator for LLM vision models. Calculate tile-based token counts for GPT-...

55. [OpenAI API: How Vision-Enabled LLMs Calculate Image Tokens ...](https://journal.qualiteg.com/openai-vision-llm-api-calculate-image-tokens/) - Hello! OpenAI's vision-capable models (that is, LLMs that accept image input) use two different meth...

56. [Help understand token usage with vision API](https://community.openai.com/t/help-understand-token-usage-with-vision-api/893022) - To calculate the approximate cost, multiply the approximate number of image tokens by the [per-token...

57. [AI Vision Input Limits - What Every Provider Hides](https://awesomeagents.ai/guides/ai-vision-image-resolution-limits/) - A technical comparison of how Claude, GPT-4o, Gemini, Grok, Pixtral, Qwen, and DeepSeek handle image...

58. [Vision Tokens Are Expensive and Nobody Reads the Pricing Page](https://gotcontext.ai/blog/vision-tokens-hidden-cost-multimodal) - You added image support to your app. You sent a 1,000×1,000 pixel screenshot to Claude. You were cha...

59. [Code execution with MCP: building more efficient AI agents](https://www.anthropic.com/engineering/code-execution-with-mcp) - Learn how code execution with the Model Context Protocol enables agents to handle more tools while u...

60. [Claude MCP Code Execution: Cut Agent Token Usage by 98% ...](https://aiforanything.io/blog/claude-mcp-code-execution-token-efficient-agents-2026) - Anthropic's code execution with MCP pattern slashes Claude agent token usage from 150K to 2K tokens....

61. [Anthropic's Code Execution with MCP: A Paradigm Shift in AI Tool ...](https://jangwook.net/en/blog/en/anthropic-code-execution-mcp/) - Explore how Anthropic's Code Execution with MCP achieves 98.7% token reduction and 60% faster execut...

62. [Code Execution with MCP: A New Approach to AI Agent ...](https://aimultiple.com/code-execution-with-mcp) - Learn how AI agents achieve 78% input token savings while maintaining 100% success rates. Code execu...

63. [Code Mode: give agents an entire API in 1000 tokens](https://blog.cloudflare.com/code-mode-mcp/) - The Cloudflare API has over 2,500 endpoints. Exposing each one as an MCP tool would consume over 2 m...

64. [Cutting MCP Tool-Call Token Costs by 50%+ with Code Mode](https://dev.to/kuldeep_paul/cutting-mcp-tool-call-token-costs-by-50-with-code-mode-4cd) - MCP tool-call token costs grow fast as agents add servers. Code Mode trims token usage 50%+ by...

65. [Prompt Caching for AI Agents: Stop Paying for the Same ...](https://munderdiffl.in/blog/prompt-caching-for-ai-agents/) - An agent re-sends the same prompt, tools, and context every turn. Prompt caching makes you pay for t...

66. [Prompt Caching Strategies for Multi-Agent Workflows](https://tamaton.com/blog/engineering/prompt-caching-strategies-for-multi-agent-workflows) - Learn practical prompt caching strategies to reduce latency and cost in multi agent systems, with la...

67. [Batching & Chaining Tools | Token Optimization Masterclass](https://agenticskillset.org/en/topics/batching-chaining-tool-calls/) - Combine multiple tool invocations into single, consolidated turns, eliminating the iterative token o...

68. [Callmux MCP multiplexer cuts tool call context ... - Agentic Universe](https://www.agentic-universe.net/articles/kNXv7xC_bJEWqLMB6w0VL)

69. [Optimize AI Agent Latency with Parallel Tool Calls - LinkedIn](https://www.linkedin.com/posts/rahulparmariitd_your-ai-agent-is-slow-and-its-probably-activity-7458127018120077312-7nBs) - Your AI agent is slow. And it’s probably not the model. It’s making 15 sequential tool calls when it...

70. [Cutting Claude Code Token Cost: Caching & Batching](https://callsphere.ai/blog/cutting-claude-code-token-cost-caching-amp-batching)

71. [Parallel Tool Calls in AI Agents Explained - AI/TLDR](https://ai-tldr.dev/learn/ai-agents/tool-use/parallel-tool-calls/) - Modern models can request several tool calls in one turn. Learn how parallel tool calling works, whe...

72. [Parallel tool calls - Samuel Ochoa](https://samuelochoa.com/expertise/agents/tools/parallel-tools.html) - Modern LLMs can request multiple tool calls in one step. Here's when to use parallel calls and how t...

73. [Vendor Usage Field Reference | NVIDIA AIPerf ...](https://docs.nvidia.com/aiperf/reference/vendor-usage-field-reference)

74. [Will cached_prompt be charged in each API call?](https://community.openai.com/t/will-cached-prompt-be-charged-in-each-api-call/977999) - When I call a chat.completions.parse API, it returns completion.usage.total_tokens completion.usage....

75. [Usage class - anthropic_sdk_dart library - Dart API](https://pub.dev/documentation/anthropic_sdk_dart/latest/anthropic_sdk_dart/Usage-class.html) - API docs for the Usage class from the anthropic_sdk_dart library, for the Dart programming language.

76. [[SDK] assistant.usage: cacheReadTokens and ...](https://github.com/github/copilot-sdk/issues/1073) - Summary The assistant.usage event defines cacheReadTokens and cacheWriteTokens fields (documented in...

77. [Anthropic Claude API Prompt Caching and Token Efficiency Guide](https://hidekazu-konishi.com/entry/anthropic_claude_api_prompt_caching_and_token_efficiency.html) - A definitive, implementation-level guide to Claude API token efficiency - prompt caching and cache b...


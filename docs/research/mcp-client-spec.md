## Scope and Assumptions

This is a minimal, implementation-ready protocol subset for a custom LLM harness acting purely as an **MCP client**: connecting to MCP servers over stdio (local subprocess) and Streamable HTTP (remote), performing the lifecycle handshake, and calling `tools/*` methods to feed results to OpenAI- and Anthropic-style tool-calling loops. `resources/*` and `prompts/*` are explicitly out of scope for v1, per the design decision below.

All wire formats are MCP JSON-RPC 2.0, cross-validated against the modelcontextprotocol.io specification (2025-06-18 / 2025-11-25 revisions, referenced generically as "the spec" below) and the official TypeScript and Python SDKs.

## Protocol-Subset Checklist

The following is the minimum surface a tools-only MCP client harness must implement:

- **Base protocol**: JSON-RPC 2.0 message framing — requests have `id` + `method` + `params`; notifications omit `id`; responses correlate by `id`.[^1]
- **Transport — stdio**: spawn the server as a subprocess; write newline-delimited JSON-RPC to its `stdin`; read newline-delimited JSON-RPC from its `stdout`; treat `stderr` as opaque logs, never as an error signal.[^2]
- **Transport — Streamable HTTP**: a single POST/GET endpoint (e.g. `/mcp`); client POSTs JSON-RPC requests with `Accept: application/json, text/event-stream`; server replies with either a plain JSON body or upgrades to a Server-Sent Events stream for long-running calls.[^3][^2]
- **Lifecycle**: `initialize` request → server response with negotiated `protocolVersion`, `capabilities`, `serverInfo` → client sends `initialized` notification → normal operation begins.[^4][^5]
- **Capability negotiation**: client declares `ClientCapabilities` (e.g. `sampling`, `roots`); server declares which of `tools`, `resources`, `prompts`, `logging` it supports, plus `listChanged` sub-flags.[^5][^4]
- **Discovery**: `tools/list` (paginated via `cursor`) to enumerate available tools and their JSON Schema `inputSchema`.[^6]
- **Invocation**: `tools/call` with `name` + `arguments`, returning a `CallToolResult` (`content[]`, optional `isError`, optional `structuredContent`).[^7][^6]
- **Cancellation**: `notifications/cancelled` referencing the target request's `id`, sendable by either side, best-effort.[^8][^9]
- **Error handling**: distinguish JSON-RPC protocol errors (`-32700`…`-32603`) from in-band tool failures (`isError: true` inside a normal result).[^10][^1]
- **Auth (remote HTTP only)**: `Authorization: Bearer <token>` header on every request; OAuth 2.1 discovery/token flow when the server requires it; stdio servers get credentials from the local environment, not HTTP OAuth.[^11][^12]
- **Explicitly deferred to v2**: `resources/list`, `resources/read`, `prompts/list`, `prompts/get`, `sampling/*`, `roots/*`, `completion/*`, logging utilities.

## Lifecycle: Initialize Handshake and Version Negotiation

The `initialize` request **must** be the first message on any transport and **must not** be batched with other calls; no other request (besides pings/logging) may precede it. The client sends the *latest* protocol version it supports, its `capabilities`, and `clientInfo`. The server either echoes that version (if supported) or downgrades to a version it does support; the client must accept the server's returned version or disconnect if it cannot support it.[^13][^4][^5]

**Client → Server (`initialize` request):**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "capabilities": {
      "roots": { "listChanged": true },
      "sampling": {}
    },
    "clientInfo": { "name": "custom-llm-harness", "version": "0.1.0" }
  }
}
```

**Server → Client (`initialize` response):**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2025-06-18",
    "capabilities": { "tools": { "listChanged": true } },
    "serverInfo": { "name": "example-server", "version": "1.4.0" },
    "instructions": "Optional human-readable usage hints"
  }
}
```

**Client → Server (`initialized` notification, no `id`, no response expected):**

```json
{ "jsonrpc": "2.0", "method": "notifications/initialized" }
```

After this exchange, the session is "active" and any method allowed by the negotiated capabilities can be used. Note that a 2026-era draft revision moves toward a *stateless*, per-request model (version and identity carried in `_meta` on every call rather than a session handshake), but this is not yet the stable baseline most SDKs implement, so the harness should target the session-based lifecycle above and treat stateless mode as a future migration.[^14][^5]

## tools/list and tools/call Semantics

`tools/list` supports cursor-based pagination and returns each tool's `name`, `description`, and `inputSchema` (JSON Schema). Servers that declare the `listChanged` capability push a `notifications/tools/list_changed` notification when the tool catalog changes, which the harness should treat as a signal to re-fetch the list rather than assume it is static.[^15][^6]

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/list",
  "params": { "cursor": "optional-cursor-value" }
}
```

**Response:**

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "tools": [
      {
        "name": "get_weather",
        "description": "Get current weather for a location",
        "inputSchema": {
          "type": "object",
          "properties": { "location": { "type": "string" } },
          "required": ["location"]
        }
      }
    ],
    "nextCursor": null
  }
}
```

`tools/call` invokes a tool by `name` with `arguments` matching `inputSchema`. The result is a `CallToolResult`: a `content` array of typed blocks (`text`, `image`, `audio`, `resource_link`, `embedded_resource`), an optional `isError` flag, and an optional `structuredContent` object validated against a declared `outputSchema`.[^16][^6][^7]

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "get_weather",
    "arguments": { "location": "New York" }
  }
}
```

**Success response:**

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [{ "type": "text", "text": "72°F, partly cloudy" }],
    "isError": false
  }
}
```

## Should Resources and Prompts Be Skipped for v1?

Yes — for a tools-only harness, `resources/*` and `prompts/*` can be safely deferred. They are declared as separate, independently-negotiated server capabilities (`capabilities.resources`, `capabilities.prompts`) distinct from `capabilities.tools`, meaning a client that never advertises interest in them and never calls `resources/list`, `resources/read`, `prompts/list`, or `prompts/get` remains fully spec-compliant. Servers do not require the client to consume resources or prompts to use tools — the three server-feature categories (resources, prompts, tools) are independent. The only cost of skipping them is functional: the harness loses access to server-exposed static/dynamic context blobs (resources) and reusable prompt templates (prompts), which some servers use to pass large reference data more efficiently than tool-call payloads. For a v1 harness whose sole job is exposing callable functions to an LLM via OpenAI/Anthropic tool-use loops, this is an acceptable and common simplification — many production MCP clients (including early Claude Desktop / Cursor tool-calling integrations) launched tools-first.[^17][^4]

## Auth for Remote HTTP Servers: Bearer vs OAuth 2.1

| Dimension | Static bearer header | Full OAuth 2.1 flow |
|---|---|---|
| When required | Internal/trusted servers, personal use, team tools[^18] | Public remote servers where users you don't control will connect[^18] |
| Spec requirement | Sufficient; still uses `Authorization: Bearer <token>` header per request[^11][^19] | Mandatory: OAuth 2.1 + PKCE, RFC 9728 Protected Resource Metadata, RFC 8414 AS metadata, RFC 8707 resource indicators[^11][^19] |
| Discovery | None — token is pre-shared/configured | Server returns `401` + `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"`; client fetches metadata to find the authorization server[^18][^20] |
| Token binding | None | `resource` parameter (RFC 8707) binds the token's audience to the specific MCP server URI[^11][^20] |
| Implementation cost | Minimal | Requires browser-based authorization-code+PKCE flow, refresh-token rotation, redirect URI handling[^21] |

For every HTTP request, regardless of flow, the token travels only in the `Authorization: Bearer <token>` header — **never** in the URI query string, even within what feels like one logical session. stdio-transported servers are explicitly out of scope for this HTTP authorization spec: stdio implementations should retrieve credentials from the local environment (env vars, OS keychain) rather than performing an HTTP OAuth dance.[^12][^19][^11]

**Example minimal bearer request (harness → remote server):**

```http
POST /mcp HTTP/1.1
Host: mcp.example.com
Content-Type: application/json
Accept: application/json, text/event-stream
Authorization: Bearer eyJhbGciOiJSUzI1NiIs...

{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"search_issues","arguments":{}}}
```

For v1, implement plain bearer-header auth as the baseline (works for the vast majority of self-hosted/internal remote MCP servers) and add the OAuth 2.1 discovery-and-PKCE flow only when connecting to a public/third-party server that returns `401` with a `WWW-Authenticate: Bearer resource_metadata=...` challenge.[^18][^20]

## Windows Spawn Quirks for stdio Servers

Windows is the single most common source of stdio-transport failures because Node's `child_process.spawn()` does not go through a shell by default, and `npx` ships as `npx.cmd` (a batch script), not a `.exe`. Calling `spawn("npx", …)` directly on Windows therefore fails with `ENOENT` even though `npx` works fine from an interactive terminal.[^22][^23]

Mitigations, in order of robustness:

- **Wrap with `cmd /c`**: change `command: "npx"` to `command: "cmd", args: ["/c", "npx", "-y", "<package>", …]`. This is the most-cited fix across Anthropic, Cursor, Cline, and Windsurf issue trackers.[^23][^22]
- **Use the absolute path to the resolved binary** (`where npx` on Windows) instead of relying on PATH resolution inherited by GUI-launched processes, which often differs from a terminal's PATH (especially with `nvm`/`mise`/Homebrew-managed Node installs).[^22]
- **Prefer `uvx` for Python-based MCP servers** — it does not carry the `.cmd`-wrapper problem that `npx` has on Windows.[^22]
- **Suppress console-window flashing** by passing `windowsHide: true` through to the underlying `spawn()` call, which applies the `CREATE_NO_WINDOW` flag.[^23]
- **Consider WSL2** for native Linux/macOS-equivalent behavior if the harness runs on developer machines, since most of the MCP tooling ecosystem is written and tested against POSIX shells.[^23]

A minimal, portable spawn strategy for a harness's stdio client config:

```json
{
  "command": "cmd",
  "args": ["/c", "npx", "-y", "@modelcontextprotocol/server-example"],
  "windowsHide": true
}
```

On macOS/Linux, the same server can be spawned directly (`command: "npx", args: ["-y", "@modelcontextprotocol/server-example"]`) without the `cmd /c` wrapper, so the harness should branch on `process.platform` (or equivalent) rather than always wrapping.[^24][^22]

## Timeouts and JSON-RPC Cancellation

MCP defines cancellation as a best-effort, notification-based mechanism rather than a hard protocol guarantee. Either side may send `notifications/cancelled` referencing the target request's `id` and an optional human-readable `reason`; the `initialize` request itself must never be cancelled by the client.[^9][^8]

**Cancellation notification:**

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/cancelled",
  "params": {
    "requestId": 3,
    "reason": "User aborted the operation"
  }
}
```

Rules the harness must follow:

- Only cancel requests it previously issued in the same direction and believes are still in-flight.[^9]
- After sending cancellation, ignore any late response that arrives for that request ID — the sender of a cancellation should disregard subsequent responses.[^9]
- Receivers may ignore a cancellation notification if the request is unknown, already completed, or uncancellable — so the harness cannot assume immediate resource release.[^9]
- On the SDK side, cancellation is applied either by interrupting the handler's execution scope (default) or by only flagging a cancellation-requested state and letting the handler run to completion, depending on implementation.[^25]

For timeouts (not formally part of the spec but essential for a production harness): implement a client-side deadline per outstanding request ID; on expiry, send `notifications/cancelled` with `reason: "timeout"` and raise a local timeout error to the calling agent loop rather than blocking indefinitely — Python SDK-style clients expose this as a `REQUEST_TIMEOUT` error distinct from a `CONNECTION_CLOSED` error if the transport itself drops.[^25]

## Translating MCP Tool Schemas to OpenAI and Anthropic Formats

Both providers consume MCP's `inputSchema` (JSON Schema) directly, but wrap it differently. The translation is largely a matter of re-keying and re-wrapping — the underlying JSON Schema needs no restructuring for straightforward object schemas.[^26][^27]

| Aspect | MCP tool definition | OpenAI tools format | Anthropic tools format |
|---|---|---|---|
| Wrapper | Flat object (`name`, `description`, `inputSchema`)[^15] | `{"type": "function", "function": {...}}`[^26][^28] | Direct object, no `type` wrapper needed for the definition[^26] |
| Schema key | `inputSchema`[^15] | `parameters`[^28][^29] | `input_schema`[^26][^30] |
| Model's call output | — | `message.tool_calls[]` with `id`, or `function_call` item (Responses API)[^31] | `tool_use` content block with `id`, `name`, `input`[^30][^32] |
| Result return | `CallToolResult` fed back as `tools/call` response[^7] | `{"role": "tool", "tool_call_id": ..., "content": ...}`[^31] | `tool_result` content block with `tool_use_id`, `content`, optional `is_error`[^30] |

**MCP tool → OpenAI translation example:**

```json
// MCP tools/list entry
{
  "name": "get_weather",
  "description": "Get current weather for a location",
  "inputSchema": {
    "type": "object",
    "properties": { "location": { "type": "string" } },
    "required": ["location"]
  }
}
```

```json
// OpenAI tools[] entry (direct field remap)
{
  "type": "function",
  "function": {
    "name": "get_weather",
    "description": "Get current weather for a location",
    "parameters": {
      "type": "object",
      "properties": { "location": { "type": "string" } },
      "required": ["location"]
    }
  }
}
```

**Same MCP tool → Anthropic translation:**

```json
{
  "name": "get_weather",
  "description": "Get current weather for a location",
  "input_schema": {
    "type": "object",
    "properties": { "location": { "type": "string" } },
    "required": ["location"]
  }
}
```

Practical notes for the harness's translation layer:

- OpenAI's `strict: true` mode requires `additionalProperties: false` on every object level and *every* property listed in `required` (optional fields become nullable types instead of omitted) — this is stricter than MCP's own JSON Schema, so enabling strict mode may require the harness to post-process MCP schemas rather than pass them through verbatim.[^31][^33]
- Anthropic's tool-call arguments arrive pre-parsed as a dict in the `input` field of the `tool_use` block, while OpenAI's Chat Completions API returns arguments as a JSON string that the harness must parse itself.[^34][^30]
- When feeding a tool's result back, map MCP's `CallToolResult.isError` to Anthropic's `tool_result.is_error` and to an OpenAI `role: "tool"` message whose content communicates the failure in plain text, since OpenAI's tool-message schema has no dedicated boolean error flag.[^30][^31]
- MCP's `content` blocks (text/image/audio/resource) should be flattened to a single string or the multi-part content structure each provider's tool-result field accepts; images from MCP `ImageContent` map naturally to Anthropic's multi-block `tool_result.content` array.[^15][^30]

## Error Shapes and Retry Guidance

MCP distinguishes two categorically different failure types, and conflating them is a common integration bug:[^35][^10]

- **Protocol-level errors**: a standard JSON-RPC `error` object (`code`, `message`, optional `data`) returned instead of `result`. Reserved for transport/protocol failures the model should never see — malformed requests, unknown methods, unsupported tool names. Standard codes: `-32700` parse error, `-32600` invalid request, `-32601` method not found, `-32602` invalid params, `-32603` internal error.[^36][^1]
- **Tool-domain errors**: a normal, successful JSON-RPC `result` containing a `CallToolResult` with `isError: true` and a descriptive message in `content`. This is how the spec wants recoverable business/runtime failures (bad arguments, downstream API failures, timeouts) surfaced — as content the model can read and self-correct from, not a raw protocol error.[^37][^10][^35]

**Protocol-level error response:**

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "error": {
    "code": -32602,
    "message": "Invalid params: 'location' is required"
  }
}
```

**Tool-domain error (still a successful JSON-RPC result):**

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "result": {
    "content": [
      { "type": "text", "text": "Service temporarily unavailable. The order database is under high load; retry is safe." }
    ],
    "isError": true
  }
}
```

**Retry guidance for the harness:**

- Never retry on protocol-level errors like `-32601` (method not found) or `-32602` (invalid params) without changing the request — these indicate a client bug or a mismatched tool schema, not a transient condition.[^1]
- Treat `isError: true` results as candidates for a bounded retry loop *only* when the message content signals a transient condition (e.g., an application-level `errorCategory: "transient"` / `isRetryable: true` convention some servers embed in `structuredContent`, though this is not a protocol-mandated field).[^38][^39]
- On `notifications/cancelled` timeouts, retry with backoff and a fresh request `id`; do not reuse the cancelled request's `id`.[^25][^9]
- On transport-level failure (`CONNECTION_CLOSED` for stdio process exit or HTTP connection drop), the harness should attempt to re-establish the session via a full `initialize` handshake rather than assuming state survived — Streamable HTTP sessions in older spec revisions are stateful and tied to an `Mcp-Session-Id`, so a dropped connection generally requires reinitializing.[^3][^25]
- Cap retries at a small fixed count (2–3) per tool call before surfacing the failure to the LLM as a final `isError` content block, so the agent loop can reason about giving up rather than looping indefinitely.[^40][^41]

## Pitfalls List

- **Batching the `initialize` request**: the spec explicitly forbids including `initialize` in a JSON-RPC batch — doing so breaks negotiation on some servers.[^4][^5]
- **Treating `stderr` as an error signal on stdio**: the spec states clients should *not* assume stderr output indicates an error condition; use it only for optional logging.[^2]
- **Assuming `npx` is directly spawnable on Windows**: it is a `.cmd` script; direct `spawn("npx", …)` throws `ENOENT` without a `cmd /c` wrapper or absolute path.[^22][^23]
- **Sending bearer tokens in query strings**: explicitly forbidden by the spec; tokens must only appear in the `Authorization` header.[^19][^11]
- **Conflating protocol errors with tool errors**: returning a JSON-RPC `error` for a recoverable tool failure hides the failure from the LLM instead of letting it self-correct via `isError: true` content.[^10][^35]
- **Reusing a cancelled request's `id`**: the sender should ignore any late response for a cancelled ID, and reusing that ID for a new request risks ambiguous correlation.[^9]
- **Ignoring `notifications/tools/list_changed`**: caching `tools/list` results indefinitely will silently drift from the server's actual tool catalog if the server declares `listChanged` and later updates it.[^6]
- **Passing MCP schemas straight into OpenAI strict mode**: without adding `additionalProperties: false` and listing every field in `required`, strict-mode validation will reject schemas that are otherwise valid MCP `inputSchema` objects.[^33][^31]
- **Assuming HTTP OAuth applies to stdio servers**: the authorization spec is scoped to HTTP-based transports only; stdio credential handling is an environment/config concern, not a protocol concern.[^12]
- **Blocking indefinitely on `tools/call` with no client-side timeout**: MCP cancellation is advisory and best-effort — the receiver may ignore it — so the harness must enforce its own deadline rather than relying on the server to respect cancellation promptly.[^9]

---

## References

1. [MCP JSON-RPC 2.0 Message Format - MCPserver.in Docs ...](https://www.mcpserver.in/docs/protocol/json-rpc/) - Discover and deploy MCP servers. Hosted infrastructure for AI agents with India-region hosting and c...

2. [Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) - In the Streamable HTTP transport, the server operates as an independent process that can handle mult...

3. [MCP Transport: Stdio vs Streamable HTTP](https://www.truefoundry.com/blog/mcp-stdio-vs-streamable-http-enterprise) - Stdio is fine for local development. Streamable HTTP is what enterprise MCP deployments actually nee...

4. [Lifecycle](https://modelcontextprotocol.io/specification/2025-03-26/basic/lifecycle)

5. [Blog 3: The Handshake - MCP Lifecycle and Capability Negotiation](https://cbruyndoncx.github.io/MCP-Learnings/3-Official-mcp-spec-tutes/Blogs/blog-3) - Blog 3: The Handshake - MCP Lifecycle and Capability Negotiation Series: Deep Dive into the Model Co...

6. [Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)

7. [Schema Reference - What is the Model Context Protocol (MCP)?](https://modelcontextprotocol.io/specification/2025-11-25/schema)

8. [notifications/cancelled — MCP Notification | DevShelfHub](https://www.devshelfhub.com/tutorials/mcp/reference/notifications/notifications-cancelled/) - notifications/cancelled: Best-effort cancellation of an in-flight request. Payload fields, examples,...

9. [Cancellation](https://modelcontextprotocol.io/specification/2025-03-26/basic/utilities/cancellation) - The Model Context Protocol (MCP) supports optional cancellation of in-progress requests through noti...

10. [Errors | MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/v2/servers/errors.html) - The TypeScript SDK implementation of the Model Context Protocol specification.

11. [Authorization](https://modelcontextprotocol.io/specification/draft/basic/authorization) - A protected MCP server acts as an OAuth 2.1 resource server, capable of accepting and responding to ...

12. [OAuth on MCP: The Comprehensive Implementation Guide](https://www.permit.io/blog/oauth-on-mcp) - They add a bearer token, call it "secure," and then let the agent do whatever the server's broad tok...

13. [Lifecycle - Model Context Protocol](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)

14. [Connection Lifecycle and Capabilities](https://deepwiki.com/modelcontextprotocol/modelcontextprotocol/2.4-connection-lifecycle-and-capabilities) - This document details the Model Context Protocol (MCP) connection lifecycle, including the shift tow...

15. [Tools](https://modelcontextprotocol.info/docs/concepts/tools/) - Enable LLMs to perform actions through your server

16. [tools/call — MCP Method | DevShelfHub](https://www.devshelfhub.com/tutorials/mcp/reference/methods/tools-call/) - tools/call: Invoke a tool by name with arguments. Request params, result type, and examples from the...

17. [specification/docs/specification/2025-03-26/basic/_index.md at main · modelcontextprotocol/specification](https://github.com/modelcontextprotocol/specification/blob/main/docs/specification/2025-03-26/basic/_index.md) - The specification of the Model Context Protocol. Contribute to modelcontextprotocol/specification de...

18. [OAuth 2.1, Bearer Tokens, and What the Spec Actually ...](https://mcpplaygroundonline.com/blog/mcp-server-oauth-authentication-guide)

19. [Authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)

20. [MCP Authentication: OAuth 2.1 in MCP Explained](https://www.authgear.com/post/mcp-authentication/) - How MCP authentication works: the OAuth 2.1 authorization spec, PKCE, RFC 9728 protected resource me...

21. [MCP OAuth 2.1: PKCE, Scopes & Token Management](https://www.practical-devsecops.com/mcp-oauth-2-1-implementation/) - MCP OAuth 2.1: PKCE, refresh token rotation, scope enforcement, resource indicators, session managem...

22. [Fix "spawn npx ENOENT" in MCP Server Setup](https://mcptools.tools/guides/fix-spawn-npx-enoent) - This error means the MCP client cannot find the npx command. It is the single most common MCP setup ...

23. [Claude Code MCP on Windows: 2026 Fix Guide](https://mcp.directory/blog/claude-code-mcp-on-windows-native-wsl-2026-complete-fix-guide) - The complete fix guide for running Claude Code with MCP on Windows 11. Two paths (WSL2 + native), ev...

24. [Client | MCP TypeScript SDK (v1)](https://ts.sdk.modelcontextprotocol.io/client.html) - Documentation for v1.x of the MCP TypeScript SDK.

25. [jsonrpc_dispatcher - MCP Python SDK](https://py.sdk.modelcontextprotocol.io/v2/api/mcp/shared/jsonrpc_dispatcher/) - The official Python SDK for the Model Context Protocol

26. [Function Calling Guide: GPT, Claude & Gemini (2026)](https://ofox.ai/blog/function-calling-tool-use-complete-guide-2026/) - Master tool use across OpenAI GPT, Claude, and Gemini. Covers parallel calls, multi-step agent loops...

27. [LLM Function Calling 2026: Tool Use Across Providers - Future AGI](https://futureagi.com/blog/llm-function-calling-2025/) - How LLM function calling works in 2026. JSON Schema, OpenAI tools, Anthropic tools, structured outpu...

28. [Function calling | OpenAI API](https://developers.openai.com/api/docs/guides/function-calling) - The tool call output can either be structured JSON or plain text, and it should contain a reference ...

29. [OpenAI Function Calling JSON Schema: Copy-Paste Examples](https://bytetools.io/guides/openai-function-calling) - The correct JSON schema format for OpenAI function parameters — fix 'parameters must be object', req...

30. [Tessl Tile for pypi/anthropic@0.66.0](https://tessl.io/registry/tessl/pypi-anthropic/0.66.0/files/docs/tools.md) - The official Python library for the anthropic API

31. [OpenAI Function Calling Guide - API易文档中心](https://docs.apiyi.com/en/api-capabilities/openai/function-calling)

32. [Tool use with Claude — Intermediate Documentation (Free ...](https://www.beri.net/learning/anthropic-tool-use-claude) - Anthropic's official reference for tool use, or function calling, on the Claude API. It explains the...

33. [Function Calling and Tool Use for AI Agents - Let's Data Science](https://letsdatascience.com/blog/function-calling-tool-use-ai-agents) - Master function calling for AI agents using structured JSON schemas. Learn to connect LLMs to real-w...

34. [LLM Function Calling and Tool Use Guide 2026: OpenAI, Anthropic, Goo…](https://baeseokjae.github.io/posts/llm-function-calling-tool-use-guide-2026/) - Complete 2026 guide to LLM function calling across OpenAI, Anthropic, and Google Gemini—with code, s...

35. [CallToolResult in rust_mcp_schema - Rust - Docs.rs](https://docs.rs/rust-mcp-schema/latest/rust_mcp_schema/struct.CallToolResult.html) - The server’s response to a tool call.

36. [Class CallToolResult - MCP C# SDK](https://csharp.sdk.modelcontextprotocol.io/api/ModelContextProtocol.Protocol.CallToolResult.html) - Represents the result of a request from a client to invoke a tool provided by the server.

37. [CallToolResult in mcp_attr::schema - Rust - Docs.rs](https://docs.rs/mcp-attr/latest/mcp_attr/schema/struct.CallToolResult.html) - The server’s response to a tool call.

38. [Tool Annotations and Structured Output | xyTom/coding-tools-mcp | DeepWiki](https://deepwiki.com/xyTom/coding-tools-mcp/9.1-tool-annotations-and-structured-output) - This page describes the normative requirements for tool metadata and result formats in the `coding-t...

39. [2.2 — Structured Error Responses - Claude Certification Guide](https://claudecertificationguide.com/learn/2-tool-design-mcp/2-2-structured-error-responses) - Implementing structured error responses for MCP tools with proper categorisation and recovery metada...

40. [Error Handling in MCP Tools - ApX Machine Learning](https://apxml.com/courses/getting-started-model-context-protocol/chapter-3-implementing-tools-and-logic/error-handling-reporting)

41. [MCP Tools: Input Schema & Error Handling - DevShelfHub](https://www.devshelfhub.com/tutorials/mcp/tools-deep-dive/) - Master MCP tool design: JSON Schema for input validation, result formatting, error types, annotation...


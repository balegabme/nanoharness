# Secrets

A key you paste into the chat is taken out of the message before anything else
happens to it. What stays behind is a reference — `{{secret:openrouter_key}}` —
and that reference is what the window draws, what the transcript stores, and
what the model reads. The value itself never leaves the main process.

Files:
- src/core/secrets.ts — detection, the vault, placeholder substitution, and the prompt block
- src/main/secret-store.ts — the app-wide vault, encrypted at rest with `safeStorage`

## The rule

The model never sees a secret. Not once, not in the first message, not in a
tool call it wrote itself. It works with references, and the harness swaps the
real value in at the last possible moment — inside tool execution, after the
provider has already been paid and answered.

That is a stronger promise than "the transcript is clean". A harness that sent
the real key and only redacted the file on disk would still have put the key on
the wire, in the provider's logs, and in whatever the provider caches. Here the
key does not cross the network to the provider at all.

It also survives a restart. The transcript on disk holds placeholders, so a
session re-opened tomorrow is in exactly the state a session is in today: the
model reading a reference it cannot resolve, and a harness that can.

## The path a key takes

1. **Capture.** `SecretVault.capture()` runs over the text of every message.
   It finds keys three ways: by vendor prefix (`sk-ant-…`, `ghp_…`, `AIza…`
   and a dozen more), by context (`api_key: <20+ characters>`), and by shape.
   Each hit is stored under a name derived from what it looks like —
   `anthropic_key`, `github_token` — and the text keeps the reference in its
   place.

   The shape rule is the one that catches a vendor nobody wrote a pattern for:
   a short word, an underscore, then forty or more letters and digits with
   upper case, lower case and a digit all present. A key pasted bare, with no
   "my key is" in front of it and a prefix the list has never seen, used to go
   straight into the window and the transcript. What the rule deliberately does
   not match is what a long random-looking string usually turns out to be: a
   git SHA is lowercase hex with no prefix, base64 carries `+`, `/` and `=`, an
   npm integrity hash is `sha512-` with a hyphen, and a snake_case identifier
   is neither forty characters long nor mixed case.

   The window calls this before it draws the message, so the key is never on
   screen. The main process calls it again on the way in, so a key that reaches
   the session by some other route is still caught. Storing is idempotent by
   value: pasting the same key twice does not make a second entry.

2. **Prompt.** `secretsBlock()` adds a short paragraph to the system prompt
   naming the references that exist and saying they are live — otherwise the
   model reads `{{secret:tavily_key}}` as a placeholder somebody forgot to fill
   in, and asks the user for the key it already has.

3. **Substitution.** `Session.runWithArgs` passes the parsed tool arguments
   through `revealDeep()` on the way into `tool.run()`. Every string in the
   argument object, however deeply nested, has its references replaced with the
   real values. The tool sees the key; nothing above it does.

   **Except for tools that do not use their arguments but retell them.** A tool
   marked `keepsPlaceholders` gets them exactly as the model wrote them.
   `spawn` is one: its `task` becomes a subagent's first message, so filling it
   in would hand the key to a child session, which would send it to the
   provider on its first request — the leak the whole design exists to prevent,
   reached through the front door. `job_update` is the other: its note is text
   for the window and for the parent's journal on disk. The test for a new tool
   is simple. Does it *use* the argument, or does it turn the argument into
   text somebody else reads? The second kind keeps the placeholder.

4. **Scrub.** `Session.executeTool` runs the result back through `redact()`
   before it becomes a transcript message. A key that a tool prints — an echoed
   command line, a config file the model asked to read, an error quoting the
   request — turns back into its reference on the way out. The journal goes
   through the same scrub, because it is written to the same file: a note, and
   the message of a tool that threw rather than returned.

   The model's own words go through it too — every text and thinking delta on
   its way to the window, the answer as it is stored, and an unsigned thinking
   block. It should never be holding a key, because everything it reads has
   already been scrubbed; the point is that what is drawn and what is written
   down do not depend on that holding. A signed thinking block is the one
   exception: editing it breaks the signature the API verifies, and it is the
   one thing that must go back byte for byte.

A key pasted into a session that is already running gets one more thing: the
session is retired, so the next turn rebuilds its system prompt with the new
name in it. That costs a cache miss and an MCP restart, once, the first time a
key appears — and the alternative is a model reading `{{secret:name}}` with
nothing in its prompt explaining it, which is the failure the block exists to
prevent.

What decides it is `hasUnknownSecret(built, current)`: the names the session's
prompt was built with, against the names the vault holds now. The first version
counted instead — how many secrets existed before this message, against after —
and it never once fired. The window captures a pasted key before it draws the
message, so by the time the main process handles that same message the key is
already stored and capturing again is idempotent. The count was taken after the
growth it was watching for. Comparing names also catches a key that arrived by
some other route entirely: a paste into settings, an `nh mcp add`, a tool that
wrote one.

## What this costs

Substitution applies to any tool, `write` included, so a model that writes
`{{secret:openai_key}}` into a file gets a file with the real key in it. That
is the point when the file is a `.env` the user asked for, and a leak when it
is a file they did not think about. The harness does not try to guess which is
which: it is the same rule everywhere, which is the only version of this that
can be reasoned about.

Pattern matching also has the two failure modes every pattern matcher has. A
key in an unusual format with no label around it is not caught, and a long
random-looking string that is not a key can be.

The second is survivable rather than free. Tools still receive what they would
have received — the reference resolves back to the same string — but `redact`
now rewrites that string out of every tool result in every session, so a hash
that was wrongly captured comes back as a placeholder wherever it is read. That
is why **Settings › Secrets** lists what the vault holds and offers to forget
any of it: automatic capture without a way to see what it took is a black box
with the user's data in it.

Forgetting is not free either. A reference in a transcript outlives the key it
names, and `reveal` leaves an unknown reference alone rather than resolving it
to an empty string — a request with no credential is a clearer failure than one
with a blank one. The confirmation says so before the key goes.

## At rest

`secret-store.ts` keeps one vault for the whole app and writes it to
`secrets.bin` in the user data directory, encrypted with Electron's
`safeStorage` — DPAPI on Windows, the Keychain on macOS, libsecret on Linux.
Writes are serialised, so two captures in the same turn cannot interleave into
a half-written file.

When the platform has no encryption available, the vault still works and still
holds the keys for the session — it simply never writes them down. A key that
would have to be stored in plain text is a key the harness would rather ask for
again.

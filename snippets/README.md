# Built-in snippets

The prompt snippets that ship with the app. Each is a Markdown file whose
frontmatter gives its `name`, `description`, `placement` (`prepend` or `append`)
and `order`, followed by the text it adds to a message. The build copies them
to `out/snippets/`. A file of the same name in the user's data directory or in a
project's `.nanoharness/snippets/` replaces one of these; see
[docs/harness/commands.md](../docs/harness/commands.md). They hold no secrets
(plan §16).

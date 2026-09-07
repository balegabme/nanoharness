// doc: docs/harness/mcp.md
import { isJsonObject } from './protocol.js'
import type { JsonSchema } from '../core/types.js'

/**
 * An MCP server publishes whole JSON Schema; this harness passes a narrow
 * subset to providers. The gap is real: `$ref`, `oneOf`, `format`, `const` and
 * a dozen other keywords are legal in an `inputSchema` and mean nothing to a
 * tool definition, and some of them are rejected outright by strict mode.
 *
 * So an MCP schema is narrowed rather than forwarded. What survives is what a
 * model needs in order to fill the arguments in: the shape, the names, the
 * types, the descriptions and the enums. What is dropped was never going to
 * change what the model typed.
 */

const TYPES = new Set(['string', 'number', 'boolean', 'object', 'array', 'null'])

type SchemaType = JsonSchema['type']

/**
 * The type of a schema node. A union (`["string","null"]`) becomes its first
 * non-null member, because a tool argument that may also be null is still, to
 * the model filling it in, a string. `integer` is JSON Schema's; `number` is
 * the only thing the provider layer knows.
 */
function typeOf(node: Record<string, unknown>): SchemaType {
  const raw = node.type
  const candidates = Array.isArray(raw) ? raw : [raw]
  for (const candidate of candidates) {
    if (candidate === 'integer') return 'number'
    if (typeof candidate === 'string' && candidate !== 'null' && TYPES.has(candidate)) return candidate as SchemaType
  }
  // No usable type. An object with properties is an object whether it said so
  // or not; anything else is described in prose and passed as a string.
  //
  // The fallback is not cosmetic. `anyOf`, `oneOf` and `$ref` are ordinary in a
  // published `inputSchema` and none of them carry a `type`, so dropping a node
  // that has none would take a *required* argument out of the tool definition
  // — the model could never supply it, and every call would come back -32602
  // with nothing in the log to say why. A string the server rejects is a
  // failure the model can read and correct; a missing argument is not.
  if (isJsonObject(node.properties)) return 'object'
  if (isJsonObject(node.items)) return 'array'
  return 'string'
}

function enumOf(node: Record<string, unknown>): JsonSchema['enum'] | undefined {
  if (!Array.isArray(node.enum)) return undefined
  const values = node.enum.filter(
    (value): value is string | number | boolean | null =>
      value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean',
  )
  return values.length === 0 ? undefined : values
}

/**
 * Narrow one node. Null only for something that is not a schema at all, or for
 * nesting deep enough that a model would not read it anyway — never for a node
 * this code merely failed to understand.
 */
export function narrowSchema(value: unknown, depth = 0): JsonSchema | null {
  if (!isJsonObject(value) || depth > 8) return null
  const schema: JsonSchema = { type: typeOf(value) }
  if (typeof value.description === 'string' && value.description !== '') schema.description = value.description
  const values = enumOf(value)
  if (values !== undefined) schema.enum = values

  if (schema.type === 'object') {
    const source = isJsonObject(value.properties) ? value.properties : {}
    const properties: Record<string, JsonSchema> = {}
    for (const [name, child] of Object.entries(source)) {
      const narrowed = narrowSchema(child, depth + 1)
      if (narrowed !== null) properties[name] = narrowed
    }
    schema.properties = properties
    const required = Array.isArray(value.required)
      ? value.required.filter((name): name is string => typeof name === 'string' && name in properties)
      : []
    if (required.length > 0) schema.required = required
    if (value.additionalProperties === false) schema.additionalProperties = false
  }

  if (schema.type === 'array') {
    const items = narrowSchema(value.items, depth + 1)
    // An array whose item type is unknown still tells the model it wants a
    // list, and a list of strings is the overwhelmingly common case.
    schema.items = items ?? { type: 'string' }
  }

  return schema
}

/** A tool's top-level schema, which is an object even when the server says so badly. */
export function narrowInputSchema(value: unknown): JsonSchema & { type: 'object' } {
  const narrowed = narrowSchema(value)
  if (narrowed !== null && narrowed.type === 'object') return narrowed as JsonSchema & { type: 'object' }
  return { type: 'object', properties: {} }
}

/** Both providers refuse a tool name longer than this, with a 400. */
const NAME_CAP = 64

/**
 * `mcp__<server>__<tool>`, with anything a provider might reject taken out of
 * the two names. The prefix is what keeps a server's `search` from colliding
 * with a built-in `read`, and keeps two servers' `search` apart; it is derived
 * from the configured name rather than generated, so the tool definitions —
 * which sit in front of every message — are the same bytes on every request and
 * the provider's cache keeps answering them.
 *
 * A long server name plus a long tool name can exceed what either provider
 * accepts, and that failure is not one bad tool: the name sits in the
 * definitions block, so every request of the session is a 400. The tail is
 * therefore trimmed and given a short digest of what was trimmed, which keeps
 * the result inside the cap, unique, and — because it is derived, not counted —
 * the same bytes on every request.
 */
export function toolName(server: string, tool: string): string {
  const full = `mcp__${slug(server)}__${slug(tool)}`
  if (full.length <= NAME_CAP) return full
  const digest = hash(full)
  return `${full.slice(0, NAME_CAP - digest.length - 1)}_${digest}`
}

/** Six hex characters of FNV-1a: enough to keep two trimmed names apart. */
function hash(value: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0').slice(0, 6)
}

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_')
}

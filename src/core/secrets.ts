// doc: docs/harness/secrets.md

/**
 * A key the user pasted, held here and nowhere else.
 *
 * The rule is one sentence: the model never sees the value. A pasted key is
 * caught on its way into the conversation, stored in memory under a name, and
 * replaced by `{{secret:name}}` before anything is drawn, stored or sent. The
 * placeholder is what goes in the transcript on disk, what the window shows,
 * and what the provider receives. The real bytes are put back in exactly one
 * place — the arguments of a tool call, at the moment it runs — and taken back
 * out of whatever that tool returns.
 *
 * So the key crosses no network the user did not ask for. It is not in the
 * provider's request log, not in `sessions/*.json`, and not on screen. What the
 * model can do with it is the only thing it needs to: pass it along.
 *
 * The value is never written to disk by this module. It lives for the life of
 * the process (`src/main/secret-store.ts` decides whether it outlives that).
 */

/** The shape a placeholder takes, and the only thing the model ever sees. */
export function placeholder(name: string): string {
  return `{{secret:${name}}}`
}

const REFERENCE = /\{\{secret:([A-Za-z0-9_]+)\}\}/g

/**
 * Shapes that are a key and nothing else. Each one is a vendor's own prefix,
 * so a match is a key rather than a guess — which is why the list is worth
 * keeping even though `PREFIXED` below catches most of the same strings: a hit
 * here knows whose key it is, and names it in settings accordingly.
 */
const PATTERNS: readonly { hint: string; re: RegExp }[] = [
  { hint: 'anthropic_key', re: /sk-ant-[A-Za-z0-9_-]{24,}/g },
  { hint: 'openrouter_key', re: /sk-or-v1-[A-Za-z0-9]{32,}/g },
  { hint: 'openai_key', re: /sk-proj-[A-Za-z0-9_-]{24,}/g },
  { hint: 'openai_key', re: /sk-[A-Za-z0-9]{32,}/g },
  { hint: 'github_token', re: /github_pat_[A-Za-z0-9_]{50,}/g },
  { hint: 'github_token', re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { hint: 'gitlab_token', re: /glpat-[A-Za-z0-9_-]{20,}/g },
  { hint: 'google_key', re: /AIza[A-Za-z0-9_-]{35}/g },
  { hint: 'tavily_key', re: /tvly-[A-Za-z0-9_-]{16,}/g },
  { hint: 'slack_token', re: /xox[abposr]-[A-Za-z0-9-]{12,}/g },
  { hint: 'stripe_key', re: /[sr]k_(?:live|test)_[A-Za-z0-9]{20,}/g },
  { hint: 'huggingface_token', re: /hf_[A-Za-z0-9]{32,}/g },
  { hint: 'aws_key_id', re: /(?:AKIA|ASIA)[0-9A-Z]{16}/g },
]

/**
 * The vendors nobody has a pattern for. A service the list has never heard of
 * still issues `<word>_<blob>`, and a user who pastes one bare — no "my key
 * is" in front of it — was getting it into the window and the transcript.
 *
 * The shape does the work the prefix list cannot: a short word, an underscore,
 * then forty or more letters and digits with upper case, lower case and a
 * digit all present. That is what an issued token looks like and what the
 * things it gets confused with do not: a git SHA is lowercase hex with no
 * prefix, base64 carries `+`, `/` and `=`, an npm integrity hash is
 * `sha512-` with a hyphen, and a snake_case identifier is neither forty
 * characters long nor mixed case.
 */
const PREFIXED = /(?<![A-Za-z0-9_-])[A-Za-z][A-Za-z0-9]{1,11}_([A-Za-z0-9]{40,})(?![A-Za-z0-9_-])/g

/** Upper, lower and a digit: an issued token rather than a long word. */
function keylike(value: string): boolean {
  return /[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value)
}

/**
 * The other half: a key with no recognisable prefix, caught by what the user
 * wrote next to it. "my tavily key is <blob>" is a key; the same blob on its
 * own is a string, and guessing at it would redact file hashes and base64 out
 * of ordinary messages.
 */
const LABELLED = /\b(?:api[_ -]?key|apikey|access[_ -]?token|auth[_ -]?token|bearer|secret|password|passwd|token|key)\b\s*(?:is\s+|[:=]\s*)["'`]?([A-Za-z0-9_\-+=]{20,})["'`]?/gi

/** A labelled candidate has to look like a key rather than like a sentence. */
function plausible(value: string): boolean {
  return /[0-9]/.test(value) && /[A-Za-z]/.test(value)
}

interface Hit {
  start: number
  end: number
  value: string
  hint: string
}

/** Every key-shaped run in `text`, non-overlapping, leftmost-longest. */
export function findSecrets(text: string): { value: string; hint: string }[] {
  const hits: Hit[] = []
  for (const { hint, re } of PATTERNS) {
    re.lastIndex = 0
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      hits.push({ start: m.index, end: m.index + m[0].length, value: m[0], hint })
    }
  }
  PREFIXED.lastIndex = 0
  for (let m = PREFIXED.exec(text); m !== null; m = PREFIXED.exec(text)) {
    const blob = m[1]
    if (blob === undefined || !keylike(blob)) continue
    hits.push({ start: m.index, end: m.index + m[0].length, value: m[0], hint: 'secret' })
  }
  LABELLED.lastIndex = 0
  for (let m = LABELLED.exec(text); m !== null; m = LABELLED.exec(text)) {
    const value = m[1]
    if (value === undefined || !plausible(value)) continue
    const start = m.index + m[0].lastIndexOf(value)
    hits.push({ start, end: start + value.length, value, hint: 'secret' })
  }

  // Longest first at the same start, so `sk-ant-…` wins over any shorter run
  // inside it, and a hit already covered by an accepted one is dropped.
  hits.sort((a, b) => a.start - b.start || b.end - a.end)
  const kept: Hit[] = []
  let reach = -1
  for (const hit of hits) {
    if (hit.start < reach) continue
    kept.push(hit)
    reach = hit.end
  }
  return kept.map(hit => ({ value: hit.value, hint: hit.hint }))
}

export interface StoredSecret {
  name: string
  value: string
  /** The vendor the shape belongs to, for the list in settings. */
  hint: string
  at: number
}

/**
 * The vault. It is deliberately small and synchronous: every path that touches
 * a secret — drawing a message, running a tool, storing a transcript — is on a
 * hot path where an await would be one more place to forget.
 */
export class SecretVault {
  private readonly byName = new Map<string, StoredSecret>()
  /** Value to name, so the same key pasted twice is one entry, not two. */
  private readonly byValue = new Map<string, string>()

  constructor(
    /** Called whenever the set changes, so the store can persist it. */
    private readonly onChange: (secrets: StoredSecret[]) => void = () => undefined,
  ) {}

  list(): StoredSecret[] {
    return [...this.byName.values()].sort((a, b) => a.at - b.at)
  }

  names(): string[] {
    return this.list().map(secret => secret.name)
  }

  /** Load a stored set without firing a change back at whoever loaded it. */
  restore(secrets: readonly StoredSecret[]): void {
    for (const secret of secrets) {
      if (secret.name === '' || secret.value === '') continue
      this.byName.set(secret.name, secret)
      this.byValue.set(secret.value, secret.name)
    }
  }

  /** Store a value and return the name it is now known by. Idempotent. */
  put(value: string, hint = 'secret'): string {
    const known = this.byValue.get(value)
    if (known !== undefined) return known
    let name = hint
    for (let n = 2; this.byName.has(name); n += 1) name = `${hint}_${n}`
    this.byName.set(name, { name, value, hint, at: Date.now() })
    this.byValue.set(value, name)
    this.onChange(this.list())
    return name
  }

  remove(name: string): boolean {
    const secret = this.byName.get(name)
    if (secret === undefined) return false
    this.byName.delete(name)
    this.byValue.delete(secret.value)
    this.onChange(this.list())
    return true
  }

  /**
   * Catch every key in a message the user just wrote, store it, and hand back
   * the message with placeholders in its place. This runs before the text is
   * drawn, so the raw key is never on screen and never in the transcript.
   */
  capture(text: string): { text: string; captured: string[] } {
    const captured: string[] = []
    let out = text
    for (const { value, hint } of findSecrets(text)) {
      const name = this.put(value, hint)
      if (!captured.includes(name)) captured.push(name)
      out = out.split(value).join(placeholder(name))
    }
    return { text: out, captured }
  }

  /**
   * Placeholders back to values. Only tool arguments go through here, and only
   * at the moment the tool runs.
   */
  reveal(text: string): string {
    return text.replace(REFERENCE, (whole, name: string) => this.byName.get(name)?.value ?? whole)
  }

  /** `reveal` over every string in a parsed tool-argument object. */
  revealDeep(value: unknown): unknown {
    if (typeof value === 'string') return this.reveal(value)
    if (Array.isArray(value)) return value.map(item => this.revealDeep(item))
    if (typeof value === 'object' && value !== null) {
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = this.revealDeep(item)
      return out
    }
    return value
  }

  /**
   * Values back to placeholders. Everything coming *out* of a tool goes through
   * here, because a shell that echoes its own arguments — or a config file read
   * back — would otherwise put the key straight into the conversation.
   */
  redact(text: string): string {
    if (text === '') return text
    let out = text
    for (const secret of this.byName.values()) {
      if (out.includes(secret.value)) out = out.split(secret.value).join(placeholder(secret.name))
    }
    return out
  }

  /** True when nothing is stored, which is the usual case. */
  get empty(): boolean {
    return this.byName.size === 0
  }
}

/**
 * Whether a prompt built with `built` would leave a reference unexplained. The
 * caller holds a live session whose system prompt named the secrets that
 * existed when it was constructed; a key captured since then is one the model
 * will meet as `{{secret:name}}` with nothing to tell it the value is real.
 *
 * It compares names rather than counts on purpose. Capture is idempotent, and
 * the window captures a message before the main process sees it, so a count
 * taken on the way in has already grown — measured that way the new key never
 * looks new, and the session that needs rebuilding never gets rebuilt.
 */
export function hasUnknownSecret(built: readonly string[], current: readonly string[]): boolean {
  return current.some(name => !built.includes(name))
}

/**
 * What the agent is told, and it needs telling. A model handed
 * `{{secret:tavily_key}}` with no explanation does one of two things: it stops
 * and asks the user for the real key, or it writes `YOUR_KEY_HERE` and calls
 * the job done. Both are the same bug — it does not know the placeholder is
 * live — and four lines fix it.
 */
export function secretsBlock(names: readonly string[]): string[] {
  if (names.length === 0) return []
  return [
    '',
    `Secrets held by the harness: ${names.map(name => `{{secret:${name}}}`).join(', ')}.`,
    'Each one is a real credential the user gave. You cannot read its value and do not need to: write the placeholder exactly as it appears, anywhere a tool argument would take the key — a curl header, an environment assignment, a config file — and the harness substitutes the real value as the tool runs.',
    'Never ask the user for the value, never invent one, and never write a stand-in such as YOUR_KEY_HERE. A placeholder that reaches a tool works; a placeholder you paraphrase does not.',
    'Tool output comes back with the value replaced by the same placeholder, so a key you echo will not appear. That is the redaction working, not a failed command.',
  ]
}

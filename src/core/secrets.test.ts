import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Session, defineTool } from './session.js'
import { SecretVault, hasUnknownSecret, secretsBlock } from './secrets.js'
import { emptyUsage } from './types.js'
import type { Tool } from './session.js'
import type { ChatInput, ChatProvider } from './provider.js'
import type { ChatChunk, ToolResult } from './types.js'

/**
 * The promise this feature makes is that a key reaches the tool that needs it
 * and nothing else: not the provider, not the transcript, not the journal. So
 * these tests read the provider's own record of every request it was handed,
 * and the session file's worth of state that survives a turn — the two places
 * a leak would actually show up.
 */

const KEY = 'sk-ant-api03-QRZ8x2LmN4pT7vB1cD5eF9gH0jK3sL6mN8pQ2rS4tU6vW8xY'

class Recorder implements ChatProvider {
  readonly seen: ChatInput[] = []
  private round = 0

  constructor(private readonly steps: (round: number) => ChatChunk[]) {}

  async *stream(input: ChatInput): AsyncGenerator<ChatChunk> {
    this.seen.push({ ...input, messages: input.messages.map(message => ({ ...message })) })
    this.round += 1
    for (const chunk of this.steps(this.round)) yield chunk
  }

  /** Everything this provider was ever sent, as one string to search. */
  get wire(): string {
    return JSON.stringify(this.seen)
  }
}

function say(text: string): ChatChunk[] {
  return [{ kind: 'text', text }, { kind: 'done', usage: emptyUsage() }]
}

function call(name: string, args: Record<string, unknown>): ChatChunk[] {
  return [{ kind: 'tool', tool: { id: 'c1', name, args: JSON.stringify(args) } }, { kind: 'done', usage: emptyUsage() }]
}

/** A tool that reports what it was actually handed, and echoes it back out. */
function spy(options: { keepsPlaceholders?: boolean } = {}): { tool: Tool; seen: string[] } {
  const seen: string[] = []
  const tool = defineTool<{ header: string }>({
    input: {
      name: 'fetch',
      description: 'call something',
      inputSchema: { type: 'object', properties: { header: { type: 'string' } }, required: ['header'] },
    },
    ...(options.keepsPlaceholders === true ? { keepsPlaceholders: true } : {}),
    parse: args => (typeof args.header === 'string' ? { ok: true, args: { header: args.header } } : { ok: false, error: 'header' }),
    async run({ header }): Promise<ToolResult> {
      seen.push(header)
      // A real endpoint echoes the request back in its errors often enough that
      // this is the normal case, not a contrived one.
      return { ok: true, summary: `sent ${header}`, content: `401 from the server for ${header}` }
    },
  })
  return { tool, seen }
}

async function turn(
  provider: Recorder,
  tools: Tool[],
  vault: SecretVault,
): Promise<{ session: Session; cwd: string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'nh-secrets-'))
  const session = new Session(
    { sessionId: 'test', cwd, model: 'test-model', systemPrompt: 'You are a test.', secrets: vault },
    provider,
    tools,
  )
  return { session, cwd }
}

describe('a key pasted into a message', () => {
  it('reaches the tool and nothing else: not the provider, not the transcript, not the journal', async () => {
    const vault = new SecretVault()
    const captured = vault.capture(`use ${KEY} for the call`)
    expect(captured.text).toBe('use {{secret:anthropic_key}} for the call')

    const watcher = spy()
    const provider = new Recorder(round => (round === 1 ? call('fetch', { header: 'Bearer {{secret:anthropic_key}}' }) : say('done')))
    const { session, cwd } = await turn(provider, [watcher.tool], vault)

    try {
      await session.run(captured.text)

      // The tool ran with the real key.
      expect(watcher.seen).toEqual([`Bearer ${KEY}`])

      // Nothing the provider was handed contains it — not the user message, not
      // the tool result that quoted the request back.
      expect(provider.wire).not.toContain(KEY)
      expect(provider.wire).toContain('{{secret:anthropic_key}}')

      // Nor does anything that gets written to the session file.
      expect(JSON.stringify(session.transcript)).not.toContain(KEY)
      expect(JSON.stringify(session.notes)).not.toContain(KEY)

      // The scrub is what did it: the tool's own output quoted the key.
      const result = session.transcript.find(message => message.role === 'tool')
      expect(result?.content).toContain('{{secret:anthropic_key}}')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('stays a reference for a tool that only turns its arguments into text, which is how a subagent would have been handed one', async () => {
    const vault = new SecretVault()
    vault.capture(KEY)

    // `spawn` is this shape: its argument becomes a child session's first
    // message, so filling it in would put the key straight back on the wire.
    const watcher = spy({ keepsPlaceholders: true })
    const provider = new Recorder(round => (round === 1 ? call('fetch', { header: 'add {{secret:anthropic_key}} to the config' }) : say('done')))
    const { session, cwd } = await turn(provider, [watcher.tool], vault)

    try {
      await session.run('set it up')
      expect(watcher.seen).toEqual(['add {{secret:anthropic_key}} to the config'])
      expect(provider.wire).not.toContain(KEY)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('is scrubbed out of a tool that read it off disk, which is the other direction a key travels', async () => {
    const vault = new SecretVault()
    vault.capture(KEY)

    const leaky = defineTool<Record<string, never>>({
      input: { name: 'read', description: 'read a file', inputSchema: { type: 'object', properties: {} } },
      parse: () => ({ ok: true, args: {} }),
      // The model asks to read `.env`; the file has the key in it.
      async run(): Promise<ToolResult> {
        return { ok: true, summary: 'read .env', content: `ANTHROPIC_API_KEY=${KEY}\n` }
      },
    })

    const provider = new Recorder(round => (round === 1 ? call('read', {}) : say('done')))
    const { session, cwd } = await turn(provider, [leaky], vault)

    try {
      await session.run('what is in .env?')
      expect(provider.wire).not.toContain(KEY)
      expect(JSON.stringify(session.transcript)).toContain('{{secret:anthropic_key}}')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
  it('is taken out of the model\'s own words too, in the window and in the file', async () => {
    const vault = new SecretVault()
    vault.capture(KEY)

    // The model should never be holding a key — everything it reads has been
    // scrubbed first — but the last thing written down should not depend on
    // that holding. Here it says one, in its answer and in its thinking.
    const provider = new Recorder(() => [
      { kind: 'thinking', text: `the key is ${KEY}` },
      { kind: 'thinking_block', block: { kind: 'thinking', text: `the key is ${KEY}` } },
      { kind: 'text', text: `your key is ${KEY}` },
      { kind: 'done', usage: emptyUsage() },
    ])
    const { session, cwd } = await turn(provider, [], vault)
    const drawn: string[] = []
    session.bus.on('text_delta', event => void drawn.push(event.text))
    session.bus.on('thinking_delta', event => void drawn.push(event.text))

    try {
      await session.run('what did I give you?')
      // The window.
      expect(drawn.join('')).not.toContain(KEY)
      expect(drawn.join('')).toContain('{{secret:anthropic_key}}')
      // The file, answer and reasoning both.
      const stored = JSON.stringify(session.transcript)
      expect(stored).not.toContain(KEY)
      expect(stored).toContain('{{secret:anthropic_key}}')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe('the vault', () => {
  it('names a key once however many times it is pasted, and finds the shapes worth finding', () => {
    const vault = new SecretVault()
    expect(vault.capture(KEY).captured).toEqual(['anthropic_key'])
    expect(vault.capture(`again: ${KEY}`).captured).toEqual(['anthropic_key'])
    expect(vault.names()).toEqual(['anthropic_key'])

    // A labelled key with no recognisable shape is still a key.
    const labelled = vault.capture('api_key: 8f3ba91c04d7e256af1b93c0')
    expect(labelled.captured).toHaveLength(1)
    expect(labelled.text).not.toContain('8f3ba91c04d7e256af1b93c0')

    // Prose is not.
    expect(vault.capture('rename the helper in four files').captured).toEqual([])
  })

  it('catches a token from a vendor the list has never heard of, and leaves hashes alone', () => {
    const vault = new SecretVault()

    // Pasted bare, with no label in front of it and no prefix any list knows:
    // the shape rule is what catches it.
    const pasted = 'user_4wV8Y3UT8cvgCpf4YCFVv2LMx2WgREoxvhiVDQHvVvFdhV24atYwGnKwJSauibmLfY8TqKeLiNJrGD3bA8orxrXF'
    const caught = vault.capture(`here it is: ${pasted}`)
    expect(caught.text).toBe('here it is: {{secret:secret}}')
    expect(vault.reveal(caught.text)).toBe(`here it is: ${pasted}`)

    // The things a "long random string" rule would have taken with it: a git
    // SHA, an npm integrity hash, a base64 blob, and an ordinary long name.
    const prose = [
      'fixed in 9f2c1b7a4e6d8039c5a1f7b2e4d6c8a0b3f5d7e9',
      'sha512-Rg8k5vMehIebFhvE1Vp2Wr8Nr5f3xE9tJqLz0aQwPmXcYbNs7Td4Uf6Hj1Kl2Zo3',
      'const request_handler_registry_entry = load()',
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk',
    ].join('\n')
    expect(vault.capture(prose).captured).toEqual([])
  })

  it('tells a live session its prompt is out of date, which a count of what it holds cannot', () => {
    const vault = new SecretVault()
    vault.capture(`the old one: ${KEY}`)

    // What the running session's system prompt was built with.
    const built = vault.names()
    expect(hasUnknownSecret(built, vault.names())).toBe(false)

    // The window captures a pasted key before it draws the message, so by the
    // time the main process handles that same message the key is already
    // stored and capturing again changes nothing. This is the trap: a count
    // taken here never grows, so a session compared that way is never rebuilt.
    const pasted = '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'
    const first = vault.capture(`use ${pasted}`)
    const again = vault.capture(`use ${pasted}`)
    expect(again.text).toBe(first.text)
    expect(vault.names().length).toBe(built.length + 1)

    // Compared by name, the session is told what a count could not tell it.
    expect(hasUnknownSecret(built, vault.names())).toBe(true)
    // And once it has been rebuilt with them, it is left alone.
    expect(hasUnknownSecret(vault.names(), vault.names())).toBe(false)
    expect(secretsBlock(vault.names()).join(' ')).toContain('tavily_key')
  })

  it('leaves a reference it cannot resolve alone rather than sending an empty header', () => {
    const vault = new SecretVault()
    vault.capture(KEY)
    expect(vault.reveal('Bearer {{secret:anthropic_key}}')).toBe(`Bearer ${KEY}`)
    // The name was forgotten, or belongs to another machine's transcript. An
    // empty string here would be a request that looks valid and is not.
    expect(vault.reveal('Bearer {{secret:gone}}')).toBe('Bearer {{secret:gone}}')
  })
})

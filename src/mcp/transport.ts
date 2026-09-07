// doc: docs/harness/mcp.md
import { spawn } from 'node:child_process'
import { ConnectionClosedError, parseMessage } from './protocol.js'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { JsonRpcMessage } from './protocol.js'

/**
 * Two ways to reach an MCP server, behind one interface the client can use
 * without caring which it got.
 *
 * A transport moves envelopes and nothing else: it does not know what
 * `initialize` is, and it never decides that something went wrong at the
 * protocol level. That belongs one layer up.
 */
export interface Transport {
  start(): Promise<void>
  send(message: JsonRpcMessage): Promise<void>
  onMessage(handler: (message: JsonRpcMessage) => void): void
  onClose(handler: (reason: string) => void): void
  close(): Promise<void>
  /**
   * The version the handshake settled on. HTTP has to repeat it on every
   * request after `initialize`; stdio has no use for it, which is why this is
   * optional rather than a method every transport must answer.
   */
  setProtocolVersion?(version: string): void
}

/**
 * `npx` on Windows is `npx.cmd`, a batch script, and `spawn()` does not go
 * through a shell — so spawning it by name fails with ENOENT on the one
 * platform where it looks like it should work. The fix every MCP client ends up
 * with is `cmd /c`, applied only to the script-shaped launchers: `uvx` and an
 * absolute path do not need it and are slower through a shell (plan §7).
 */
const NEEDS_CMD = new Set(['npx', 'npm', 'pnpm', 'yarn', 'bunx', 'npx.cmd', 'npm.cmd', 'pnpm.cmd', 'yarn.cmd', 'bunx.cmd'])

export function stdioCommand(command: string, args: readonly string[]): { command: string; args: string[] } {
  if (process.platform !== 'win32') return { command, args: [...args] }
  if (!NEEDS_CMD.has(command.toLowerCase())) return { command, args: [...args] }
  return { command: 'cmd', args: ['/c', command, ...args] }
}

/**
 * SIGTERM then SIGKILL on POSIX. On Windows there are no signals: `kill()` is a
 * `TerminateProcess` on that one process, so the tree goes through `taskkill`,
 * and a failure there is ignored because the process may simply have exited
 * first.
 */
function kill(child: ChildProcessWithoutNullStreams, hard = false): void {
  if (process.platform !== 'win32' || child.pid === undefined) {
    child.kill(hard ? 'SIGKILL' : 'SIGTERM')
    return
  }
  const done = (): void => undefined
  spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    .on('error', done)
    .on('exit', done)
}

export interface StdioOptions {
  command: string
  args: readonly string[]
  cwd: string
  /** Extra variables for the child, on top of the harness's own environment. */
  env?: Readonly<Record<string, string>>
}

/**
 * A local server as a subprocess, newline-delimited JSON on stdin and stdout.
 *
 * `stderr` is where these servers log, including on a perfectly healthy start,
 * so it is drained and ignored. Treating it as an error signal is the classic
 * way to declare a working server broken.
 */
export class StdioTransport implements Transport {
  private child: ChildProcessWithoutNullStreams | null = null
  private buffer = ''
  private messageHandler: ((message: JsonRpcMessage) => void) | null = null
  private closeHandler: ((reason: string) => void) | null = null
  private closed = false

  constructor(private readonly options: StdioOptions) {}

  async start(): Promise<void> {
    const { command, args } = stdioCommand(this.options.command, this.options.args)
    const child = spawn(command, args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.feed(chunk))
    // Drained on purpose: an unread pipe fills and blocks the server.
    child.stderr.resume()
    child.on('error', err => this.die(`${this.options.command} failed to start: ${err.message}`))
    child.on('exit', code => this.die(`${this.options.command} exited with code ${code ?? 'null'}`))

    // A spawn error arrives asynchronously, so a command that does not exist
    // looks alive for one tick. Waiting a beat turns "connected, then every
    // call times out" into the error it actually is.
    await new Promise<void>((resolve, reject) => {
      const ok = (): void => {
        child.off('error', fail)
        resolve()
      }
      const fail = (err: Error): void => {
        clearTimeout(timer)
        reject(new ConnectionClosedError(`${this.options.command} failed to start: ${err.message}`))
      }
      const timer = setTimeout(ok, 50)
      child.once('error', fail)
    })
  }

  private feed(chunk: string): void {
    this.buffer += chunk
    let cut = this.buffer.indexOf('\n')
    while (cut >= 0) {
      const line = this.buffer.slice(0, cut).trim()
      this.buffer = this.buffer.slice(cut + 1)
      if (line !== '') {
        const message = parseMessage(line)
        if (message !== null) this.messageHandler?.(message)
      }
      cut = this.buffer.indexOf('\n')
    }
  }

  private die(reason: string): void {
    if (this.closed) return
    this.closed = true
    this.closeHandler?.(reason)
  }

  async send(message: JsonRpcMessage): Promise<void> {
    const child = this.child
    if (child === null || this.closed) throw new ConnectionClosedError('the server is not running')
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(`${JSON.stringify(message)}\n`, err => (err ? reject(err) : resolve()))
    })
  }

  onMessage(handler: (message: JsonRpcMessage) => void): void {
    this.messageHandler = handler
  }

  onClose(handler: (reason: string) => void): void {
    this.closeHandler = handler
  }

  /**
   * Killing the child is not the same as the child being gone: it still holds
   * its pipes and, on Windows, its handles on whatever it was started from.
   * Closing waits for the exit, so "the hub is closed" means the process really
   * has ended rather than been asked to.
   *
   * On Windows the child may also not be the server. A `cmd /c npx …` launcher
   * is the process this owns, and the actual server is its grandchild; killing
   * the launcher leaves that grandchild running with its parent gone. `taskkill
   * /T` is the only way to take the tree, so that is what a win32 close does.
   */
  async close(): Promise<void> {
    this.closed = true
    const child = this.child
    this.child = null
    if (child === null || child.exitCode !== null) return
    child.stdin.end()
    kill(child)
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        // It ignored the polite one. Nothing waits on this forever.
        kill(child, true)
        resolve()
      }, 2000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}

export interface HttpOptions {
  url: string
  /** Sent as `Authorization: Bearer`. Never in the query string (plan §7). */
  token?: string | undefined
  headers?: Readonly<Record<string, string>>
}

/**
 * Streamable HTTP: one endpoint, and a POST that comes back either as a JSON
 * body or as an SSE stream the server upgraded to because the call is slow.
 *
 * A tools-only client never needs the standalone GET stream — every message it
 * cares about is the answer to something it asked — so this reads only the
 * response to each POST. `Mcp-Session-Id` is echoed back on every subsequent
 * request; a server that forgets the session closes this transport, and the
 * session gets its tools back the next time the hub is built. Re-initializing
 * underneath a running conversation is deliberately not done: the tool
 * definitions are already in the cached prefix of every request, so a silent
 * reconnect that returned a different catalog would be worse than an error.
 */
export class HttpTransport implements Transport {
  private sessionId: string | null = null
  private protocolVersion: string | null = null
  private messageHandler: ((message: JsonRpcMessage) => void) | null = null
  private closeHandler: ((reason: string) => void) | null = null
  private closed = false

  constructor(private readonly options: HttpOptions) {}

  async start(): Promise<void> {
    // Nothing to open: the first POST is the connection.
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...this.options.headers,
    }
    if (this.options.token !== undefined) headers.authorization = `Bearer ${this.options.token}`
    if (this.sessionId !== null) headers['mcp-session-id'] = this.sessionId
    // Required on every request after the handshake. A server that gets no
    // version is entitled to assume 2025-03-26 and answer in a shape this
    // client stopped expecting.
    if (this.protocolVersion !== null) headers['mcp-protocol-version'] = this.protocolVersion
    return headers
  }

  setProtocolVersion(version: string): void {
    this.protocolVersion = version
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.closed) throw new ConnectionClosedError('the server session is closed')
    let response: Response
    try {
      response = await fetch(this.options.url, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(message),
      })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      this.die(`${this.options.url} is unreachable: ${reason}`)
      throw new ConnectionClosedError(reason)
    }

    const issued = response.headers.get('mcp-session-id')
    if (issued !== null) this.sessionId = issued

    if (response.status === 404 && this.sessionId !== null) {
      // The server forgot the session. A stateful Streamable HTTP session that
      // is gone can only be recovered by initializing again from scratch.
      this.sessionId = null
      this.die('the server dropped this session; it needs re-initializing')
      return
    }
    // 202 is the correct answer to a notification: accepted, no body.
    if (response.status === 202 || response.status === 204) return
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new ConnectionClosedError(`${this.options.url} answered ${response.status}${body === '' ? '' : `: ${body.slice(0, 200)}`}`)
    }

    const type = response.headers.get('content-type') ?? ''
    const body = await response.text()
    if (type.includes('text/event-stream')) this.readEvents(body)
    else this.readJson(body)
  }

  private readJson(body: string): void {
    if (body.trim() === '') return
    const message = parseMessage(body)
    if (message !== null) this.messageHandler?.(message)
  }

  /**
   * SSE, only as much of it as MCP uses: `data:` lines, one event per blank
   * line, everything else (`event:`, `id:`, comments) ignored.
   */
  private readEvents(body: string): void {
    for (const block of body.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())
        .join('\n')
      if (data === '') continue
      const message = parseMessage(data)
      if (message !== null) this.messageHandler?.(message)
    }
  }

  private die(reason: string): void {
    if (this.closed) return
    this.closed = true
    this.closeHandler?.(reason)
  }

  onMessage(handler: (message: JsonRpcMessage) => void): void {
    this.messageHandler = handler
  }

  onClose(handler: (reason: string) => void): void {
    this.closeHandler = handler
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.sessionId === null) return
    // Best effort: a server that does not implement DELETE is not a problem.
    await fetch(this.options.url, { method: 'DELETE', headers: this.buildHeaders() }).catch(() => undefined)
  }
}

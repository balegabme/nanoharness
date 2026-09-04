// doc: docs/harness/overview.md
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { createOpenAIProvider } from '../providers/openai.js'
import { BASH_TOOL } from '../tools/bash.js'
import { READ_TOOL } from '../tools/read.js'
import { WRITE_TOOL } from '../tools/write.js'
import { LOG_IMPROVEMENT_TOOL } from '../tools/log-improvement.js'
import { EventBus } from '../core/event-bus.js'
import { Session } from '../core/session.js'
import { appendUsage } from '../core/usage-log.js'
import { IPC_CHANNELS } from '../ipc/contract.js'
import { configStatus, loadProviderConfig, probeProvider, writeSettings } from './config-store.js'
import { createWindow, serveRenderer } from './window.js'
import type { AppEvent } from '../core/types.js'
import type { ConfigProbeRequest, ConfigProbeResult, ConfigSetRequest, ConfigStatus } from '../ipc/contract.js'

const require = createRequire(import.meta.url)
const pkg = require('../../package.json') as { version: string }

const EVENT_TYPES: AppEvent['type'][] = [
  'session.started',
  'text_delta',
  'thinking_delta',
  'tool_call',
  'tool_result',
  'usage',
  'session.error',
  'session.finished',
]

const SYSTEM_PROMPT = 'You are NanoHarness. Be minimal and precise.'
const MAX_TOOL_ROUNDS = 8

// One session per window, so a conversation keeps its history across messages.
const sessions = new Map<number, Session>()

// No endpoint and no model are baked in: both come from the settings the user
// saved, and an incomplete configuration is an error the setup screen handles,
// never a silent default (plan §11).
async function sessionFor(sender: WebContents): Promise<Session> {
  const existing = sessions.get(sender.id)
  if (existing) return existing

  const config = await loadProviderConfig()
  const provider = createOpenAIProvider({ apiKey: config.apiKey, baseURL: config.baseURL })
  const bus = new EventBus()
  for (const type of EVENT_TYPES) {
    bus.on(type, event => {
      if (!sender.isDestroyed()) sender.send(IPC_CHANNELS.sessionEvent, event)
    })
  }

  const session = new Session(
    { sessionId: randomUUID(), cwd: process.cwd(), model: config.model, systemPrompt: SYSTEM_PROMPT, maxToolRounds: MAX_TOOL_ROUNDS },
    provider,
    [BASH_TOOL, READ_TOOL, WRITE_TOOL, LOG_IMPROVEMENT_TOOL],
    bus,
  )
  sessions.set(sender.id, session)
  sender.once('destroyed', () => sessions.delete(sender.id))
  return session
}

app.whenReady().then(() => {
  serveRenderer()

  ipcMain.handle(IPC_CHANNELS.ping, () => ({ ok: true, version: pkg.version }))

  ipcMain.handle(IPC_CHANNELS.configGet, (): Promise<ConfigStatus> => configStatus())

  ipcMain.handle(IPC_CHANNELS.configProbe, (_event: IpcMainInvokeEvent, req: ConfigProbeRequest): Promise<ConfigProbeResult> => probeProvider(req))

  ipcMain.handle(IPC_CHANNELS.configSet, async (_event: IpcMainInvokeEvent, req: ConfigSetRequest): Promise<ConfigStatus> => {
    await writeSettings(req)
    // Live sessions hold a provider built from the old settings, so retire
    // them; the next turn builds a session against the new ones.
    sessions.clear()
    return configStatus()
  })

  ipcMain.handle(IPC_CHANNELS.sessionSend, async (event: IpcMainInvokeEvent, req: { text: string }) => {
    const session = await sessionFor(event.sender)
    const usage = await session.run(req.text)
    // One line per completed turn, so `nh usage` has something to read. A log
    // that cannot be written is worth a warning, never a failed turn.
    await appendUsage({
      at: Date.now(),
      sessionId: session.options.sessionId,
      turn: session.turnNumber,
      model: session.options.model,
      usage: session.lastTurnUsage,
    }).catch((err: unknown) => {
      process.stderr.write(`usage log: ${err instanceof Error ? err.message : String(err)}\n`)
    })
    return { sessionId: session.options.sessionId, usage }
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  app.on('window-all-closed', () => app.quit())
})

// doc: docs/harness/overview.md
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { createRequire } from 'node:module'
import { createProvider } from '../providers/factory.js'
import { BASH_TOOL } from '../tools/bash.js'
import { READ_TOOL } from '../tools/read.js'
import { WRITE_TOOL } from '../tools/write.js'
import { LOG_IMPROVEMENT_TOOL } from '../tools/log-improvement.js'
import { EventBus } from '../core/event-bus.js'
import { buildSystemPrompt } from '../core/prompt.js'
import { Session } from '../core/session.js'
import { appendUsage } from '../core/usage-log.js'
import { IPC_CHANNELS } from '../ipc/contract.js'
import { configStatus, deleteProvider, loadProviderConfig, probeProvider, saveProvider, setActive } from './config-store.js'
import { PermissionBroker, promptingGate } from './permission.js'
import {
  addWorkspace,
  createSession,
  deleteSession,
  loadTranscript,
  noteTurn,
  removeWorkspace,
  saveTranscript,
  sessionRoot,
  toTranscriptView,
  workspaceStatus,
} from './workspace-store.js'
import { createWindow, serveRenderer } from './window.js'
import type { AppEvent } from '../core/types.js'
import type {
  ActiveSetRequest,
  ConfigProbeRequest,
  ConfigProbeResult,
  ConfigStatus,
  PermissionDecision,
  ProviderSaveRequest,
  SessionOpenResponse,
  SessionSendRequest,
  SessionView,
  WorkspaceStatus,
} from '../ipc/contract.js'

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
  'session.stopped',
  'permission.request',
]

const MAX_TOOL_ROUNDS = 8

// Windows shows a toast under an application id. Without one set, a
// notification from a dev-run Electron app is silently dropped.
const APP_ID = 'com.nanoharness.app'

function shellName(): string {
  return process.platform === 'win32' ? 'Git Bash (MSYS), through `bash -lc`' : 'bash, through `bash -lc`'
}

// Live sessions, keyed the way the renderer addresses them. A session that was
// never opened this launch is rebuilt from its stored transcript on first use.
const sessions = new Map<string, Session>()
// One broker per window: it is the thing that can put a modal in front of a
// person, so it belongs to the window that has one.
const brokers = new Map<number, PermissionBroker>()

function brokerFor(sender: WebContents): PermissionBroker {
  const existing = brokers.get(sender.id)
  if (existing) return existing
  const broker = new PermissionBroker(ask => {
    if (!sender.isDestroyed()) {
      sender.send(IPC_CHANNELS.sessionEvent, { type: 'permission.request', ...ask, at: Date.now() } satisfies AppEvent)
    }
  })
  brokers.set(sender.id, broker)
  sender.once('destroyed', () => {
    // Nobody left to answer a prompt, and the tools waiting on one would hang.
    broker.cancelAll()
    brokers.delete(sender.id)
  })
  return broker
}

// No endpoint and no model are baked in: both come from the settings the user
// saved, and an incomplete configuration is an error the setup screen handles,
// never a silent default (plan §11).
async function sessionFor(sender: WebContents, sessionId: string): Promise<Session> {
  const existing = sessions.get(sessionId)
  if (existing) return existing

  const root = await sessionRoot(sessionId)
  if (root === null) throw new Error('that session is gone; start a new one from the sidebar')

  const config = await loadProviderConfig()
  const provider = createProvider({ kind: config.provider.kind, baseURL: config.provider.baseURL, apiKey: config.apiKey })
  const bus = new EventBus()
  for (const type of EVENT_TYPES) {
    bus.on(type, event => {
      if (!sender.isDestroyed()) sender.send(IPC_CHANNELS.sessionEvent, event)
    })
  }

  const session = new Session(
    {
      sessionId,
      // The folder the session was started in is its cwd *and* the boundary
      // every tool is held to, so a session can never wander into a sibling
      // project without someone saying yes.
      cwd: root,
      model: config.model,
      effort: config.effort,
      systemPrompt: buildSystemPrompt({
        root,
        platform: process.platform,
        shell: shellName(),
        today: new Date().toISOString().slice(0, 10),
      }),
      maxToolRounds: MAX_TOOL_ROUNDS,
      access: promptingGate({ root, sessionId, broker: brokerFor(sender) }),
      history: await loadTranscript(sessionId),
    },
    provider,
    [BASH_TOOL, READ_TOOL, WRITE_TOOL, LOG_IMPROVEMENT_TOOL],
    bus,
  )
  sessions.set(sessionId, session)
  return session
}

app.whenReady().then(() => {
  app.setAppUserModelId(APP_ID)
  serveRenderer()

  ipcMain.handle(IPC_CHANNELS.ping, () => ({ ok: true, version: pkg.version }))

  ipcMain.handle(IPC_CHANNELS.configGet, (): Promise<ConfigStatus> => configStatus())

  ipcMain.handle(IPC_CHANNELS.configProbe, (_event: IpcMainInvokeEvent, req: ConfigProbeRequest): Promise<ConfigProbeResult> => probeProvider(req))

  // Every settings write retires the live sessions: they hold a provider built
  // from the old configuration, so the next turn rebuilds against the new one.
  // The stored transcript is what makes that lossless.
  ipcMain.handle(IPC_CHANNELS.configSaveProvider, async (_event: IpcMainInvokeEvent, req: ProviderSaveRequest): Promise<ConfigStatus> => {
    await saveProvider(req)
    sessions.clear()
    return configStatus()
  })

  ipcMain.handle(IPC_CHANNELS.configDeleteProvider, async (_event: IpcMainInvokeEvent, id: string): Promise<ConfigStatus> => {
    await deleteProvider(id)
    sessions.clear()
    return configStatus()
  })

  ipcMain.handle(IPC_CHANNELS.configSetActive, async (_event: IpcMainInvokeEvent, req: ActiveSetRequest): Promise<ConfigStatus> => {
    await setActive(req)
    sessions.clear()
    return configStatus()
  })

  ipcMain.handle(IPC_CHANNELS.workspaceList, (): Promise<WorkspaceStatus> => workspaceStatus())

  ipcMain.handle(IPC_CHANNELS.workspaceAdd, async (event: IpcMainInvokeEvent): Promise<WorkspaceStatus | null> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const picked = window
      ? await dialog.showOpenDialog(window, { title: 'Add a folder', properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ title: 'Add a folder', properties: ['openDirectory', 'createDirectory'] })
    const dir = picked.filePaths[0]
    if (picked.canceled || dir === undefined) return null
    await addWorkspace(dir)
    return workspaceStatus()
  })

  ipcMain.handle(IPC_CHANNELS.workspaceRemove, async (_event: IpcMainInvokeEvent, id: string): Promise<WorkspaceStatus> => {
    const status = await workspaceStatus()
    for (const session of status.sessions.filter(s => s.workspaceId === id)) sessions.delete(session.id)
    await removeWorkspace(id)
    return workspaceStatus()
  })

  ipcMain.handle(IPC_CHANNELS.sessionCreate, (_event: IpcMainInvokeEvent, workspaceId: string): Promise<SessionView> => createSession(workspaceId))

  ipcMain.handle(IPC_CHANNELS.sessionOpen, async (_event: IpcMainInvokeEvent, id: string): Promise<SessionOpenResponse> => {
    const status = await workspaceStatus()
    const session = status.sessions.find(s => s.id === id)
    const workspace = status.workspaces.find(w => w.id === session?.workspaceId)
    if (session === undefined || workspace === undefined) throw new Error('that session is gone; start a new one from the sidebar')
    return { session, workspace, messages: toTranscriptView(await loadTranscript(id)) }
  })

  ipcMain.handle(IPC_CHANNELS.sessionDelete, async (_event: IpcMainInvokeEvent, id: string): Promise<WorkspaceStatus> => {
    sessions.delete(id)
    await deleteSession(id)
    return workspaceStatus()
  })

  ipcMain.handle(IPC_CHANNELS.permissionRespond, (event: IpcMainInvokeEvent, req: { id: string; decision: PermissionDecision }) => {
    brokerFor(event.sender).resolve(req.id, req.decision)
  })

  // Stop is a message to a turn already in flight, so it never builds a
  // session: a session that is not running has nothing to stop.
  ipcMain.handle(IPC_CHANNELS.sessionStop, (_event: IpcMainInvokeEvent, sessionId: string) => {
    sessions.get(sessionId)?.stop()
  })

  ipcMain.handle(IPC_CHANNELS.sessionSend, async (event: IpcMainInvokeEvent, req: SessionSendRequest) => {
    const session = await sessionFor(event.sender, req.sessionId)
    const usage = await session.run(req.text)

    // The transcript is written after the turn, not during it: a half-streamed
    // answer is not a message, and a crash mid-turn should leave the session
    // exactly as it was before the message was sent.
    await saveTranscript(req.sessionId, session.transcript)
    const updated = await noteTurn(req.sessionId, req.text)

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

    const status = await workspaceStatus()
    const view = updated ?? status.sessions.find(s => s.id === req.sessionId)
    if (view === undefined) throw new Error('that session is gone; start a new one from the sidebar')
    return { sessionId: req.sessionId, usage, session: view }
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  app.on('window-all-closed', () => app.quit())
})

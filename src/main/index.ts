// doc: docs/harness/overview.md
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { createRequire } from 'node:module'
import { createProvider } from '../providers/factory.js'
import { BASH_TOOL, GUARDED_BASH_TOOL } from '../tools/bash.js'
import { READ_TOOL } from '../tools/read.js'
import { WRITE_TOOL } from '../tools/write.js'
import { LOG_IMPROVEMENT_TOOL } from '../tools/log-improvement.js'
import { SPAWN_TOOL } from '../tools/spawn.js'
import { JOB_UPDATE_TOOL } from '../tools/job-update.js'
import { AGENTS, AGENT_ROLES, agentPrompt, isAgentRole, roleContext } from '../core/agents.js'
import { EventBus } from '../core/event-bus.js'
import { JobRegistry } from '../core/jobs.js'
import { createSpawnHost } from '../core/spawn.js'
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
  sessionRole,
  sessionRoot,
  sessionUsage,
  setSessionRole,
  toTranscriptView,
  workspaceStatus,
} from './workspace-store.js'
import { createWindow, serveRenderer } from './window.js'
import type { AgentRole } from '../core/agents.js'
import type { JobView } from '../core/jobs.js'
import type { PromptEnvironment } from '../core/prompt.js'
import type { SubagentSetup } from '../core/spawn.js'
import type { Tool } from '../core/session.js'
import type { AppEvent } from '../core/types.js'
import type {
  ActiveSetRequest,
  AgentSummary,
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
  'job.started',
  'job.update',
  'job.finished',
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

// One registry per window, for the same reason as the broker: a job is only
// visible where it can be shown, and its events go to that window's renderer.
const jobRegistries = new Map<number, JobRegistry>()

function jobsFor(sender: WebContents): JobRegistry {
  const existing = jobRegistries.get(sender.id)
  if (existing) return existing
  const bus = new EventBus()
  for (const type of ['job.started', 'job.update', 'job.finished'] as const) {
    bus.on(type, event => {
      if (!sender.isDestroyed()) sender.send(IPC_CHANNELS.sessionEvent, event)
    })
  }
  const registry = new JobRegistry(bus)
  jobRegistries.set(sender.id, registry)
  sender.once('destroyed', () => void jobRegistries.delete(sender.id))
  return registry
}

const TOOLS: Record<string, Tool> = {
  bash: BASH_TOOL,
  read: READ_TOOL,
  write: WRITE_TOOL,
  log_improvement: LOG_IMPROVEMENT_TOOL,
  spawn: SPAWN_TOOL,
  job_update: JOB_UPDATE_TOOL,
}

/**
 * The role's tools, minus the two that only make sense in one place: nothing
 * but a background job may report progress, and a subagent may not summon
 * another one — a tree of agents is a bill nobody asked for.
 */
function toolsFor(role: AgentRole, options: { canSpawn: boolean; isJob: boolean }): Tool[] {
  const definition = AGENTS[role]
  const tools: Tool[] = []
  for (const name of definition.tools) {
    if (name === 'spawn' && !options.canSpawn) continue
    if (name === 'job_update' && !options.isJob) continue
    if (name === 'bash') {
      if (definition.bash === 'none') continue
      tools.push(definition.bash === 'guarded' ? GUARDED_BASH_TOOL : BASH_TOOL)
      continue
    }
    const tool = TOOLS[name]
    if (tool !== undefined) tools.push(tool)
  }
  return tools
}

function environment(root: string): PromptEnvironment {
  return { root, platform: process.platform, shell: shellName(), today: new Date().toISOString().slice(0, 10) }
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

  const role = (await sessionRole(sessionId)) ?? 'builder'
  const systemPrompt = agentPrompt(role, environment(root), await roleContext(role, root))
  const tools = toolsFor(role, { canSpawn: true, isJob: false })
  // A subagent is held to the parent's boundary, and to the same broker: an
  // "allow for this session" the user already gave covers the work they asked
  // for, whoever ends up doing it.
  const access = promptingGate({ root, sessionId, broker: brokerFor(sender) })

  // A clone is built from the parent's live transcript, and the parent does not
  // exist until the call below; the holder is what ties the two together.
  const parent: { session?: Session } = {}

  const spent = await sessionUsage(sessionId)

  const setup = async (request: { role: AgentRole; mode: string }, jobId: string | null): Promise<SubagentSetup> => {
    const isJob = jobId !== null
    if (request.mode === 'clone') {
      // A clone is the parent, one message later: the same prompt, the same
      // tool list and the same history, so the provider's cache answers the
      // whole prefix. "The same tool list" is literal — the tool definitions
      // sit in front of the messages, so dropping one would invalidate exactly
      // the bytes the mode exists to reuse. `spawn` therefore stays in the
      // list and refuses at the call, and a background clone has no
      // `job_update`: it reports once, at the end.
      return {
        systemPrompt,
        tools,
        history: parent.session?.transcript ?? [],
        ...(config.effort === undefined ? {} : { effort: config.effort }),
      }
    }
    return {
      systemPrompt: agentPrompt(request.role, environment(root), await roleContext(request.role, root)),
      tools: toolsFor(request.role, { canSpawn: false, isJob }),
      effort: AGENTS[request.role].defaultEffort,
    }
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
      systemPrompt,
      maxToolRounds: MAX_TOOL_ROUNDS,
      access,
      history: await loadTranscript(sessionId),
      ...(spent === null ? {} : { usage: spent }),
      spawn: createSpawnHost({
        sessionId,
        cwd: root,
        model: config.model,
        provider,
        access,
        jobs: jobsFor(sender),
        maxToolRounds: MAX_TOOL_ROUNDS,
        setup,
      }),
    },
    provider,
    tools,
    bus,
  )
  parent.session = session
  sessions.set(sessionId, session)
  return session
}

app.whenReady().then(() => {
  app.setAppUserModelId(APP_ID)
  serveRenderer()

  ipcMain.handle(IPC_CHANNELS.ping, () => ({ ok: true, version: pkg.version }))

  // The only way out of the window. `setWindowOpenHandler` denies everything and
  // `will-navigate` is blocked, so a link is handed to the OS browser instead —
  // and only ever an http(s) one, since `shell.openExternal` would otherwise
  // launch whatever a `file:` or a custom scheme is registered to.
  ipcMain.handle(IPC_CHANNELS.openExternal, async (_event: IpcMainInvokeEvent, url: string): Promise<void> => {
    const target = new URL(url)
    if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new Error(`refusing to open ${target.protocol} link`)
    await shell.openExternal(target.toString())
  })

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

  // Switching agent keeps the transcript and retires the live session: its
  // prompt and its tool list both belong to the role it was built with.
  ipcMain.handle(IPC_CHANNELS.sessionSetRole, async (_event: IpcMainInvokeEvent, req: { sessionId: string; role: AgentRole }): Promise<SessionView> => {
    if (!isAgentRole(req.role)) throw new Error(`unknown agent: ${String(req.role)}`)
    sessions.delete(req.sessionId)
    return setSessionRole(req.sessionId, req.role)
  })

  ipcMain.handle(
    IPC_CHANNELS.agentsList,
    (): AgentSummary[] =>
      AGENT_ROLES.map(role => ({
        role,
        name: AGENTS[role].name,
        purpose: AGENTS[role].purpose,
        defaultEffort: AGENTS[role].defaultEffort,
      })),
  )

  ipcMain.handle(IPC_CHANNELS.jobsList, (event: IpcMainInvokeEvent): JobView[] => jobsFor(event.sender).list())

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
    const updated = await noteTurn(req.sessionId, req.text, usage)

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

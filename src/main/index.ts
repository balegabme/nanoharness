// doc: docs/harness/overview.md
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { plural, toolsText } from '../shared/format.js'
import { emptyUsage, totalTokens } from '../shared/usage.js'
import { resolveFacts } from '../shared/facts.js'
import { compose } from '../shared/compose.js'
import { warmShell } from '../env/shell.js'
import { hostFacts } from '../env/probe.js'
import { stopHooks } from '../hooks/hooks.js'
import { Terminals, stopTerminals } from '../tools/terminal.js'
import { QuestionBroker } from './questions.js'
import { AGENTS, AGENT_ROLES, isAgentRole } from '../core/agents.js'
import { EventBus } from '../core/event-bus.js'
import { ProjectTrust, projectTrustPath } from '../core/project-trust.js'
import type { ProjectFile } from '../core/project-trust.js'
import { JobRegistry } from '../core/jobs.js'
import { McpHub } from '../mcp/hub.js'
import { loadSkills } from '../core/skills.js'
import { SNIPPETS_DIR, loadSnippets } from '../core/snippets.js'
import { loadServers } from '../mcp/config.js'
import { hasUnknownSecret } from '../core/secrets.js'
import { flushSecrets, forgetSecret, secretList, secretVault } from './secret-store.js'
import { Session } from '../core/session.js'
import { CheckpointStore, REWIND_MODES, shownPath } from '../core/checkpoints.js'
import { appendUsage, clearUsage, readUsage, userDataDir } from '../core/usage-log.js'
import { buildReport } from '../core/usage-report.js'
import type { UsageReport } from '../core/usage-report.js'
import { Judge, approvalProblem } from '../core/approval.js'
import type { ApprovalConfig, PermissionMode } from '../core/approval.js'
import type { SwitchName } from '../core/config.js'
import { IPC_CHANNELS } from '../ipc/contract.js'
import {
  configStatus,
  defaultMode,
  deleteProvider,
  loadProviderConfig,
  probeProvider,
  readStored,
  saveApproval,
  saveProvider,
  setActive,
  setAutoCompact,
  setContextLimit,
  setDefaultMode,
  setSwitch,
} from './config-store.js'
import { PermissionBroker, gateState } from './permission.js'
import type { GateState } from './permission.js'
import {
  acceptImages,
  addWorkspace,
  checkpointDir,
  createSession,
  deleteSession,
  loadNotes,
  loadSubagent,
  loadTranscript,
  removeWorkspace,
  renameSession,
  saveTranscript,
  sessionIdentity,
  sessionRoot,
  setSessionRole,
  setSessionState,
  toTranscriptView,
  transcriptPath,
  usageNames,
  workspaceStatus,
} from './workspace-store.js'
import { createWindow, serveRenderer } from './window.js'
import { assembleSession, buildJudge, recordTurn, stateOf } from './assemble.js'
import type { AgentRole } from '../core/agents.js'
import type { JobView } from '../core/jobs.js'
import type { CompactSpend } from '../core/session.js'
import type { AppEvent, McpServerStatus, ProjectFileKind } from '../core/types.js'
import type {
  ActiveSetRequest,
  AgentSummary,
  ConfigProbeRequest,
  ConfigProbeResult,
  CaptureResult,
  ConfigStatus,
  McpStatusView,
  PermissionDecision,
  PermissionModeView,
  ProviderSaveRequest,
  SessionOpenResponse,
  SessionRewindRequest,
  SessionRewindResponse,
  SessionSendRequest,
  SecretView,
  SessionCheckpointsResponse,
  SessionCompactResponse,
  SessionReloadResponse,
  SessionTldrResponse,
  SessionView,
  SnippetView,
  SubagentOpenResponse,
  WorkspaceStatus,
} from '../ipc/contract.js'

const require = createRequire(import.meta.url)
const pkg = require('../../package.json') as { version: string }

/** The snippets that ship with the app, copied next to the build by `scripts/copy-assets.mjs`. */
const BUILT_IN_SNIPPETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'snippets')

// Windows shows a toast under an application id. Without one set, a
// notification from a dev-run Electron app is silently dropped.
const APP_ID = 'com.nanoharness.app'

// Live sessions, keyed the way the renderer addresses them. A session that was
// never opened this launch is rebuilt from its stored transcript on first use.
const sessions = new Map<string, Session>()

// The secret names each live session's prompt was built with. A key captured
// after that build, whether pasted into the composer, added in settings or
// written by a tool, leaves the session holding a reference its prompt never
// explained. This is what notices.
const promptSecrets = new Map<string, string[]>()

// One hub per session, held apart from the session itself because it owns
// subprocesses and sockets: retiring a session has to close them, and a Map
// that only holds Sessions has nowhere to put that.
const hubs = new Map<string, McpHub>()

/** Sessions being built right now, so two messages cannot build one twice. */
const building = new Map<string, Promise<Session>>()

// One checkpoint store per session for the whole launch. Retiring a session
// leaves its background jobs running, and they keep writing through the store
// they were given, so a rebuilt session has to share it and not open a second
// one over the same index.
const checkpointStores = new Map<string, CheckpointStore>()

function checkpointsFor(sessionId: string): CheckpointStore {
  let store = checkpointStores.get(sessionId)
  if (store === undefined) {
    store = new CheckpointStore(checkpointDir(sessionId))
    checkpointStores.set(sessionId, store)
  }
  return store
}

/**
 * How many times a session has been retired. A build reads this when it starts,
 * again once its servers are up and once more when it is whole: a different
 * number means the settings it was built against are gone, so it closes what
 * it opened. Without it, a save landing mid-build leaves a set of subprocesses
 * with nothing holding them.
 */
const epochs = new Map<string, number>()

function epochOf(sessionId: string): number {
  return epochs.get(sessionId) ?? 0
}

/**
 * What a request the user made between turns leaves behind: the transcript and
 * the session record written, and the harness's spend on a usage line of its
 * own under the turn it followed, since it belongs to no turn.
 */
async function settleBetweenTurns(
  sessionId: string,
  identity: { workspaceId: string; role: AgentRole },
  session: Session,
  spend: Pick<CompactSpend, 'usage' | 'costUsd'>,
): Promise<void> {
  await saveTranscript(sessionId, session.transcript, session.notes)
  const updated = await setSessionState(sessionId, stateOf(session))
  if (totalTokens(spend.usage) > 0) {
    await appendUsage({
      at: Date.now(),
      sessionId,
      workspaceId: identity.workspaceId,
      turn: session.turnNumber,
      role: identity.role,
      model: session.options.model,
      usage: spend.usage,
      subagent: emptyUsage(),
      harness: spend.usage,
      costUsd: spend.costUsd,
      subagentCostUsd: 0,
      harnessCostUsd: spend.costUsd ?? 0,
      streamMs: 0,
      betweenTurns: true,
    }).catch((err: unknown) => {
      process.stderr.write(`usage log: ${err instanceof Error ? err.message : String(err)}\n`)
    })
  }
  if (updated === null) throw new Error('that session is gone; start a new one from the sidebar')
}

/**
 * Drop live sessions and close what they opened, so the next turn rebuilds
 * against the configuration as it stands; the stored transcript is what makes
 * it lossless. A write carrying only prices and effort levels does not do this.
 *
 * Resolves when every server has actually exited, which is what quitting needs;
 * a settings write does not wait.
 */
async function retire(sessionId?: string): Promise<void> {
  const ids = sessionId === undefined ? [...new Set([...hubs.keys(), ...building.keys()])] : [sessionId]
  const closing: Promise<void>[] = []
  for (const id of ids) {
    epochs.set(id, epochOf(id) + 1)
    const hub = hubs.get(id)
    hubs.delete(id)
    promptSecrets.delete(id)
    if (hub !== undefined) closing.push(hub.close())
  }
  if (sessionId === undefined) {
    sessions.clear()
    promptSecrets.clear()
  } else sessions.delete(sessionId)
  await Promise.all(closing)
}
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

// One per window, like the permission broker: a question is only answerable
// where it is drawn.
const questionBrokers = new Map<number, QuestionBroker>()

function questionsFor(sender: WebContents): QuestionBroker {
  const existing = questionBrokers.get(sender.id)
  if (existing) return existing
  const broker: QuestionBroker = new QuestionBroker(ask => {
    // A window closed before the turn asked will never answer, and its
    // `destroyed` has already fired.
    if (sender.isDestroyed()) broker.resolve(ask.id, null)
    else sender.send(IPC_CHANNELS.sessionEvent, { type: 'question.request', ...ask, at: Date.now() } satisfies AppEvent)
  })
  questionBrokers.set(sender.id, broker)
  sender.once('destroyed', () => {
    broker.cancelAll()
    questionBrokers.delete(sender.id)
  })
  return broker
}

// One set of background shells per session for the whole launch, kept apart
// from the session for the reason the checkpoint stores are: a session is
// rebuilt when the settings change, and the servers it started must still be
// its own afterwards.
const terminalSets = new Map<string, Terminals>()

function terminalsFor(sessionId: string): Terminals {
  let set = terminalSets.get(sessionId)
  if (set === undefined) {
    set = new Terminals()
    terminalSets.set(sessionId, set)
  }
  return set
}

/** Stop a session's background shells, for a session that is being deleted. */
function closeTerminals(sessionId: string): void {
  terminalSets.get(sessionId)?.close()
  terminalSets.delete(sessionId)
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
  // A background job is the one thing the user watches that the conversation
  // knows nothing about: it starts inside a turn and answers after it, so both
  // ends go into the session's notes. A foreground spawn is not one of these:
  // its answer arrives as a tool result, and a note would tell it twice.
  bus.on('job.started', event => {
    // The marker makes the note the way in while the job is still running: it
    // is the only mention of the subagent until it answers.
    if (event.job.background) {
      sessions
        .get(event.job.sessionId)
        ?.note(`Background ${event.job.role} started: ${event.job.task} [subagent:${event.job.id}]`)
    }
  })
  bus.on('job.finished', event => {
    const parent = sessions.get(event.job.sessionId)
    // A background job outlives the turn that started it, so its tokens land on
    // the parent's total with no turn left to write them down. Store the total
    // as it now stands, or the window and the file disagree until the next
    // message is sent.
    if (parent !== undefined) {
      void setSessionState(event.job.sessionId, stateOf(parent)).catch((err: unknown) => {
        process.stderr.write(`session usage: ${err instanceof Error ? err.message : String(err)}\n`)
      })
    }
    if (!event.job.background) return
    const first = event.job.note?.split('\n')[0] ?? ''
    // What it did to get there, alongside what it concluded. The note names the
    // subagent, so the parent's own transcript points back at the conversation
    // the subagent had.
    parent?.note(
      [
        `Background ${event.job.role} ${event.job.state}`,
        event.job.tools === undefined ? '' : ` (${toolsText(event.job.tools)})`,
        first === '' ? '' : `: ${first}`,
        ` [subagent:${event.job.id}]`,
      ].join(''),
    )
  })
  const registry = new JobRegistry(bus)
  jobRegistries.set(sender.id, registry)
  sender.once('destroyed', () => void jobRegistries.delete(sender.id))
  return registry
}

// No endpoint and no model are baked in: both come from the settings the user
// saved, and an incomplete configuration is an error the setup screen handles,
// never a silent default (plan §11).
function sessionFor(sender: WebContents, sessionId: string): Promise<Session> {
  const existing = sessions.get(sessionId)
  if (existing) return Promise.resolve(existing)
  // Building a session now spawns MCP subprocesses, so two messages racing to
  // open the same one would leave a set of servers with nothing holding them.
  // So the in-flight build is shared, along with the session it ends with.
  const started = building.get(sessionId)
  if (started !== undefined) return started
  const build = buildSession(sender, sessionId).finally(() => building.delete(sessionId))
  building.set(sessionId, build)
  return build
}

/**
 * What each open session has already been allowed, keyed by session id. The
 * user's answers were about the session, not about the process that happened
 * to build it, so they outlive a rebuild. Deleting a session forgets them.
 */
const permissions = new Map<string, GateState>()

async function permissionsFor(sessionId: string): Promise<GateState> {
  const existing = permissions.get(sessionId)
  if (existing) return existing
  // A new session starts in whichever mode the user last chose. The grants
  // themselves never persist, being answers about one run of the app, but the
  // mode is a preference and is stored.
  const mode = await defaultMode()
  // Read the map again on the far side of that await. Two callers racing here
  // would otherwise each make a state and the second replace the first. The
  // gate holds the object it was handed, so switching to auto would leave the
  // live gate in `ask`, silently. That is the one failure this mode must not
  // have.
  const settled = permissions.get(sessionId)
  if (settled) return settled
  const state = gateState(mode)
  permissions.set(sessionId, state)
  return state
}

/**
 * One approval model per session, so the rung that answered first goes on
 * answering. Plan §15 wants a stable prefix, and nothing records a switch of
 * judge mid-session.
 */
const judges = new Map<string, Promise<Judge>>()

/**
 * The session's judge. The promise is what is kept, so checks that arrive
 * together while settings are still being read share one judge: two would
 * each look new to the gate and empty its verdicts under the other.
 */
function judgeFor(sessionId: string): Promise<Judge> {
  const existing = judges.get(sessionId)
  if (existing) return existing
  const built = buildJudge(sessionId)
  judges.set(sessionId, built)
  // A failed read is not kept, so the next check tries again.
  built.catch(() => {
    if (judges.get(sessionId) === built) judges.delete(sessionId)
  })
  return built
}

/** The project files the user has approved, and the ones refused this run. */
const projectTrust = new ProjectTrust(projectTrustPath())

/** Trust questions waiting on the window, by the id their event carried. */
const trustAnswers = new Map<string, (allow: boolean) => void>()

/**
 * Whether a project's hooks or MCP servers may run. The session build waits on
 * the window for the answer, which `ProjectTrust` asks for only when the file
 * is not already approved as it reads now.
 */
function projectTrusted(sender: WebContents, sessionId: string, kind: ProjectFileKind, file: ProjectFile): Promise<boolean> {
  return projectTrust.check(file, () => askTrust(sender, sessionId, kind, file))
}

function askTrust(sender: WebContents, sessionId: string, kind: ProjectFileKind, file: ProjectFile): Promise<boolean> {
  if (sender.isDestroyed()) return Promise.resolve(false)
  const id = randomUUID()
  return new Promise<boolean>(resolve => {
    // A window closed with the question still up has answered no.
    const gone = (): void => settle(false)
    const settle = (allow: boolean): void => {
      trustAnswers.delete(id)
      sender.off('destroyed', gone)
      resolve(allow)
    }
    trustAnswers.set(id, settle)
    sender.once('destroyed', gone)
    sender.send(IPC_CHANNELS.sessionEvent, { type: 'project.trust', sessionId, id, kind, path: file.path, text: file.text, at: Date.now() } satisfies AppEvent)
  })
}

/**
 * The hook notes each session was last given. A session is rebuilt after every
 * settings save, and a note it already carries is not written again.
 */
const hookNotes = new Map<string, string>()

/** The snippet texts the window sent around a message. Anything but a list of strings is refused, and the message is not sent. */
function snippetTexts(texts: unknown): string[] {
  if (!Array.isArray(texts) || !texts.every((text: unknown) => typeof text === 'string')) throw new Error('the snippets did not arrive as a list of texts')
  return texts
}

/**
 * Why auto mode cannot be turned on, or nothing when it can. Read from the
 * stored settings each time and never cached: a provider deleted in the
 * settings screen should take the mode with it.
 */
async function approvalGap(): Promise<string | undefined> {
  const stored = await readStored()
  return approvalProblem(stored.approval, stored.providers)
}

function modeView(mode: PermissionMode, problem: string | undefined): PermissionModeView {
  return problem === undefined ? { mode } : { mode, problem }
}

async function buildSession(sender: WebContents, sessionId: string): Promise<Session> {
  const mine = epochOf(sessionId)
  const built = await assembleSession(sessionId, {
    config: await loadProviderConfig(),
    forward: event => {
      if (!sender.isDestroyed()) sender.send(IPC_CHANNELS.sessionEvent, event)
    },
    trust: (kind, file) => projectTrusted(sender, sessionId, kind, file),
    broker: brokerFor(sender),
    permissions: await permissionsFor(sessionId),
    judge: () => judgeFor(sessionId),
    jobs: jobsFor(sender),
    checkpoints: checkpointsFor(sessionId),
    terminals: terminalsFor(sessionId),
    ask: (questions, signal) => questionsFor(sender).ask(sessionId, questions, signal),
    // An approval checked for a background job after a rebuild is billed to
    // the session the user now sees.
    live: () => sessions.get(sessionId),
    current: () => epochOf(sessionId) === mine,
  })
  // A save can land in the last stretch of the build, after the servers were
  // checked. The session it would keep is already out of date.
  if (epochOf(sessionId) !== mine) {
    await built.hub.close()
    throw new Error('the settings changed while this session was opening; send that again')
  }
  const { session, problems } = built
  hubs.set(sessionId, built.hub)
  const heard = problems.join('\n')
  if (problems.length > 0 && hookNotes.get(sessionId) !== heard) for (const problem of problems) session.note(problem)
  hookNotes.set(sessionId, heard)
  sessions.set(sessionId, session)
  promptSecrets.set(sessionId, built.secrets)
  return session
}

/**
 * Hand the settings' current facts to every live session, after a save that
 * changed prices, limits or the context window and nothing a session is built
 * from. Settings that do not resolve leave the sessions as they are: the save
 * that broke them is the setup screen's to report.
 */
async function refreshFacts(): Promise<void> {
  const config = await loadProviderConfig().catch(() => null)
  if (config === null) return
  const facts = resolveFacts(config.provider, config.model)
  for (const session of sessions.values()) session.setFacts(facts)
}

/**
 * Quitting is the one path that has to wait: Electron tears the process down
 * the moment this handler returns, and a `kill` that has been sent but not
 * waited for leaves the server running with nothing to reap it.
 */
let quitting = false

/**
 * What happens to the subagents that are still working when the app goes away.
 * They die with the process, and the conversation has to carry the loss: the
 * next turn needs to know the work was never done, so it asks for it again
 * and waits on no answer that is gone.
 */
async function abandonJobs(): Promise<void> {
  const why = 'the app closed while it was running'
  const touched = new Map<string, Session>()
  for (const registry of jobRegistries.values()) {
    for (const job of registry.abandon(why)) {
      const parent = sessions.get(job.sessionId)
      if (parent === undefined || !job.background) continue
      parent.deliver(`Background ${job.role} job ${job.id} never finished: ${why}, and its answer is gone. It was asked: ${job.task}`)
      touched.set(job.sessionId, parent)
    }
  }
  for (const [id, session] of touched) {
    // A turn may still be in flight, and in that case `deliver` queues instead
    // of folding in. Nothing is coming that would drain the queue.
    session.settle()
    await saveTranscript(id, session.transcript, session.notes).catch((err: unknown) => {
      process.stderr.write(`abandoned job: ${err instanceof Error ? err.message : String(err)}\n`)
    })
  }
}

function quit(event: Electron.Event): void {
  if (quitting) return
  quitting = true
  event.preventDefault()
  // A hook's children and a terminal's live in groups of their own, which
  // would outlive the app.
  stopHooks()
  stopTerminals()
  // A key captured in the last turn is still queued for the credential store, and
  // a job still running has to be written down before the sessions go.
  void abandonJobs()
    .then(() => Promise.all([retire(), flushSecrets()]))
    .finally(() => app.quit())
}

app.whenReady().then(() => {
  app.setAppUserModelId(APP_ID)
  serveRenderer()
  // Read the shell's PATH and probe the machine while the window is still
  // being built. The PATH read is never waited on, and doing it here means the
  // agent's first command is as quick as its second. The probe is awaited by
  // the first session's system prompt, which by then has usually got it.
  void warmShell()
  void hostFacts()

  ipcMain.handle(IPC_CHANNELS.ping, () => ({ ok: true, version: pkg.version }))

  // The only way out of the window. `setWindowOpenHandler` denies everything
  // and `will-navigate` is blocked, so a link is handed to the OS browser
  // instead, and only ever an http(s) one: `shell.openExternal` would otherwise
  // launch whatever a `file:` or a custom scheme is registered to.
  ipcMain.handle(IPC_CHANNELS.openExternal, async (_event: IpcMainInvokeEvent, url: string): Promise<void> => {
    const target = new URL(url)
    if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new Error(`refusing to open ${target.protocol} link`)
    await shell.openExternal(target.toString())
  })

  ipcMain.handle(IPC_CHANNELS.configGet, (): Promise<ConfigStatus> => configStatus())

  ipcMain.handle(IPC_CHANNELS.configProbe, (_event: IpcMainInvokeEvent, req: ConfigProbeRequest): Promise<ConfigProbeResult> => probeProvider(req))

  // A settings write that changes what a session is built from retires the
  // live sessions, and the stored transcript makes that lossless. One carrying
  // only prices and effort levels leaves them running: a turn in flight should
  // not end because somebody looked at the model list.
  ipcMain.handle(IPC_CHANNELS.configSaveProvider, async (_event: IpcMainInvokeEvent, req: ProviderSaveRequest): Promise<ConfigStatus> => {
    if (await saveProvider(req)) void retire()
    else await refreshFacts()
    return configStatus()
  })

  // One setting for every session, so it is stored and handed to each live one.
  // A session built later reads it from the file.
  ipcMain.handle(IPC_CHANNELS.configSetAutoCompact, async (_event: IpcMainInvokeEvent, on: boolean): Promise<ConfigStatus> => {
    await setAutoCompact(on)
    for (const session of sessions.values()) session.setAutoCompact(on)
    return configStatus()
  })

  ipcMain.handle(IPC_CHANNELS.configSetContextLimit, async (_event: IpcMainInvokeEvent, limit: number | null): Promise<ConfigStatus> => {
    await setContextLimit(limit)
    for (const session of sessions.values()) session.setContextLimit(limit ?? undefined)
    return configStatus()
  })

  // Hooks are read when a session is built, so switching them is followed by
  // a rebuild. How images are prepared is read at each paste.
  ipcMain.handle(IPC_CHANNELS.configSetSwitch, async (_event: IpcMainInvokeEvent, req: { name: SwitchName; on: boolean }): Promise<ConfigStatus> => {
    await setSwitch(req.name, req.on)
    if (req.name === 'hooks') void retire()
    return configStatus()
  })

  ipcMain.handle(IPC_CHANNELS.configDeleteProvider, async (_event: IpcMainInvokeEvent, id: string): Promise<ConfigStatus> => {
    await deleteProvider(id)
    void retire()
    return configStatus()
  })

  ipcMain.handle(IPC_CHANNELS.configSetActive, async (_event: IpcMainInvokeEvent, req: ActiveSetRequest): Promise<ConfigStatus> => {
    await setActive(req)
    void retire()
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
    for (const session of status.sessions.filter(s => s.workspaceId === id)) {
      sessions.get(session.id)?.stop()
      void retire(session.id)
      closeTerminals(session.id)
      permissions.delete(session.id)
    }
    await removeWorkspace(id)
    return workspaceStatus()
  })

  ipcMain.handle(IPC_CHANNELS.sessionCreate, (_event: IpcMainInvokeEvent, workspaceId: string): Promise<SessionView> => createSession(workspaceId))

  ipcMain.handle(IPC_CHANNELS.sessionOpen, async (_event: IpcMainInvokeEvent, id: string): Promise<SessionOpenResponse> => {
    const status = await workspaceStatus()
    const session = status.sessions.find(s => s.id === id)
    const workspace = status.workspaces.find(w => w.id === session?.workspaceId)
    if (session === undefined || workspace === undefined) throw new Error('that session is gone; start a new one from the sidebar')
    return { session, workspace, messages: toTranscriptView(await loadTranscript(id)), notes: await loadNotes(id) }
  })

  // A session's own name, once the user has given it one. `noteTurn` only ever
  // writes a title over the placeholder, so a renamed session keeps its name.
  ipcMain.handle(IPC_CHANNELS.sessionRename, async (_event: IpcMainInvokeEvent, req: { id: string; title: string }): Promise<WorkspaceStatus> => {
    await renameSession(req.id, req.title)
    return workspaceStatus()
  })

  ipcMain.handle(IPC_CHANNELS.sessionTranscriptPath, (_event: IpcMainInvokeEvent, id: string): string => transcriptPath(id))

  /**
   * What MCP this session has. A session that has never run has no hub, since
   * it is built on the first message and dialling servers for a session the
   * user only clicked on would spawn subprocesses nobody asked for. Until then
   * the answer is the configured list, marked as not yet dialled.
   */
  ipcMain.handle(IPC_CHANNELS.mcpStatus, async (_event: IpcMainInvokeEvent, sessionId: string): Promise<McpStatusView> => {
    const hub = hubs.get(sessionId)
    if (hub !== undefined) return { live: true, servers: [...hub.status] }
    const root = await sessionRoot(sessionId)
    if (root === null) return { live: false, servers: [] }
    const loaded = await loadServers(root)
    const servers: McpServerStatus[] = loaded.problems.map(problem => ({
      name: 'mcp.json',
      connected: false,
      toolCount: 0,
      error: problem,
    }))
    for (const server of loaded.servers) servers.push({ name: server.name, connected: false, toolCount: 0, pending: true })
    return { live: false, servers }
  })

  ipcMain.handle(IPC_CHANNELS.secretsList, (): Promise<SecretView[]> => secretList())

  ipcMain.handle(IPC_CHANNELS.secretsForget, (_event: IpcMainInvokeEvent, name: string): Promise<SecretView[]> => forgetSecret(name))

  /**
   * The window's first call for every message it is about to draw. A key is
   * taken out here, before anything renders and before anything is stored, so
   * the raw value exists in exactly one place: the vault.
   */
  ipcMain.handle(IPC_CHANNELS.secretsCapture, async (_event: IpcMainInvokeEvent, text: string): Promise<CaptureResult> => {
    return (await secretVault()).capture(text)
  })

  /**
   * The spend view, built here and not in the window: the arithmetic is one
   * copy in `usage-report.ts`, shared with `nh usage`, and the window is a
   * separate bundle that cannot import it. The names come from the index, so a
   * row for a deleted session says so and never shows a bare id.
   */
  ipcMain.handle(IPC_CHANNELS.usageReport, async (_event: IpcMainInvokeEvent, days: number | null): Promise<UsageReport> => {
    const log = await readUsage()
    return buildReport(log.records, { days, skipped: log.skipped, names: await usageNames() })
  })

  ipcMain.handle(IPC_CHANNELS.usageClear, async (_event: IpcMainInvokeEvent, days: number | null): Promise<UsageReport> => {
    await clearUsage()
    const log = await readUsage()
    return buildReport(log.records, { days, skipped: log.skipped, names: await usageNames() })
  })

  ipcMain.handle(IPC_CHANNELS.sessionDelete, async (_event: IpcMainInvokeEvent, id: string): Promise<WorkspaceStatus> => {
    // A turn still running would go on waiting for a question nobody can see
    // any more, or start a terminal into a set that is already closed.
    sessions.get(id)?.stop()
    void retire(id)
    closeTerminals(id)
    permissions.delete(id)
    checkpointStores.delete(id)
    await deleteSession(id)
    return workspaceStatus()
  })

  // Switching agent keeps the transcript and retires the live session: its
  // prompt and its tool list both belong to the role it was built with.
  ipcMain.handle(IPC_CHANNELS.sessionSetRole, async (_event: IpcMainInvokeEvent, req: { sessionId: string; role: AgentRole }): Promise<SessionView> => {
    if (!isAgentRole(req.role)) throw new Error(`unknown agent: ${String(req.role)}`)
    void retire(req.sessionId)
    return setSessionRole(req.sessionId, req.role)
  })

  ipcMain.handle(
    IPC_CHANNELS.agentsList,
    (): AgentSummary[] =>
      AGENT_ROLES.map(role => ({
        role,
        name: AGENTS[role].name,
        purpose: AGENTS[role].purpose,
      })),
  )

  ipcMain.handle(IPC_CHANNELS.jobsList, (event: IpcMainInvokeEvent): JobView[] => jobsFor(event.sender).list())

  /**
   * One subagent's stored conversation. The window uses it for a subagent this
   * launch never ran, such as a spawn from last week opened from the tool call
   * that started it, where there is no live stream to replay.
   */
  ipcMain.handle(
    IPC_CHANNELS.subagentOpen,
    async (_event: IpcMainInvokeEvent, req: { sessionId: string; id: string }): Promise<SubagentOpenResponse | null> => {
      const stored = await loadSubagent(req.sessionId, req.id)
      if (stored === null) return null
      return { ...stored, messages: toTranscriptView(stored.messages) }
    },
  )

  ipcMain.handle(IPC_CHANNELS.permissionMode, async (_event: IpcMainInvokeEvent, sessionId: string): Promise<PermissionModeView> => {
    const state = await permissionsFor(sessionId)
    return modeView(state.mode, await approvalGap())
  })

  /**
   * Switch how a session answers permission questions. Asking for auto mode
   * with nothing to ask is refused outright, never accepted and then ignored.
   */
  ipcMain.handle(
    IPC_CHANNELS.permissionSetMode,
    async (_event: IpcMainInvokeEvent, req: { sessionId: string; mode: PermissionMode }): Promise<PermissionModeView> => {
      const state = await permissionsFor(req.sessionId)
      const gap = await approvalGap()
      if (req.mode === 'auto' && gap !== undefined) return modeView(state.mode, gap)
      state.mode = req.mode
      // The judge is rebuilt with the next question, so a ladder edited while
      // the session was in `ask` is the one auto mode comes back on with.
      judges.delete(req.sessionId)
      await setDefaultMode(req.mode)
      return modeView(req.mode, gap)
    },
  )

  ipcMain.handle(IPC_CHANNELS.configSaveApproval, async (_event: IpcMainInvokeEvent, approval: ApprovalConfig): Promise<ConfigStatus> => {
    await saveApproval(approval)
    // Every live judge was built from the old ladder and the old rules.
    judges.clear()
    return configStatus()
  })

  ipcMain.handle(IPC_CHANNELS.projectTrustRespond, (_event: IpcMainInvokeEvent, req: { id: string; allow: boolean }) => {
    trustAnswers.get(req.id)?.(req.allow === true)
  })

  ipcMain.handle(IPC_CHANNELS.permissionRespond, (event: IpcMainInvokeEvent, req: { id: string; decision: PermissionDecision }) => {
    brokerFor(event.sender).resolve(req.id, req.decision)
  })

  ipcMain.handle(IPC_CHANNELS.questionRespond, (event: IpcMainInvokeEvent, req: { id: string; reply: unknown }) => {
    questionsFor(event.sender).resolve(req.id, req.reply)
  })

  // Stop is a message to a turn already in flight, so it never builds a
  // session: a session that is not running has nothing to stop.
  ipcMain.handle(IPC_CHANNELS.sessionStop, (_event: IpcMainInvokeEvent, sessionId: string) => {
    sessions.get(sessionId)?.stop()
  })

  // A compaction runs between turns, on the session's own model and history,
  // so a session nobody has sent anything to since launch is built for it.
  ipcMain.handle(IPC_CHANNELS.sessionCompact, async (event: IpcMainInvokeEvent, sessionId: string): Promise<SessionCompactResponse> => {
    const session = await sessionFor(event.sender, sessionId)
    const identity = await sessionIdentity(sessionId)
    if (identity === null) throw new Error('that session is gone; start a new one from the sidebar')
    const outcome = await session.compact()
    await settleBetweenTurns(sessionId, identity, session, outcome)
    return { compacted: outcome.compacted }
  })

  ipcMain.handle(IPC_CHANNELS.sessionTldr, async (event: IpcMainInvokeEvent, sessionId: string): Promise<SessionTldrResponse> => {
    const session = await sessionFor(event.sender, sessionId)
    const identity = await sessionIdentity(sessionId)
    if (identity === null) throw new Error('that session is gone; start a new one from the sidebar')
    const outcome = await session.tldr()
    await settleBetweenTurns(sessionId, identity, session, outcome)
    return { written: outcome.written }
  })

  // Skills, hooks and MCP servers are fixed for a session's life, because the
  // prompt and the tool list they feed are the cached prefix, so reading them
  // again means building the session again. It is built now and not on the
  // next message, so the window can say at once what it came back with.
  ipcMain.handle(IPC_CHANNELS.sessionReload, async (event: IpcMainInvokeEvent, sessionId: string): Promise<SessionReloadResponse> => {
    if (sessions.get(sessionId)?.running === true) throw new Error('a turn is running; stop it or let it finish, then reload')
    // A subagent reaches MCP servers through the session's hub, which the
    // rebuild closes under it.
    const running = jobsFor(event.sender).list().some(job => job.sessionId === sessionId && job.state === 'running')
    if (running) throw new Error('a background job in this session is still running; stop it or wait for it before reloading')
    const root = await sessionRoot(sessionId)
    if (root === null) throw new Error('that session is gone; start a new one from the sidebar')
    await retire(sessionId)
    const session = await sessionFor(event.sender, sessionId)
    const skills = (await loadSkills(root)).length
    const servers = [...(hubs.get(sessionId)?.status ?? [])]
    const connected = servers.filter(server => server.connected).length
    session.note(
      `Reloaded: ${plural(skills, 'skill')}, ${connected} of ${plural(servers.length, 'MCP server')} connected, hooks read again. The next message pays for the whole prompt once, since the provider has not cached the new one.`,
    )
    await saveTranscript(sessionId, session.transcript, session.notes)
    return { skills, servers }
  })

  ipcMain.handle(IPC_CHANNELS.snippetsList, async (_event: IpcMainInvokeEvent, sessionId: string | null): Promise<SnippetView[]> => {
    const root = sessionId === null ? null : await sessionRoot(sessionId)
    return loadSnippets([
      { dir: BUILT_IN_SNIPPETS, source: 'built-in' },
      { dir: join(userDataDir(), 'snippets'), source: 'user' },
      ...(root === null ? [] : [{ dir: join(root, SNIPPETS_DIR), source: 'project' as const }]),
    ])
  })

  // The list is read from disk when the session is not built, since opening a
  // session should not start a provider and a set of MCP servers.
  ipcMain.handle(IPC_CHANNELS.sessionCheckpoints, async (_event: IpcMainInvokeEvent, sessionId: string): Promise<SessionCheckpointsResponse> => {
    const root = await sessionRoot(sessionId)
    if (root === null) throw new Error('that session is gone; start a new one from the sidebar')
    const store = checkpointsFor(sessionId)
    const { entries, held } = await store.list()
    return {
      checkpoints: entries.map(entry => ({ ...entry, files: entry.files.map(abs => shownPath(root, abs)) })),
      held: held === null ? null : { checkpointId: held.id, mode: held.mode },
    }
  })

  ipcMain.handle(IPC_CHANNELS.sessionRewind, async (event: IpcMainInvokeEvent, req: SessionRewindRequest): Promise<SessionRewindResponse> => {
    if (!REWIND_MODES.includes(req.mode)) throw new Error(`unknown rewind mode: ${String(req.mode)}`)
    // A background job still running could write a file straight after it was
    // put back, or finish into a conversation that no longer asked for it.
    const running = jobsFor(event.sender).list().some(job => job.sessionId === req.sessionId && job.state === 'running')
    if (running) throw new Error('a background job in this session is still running; stop it or wait for it before rewinding')
    const session = await sessionFor(event.sender, req.sessionId)
    // The transcript is left whole until the next message or a compaction
    // keeps the rewind.
    const outcome = await session.rewind(req.checkpointId, req.mode)
    const root = session.options.cwd
    return {
      failed: outcome.failed.map(miss => ({ path: shownPath(root, miss.path), reason: miss.reason })),
      ...(outcome.prompt === undefined ? {} : { prompt: outcome.prompt }),
    }
  })

  ipcMain.handle(IPC_CHANNELS.sessionSend, async (event: IpcMainInvokeEvent, req: SessionSendRequest) => {
    // The window has already captured what it drew, and this is idempotent on
    // text that has been through it. It runs again because this is the boundary
    // that matters: a key must not reach the transcript whatever called send.
    const vault = await secretVault()
    const safe = (part: string): string => vault.capture(part).text
    const own = safe(req.text)
    const { text, said } = compose(own, snippetTexts(req.before).map(safe), snippetTexts(req.after).map(safe))
    const images = acceptImages(req.images)
    // A key captured after this session was built gives it a reference its
    // system prompt has never heard of, and a model reading `{{secret:name}}`
    // with nothing to explain it asks for the key it already has. Retiring the
    // session costs one cache miss, once, the first time a key appears.
    //
    // The comparison is against what the prompt was built with. Against the
    // vault as it stood a moment ago it would never fire: the window captures
    // the message before it draws it, so the name is already stored by here.
    const built = promptSecrets.get(req.sessionId)
    if (built !== undefined && hasUnknownSecret(built, vault.names())) await retire(req.sessionId)
    const session = await sessionFor(event.sender, req.sessionId)
    // Read before the turn and not after it: a session deleted while it was
    // running still spent what it spent, and by then the index no longer knows
    // which folder or which agent to file that line under.
    const identity = await sessionIdentity(req.sessionId)
    if (identity === null) throw new Error('that session is gone; start a new one from the sidebar')
    const usage = await session.run(text, images, said)
    // The title comes from the user's own words, and from the snippets only
    // when they sent nothing else.
    const updated = await recordTurn(identity, session, own.trim() === '' ? text : own)

    const status = await workspaceStatus()
    const view = updated ?? status.sessions.find(s => s.id === req.sessionId)
    if (view === undefined) throw new Error('that session is gone; start a new one from the sidebar')
    return { sessionId: req.sessionId, usage, session: view }
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  // An MCP server is a subprocess this app started, so quitting takes them
  // with it. Not `window-all-closed`, which does not end the app on macOS, and
  // not `will-quit`, which fires after a window has taken its job registry
  // with it. `before-quit` runs while both are still here.
  app.on('before-quit', quit)

  app.on('window-all-closed', () => app.quit())
})

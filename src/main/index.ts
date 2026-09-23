// doc: docs/harness/overview.md
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createProvider } from '../providers/factory.js'
import { BASH_TOOL, GUARDED_BASH_TOOL } from '../tools/bash.js'
import { warmShell } from '../env/shell.js'
import { hostFacts } from '../env/probe.js'
import { Hooks, hooksBlock, stopHooks } from '../hooks/hooks.js'
import { hookPaths, readHookFile } from '../hooks/config.js'
import { READ_TOOL } from '../tools/read.js'
import { GLOB_TOOL, GREP_TOOL } from '../tools/search.js'
import { WRITE_TOOL } from '../tools/write.js'
import { EDIT_TOOL } from '../tools/edit.js'
import { LOG_IMPROVEMENT_TOOL } from '../tools/log-improvement.js'
import { SPAWN_TOOL, toolsText } from '../tools/spawn.js'
import { JOB_UPDATE_TOOL } from '../tools/job-update.js'
import { AGENTS, AGENT_ROLES, HARNESS_HANDOFF, agentPrompt, isAgentRole, roleContext } from '../core/agents.js'
import { EventBus } from '../core/event-bus.js'
import { ProjectTrust, projectTrustPath } from '../core/project-trust.js'
import type { ProjectFile } from '../core/project-trust.js'
import { JobRegistry } from '../core/jobs.js'
import { cloneHistory, createSpawnHost } from '../core/spawn.js'
import { McpHub, mcpBlock } from '../mcp/hub.js'
import { loadSkills, skillsBlock } from '../core/skills.js'
import { loadServers, mcpPaths } from '../mcp/config.js'
import { hasUnknownSecret, secretsBlock } from '../core/secrets.js'
import { flushSecrets, forgetSecret, secretList, secretVault } from './secret-store.js'
import { Session } from '../core/session.js'
import { appendUsage, clearUsage, readUsage } from '../core/usage-log.js'
import { buildReport } from '../core/usage-report.js'
import type { UsageReport } from '../core/usage-report.js'
import { Judge, approvalProblem, goalsFrom, mergeRules } from '../core/approval.js'
import type { ApprovalConfig, PermissionMode } from '../core/approval.js'
import { resolveFacts } from '../core/config.js'
import type { SwitchName } from '../core/config.js'
import { emptyUsage } from '../core/types.js'
import { IPC_CHANNELS } from '../ipc/contract.js'
import {
  approvalEndpoints,
  autoCompact,
  configStatus,
  contextLimit,
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
  switchOn,
} from './config-store.js'
import { PermissionBroker, gateState, promptingGate } from './permission.js'
import type { ApprovalRecord, GateState } from './permission.js'
import {
  acceptImages,
  addWorkspace,
  appendApproval,
  createSession,
  deleteSession,
  loadNotes,
  loadSubagent,
  loadTranscript,
  noteTurn,
  removeWorkspace,
  renameSession,
  saveSubagent,
  saveTranscript,
  sessionContext,
  sessionIdentity,
  sessionRole,
  sessionRoot,
  sessionUsage,
  setSessionRole,
  setSessionState,
  toTranscriptView,
  transcriptPath,
  usageNames,
  workspaceStatus,
} from './workspace-store.js'
import type { SessionState } from './workspace-store.js'
import { createWindow, serveRenderer } from './window.js'
import type { AgentRole, HarnessFacts } from '../core/agents.js'
import type { JobView } from '../core/jobs.js'
import type { PromptEnvironment } from '../core/prompt.js'
import type { SubagentSetup, SubagentSlot } from '../core/spawn.js'
import type { Tool } from '../core/session.js'
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
  SessionSendRequest,
  SecretView,
  SessionCompactResponse,
  SessionView,
  SubagentOpenResponse,
  WorkspaceStatus,
} from '../ipc/contract.js'

const require = createRequire(import.meta.url)
const pkg = require('../../package.json') as { version: string }

/**
 * Every event forwarded to the window, which is every event there is. A keyed
 * object and not a list, so leaving one out stops the build. Nothing goes
 * unforwarded in silence.
 */
const FORWARDED: Record<AppEvent['type'], true> = {
  'session.started': true,
  text_delta: true,
  thinking_delta: true,
  tool_call: true,
  tool_result: true,
  usage: true,
  'session.error': true,
  'round.started': true,
  'round.retry': true,
  'session.finished': true,
  'session.stopped': true,
  'session.note': true,
  'session.summary': true,
  context: true,
  'context.compacting': true,
  'context.compacted': true,
  'permission.request': true,
  'project.trust': true,
  'mcp.status': true,
  'job.started': true,
  'job.update': true,
  'job.finished': true,
}

const EVENT_TYPES = Object.keys(FORWARDED) as AppEvent['type'][]

/**
 * Where this build's own source is, when it is on disk to be read; a packaged
 * app without it says nothing, and points at no folder that is not there.
 * The harness editor is the one role told where it is.
 */
function harnessFacts(): HarnessFacts | undefined {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  if (!existsSync(join(root, 'docs', 'harness', 'doc-map.md'))) return undefined
  return { root, cli: `node "${join(root, 'out', 'cli', 'index.js')}"` }
}

const HARNESS = harnessFacts()

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

/**
 * Which subagent ids belong to which window, so a child's own stream reaches
 * the window that asked for it and nowhere else. The id is the job id, which is
 * also the child session's id, and that is what lets the renderer tell a
 * subagent's events apart from the conversation's.
 */
function subagentBus(sender: WebContents, parent: () => Session | undefined): (slot: SubagentSlot) => EventBus {
  return slot => {
    const bus = new EventBus()
    for (const type of EVENT_TYPES) {
      bus.on(type, event => {
        if (!sender.isDestroyed()) sender.send(IPC_CHANNELS.sessionEvent, event)
      })
    }
    // What the child has spent, as of the last usage event it emitted. A
    // subagent's usage event carries its own running total, so what the parent
    // is owed is the difference since the one before. Adding it round by round
    // keeps the counter showing what is being spent right now, with no jump
    // when the subagent finishes.
    let counted = emptyUsage()
    bus.on('usage', event => {
      if (event.sessionId !== slot.id) return
      const total = event.usage
      parent()?.addSubagentUsage({
        input: total.input - counted.input,
        output: total.output - counted.output,
        cacheRead: total.cacheRead - counted.cacheRead,
        cacheWrite: total.cacheWrite - counted.cacheWrite,
        reasoning: total.reasoning - counted.reasoning,
      })
      counted = { ...total }
    })
    return bus
  }
}

/**
 * How many times a session has been retired. A build reads this when it starts
 * and again once its servers are up: a different number means the settings it
 * was built against are gone, so it closes what it opened. Without it, a save
 * landing mid-build leaves a set of subprocesses with nothing holding them.
 */
const epochs = new Map<string, number>()

function epochOf(sessionId: string): number {
  return epochs.get(sessionId) ?? 0
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

const TOOLS: Record<string, Tool> = {
  bash: BASH_TOOL,
  read: READ_TOOL,
  grep: GREP_TOOL,
  glob: GLOB_TOOL,
  write: WRITE_TOOL,
  edit: EDIT_TOOL,
  log_improvement: LOG_IMPROVEMENT_TOOL,
  spawn: SPAWN_TOOL,
  job_update: JOB_UPDATE_TOOL,
}

/**
 * The role's tools, minus the two that only make sense in one place: only a
 * background job may report progress, and a subagent may not summon another
 * one.
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

async function environment(root: string): Promise<PromptEnvironment> {
  return { root, platform: process.platform, host: await hostFacts(), today: new Date().toISOString().slice(0, 10) }
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
const judges = new Map<string, Judge>()

async function judgeFor(sessionId: string): Promise<Judge> {
  const existing = judges.get(sessionId)
  if (existing) return existing
  const stored = await readStored()
  const judge = new Judge({
    endpoints: approvalEndpoints,
    rules: mergeRules(stored.approval?.rules),
    // Derived from the session's and never equal to it: the judge shares the
    // session's lifetime and nothing else, least of all its message history.
    conversationId: `${sessionId}-approval`,
    ...(stored.approval?.effort === undefined ? {} : { effort: stored.approval.effort }),
  })
  judges.set(sessionId, judge)
  return judge
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
 * The hooks a session runs, read once as it is built: the global file, then
 * the project's once the user has approved it. What went wrong comes back as
 * problems for the session to note.
 */
async function loadHooks(sender: WebContents, sessionId: string, root: string): Promise<{ hooks: Hooks; problems: string[] }> {
  if (!(await switchOn('hooks'))) return { hooks: new Hooks([], root), problems: [] }
  const paths = hookPaths(root)
  const global = await readHookFile(paths.global)
  const specs = [...global.hooks]
  const problems = [...global.problems]
  // A workspace opened at the home folder finds one file in both places.
  if (paths.project !== paths.global) {
    const project = await readHookFile(paths.project)
    if (project.hooks.length === 0) {
      problems.push(...project.problems)
    } else if (await projectTrusted(sender, sessionId, 'hooks', project)) {
      specs.push(...project.hooks)
      problems.push(...project.problems)
    } else {
      problems.push(`The hooks in ${project.path} are off because they were not approved. Change the file or restart the app to be asked again.`)
    }
  }
  return { hooks: new Hooks(specs, root), problems }
}

/**
 * The hook notes each session was last given. A session is rebuilt after every
 * settings save, and a note it already carries is not written again.
 */
const hookNotes = new Map<string, string>()

/** A session's running totals and its context, in the shape the store writes. */
function stateOf(session: Session): SessionState {
  return {
    spend: { total: session.spent, subagents: session.spentBySubagents, harness: session.spentByHarness, harnessCostUsd: session.harnessCost },
    context: session.context,
  }
}

/**
 * What one automatic decision costs and where it is written down. The tokens go
 * on the session's counter as the harness's own; the line goes to the session's
 * approval log, so a decision the user never saw is still one they can read. A
 * log that cannot be written is a warning, never the end of the turn.
 */
function recordApproval(sessionId: string, record: ApprovalRecord): void {
  const session = sessions.get(sessionId)
  if (session !== undefined && record.outcome !== undefined) {
    session.addHarnessUsage(record.outcome.usage, record.outcome.costUsd)
  }
  void appendApproval({
    at: record.at,
    sessionId,
    intent: record.action.intent,
    ...(record.action.command === undefined ? {} : { command: record.action.command }),
    ...(record.action.paths.length === 0 ? {} : { paths: [...record.action.paths] }),
    ...(record.outcome === undefined
      ? {}
      : {
          verdict: record.outcome.verdict,
          rule: record.outcome.rule,
          reason: record.outcome.reason,
          model: record.outcome.model,
          ms: record.outcome.ms,
          usage: record.outcome.usage,
          ...(record.outcome.costUsd === null ? {} : { costUsd: record.outcome.costUsd }),
        }),
    ...(record.problem === undefined ? {} : { problem: record.problem }),
  }).catch((err: unknown) => {
    process.stderr.write(`approval log: ${err instanceof Error ? err.message : String(err)}\n`)
  })
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
  const root = await sessionRoot(sessionId)
  if (root === null) throw new Error('that session is gone; start a new one from the sidebar')

  const config = await loadProviderConfig()
  const facts = resolveFacts(config.provider, config.model)
  const provider = createProvider({
    kind: config.provider.kind,
    baseURL: config.provider.baseURL,
    apiKey: config.apiKey,
    ...(facts.wire === undefined ? {} : { wire: facts.wire }),
    ...(config.provider.sessionHeader === undefined ? {} : { sessionHeader: config.provider.sessionHeader }),
  })
  const bus = new EventBus()
  for (const type of EVENT_TYPES) {
    bus.on(type, event => {
      if (!sender.isDestroyed()) sender.send(IPC_CHANNELS.sessionEvent, event)
    })
  }

  const role = (await sessionRole(sessionId)) ?? 'builder'

  // Both of these are decided before the first request and never again inside
  // a session, and for the same reason: the skills list sits in the system
  // prompt and the MCP tools sit in the tool definitions, which is to say both
  // are part of the cached prefix. Discovering either mid-session would move
  // bytes the provider has already cached and cost the whole prefix.
  const skills = await loadSkills(root)
  // Before anything is spawned, because the first time a project's hooks or
  // servers are met, each of these waits on the user.
  const { hooks, problems: hookProblems } = await loadHooks(sender, sessionId, root)
  const servers = await loadServers(root, { trust: file => projectTrusted(sender, sessionId, 'mcp', file) })
  const hub = await McpHub.connect(root, servers.servers, servers.problems)
  if (epochOf(sessionId) !== mine) {
    await hub.close()
    throw new Error('the settings changed while this session was opening; send that again')
  }
  // After the check, so a build that is about to be thrown away does not run
  // the user's commands for nothing.
  const started = await hooks.run('SessionStart', sessionId, {})
  hubs.set(sessionId, hub)
  for (const server of hub.status) {
    if (!server.connected) console.warn(`mcp: ${server.name} is not connected: ${server.error ?? 'unknown reason'}`)
  }
  // The window asked what MCP this session has before it had any, because a
  // session is only built on its first message and nothing is dialled for one
  // the user merely clicked on. This is the answer arriving late.
  bus.emit({ type: 'mcp.status', sessionId, servers: [...hub.status], live: true, at: Date.now() })

  // What MCP the session actually has, told to the agent in its own words. A
  // model with no such block answers "what tools do you have" from its
  // training set.
  const paths = mcpPaths(root)
  const secrets = await secretVault()
  const context = [
    ...(await roleContext(role, root, HARNESS)),
    ...skillsBlock(skills),
    ...secretsBlock(secrets.names()),
    ...mcpBlock(hub.status, paths, {
      canConfigure: role === 'harness-editor',
      canSpawn: AGENTS[role].tools.includes('spawn'),
      root,
      ...(HARNESS === undefined ? {} : { cli: HARNESS.cli }),
    }),
    // A session that can spawn carries the routing rule. A distinct subagent
    // has no `spawn` tool, so its prompt does not name one.
    ...(AGENTS[role].tools.includes('spawn') ? HARNESS_HANDOFF : []),
    // What a hook printed can hold a key. The session scrubs what passes
    // through it, and this goes straight into the prompt, so it is scrubbed here.
    ...hooksBlock(hooks, started.context.map(text => secrets.redact(text))),
  ]
  const systemPrompt = agentPrompt(role, await environment(root), context)
  const tools = [...toolsFor(role, { canSpawn: true, isJob: false }), ...hub.tools()]
  // A subagent is held to the parent's boundary and the same broker: an "allow
  // for this session" covers the work the user asked for, whoever does it. A
  // clone is built from the parent's live transcript, which the gate also reads
  // for the goals it judges against; the holder ties the two together.
  const parent: { session?: Session } = {}

  const access = promptingGate({
    root,
    sessionId,
    broker: brokerFor(sender),
    state: await permissionsFor(sessionId),
    redact: text => secrets.redact(text),
    judge: await judgeFor(sessionId),
    // The user's own messages, read off the live transcript at the moment the
    // question is asked. Never the assistant's and never a tool result: tool
    // output is the part an attacker can write into.
    goals: () => goalsFrom(parent.session?.transcript ?? []),
    onDecision: record => {
      recordApproval(sessionId, record)
    },
    ...(HARNESS === undefined ? {} : { readable: [HARNESS.root] }),
  })

  const spent = await sessionUsage(sessionId)
  const auto = await autoCompact()
  const limit = await contextLimit()
  const stored = await sessionContext(sessionId)

  const setup = async (request: { role: AgentRole; mode: string }, slot: SubagentSlot): Promise<SubagentSetup> => {
    // Only a background child gets `job_update`: a foreground one is being
    // waited on, so its report is the answer it comes back with.
    const isJob = slot.background
    if (request.mode === 'clone') {
      // A clone is the parent one message later: same prompt, same tool list,
      // same history, so the provider's cache answers the whole prefix. The
      // tool definitions sit in front of the messages, so dropping one would
      // invalidate the bytes this exists to reuse, so `spawn` stays in the
      // list and refuses at the call instead.
      return {
        systemPrompt,
        tools,
        history: cloneHistory(parent.session?.transcript ?? []),
        effort: config.effort,
      }
    }
    // Every agent thinks as hard as the user asked this session to think.
    // There is no per-role default: the chip in the window is the whole
    // answer.
    return {
      systemPrompt: agentPrompt(request.role, await environment(root), [
        ...(await roleContext(request.role, root, HARNESS)),
        ...skillsBlock(skills),
        ...secretsBlock(secrets.names()),
        // A subagent cannot spawn, so it cannot hand the work on again. The
        // MCP configurer is the harness-editor, which gets the commands (the
        // CLI names the harness root, which only that role may know); a builder
        // or planner child gets the facts and nothing to relay. No child gets
        // the routing rule, which would name a tool it does not have.
        ...mcpBlock(hub.status, paths, {
          canConfigure: request.role === 'harness-editor',
          canSpawn: false,
          root,
          ...(request.role === 'harness-editor' && HARNESS !== undefined ? { cli: HARNESS.cli } : {}),
        }),
        ...hooksBlock(hooks.forSubagent(), []),
      ]),
      // A distinct subagent reaches the same servers the session does. They are
      // the session's connections, so nothing is spawned twice and nothing has
      // to be shut down when the subagent finishes.
      tools: [...toolsFor(request.role, { canSpawn: false, isJob }), ...hub.tools()],
      effort: config.effort,
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
      facts,
      systemPrompt,
      access,
      history: await loadTranscript(sessionId),
      secrets,
      hooks,
      autoCompact: auto,
      ...(limit === undefined ? {} : { contextLimit: limit }),
      ...(stored === null ? {} : { compactions: stored.compactions }),
      ...(stored?.model === config.model ? { calibration: stored.calibration } : {}),
      ...(spent === null ? {} : { usage: spent.total, subagentUsage: spent.subagents, harnessUsage: spent.harness, harnessCostUsd: spent.harnessCostUsd }),
      spawn: createSpawnHost({
        sessionId,
        role,
        cwd: root,
        model: config.model,
        facts,
        autoCompact: auto,
        ...(limit === undefined ? {} : { contextLimit: limit }),
        provider,
        access,
        jobs: jobsFor(sender),
        secrets,
        hooks,
        setup,
        // A subagent's stream goes to the same window, under the job's id. That
        // is the whole of what makes one watchable: the renderer already knows
        // how to draw these events, and the id says which panel they belong in.
        bus: subagentBus(sender, () => parent.session),
        // The subagent's own conversation, stored beside the parent's and named
        // by the id the tool result quotes. Reading back what another agent
        // actually did is the difference between a debuggable harness and one
        // that hands you a paragraph and asks you to trust it.
        save: async (slot, record) => {
          const job = jobsFor(sender).get(slot.id)
          await saveSubagent({
            id: slot.id,
            sessionId,
            role: record.request.role,
            mode: record.request.mode,
            task: record.request.task,
            background: slot.background,
            state: record.state,
            note: record.note,
            usage: record.usage,
            tools: record.tools,
            startedAt: job?.startedAt ?? Date.now(),
            endedAt: Date.now(),
            messages: record.messages,
            notes: record.notes,
            context: record.context,
          })
        },
        // Sending a failed write to stderr would tell nobody, and by then the
        // window has already drawn a card offering to open that conversation.
        // So it is drawn as an error in the conversation itself and kept in the
        // transcript beside the turn it belongs to.
        problem: text => {
          parent.session?.fault(text)
        },
        // A background job's answer, back into the conversation that started
        // it. Without this the model is told a job finished and never told what
        // it found: the answer lives in a file under the app's data directory,
        // outside the workspace, which is exactly where the agent cannot read.
        finished: (slot, outcome) => {
          const live = parent.session
          if (live === undefined) return
          const head = `Background ${outcome.request.role} job ${slot.id} ${outcome.state}. It was asked: ${outcome.request.task}`
          live.deliver(`${head}

What it answered:
${outcome.answer}`)
          // A job usually outlives the turn that started it, so this is often
          // the only moment the answer exists anywhere the model can reach.
          // Between turns nothing else writes the transcript: the next message
          // might never come, and saving settings retires the session. So it is
          // written here.
          if (!live.running) {
            void saveTranscript(sessionId, live.transcript, live.notes).catch((err: unknown) => {
              live.fault(`A background job's answer could not be stored: ${err instanceof Error ? err.message : String(err)}. It is in this conversation until the app closes.`)
            })
          }
        },
      }),
    },
    provider,
    tools,
    bus,
  )
  parent.session = session
  session.restoreNotes(await loadNotes(sessionId))
  const heard = [
    ...hookProblems,
    ...started.problems,
    ...(started.block === null ? [] : [`A SessionStart hook exited 2, which stops nothing when a session opens, and the hooks after it did not run. It said: ${started.block}`]),
  ]
  if (heard.length > 0 && hookNotes.get(sessionId) !== heard.join('\n')) for (const problem of heard) session.note(problem)
  hookNotes.set(sessionId, heard.join('\n'))
  sessions.set(sessionId, session)
  promptSecrets.set(sessionId, secrets.names())
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
  // A hook's children live in a group of their own, which would outlive the app.
  stopHooks()
  // A key captured in the last turn is still queued for the encrypted file, and
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
      void retire(session.id)
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
    void retire(id)
    permissions.delete(id)
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
    await saveTranscript(sessionId, session.transcript, session.notes)
    const updated = await setSessionState(sessionId, stateOf(session))
    // The summary requests are the harness's own spend and belong to no turn,
    // so they get a line of their own under the turn they followed.
    if (outcome.usage.input + outcome.usage.output + outcome.usage.cacheRead + outcome.usage.cacheWrite > 0) {
      await appendUsage({
        at: Date.now(),
        sessionId,
        workspaceId: identity.workspaceId,
        turn: session.turnNumber,
        role: identity.role,
        model: session.options.model,
        usage: outcome.usage,
        subagent: emptyUsage(),
        harness: outcome.usage,
        costUsd: outcome.costUsd,
        subagentCostUsd: 0,
        harnessCostUsd: outcome.costUsd ?? 0,
        streamMs: 0,
        betweenTurns: true,
      }).catch((err: unknown) => {
        process.stderr.write(`usage log: ${err instanceof Error ? err.message : String(err)}\n`)
      })
    }
    if (updated === null) throw new Error('that session is gone; start a new one from the sidebar')
    return { compacted: outcome.compacted }
  })

  ipcMain.handle(IPC_CHANNELS.sessionSend, async (event: IpcMainInvokeEvent, req: SessionSendRequest) => {
    // The window has already captured what it drew, and this is idempotent on
    // text that has been through it. It runs again because this is the boundary
    // that matters: a key must not reach the transcript whatever called send.
    const vault = await secretVault()
    const text = vault.capture(req.text).text
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
    const usage = await session.run(text, images)

    // The transcript is written after the turn, not during it: a half-streamed
    // answer is not a message, and a crash mid-turn should leave the session
    // exactly as it was before the message was sent.
    await saveTranscript(req.sessionId, session.transcript, session.notes)
    const rate = session.lastRate
    const updated = await noteTurn(req.sessionId, text, { ...stateOf(session), ...(rate === undefined ? {} : { rate }) })

    // One line per completed turn: what `nh usage` and the spend view are both
    // built out of. A log that cannot be written is worth a warning and no more
    // than that.
    const turn = session.lastTurn
    await appendUsage({
      at: Date.now(),
      sessionId: session.options.sessionId,
      workspaceId: identity.workspaceId,
      turn: session.turnNumber,
      role: identity.role,
      model: session.options.model,
      usage: turn.usage,
      subagent: turn.subagent,
      harness: turn.harness,
      costUsd: turn.costUsd,
      subagentCostUsd: turn.subagentCostUsd,
      harnessCostUsd: turn.harnessCostUsd,
      streamMs: turn.streamMs,
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
  // An MCP server is a subprocess this app started, so quitting takes them
  // with it. Not `window-all-closed`, which does not end the app on macOS, and
  // not `will-quit`, which fires after a window has taken its job registry
  // with it. `before-quit` runs while both are still here.
  app.on('before-quit', quit)

  app.on('window-all-closed', () => app.quit())
})

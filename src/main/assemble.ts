// doc: docs/harness/overview.md
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { emptyUsage } from '../shared/usage.js'
import { resolveFacts } from '../shared/facts.js'
import { createProvider } from '../providers/factory.js'
import { BASH_TOOL, GUARDED_BASH_TOOL } from '../tools/bash.js'
import { hostFacts } from '../env/probe.js'
import { Hooks, hooksBlock } from '../hooks/hooks.js'
import { hookPaths, readHookFile } from '../hooks/config.js'
import { READ_TOOL } from '../tools/read.js'
import { GLOB_TOOL, GREP_TOOL } from '../tools/search.js'
import { WRITE_TOOL } from '../tools/write.js'
import { EDIT_TOOL } from '../tools/edit.js'
import { LOG_IMPROVEMENT_TOOL } from '../tools/log-improvement.js'
import { SPAWN_TOOL } from '../tools/spawn.js'
import { JOB_UPDATE_TOOL } from '../tools/job-update.js'
import { TODO_TOOL } from '../tools/todo.js'
import { ASK_USER_TOOL } from '../tools/ask-user.js'
import { TERMINAL_TOOL } from '../tools/terminal.js'
import { AGENTS, HARNESS_HANDOFF, agentPrompt, roleContext } from '../core/agents.js'
import { EventBus } from '../core/event-bus.js'
import { cloneHistory, createSpawnHost } from '../core/spawn.js'
import { McpHub, mcpBlock } from '../mcp/hub.js'
import { loadSkills, skillsBlock } from '../core/skills.js'
import { loadServers, mcpPaths } from '../mcp/config.js'
import { secretsBlock } from '../core/secrets.js'
import { Session } from '../core/session.js'
import { Judge, goalsFrom, mergeRules } from '../core/approval.js'
import { appendUsage } from '../core/usage-log.js'
import { secretVault } from './secret-store.js'
import { approvalEndpoints, autoCompact, contextLimit, readStored, switchOn } from './config-store.js'
import { promptingGate } from './permission.js'
import {
  appendApproval,
  loadNotes,
  loadTranscript,
  noteTurn,
  saveSubagent,
  saveTranscript,
  sessionContext,
  sessionRole,
  sessionRoot,
  sessionUsage,
  setSessionState,
} from './workspace-store.js'
import type { ApprovalRecord, GateState, PermissionBroker } from './permission.js'
import type { SessionState } from './workspace-store.js'
import type { SessionView } from '../ipc/contract.js'
import type { ProviderConfig } from '../core/config.js'
import type { ProjectFile } from '../core/project-trust.js'
import type { CheckpointStore } from '../core/checkpoints.js'
import type { JobRegistry } from '../core/jobs.js'
import type { Terminals } from '../tools/terminal.js'
import type { AgentRole, HarnessFacts } from '../core/agents.js'
import type { PromptEnvironment } from '../core/prompt.js'
import type { SubagentSetup, SubagentSlot } from '../core/spawn.js'
import type { AskUser, Tool } from '../core/session.js'
import type { AppEvent, ProjectFileKind } from '../core/types.js'

/**
 * How a session is put together from what is stored: the provider, the role's
 * prompt and tools, skills, hooks, MCP servers, the permission gate and the
 * subagent host. The window and `nh run` both build sessions here, so a task
 * run from a script meets the same agent the user talks to. Nothing in this
 * module imports Electron. What only one host has (a window to forward events
 * to, a modal to ask in, a registry kept per window) comes in through
 * `SessionHost`.
 */

/**
 * Every event type there is, as a keyed object and not a list, so leaving one
 * out stops the build. A host is handed each of them; nothing goes unforwarded
 * in silence.
 */
const FORWARDED: Record<AppEvent['type'], true> = {
  'session.started': true,
  'session.checkpoint': true,
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
  'session.tldr': true,
  context: true,
  'context.compacting': true,
  'context.compacted': true,
  'permission.request': true,
  'question.request': true,
  'project.trust': true,
  'mcp.status': true,
  'job.started': true,
  'job.update': true,
  'job.finished': true,
}

const EVENT_TYPES = Object.keys(FORWARDED) as AppEvent['type'][]

function forwardAll(bus: EventBus, forward: (event: AppEvent) => void): void {
  for (const type of EVENT_TYPES) bus.on(type, forward)
}

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
  todo_write: TODO_TOOL,
  ask_user: ASK_USER_TOOL,
  terminal: TERMINAL_TOOL,
}

/** Tools only the session the user talks to may call. */
const SESSION_ONLY = new Set(['spawn', 'ask_user', 'terminal'])

/**
 * The role's tools, minus the ones that only make sense in one place: only a
 * background job may report progress, and a distinct subagent may not summon
 * another one, ask the user anything, or start a shell that outlives it. A
 * clone does not come through here; it takes the parent's list whole.
 */
function toolsFor(role: AgentRole, options: { subagent: boolean; isJob: boolean }): Tool[] {
  const definition = AGENTS[role]
  const tools: Tool[] = []
  for (const name of definition.tools) {
    if (SESSION_ONLY.has(name) && options.subagent) continue
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

/** A session's running totals and its context, in the shape the store writes. */
export function stateOf(session: Session): SessionState {
  return {
    spend: { total: session.spent, subagents: session.spentBySubagents, harness: session.spentByHarness, harnessCostUsd: session.harnessCost },
    context: session.context,
  }
}

/**
 * The approval model for one session, built from the stored rules. The
 * conversation id is derived from the session's and never equal to it: the
 * judge shares the session's lifetime and nothing else, least of all its
 * message history.
 */
export async function buildJudge(sessionId: string): Promise<Judge> {
  const stored = await readStored()
  const rules = mergeRules(stored.approval?.rules)
  // The rules allow scratch files in the temp folder, and the judge cannot
  // see which folder that is.
  rules.environment.push(`The system temp folder is ${tmpdir()}.`)
  return new Judge({ endpoints: approvalEndpoints, rules, conversationId: `${sessionId}-approval` })
}

/**
 * What one automatic decision costs and where it is written down. The tokens go
 * on the session's counter as the harness's own; the line goes to the session's
 * approval log, so a decision the user never saw is still one they can read. A
 * log that cannot be written is a warning, never the end of the turn.
 */
function recordApproval(session: Session | undefined, sessionId: string, record: ApprovalRecord): void {
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
 * The hooks a session runs, read once as it is built: the global file, then
 * the project's once the host has approved it. What went wrong comes back as
 * problems for the session to note.
 */
async function loadHooks(root: string, trust: (file: ProjectFile) => Promise<boolean>): Promise<{ hooks: Hooks; problems: string[] }> {
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
    } else if (await trust(project)) {
      specs.push(...project.hooks)
      problems.push(...project.problems)
    } else {
      problems.push(`The hooks in ${project.path} are off because they were not approved. Change the file or restart the app to be asked again.`)
    }
  }
  return { hooks: new Hooks(specs, root), problems }
}

/**
 * A subagent's own event stream. It goes wherever the session's events go,
 * under the job's id, which is also the child session's id and what lets a
 * reader tell a subagent's events apart from the conversation's.
 */
function subagentBus(forward: (event: AppEvent) => void, parent: () => Session | undefined): (slot: SubagentSlot) => EventBus {
  return slot => {
    const bus = new EventBus()
    forwardAll(bus, forward)
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

/** What differs between the window and a headless run, handed in by whichever one is building. */
export interface SessionHost {
  /** The provider, model and effort this session runs on. */
  config: ProviderConfig
  /** Every event the session and its subagents emit. */
  forward: (event: AppEvent) => void
  /** Whether a project's hooks or MCP servers may run. Asked only for a file not already approved as it reads now. */
  trust: (kind: ProjectFileKind, file: ProjectFile) => Promise<boolean>
  /** Where a question the gate cannot settle by itself goes. */
  broker: PermissionBroker
  /** What the user has already allowed for this session, kept across rebuilds. */
  permissions: GateState
  /** The approval model, fetched for each question. */
  judge: () => Promise<Judge>
  jobs: JobRegistry
  checkpoints: CheckpointStore
  terminals: Terminals
  /** How `ask_user` reaches a person. Without it the tool refuses, which is right when nobody is there. */
  ask?: AskUser
  /** The session this id names right now, for approval spend landing after a rebuild. The one built here when absent. */
  live?: () => Session | undefined
  /** False once the settings this build started from are gone, so the build closes what it opened and stops. */
  current: () => boolean
}

export interface Assembled {
  session: Session
  /** The session's MCP connections, which its owner closes when the session goes. */
  hub: McpHub
  /** The secret names the prompt was built with. */
  secrets: string[]
  /** What went wrong loading hooks, for the host to note on the session. */
  problems: string[]
}

export async function assembleSession(sessionId: string, host: SessionHost): Promise<Assembled> {
  const root = await sessionRoot(sessionId)
  if (root === null) throw new Error('that session is gone; start a new one from the sidebar')

  const config = host.config
  const facts = resolveFacts(config.provider, config.model)
  const provider = createProvider({
    kind: config.provider.kind,
    baseURL: config.provider.baseURL,
    apiKey: config.apiKey,
    ...(facts.wire === undefined ? {} : { wire: facts.wire }),
    ...(config.provider.sessionHeader === undefined ? {} : { sessionHeader: config.provider.sessionHeader }),
  })
  const bus = new EventBus()
  forwardAll(bus, host.forward)

  const role = (await sessionRole(sessionId)) ?? 'builder'

  // Both of these are decided before the first request and never again inside
  // a session, and for the same reason: the skills list sits in the system
  // prompt and the MCP tools sit in the tool definitions, which is to say both
  // are part of the cached prefix. Discovering either mid-session would move
  // bytes the provider has already cached and cost the whole prefix.
  const skills = await loadSkills(root)
  // Before anything is spawned, because the first time a project's hooks or
  // servers are met, each of these waits on the user.
  const { hooks, problems: hookProblems } = await loadHooks(root, file => host.trust('hooks', file))
  const servers = await loadServers(root, { trust: file => host.trust('mcp', file) })
  const hub = await McpHub.connect(root, servers.servers, servers.problems)
  if (!host.current()) {
    await hub.close()
    throw new Error('the settings changed while this session was opening; send that again')
  }
  // Everything after this point can throw, and a build that fails must not
  // leave the servers it started running with nobody holding the hub.
  try {
    // After the check, so a build that is about to be thrown away does not run
    // the user's commands for nothing.
    const started = await hooks.run('SessionStart', sessionId, {})
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
    const tools = [...toolsFor(role, { subagent: false, isJob: false }), ...hub.tools()]
    // A subagent is held to the parent's boundary and the same broker: an "allow
    // for this session" covers the work the user asked for, whoever does it. A
    // clone is built from the parent's live transcript, which the gate also reads
    // for the goals it judges against; the holder ties the two together.
    const parent: { session?: Session } = {}
    const live = host.live ?? ((): Session | undefined => parent.session)

    const access = promptingGate({
      root,
      sessionId,
      broker: host.broker,
      state: host.permissions,
      redact: text => secrets.redact(text),
      judge: host.judge,
      // The user's own messages, read off the live transcript at the moment the
      // question is asked. Never the assistant's and never a tool result: tool
      // output is the part an attacker can write into.
      goals: () => goalsFrom(parent.session?.transcript ?? []),
      onDecision: record => {
        recordApproval(live(), sessionId, record)
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
        // invalidate the bytes this exists to reuse. `spawn`, `ask_user` and
        // `terminal` stay in the list and refuse at the call instead, since the
        // clone's context has no spawn host, no one to ask and no terminals.
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
        tools: [...toolsFor(request.role, { subagent: true, isJob }), ...hub.tools()],
        effort: config.effort,
      }
    }

    // The session and every subagent it starts write through one store, so
    // what a subagent writes goes back with whichever of the session's turns
    // was the latest when it wrote.
    const checkpoints = host.checkpoints
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
        checkpoints,
        ...(host.ask === undefined ? {} : { ask: host.ask }),
        terminals: host.terminals,
        saveHistory: async () => {
          await saveTranscript(sessionId, session.transcript, session.notes)
          await setSessionState(sessionId, stateOf(session))
        },
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
          jobs: host.jobs,
          secrets,
          hooks,
          guard: checkpoints,
          setup,
          // A subagent's stream goes where the session's does, under the job's
          // id. That is the whole of what makes one watchable: the window already
          // knows how to draw these events, and the id says which panel they
          // belong in.
          bus: subagentBus(host.forward, () => parent.session),
          // The subagent's own conversation, stored beside the parent's and named
          // by the id the tool result quotes. Reading back what another agent
          // actually did is the difference between a debuggable harness and one
          // that hands you a paragraph and asks you to trust it.
          save: async (slot, record) => {
            const job = host.jobs.get(slot.id)
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
            const current = parent.session
            if (current === undefined) return
            const head = `Background ${outcome.request.role} job ${slot.id} ${outcome.state}. It was asked: ${outcome.request.task}`
            current.deliver(`${head}

  What it answered:
  ${outcome.answer}`)
            // A job usually outlives the turn that started it, so this is often
            // the only moment the answer exists anywhere the model can reach.
            // Between turns nothing else writes the transcript: the next message
            // might never come, and saving settings retires the session. So it is
            // written here.
            if (!current.running) {
              void saveTranscript(sessionId, current.transcript, current.notes).catch((err: unknown) => {
                current.fault(`A background job's answer could not be stored: ${err instanceof Error ? err.message : String(err)}. It is in this conversation until the app closes.`)
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
    const problems = [
      ...hookProblems,
      ...started.problems,
      ...(started.block === null ? [] : [`A SessionStart hook exited 2, which stops nothing when a session opens, and the hooks after it did not run. It said: ${started.block}`]),
    ]
    return { session, hub, secrets: secrets.names(), problems }
  } catch (err) {
    await hub.close()
    throw err
  }
}

/**
 * What a completed turn leaves behind: the transcript, the session record with
 * its title and totals, and one line in the usage log. `title` is the user's
 * own words, which the record is named after on its first turn.
 *
 * The transcript is written after the turn, not during it: a half-streamed
 * answer is not a message, and a crash mid-turn should leave the session
 * exactly as it was before the message was sent.
 */
export async function recordTurn(
  identity: { workspaceId: string; role: AgentRole },
  session: Session,
  title: string,
): Promise<SessionView | null> {
  const sessionId = session.options.sessionId
  await saveTranscript(sessionId, session.transcript, session.notes)
  const rate = session.lastRate
  const updated = await noteTurn(sessionId, title, { ...stateOf(session), ...(rate === undefined ? {} : { rate }) })

  // One line per completed turn: what `nh usage` and the spend view are both
  // built out of. A log that cannot be written is worth a warning and no more
  // than that.
  const turn = session.lastTurn
  await appendUsage({
    at: Date.now(),
    sessionId,
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
  return updated
}

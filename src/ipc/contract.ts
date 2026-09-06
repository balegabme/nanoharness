// doc: docs/harness/overview.md
import type { AgentRole } from '../core/agents.js'
import type { ActiveSelection, Effort, ProviderKind, ProviderRecord } from '../core/config.js'
import type { JobView } from '../core/jobs.js'
import type { AccessIntent } from '../core/scope.js'
import type { AppEvent, TurnUsage } from '../core/types.js'

export const IPC_CHANNELS = {
  ping: 'ipc:ping',
  sessionSend: 'session:send',
  sessionStop: 'session:stop',
  sessionEvent: 'session:event',
  configGet: 'config:get',
  configSaveProvider: 'config:save-provider',
  configDeleteProvider: 'config:delete-provider',
  configSetActive: 'config:set-active',
  configProbe: 'config:probe',
  workspaceList: 'workspace:list',
  workspaceAdd: 'workspace:add',
  workspaceRemove: 'workspace:remove',
  sessionCreate: 'session:create',
  sessionOpen: 'session:open',
  sessionDelete: 'session:delete',
  permissionRespond: 'permission:respond',
  sessionSetRole: 'session:set-role',
  jobsList: 'jobs:list',
  agentsList: 'agents:list',
  openExternal: 'shell:open-external',
} as const

/**
 * One agent as the window lists it. The registry lives in the main process —
 * the renderer is served over the app scheme and cannot import across into
 * core — so the three roles arrive over IPC like everything else.
 */
export interface AgentSummary {
  role: AgentRole
  name: string
  purpose: string
}

export interface SessionSendRequest {
  sessionId: string
  text: string
}

/** A folder in the sidebar. Every session inside it is scoped to `root`. */
export interface WorkspaceView {
  id: string
  name: string
  root: string
}

export interface SessionView {
  id: string
  workspaceId: string
  title: string
  /** Which of the three agents this session is talking to right now (plan §5). */
  role: AgentRole
  createdAt: number
  updatedAt: number
  /** What this session has spent so far, across every launch it has run in. */
  usage?: TurnUsage
}

/** Everything the sidebar draws itself from. */
export interface WorkspaceStatus {
  workspaces: WorkspaceView[]
  /** Newest first, across all workspaces; the sidebar groups them. */
  sessions: SessionView[]
}

/** One stored message, in the shape the chat view replays. */
export interface TranscriptMessage {
  role: 'user' | 'assistant' | 'tool'
  text: string
  /** Tool calls the assistant made in this message. */
  tools?: { id: string; name: string; args: string }[]
  /** Which call a tool message answers. */
  callId?: string
  /** The call this message answers came back an error. */
  failed?: boolean
  /** What the model thought before this message, where the provider signs and returns it. */
  thinking?: string
}

export interface SessionOpenResponse {
  session: SessionView
  workspace: WorkspaceView
  messages: TranscriptMessage[]
}

/** A tool wants paths outside the session root, and is waiting on an answer. */
export interface PermissionAsk {
  id: string
  sessionId: string
  intent: AccessIntent
  /**
   * Every resolved path this one tool call reaches for — symlinks and `..`
   * already followed. A shell command routinely names several, and they are
   * asked about together so one command costs one answer.
   */
  paths: string[]
  root: string
}

export type PermissionDecision = 'once' | 'session' | 'deny'

export interface SessionSendResponse {
  sessionId: string
  usage: TurnUsage
  /** The session as it stands after the turn: the title may have been set. */
  session: SessionView
}

export interface PingResponse {
  ok: true
  version: string
}

/** One configured endpoint as the renderer sees it: the record, minus its key. */
export interface ProviderView extends ProviderRecord {
  hasKey: boolean
}

/** Everything the settings screen needs. Deliberately carries no API key. */
export interface ConfigStatus {
  /** True when a session can start right now. */
  configured: boolean
  providers: ProviderView[]
  /** Which provider, model and effort a turn will use. */
  active?: ActiveSelection
  /** Whether the OS can encrypt a stored key at all. */
  keyStorage: 'os' | 'unavailable'
  /** Why it is not configured yet. Absent once it is. */
  problem?: string
}

/** Create a provider (no `id`) or update one (with its `id`). */
export interface ProviderSaveRequest {
  id?: string
  name: string
  kind: ProviderKind
  baseURL: string
  /** The models this provider may run. Empty means "whatever is typed". */
  models: string[]
  /** Omit to keep the key already stored for this provider. */
  apiKey?: string
  /**
   * Make this provider active on the given model once it is saved. Saving and
   * switching in one call is what the settings screen needs, and it spares the
   * renderer from having to learn the id of a provider it just created.
   */
  activeModel?: string
}

/** Switch provider, model or effort without touching the provider list. */
export interface ActiveSetRequest {
  providerId: string
  model: string
  effort: Effort
}

/** Ask an endpoint what it offers. Doubles as the connection test. */
export interface ConfigProbeRequest {
  kind: ProviderKind
  baseURL: string
  /** Omit to probe with the key already stored for `providerId`. */
  apiKey?: string
  providerId?: string
}

export type ConfigProbeResult = { ok: true; models: string[] } | { ok: false; error: string }

/** The only surface the renderer gets. Exposed by the preload script. */
export interface NanoBridge {
  ping(): Promise<PingResponse>
  send(sessionId: string, text: string): Promise<SessionSendResponse>
  /** End the running turn. Safe to call when nothing is running. */
  stop(sessionId: string): Promise<void>
  workspaces(): Promise<WorkspaceStatus>
  /** Opens a directory picker. Resolves to null when the user cancels it. */
  addWorkspace(): Promise<WorkspaceStatus | null>
  removeWorkspace(id: string): Promise<WorkspaceStatus>
  createSession(workspaceId: string): Promise<SessionView>
  openSession(id: string): Promise<SessionOpenResponse>
  deleteSession(id: string): Promise<WorkspaceStatus>
  respondToPermission(id: string, decision: PermissionDecision): Promise<void>
  /** Switch the agent a session is talking to. The transcript is kept. */
  setSessionRole(sessionId: string, role: AgentRole): Promise<SessionView>
  /** Background subagents, newest first. In-memory: empty after a restart. */
  jobs(): Promise<JobView[]>
  /** The three agents, for the role chip. */
  agents(): Promise<AgentSummary[]>
  config(): Promise<ConfigStatus>
  saveProvider(request: ProviderSaveRequest): Promise<ConfigStatus>
  deleteProvider(id: string): Promise<ConfigStatus>
  setActive(request: ActiveSetRequest): Promise<ConfigStatus>
  probeProvider(request: ConfigProbeRequest): Promise<ConfigProbeResult>
  /** Hand an https link to the OS browser. The window itself never navigates. */
  openExternal(url: string): Promise<void>
  /** Subscribe to live session events. Returns an unsubscribe function. */
  onEvent(listener: (event: AppEvent) => void): () => void
}

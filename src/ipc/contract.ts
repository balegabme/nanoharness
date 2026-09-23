// doc: docs/harness/overview.md
import type { AgentRole } from '../core/agents.js'
import type { ApprovalConfig, PermissionMode } from '../core/approval.js'
import type { KnownProvider } from '../providers/profiles.js'
import type { ActiveSelection, Effort, ModelFacts, ModelOffer, ProviderKind, ProviderRecord, SwitchName } from '../core/config.js'
import type { JobState, JobView } from '../core/jobs.js'
import type { AccessIntent } from '../core/scope.js'
import type { SpawnMode } from '../core/spawn.js'
import type { AppEvent, CompactionMark, ContextLedger, ImageType, McpServerStatus, SessionNote, ToolStats, TurnRate, TurnUsage } from '../core/types.js'
import type { UsageReport } from '../core/usage-report.js'

export const IPC_CHANNELS = {
  ping: 'ipc:ping',
  sessionSend: 'session:send',
  sessionStop: 'session:stop',
  sessionCompact: 'session:compact',
  sessionEvent: 'session:event',
  configGet: 'config:get',
  configSaveProvider: 'config:save-provider',
  configDeleteProvider: 'config:delete-provider',
  configSetActive: 'config:set-active',
  configProbe: 'config:probe',
  configSetAutoCompact: 'config:set-auto-compact',
  configSetContextLimit: 'config:set-context-limit',
  configSetSwitch: 'config:set-switch',
  workspaceList: 'workspace:list',
  workspaceAdd: 'workspace:add',
  workspaceRemove: 'workspace:remove',
  sessionCreate: 'session:create',
  sessionOpen: 'session:open',
  sessionDelete: 'session:delete',
  sessionRename: 'session:rename',
  sessionTranscriptPath: 'session:transcript-path',
  permissionRespond: 'permission:respond',
  projectTrustRespond: 'project:trust-respond',
  permissionMode: 'permission:mode',
  permissionSetMode: 'permission:set-mode',
  configSaveApproval: 'config:save-approval',
  sessionSetRole: 'session:set-role',
  jobsList: 'jobs:list',
  subagentOpen: 'subagent:open',
  agentsList: 'agents:list',
  mcpStatus: 'mcp:status',
  secretsList: 'secrets:list',
  secretsForget: 'secrets:forget',
  secretsCapture: 'secrets:capture',
  usageReport: 'usage:report',
  usageClear: 'usage:clear',
  openExternal: 'shell:open-external',
} as const

/**
 * One agent as the window lists it. The registry lives in the main process,
 * since the renderer is served over the app scheme and cannot import across
 * into core, so the three roles arrive over IPC like everything else.
 */
export interface AgentSummary {
  role: AgentRole
  name: string
  purpose: string
}

/** A picture as the window sends it, already shrunk if the user asked for that. */
export interface ImageUpload {
  mediaType: ImageType
  width: number
  height: number
  /** The bytes, in base64 with no `data:` prefix. */
  data: string
}

export interface SessionSendRequest {
  sessionId: string
  text: string
  images?: ImageUpload[]
}

/** The MCP servers one session has, and whether anything has been dialled yet. */
export interface McpStatusView {
  /**
   * True once the session's hub exists. Until the first message a session has
   * no hub, because nothing is spawned for a session the user only clicked on,
   * so the list before that is what the config says, not what is running.
   */
  live: boolean
  servers: McpServerStatus[]
}

/** One captured key, named but never valued: the value does not cross IPC. */
export interface SecretView {
  name: string
  /** The vendor whose shape it matched, or `secret` when it was labelled. */
  hint: string
  at: number
}

/** What `capture` did to a message on its way into the conversation. */
export interface CaptureResult {
  /** The text with every key replaced by its placeholder. Safe to draw and store. */
  text: string
  /** The names now standing in for what was taken out. */
  captured: string[]
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
  /** The subagents' share of `usage`. */
  subagentUsage?: TurnUsage
  /** The harness's own share of `usage`: approval checks and compaction summaries. */
  harnessUsage?: TurnUsage
  /** What that share cost, priced at the models that ran it. */
  harnessCostUsd?: number
  /** The context as it stood when the session last stopped. Absent until it has measured one. */
  context?: ContextLedger
  /** The last turn's rate, so a re-opened session shows one. Absent until a turn has finished. */
  rate?: TurnRate
}

/** Auto mode's answer for one session, and why it is not available when it is not. */
export interface PermissionModeView {
  mode: PermissionMode
  /** Absent when auto mode can be turned on. Present says why it cannot. */
  problem?: string
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
  /** What the model thought before this message, where the provider reports it. */
  thinking?: string
  /** Folded into a summary, or a tool result sent shortened. The message itself is whole. */
  compacted?: CompactionMark
  /** A summary a compaction wrote, drawn where the compaction happened. */
  summary?: true
  /** A Stop hook's reply, drawn as the note it was shown as live. */
  hook?: true
  /** The pictures sent with a user message. */
  images?: ImageView[]
}

/** A picture as the chat view draws it. */
export interface ImageView {
  /** The bytes as a `data:` URL. */
  src: string
  width: number
  height: number
}

export interface SessionOpenResponse {
  session: SessionView
  workspace: WorkspaceView
  messages: TranscriptMessage[]
  /**
   * Errors, stops and harness notes, in the places they happened. Re-opening a
   * session shows what the window showed, not a tidied version of it.
   */
  notes: SessionNote[]
}

/**
 * One subagent as the window replays it: the job's facts, and the conversation
 * it actually had. The window draws it with the same blocks it draws the main
 * agent with, so this is the same shape a session opens with plus the job.
 */
export interface SubagentOpenResponse {
  id: string
  sessionId: string
  role: AgentRole
  mode: SpawnMode
  task: string
  background: boolean
  state: JobState
  note: string
  usage: TurnUsage
  /**
   * What its tool calls came to: how many, how many failed. Absent on a
   * subagent stored before the count existed, which is a line the window
   * leaves out instead of making up a zero.
   */
  tools?: ToolStats
  startedAt: number
  endedAt: number
  messages: TranscriptMessage[]
  notes: SessionNote[]
  /** Its context when it ended, for the meter above its conversation. */
  context?: ContextLedger
}

/** A tool wants paths outside the session root, or a command run, and waits. */
export interface PermissionAsk {
  id: string
  sessionId: string
  intent: AccessIntent
  /**
   * Every resolved path this one tool call reaches for, symlinks and `..`
   * already followed. A file tool names one; the array is what lets a future
   * multi-path tool ask about them in a single answer. Empty for a command.
   */
  paths: string[]
  /**
   * The shell command this ask is about, shown to the user verbatim. Present
   * only when `intent` is `run`; a command has no resolved path to show.
   */
  command?: string
  root: string
  /**
   * Why auto mode did not answer this one itself. Present only when the mode
   * was on and the approval model failed. The dialog shows it, so a person who
   * turned automatic approval on is told why they are being asked.
   */
  problem?: string
}

export type PermissionDecision = 'once' | 'session' | 'deny'

export interface SessionCompactResponse {
  /** False when there was nothing to compact, no summary came back or the user stopped it. The session's notes say which. */
  compacted: boolean
}

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
  /**
   * Endpoints the harness already knows the address and habits of, for the
   * picker that fills the form in. The window cannot import the provider layer,
   * so the list travels and is never kept in two places.
   */
  knownProviders: readonly KnownProvider[]
  /** Why it is not configured yet. Absent once it is. */
  problem?: string
  /** The approval model ladder auto mode runs on. Carries no key. */
  approval?: ApprovalConfig
  /** Why auto mode cannot be turned on. Absent when it can. */
  approvalProblem?: string
  /** Whether sessions compact on their own as the context fills. */
  autoCompact: boolean
  /** The most any context may grow to, in tokens. Null for the model's window alone. */
  contextLimit: number | null
  /** Whether the user's hooks run. */
  hooks: boolean
  /** Whether pasted images are shrunk to the size the model reads. */
  downscaleImages: boolean
}

/** Create a provider (no `id`) or update one (with its `id`). */
export interface ProviderSaveRequest {
  id?: string
  name: string
  kind: ProviderKind
  baseURL: string
  /** The models this provider may run. Empty means "whatever is typed". */
  models: string[]
  /** What the last fetch learned, by model id. Omit to keep what is stored. */
  facts?: Record<string, ModelFacts>
  /**
   * What the user typed for a model the fetch found nothing useful about, by
   * model id. Omit to keep what is stored; a model mapped to `null` is cleared,
   * which is the only way back to "nobody has said".
   */
  overrides?: Record<string, ModelFacts | null>
  /**
   * The header this endpoint wants the session id under. No screen offers it:
   * known endpoints are answered by `src/providers/profiles.ts` and anything
   * else is edited into the settings file by hand. Omit to keep what is stored,
   * which is what every save does; an empty string clears it.
   */
  sessionHeader?: string
  /** Omit to keep the key already stored for this provider. */
  apiKey?: string
  /**
   * Make this provider active on the given model once it is saved. Saving and
   * switching in one call spares the renderer the id of a provider it has just
   * created.
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

export type ConfigProbeResult = { ok: true; models: ModelOffer[] } | { ok: false; error: string }

/** The only surface the renderer gets. Exposed by the preload script. */
export interface NanoBridge {
  ping(): Promise<PingResponse>
  send(sessionId: string, text: string, images: ImageUpload[]): Promise<SessionSendResponse>
  /** End the running turn. Safe to call when nothing is running. */
  stop(sessionId: string): Promise<void>
  /**
   * Summarise the older part of the conversation now. Refused while a turn is
   * running; `stop` ends a compaction that is.
   */
  compact(sessionId: string): Promise<SessionCompactResponse>
  workspaces(): Promise<WorkspaceStatus>
  /** Opens a directory picker. Resolves to null when the user cancels it. */
  addWorkspace(): Promise<WorkspaceStatus | null>
  removeWorkspace(id: string): Promise<WorkspaceStatus>
  createSession(workspaceId: string): Promise<SessionView>
  openSession(id: string): Promise<SessionOpenResponse>
  deleteSession(id: string): Promise<WorkspaceStatus>
  /** Give a session a name of its own. The transcript is untouched. */
  renameSession(id: string, title: string): Promise<WorkspaceStatus>
  /** Where this session's transcript file is, for the context menu's copy item. */
  transcriptPath(id: string): Promise<string>
  respondToPermission(id: string, decision: PermissionDecision): Promise<void>
  /** How this session answers permission questions right now. */
  permissionMode(sessionId: string): Promise<PermissionModeView>
  /**
   * Switch it. Asking for `auto` with no approval model configured is refused
   * and comes back with the reason in `problem`, still on the old mode.
   */
  setPermissionMode(sessionId: string, mode: PermissionMode): Promise<PermissionModeView>
  /** Switch the agent a session is talking to. The transcript is kept. */
  setSessionRole(sessionId: string, role: AgentRole): Promise<SessionView>
  /** Background subagents, newest first. In-memory: empty after a restart. */
  jobs(): Promise<JobView[]>
  /**
   * One subagent's stored conversation, or null when it was never written,
   * which is the case for one still running in this launch, whose stream the
   * window already has.
   */
  subagent(sessionId: string, id: string): Promise<SubagentOpenResponse | null>
  /** The three agents, for the role chip. */
  agents(): Promise<AgentSummary[]>
  /** Which MCP servers this session has, live if it has been built. */
  mcpStatus(sessionId: string): Promise<McpStatusView>
  /** The captured keys, by name. Never their values. */
  secrets(): Promise<SecretView[]>
  /** Drop one key. A placeholder naming it stops resolving from here on. */
  forgetSecret(name: string): Promise<SecretView[]>
  /**
   * Take every key out of a message before it is drawn or sent. The window
   * calls this first and shows what comes back, so a pasted key is never on
   * screen, not even for the frame between typing and sending.
   */
  captureSecrets(text: string): Promise<CaptureResult>
  config(): Promise<ConfigStatus>
  saveProvider(request: ProviderSaveRequest): Promise<ConfigStatus>
  deleteProvider(id: string): Promise<ConfigStatus>
  setActive(request: ActiveSetRequest): Promise<ConfigStatus>
  /** Set the approval model ladder. An empty list turns auto mode off for good. */
  saveApproval(approval: ApprovalConfig): Promise<ConfigStatus>
  /** Turn automatic compaction on or off, for every session, live ones included. */
  setAutoCompact(on: boolean): Promise<ConfigStatus>
  /** Set the most any context may grow to, or clear it with null. Live sessions take it at once. */
  setContextLimit(limit: number | null): Promise<ConfigStatus>
  /** Turn one of the on-or-off settings on or off. Live sessions take it when they are next built. */
  setSwitch(name: SwitchName, on: boolean): Promise<ConfigStatus>
  /** Answer a `project.trust` event: use that project's file, or leave it off. */
  answerProjectTrust(id: string, allow: boolean): Promise<void>
  probeProvider(request: ConfigProbeRequest): Promise<ConfigProbeResult>
  /**
   * What has been spent, grouped for the spend view. `days` counts back from
   * today in whole local days; null is everything the log holds.
   */
  usageReport(days: number | null): Promise<UsageReport>
  /**
   * Delete the usage log and report on what is left, which is nothing. The
   * answer comes back as a report and not as void, so the view redraws from
   * the same channel it drew from before.
   */
  usageClear(days: number | null): Promise<UsageReport>
  /** Hand an https link to the OS browser. The window itself never navigates. */
  openExternal(url: string): Promise<void>
  /** Subscribe to live session events. Returns an unsubscribe function. */
  onEvent(listener: (event: AppEvent) => void): () => void
}

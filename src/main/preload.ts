// doc: docs/harness/ui.md
import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../ipc/contract.js'
import type { ApprovalConfig, PermissionMode } from '../core/approval.js'
import type {
  ActiveSetRequest,
  AgentSummary,
  CaptureResult,
  ConfigProbeRequest,
  ConfigProbeResult,
  ConfigStatus,
  McpStatusView,
  NanoBridge,
  PermissionDecision,
  PermissionModeView,
  PingResponse,
  ProviderSaveRequest,
  SecretView,
  SessionCompactResponse,
  SessionOpenResponse,
  SessionSendResponse,
  SessionView,
  SubagentOpenResponse,
  WorkspaceStatus,
} from '../ipc/contract.js'
import type { AgentRole } from '../core/agents.js'
import type { JobView } from '../core/jobs.js'
import type { AppEvent } from '../core/types.js'
import type { UsageReport } from '../core/usage-report.js'

// The renderer never sees ipcRenderer itself, only the calls on this bridge.
const bridge: NanoBridge = {
  ping: () => ipcRenderer.invoke(IPC_CHANNELS.ping) as Promise<PingResponse>,
  send: (sessionId: string, text: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.sessionSend, { sessionId, text }) as Promise<SessionSendResponse>,
  stop: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.sessionStop, sessionId) as Promise<void>,
  compact: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.sessionCompact, sessionId) as Promise<SessionCompactResponse>,
  workspaces: () => ipcRenderer.invoke(IPC_CHANNELS.workspaceList) as Promise<WorkspaceStatus>,
  addWorkspace: () => ipcRenderer.invoke(IPC_CHANNELS.workspaceAdd) as Promise<WorkspaceStatus | null>,
  removeWorkspace: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.workspaceRemove, id) as Promise<WorkspaceStatus>,
  createSession: (workspaceId: string) => ipcRenderer.invoke(IPC_CHANNELS.sessionCreate, workspaceId) as Promise<SessionView>,
  openSession: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.sessionOpen, id) as Promise<SessionOpenResponse>,
  deleteSession: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.sessionDelete, id) as Promise<WorkspaceStatus>,
  renameSession: (id: string, title: string) => ipcRenderer.invoke(IPC_CHANNELS.sessionRename, { id, title }) as Promise<WorkspaceStatus>,
  transcriptPath: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.sessionTranscriptPath, id) as Promise<string>,
  respondToPermission: (id: string, decision: PermissionDecision) =>
    ipcRenderer.invoke(IPC_CHANNELS.permissionRespond, { id, decision }) as Promise<void>,
  permissionMode: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.permissionMode, sessionId) as Promise<PermissionModeView>,
  setPermissionMode: (sessionId: string, mode: PermissionMode) =>
    ipcRenderer.invoke(IPC_CHANNELS.permissionSetMode, { sessionId, mode }) as Promise<PermissionModeView>,
  setSessionRole: (sessionId: string, role: AgentRole) =>
    ipcRenderer.invoke(IPC_CHANNELS.sessionSetRole, { sessionId, role }) as Promise<SessionView>,
  jobs: () => ipcRenderer.invoke(IPC_CHANNELS.jobsList) as Promise<JobView[]>,
  subagent: (sessionId: string, id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.subagentOpen, { sessionId, id }) as Promise<SubagentOpenResponse | null>,
  agents: () => ipcRenderer.invoke(IPC_CHANNELS.agentsList) as Promise<AgentSummary[]>,
  mcpStatus: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.mcpStatus, sessionId) as Promise<McpStatusView>,
  secrets: () => ipcRenderer.invoke(IPC_CHANNELS.secretsList) as Promise<SecretView[]>,
  forgetSecret: (name: string) => ipcRenderer.invoke(IPC_CHANNELS.secretsForget, name) as Promise<SecretView[]>,
  captureSecrets: (text: string) => ipcRenderer.invoke(IPC_CHANNELS.secretsCapture, text) as Promise<CaptureResult>,
  config: () => ipcRenderer.invoke(IPC_CHANNELS.configGet) as Promise<ConfigStatus>,
  saveProvider: (request: ProviderSaveRequest) => ipcRenderer.invoke(IPC_CHANNELS.configSaveProvider, request) as Promise<ConfigStatus>,
  deleteProvider: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.configDeleteProvider, id) as Promise<ConfigStatus>,
  setActive: (request: ActiveSetRequest) => ipcRenderer.invoke(IPC_CHANNELS.configSetActive, request) as Promise<ConfigStatus>,
  saveApproval: (approval: ApprovalConfig) => ipcRenderer.invoke(IPC_CHANNELS.configSaveApproval, approval) as Promise<ConfigStatus>,
  setAutoCompact: (on: boolean) => ipcRenderer.invoke(IPC_CHANNELS.configSetAutoCompact, on) as Promise<ConfigStatus>,
  setContextLimit: (limit: number | null) => ipcRenderer.invoke(IPC_CHANNELS.configSetContextLimit, limit) as Promise<ConfigStatus>,
  probeProvider: (request: ConfigProbeRequest) => ipcRenderer.invoke(IPC_CHANNELS.configProbe, request) as Promise<ConfigProbeResult>,
  usageReport: (days: number | null) => ipcRenderer.invoke(IPC_CHANNELS.usageReport, days) as Promise<UsageReport>,
  usageClear: (days: number | null) => ipcRenderer.invoke(IPC_CHANNELS.usageClear, days) as Promise<UsageReport>,
  openExternal: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.openExternal, url) as Promise<void>,
  onEvent(listener) {
    const handler = (_event: Electron.IpcRendererEvent, payload: AppEvent): void => listener(payload)
    ipcRenderer.on(IPC_CHANNELS.sessionEvent, handler)
    return () => {
      ipcRenderer.off(IPC_CHANNELS.sessionEvent, handler)
    }
  },
}

contextBridge.exposeInMainWorld('nanoharness', bridge)

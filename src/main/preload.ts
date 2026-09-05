// doc: docs/harness/ui.md
import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../ipc/contract.js'
import type {
  ActiveSetRequest,
  ConfigProbeRequest,
  ConfigProbeResult,
  ConfigStatus,
  NanoBridge,
  PermissionDecision,
  PingResponse,
  ProviderSaveRequest,
  SessionOpenResponse,
  SessionSendResponse,
  SessionView,
  WorkspaceStatus,
} from '../ipc/contract.js'
import type { AppEvent } from '../core/types.js'

// The renderer never sees ipcRenderer itself, only the calls on this bridge.
const bridge: NanoBridge = {
  ping: () => ipcRenderer.invoke(IPC_CHANNELS.ping) as Promise<PingResponse>,
  send: (sessionId: string, text: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.sessionSend, { sessionId, text }) as Promise<SessionSendResponse>,
  stop: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.sessionStop, sessionId) as Promise<void>,
  workspaces: () => ipcRenderer.invoke(IPC_CHANNELS.workspaceList) as Promise<WorkspaceStatus>,
  addWorkspace: () => ipcRenderer.invoke(IPC_CHANNELS.workspaceAdd) as Promise<WorkspaceStatus | null>,
  removeWorkspace: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.workspaceRemove, id) as Promise<WorkspaceStatus>,
  createSession: (workspaceId: string) => ipcRenderer.invoke(IPC_CHANNELS.sessionCreate, workspaceId) as Promise<SessionView>,
  openSession: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.sessionOpen, id) as Promise<SessionOpenResponse>,
  deleteSession: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.sessionDelete, id) as Promise<WorkspaceStatus>,
  respondToPermission: (id: string, decision: PermissionDecision) =>
    ipcRenderer.invoke(IPC_CHANNELS.permissionRespond, { id, decision }) as Promise<void>,
  config: () => ipcRenderer.invoke(IPC_CHANNELS.configGet) as Promise<ConfigStatus>,
  saveProvider: (request: ProviderSaveRequest) => ipcRenderer.invoke(IPC_CHANNELS.configSaveProvider, request) as Promise<ConfigStatus>,
  deleteProvider: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.configDeleteProvider, id) as Promise<ConfigStatus>,
  setActive: (request: ActiveSetRequest) => ipcRenderer.invoke(IPC_CHANNELS.configSetActive, request) as Promise<ConfigStatus>,
  probeProvider: (request: ConfigProbeRequest) => ipcRenderer.invoke(IPC_CHANNELS.configProbe, request) as Promise<ConfigProbeResult>,
  onEvent(listener) {
    const handler = (_event: Electron.IpcRendererEvent, payload: AppEvent): void => listener(payload)
    ipcRenderer.on(IPC_CHANNELS.sessionEvent, handler)
    return () => {
      ipcRenderer.off(IPC_CHANNELS.sessionEvent, handler)
    }
  },
}

contextBridge.exposeInMainWorld('nanoharness', bridge)

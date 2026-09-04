// doc: docs/harness/ui.md
import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../ipc/contract.js'
import type {
  ConfigProbeRequest,
  ConfigProbeResult,
  ConfigSetRequest,
  ConfigStatus,
  NanoBridge,
  PingResponse,
  SessionSendResponse,
} from '../ipc/contract.js'
import type { AppEvent } from '../core/types.js'

// The renderer never sees ipcRenderer itself, only these six calls.
const bridge: NanoBridge = {
  ping: () => ipcRenderer.invoke(IPC_CHANNELS.ping) as Promise<PingResponse>,
  send: (text: string) => ipcRenderer.invoke(IPC_CHANNELS.sessionSend, { text }) as Promise<SessionSendResponse>,
  config: () => ipcRenderer.invoke(IPC_CHANNELS.configGet) as Promise<ConfigStatus>,
  saveConfig: (settings: ConfigSetRequest) => ipcRenderer.invoke(IPC_CHANNELS.configSet, settings) as Promise<ConfigStatus>,
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

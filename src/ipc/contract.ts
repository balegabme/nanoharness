// doc: docs/harness/overview.md
import type { AppEvent, TurnUsage } from '../core/types.js'

export const IPC_CHANNELS = {
  ping: 'ipc:ping',
  sessionSend: 'session:send',
  sessionEvent: 'session:event',
  configGet: 'config:get',
  configSet: 'config:set',
  configProbe: 'config:probe',
} as const

export interface SessionSendRequest {
  text: string
}

export interface SessionSendResponse {
  sessionId: string
  usage: TurnUsage
}

export interface PingResponse {
  ok: true
  version: string
}

/** Everything the setup screen needs. Deliberately carries no API key. */
export interface ConfigStatus {
  /** True when a session can start right now. */
  configured: boolean
  baseURL: string
  model: string
  hasKey: boolean
  /** The models the user selected. A session may only run one of these. */
  models: string[]
  /** Whether the OS can encrypt a stored key at all. */
  keyStorage: 'os' | 'unavailable'
  /** Why it is not configured yet. Absent once it is. */
  problem?: string
}

export interface ConfigSetRequest {
  baseURL: string
  model: string
  /** Omit to keep the key already stored. */
  apiKey?: string
  /** Omit to keep the selection already stored. */
  models?: string[]
}

/** Ask the provider what it offers. Doubles as the connection test. */
export interface ConfigProbeRequest {
  baseURL: string
  /** Omit to probe with the key already stored. */
  apiKey?: string
}

export type ConfigProbeResult = { ok: true; models: string[] } | { ok: false; error: string }

/** The only surface the renderer gets. Exposed by the preload script. */
export interface NanoBridge {
  ping(): Promise<PingResponse>
  send(text: string): Promise<SessionSendResponse>
  config(): Promise<ConfigStatus>
  saveConfig(settings: ConfigSetRequest): Promise<ConfigStatus>
  probeProvider(request: ConfigProbeRequest): Promise<ConfigProbeResult>
  /** Subscribe to live session events. Returns an unsubscribe function. */
  onEvent(listener: (event: AppEvent) => void): () => void
}

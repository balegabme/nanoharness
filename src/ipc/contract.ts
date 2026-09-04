// doc: docs/harness/overview.md
import type { AppEvent, TurnUsage } from '../core/types.js'

export const IPC_CHANNELS = {
  ping: 'ipc:ping',
  sessionSend: 'session:send',
  sessionEvent: 'session:event',
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
/** The only surface the renderer gets. Exposed by the preload script. */
export interface NanoBridge {
  ping(): Promise<PingResponse>
  send(text: string): Promise<SessionSendResponse>
  /** Subscribe to live session events. Returns an unsubscribe function. */
  onEvent(listener: (event: AppEvent) => void): () => void
}

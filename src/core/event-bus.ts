// doc: docs/harness/overview.md
import type { AppEvent } from './types.js'

export class EventBus {
  private listeners = new Map<AppEvent['type'], Set<(event: AppEvent) => void>>()

  on<E extends AppEvent['type']>(type: E, fn: (event: Extract<AppEvent, { type: E }>) => void): () => void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(fn as (event: AppEvent) => void)
    this.listeners.set(type, set)
    return () => void set.delete(fn as (event: AppEvent) => void)
  }

  emit(event: AppEvent): void {
    const set = this.listeners.get(event.type)
    if (!set) return
    for (const fn of [...set]) fn(event)
  }
}
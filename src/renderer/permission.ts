// doc: docs/harness/ui.md
import { message, must } from './dom.js'
import { announce } from './notify.js'
import type { NanoBridge, PermissionDecision } from '../ipc/contract.js'
import type { AppEvent } from '../core/types.js'

/**
 * A tool asked for something outside its folder, or for a shell command, and
 * the turn is parked until this is answered. A path ask names the resolved
 * path, after symlinks and `..`, because the point is that the person can see
 * where the agent actually ended up pointing. A command ask shows the command
 * itself: it was not parsed, and the only honest thing to show is what will
 * run.
 */

const dialog = must<HTMLDialogElement>('permission-dialog')
const title = must<HTMLElement>('perm-title')
const detail = must<HTMLElement>('perm-detail')
const pathLine = must<HTMLElement>('perm-path')
const rootLine = must<HTMLElement>('perm-root')
const onceButton = must<HTMLButtonElement>('perm-once')
const sessionButton = must<HTMLButtonElement>('perm-session')
const denyButton = must<HTMLButtonElement>('perm-deny')

type Ask = Extract<AppEvent, { type: 'permission.request' }>

let bridge: NanoBridge | null = null
let report: (text: string) => void = () => {}
// Two tools can ask at once, and only one modal can be on screen.
const queue: Ask[] = []
let current: Ask | null = null

const VERB: Record<Ask['intent'], string> = {
  read: 'wants to read',
  write: 'wants to write',
  run: 'wants to run',
}

function show(ask: Ask): void {
  current = ask
  if (ask.command !== undefined) {
    title.textContent = 'Run this shell command?'
    detail.textContent =
      'The shell is not screened, so a command can reach anything you can. Allowing all shell commands answers this for the rest of the session.'
    pathLine.textContent = ask.command
    rootLine.textContent = `Its files are scoped to ${ask.root}; the shell is not`
    onceButton.textContent = 'Allow once'
    sessionButton.textContent = 'Allow all shell commands'
  } else {
    title.textContent = 'Allow access outside the folder?'
    const count = ask.paths.length
    const what = count > 1 ? `${count} paths` : 'a path'
    detail.textContent = `This session ${VERB[ask.intent]} ${what} outside its folder.`
    pathLine.textContent = ask.paths.join('\n')
    rootLine.textContent = `It is scoped to ${ask.root}`
    onceButton.textContent = 'Allow once'
    sessionButton.textContent = 'Allow for this session'
  }
  if (!dialog.open) dialog.showModal()
  denyButton.focus()
  // The turn is parked until this is answered, and a modal on a window nobody
  // is looking at parks it for as long as that takes. Every ask rings, queued
  // ones included: each is a separate question.
  announce('asking')
}

function next(): void {
  current = null
  const pending = queue.shift()
  if (pending === undefined) {
    if (dialog.open) dialog.close()
    return
  }
  show(pending)
}

function answer(decision: PermissionDecision): void {
  const ask = current
  if (ask === null || bridge === null) return
  bridge.respondToPermission(ask.id, decision).catch((err: unknown) => report(message(err)))
  next()
}

export function enqueue(ask: Ask): void {
  if (current === null) show(ask)
  else queue.push(ask)
}

export interface PermissionHandlers {
  bridge: NanoBridge
  report(text: string): void
}

export function initPermission(handlers: PermissionHandlers): void {
  bridge = handlers.bridge
  report = handlers.report

  onceButton.addEventListener('click', () => answer('once'))
  sessionButton.addEventListener('click', () => answer('session'))
  denyButton.addEventListener('click', () => answer('deny'))
  // Esc on a permission prompt is not an answer; the safe reading is "no".
  dialog.addEventListener('cancel', event => {
    event.preventDefault()
    answer('deny')
  })
}

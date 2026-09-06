// doc: docs/harness/ui.md
import { must } from './dom.js'

/**
 * The turn is over and the window is behind something else. A long turn is the
 * normal case, not the exception, so the app says so out loud: a short blip and
 * an OS notification when the window is not the one being looked at.
 *
 * Both are one setting, kept in `localStorage` because it is a preference about
 * this machine's speakers, not part of the harness configuration.
 */

export type Outcome = 'finished' | 'stopped' | 'error'

const KEY = 'nanoharness.alerts'
const toggle = must<HTMLButtonElement>('alerts')

let enabled = localStorage.getItem(KEY) !== 'off'

const TONE: Record<Outcome, readonly number[]> = {
  // A rising pair reads as "done", a falling pair as "stopped early", and a
  // single flat low note as "that went wrong" - without anyone being told.
  finished: [660, 880],
  stopped: [660, 494],
  error: [330, 330],
}

/**
 * A tone built on the spot. No audio file: an asset would have to be shipped,
 * loaded and allowed past the content-security policy for a third of a second
 * of sound.
 */
function blip(outcome: Outcome): void {
  const Ctor = window.AudioContext
  if (Ctor === undefined) return
  const ctx = new Ctor()
  const gain = ctx.createGain()
  gain.connect(ctx.destination)
  gain.gain.value = 0.0001

  const start = ctx.currentTime + 0.01
  const step = 0.12
  TONE[outcome].forEach((hz, index) => {
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = hz
    osc.connect(gain)
    const at = start + index * step
    // Ramp rather than switch: a square edge on a gain node is an audible click.
    gain.gain.exponentialRampToValueAtTime(0.12, at + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + step - 0.01)
    osc.start(at)
    osc.stop(at + step)
  })
  window.setTimeout(() => void ctx.close(), 1000)
}

function toast(outcome: Outcome, session: string): void {
  if (typeof Notification === 'undefined') return
  if (Notification.permission === 'denied') return
  const body = outcome === 'finished' ? `${session} finished.` : outcome === 'stopped' ? `${session} stopped.` : `${session} failed.`
  const show = (): void => {
    new Notification('NanoHarness', { body, silent: true })
  }
  if (Notification.permission === 'granted') show()
  else void Notification.requestPermission().then(result => {
    if (result === 'granted') show()
  })
}

const bellOn = toggle.querySelector<SVGElement>('.bell-on')
const bellOff = toggle.querySelector<SVGElement>('.bell-off')

/** A bell, struck or crossed out. The word was a control row's worth of width. */
function render(): void {
  if (bellOn !== null) bellOn.toggleAttribute('hidden', !enabled)
  if (bellOff !== null) bellOff.toggleAttribute('hidden', enabled)
  toggle.classList.toggle('off', !enabled)
  toggle.setAttribute('aria-label', enabled ? 'Alerts on' : 'Alerts off')
  toggle.title = enabled
    ? 'Sound and a desktop notification when a turn ends. Click to silence.'
    : 'Turn endings are silent. Click to hear them.'
}

/**
 * Announce the end of a turn. The notification is held back while the window
 * has focus — the person is already watching the answer arrive — but the blip
 * plays either way, because a turn that ends off-screen still ends.
 */
export function announce(outcome: Outcome, session: string): void {
  if (!enabled) return
  blip(outcome)
  if (!document.hasFocus()) toast(outcome, session)
}

export function initNotify(): void {
  render()
  toggle.addEventListener('click', () => {
    enabled = !enabled
    localStorage.setItem(KEY, enabled ? 'on' : 'off')
    render()
    // Turning it on is the one moment the sound is wanted for its own sake.
    if (enabled) blip('finished')
  })
}

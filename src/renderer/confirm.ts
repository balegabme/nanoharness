// doc: docs/harness/ui.md
import { must } from './dom.js'

/**
 * The browser's own `confirm()` is a system-drawn box in the middle of an app
 * that draws everything else itself, and it blocks the renderer while it is up.
 * This is the same question asked in the app's own sheet.
 */

const dialog = must<HTMLDialogElement>('confirm-dialog')
const title = must<HTMLElement>('confirm-title')
const detail = must<HTMLElement>('confirm-detail')
const yes = must<HTMLButtonElement>('confirm-yes')
const no = must<HTMLButtonElement>('confirm-no')

export interface ConfirmRequest {
  title: string
  detail?: string
  /** What the destructive button says. Naming the act beats a bare "OK". */
  confirmLabel?: string
}

export async function ask(request: ConfirmRequest): Promise<boolean> {
  title.textContent = request.title
  detail.textContent = request.detail ?? ''
  detail.hidden = request.detail === undefined
  yes.textContent = request.confirmLabel ?? 'Remove'

  dialog.showModal()
  // Esc and the backdrop both close a <dialog> without pressing a button, and
  // that has to read as "no" rather than as an unanswered promise.
  return new Promise<boolean>(resolve => {
    const finish = (answer: boolean): void => {
      yes.removeEventListener('click', onYes)
      no.removeEventListener('click', onNo)
      dialog.removeEventListener('close', onClose)
      if (dialog.open) dialog.close()
      resolve(answer)
    }
    const onYes = (): void => finish(true)
    const onNo = (): void => finish(false)
    const onClose = (): void => finish(false)
    yes.addEventListener('click', onYes)
    no.addEventListener('click', onNo)
    dialog.addEventListener('close', onClose)
    no.focus()
  })
}

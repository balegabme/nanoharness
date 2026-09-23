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
const code = must<HTMLElement>('confirm-code')
const yes = must<HTMLButtonElement>('confirm-yes')
const no = must<HTMLButtonElement>('confirm-no')

const promptDialog = must<HTMLDialogElement>('prompt-dialog')
const promptForm = must<HTMLFormElement>('prompt-form')
const promptTitle = must<HTMLElement>('prompt-title')
const promptInput = must<HTMLInputElement>('prompt-input')
const promptCancel = must<HTMLButtonElement>('prompt-cancel')

export interface ConfirmRequest {
  title: string
  detail?: string
  /** Text shown as it is, in a box of its own: a file the question is about. */
  code?: string
  /** What the destructive button says. Naming the act beats a bare "OK". */
  confirmLabel?: string
}

/**
 * The question on screen, and every one asked after it. A question can arrive
 * from the main process while another is up, and `showModal()` on an open
 * dialog throws, so each waits for the one before it to be answered.
 */
let asking: Promise<unknown> = Promise.resolve()

export function ask(request: ConfirmRequest): Promise<boolean> {
  const turn = asking.then(() => show(request))
  asking = turn
  return turn
}

function show(request: ConfirmRequest): Promise<boolean> {
  title.textContent = request.title
  detail.textContent = request.detail ?? ''
  detail.hidden = request.detail === undefined
  code.textContent = request.code ?? ''
  code.hidden = request.code === undefined
  yes.textContent = request.confirmLabel ?? 'Remove'

  dialog.showModal()
  // Esc and the backdrop both close a <dialog> without pressing a button, and
  // that has to read as "no" and not as an unanswered promise.
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

export interface PromptRequest {
  title: string
  /** What the field starts as, pre-selected so typing replaces it. */
  value?: string
}

/**
 * One line of text, asked for in the app's own sheet. Resolves to null when the
 * user backs out with Esc, the backdrop or Cancel, which has to be
 * distinguishable from an empty answer.
 */
export async function askText(request: PromptRequest): Promise<string | null> {
  // `showModal()` on an open dialog throws, and the throw would leave the first
  // question unanswered forever. Two at once is a double-click on Rename.
  if (promptDialog.open) return null
  promptTitle.textContent = request.title
  promptInput.value = request.value ?? ''

  promptDialog.showModal()
  promptInput.focus()
  promptInput.select()

  return new Promise<string | null>(resolve => {
    let answer: string | null = null
    const finish = (): void => {
      promptForm.removeEventListener('submit', onSubmit)
      promptCancel.removeEventListener('click', onCancel)
      promptDialog.removeEventListener('close', onClose)
      resolve(answer)
    }
    const onSubmit = (event: Event): void => {
      event.preventDefault()
      answer = promptInput.value
      if (promptDialog.open) promptDialog.close()
      else finish()
    }
    const onCancel = (): void => {
      answer = null
      if (promptDialog.open) promptDialog.close()
      else finish()
    }
    const onClose = (): void => finish()
    promptForm.addEventListener('submit', onSubmit)
    promptCancel.addEventListener('click', onCancel)
    promptDialog.addEventListener('close', onClose)
  })
}

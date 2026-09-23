// doc: docs/harness/ui.md
import type { ImageType } from '../core/types.js'
import type { ImageUpload, ImageView } from '../ipc/contract.js'

/**
 * The formats a message can carry as they are. `IMAGE_TYPES` in core is the
 * list, and the renderer cannot load it at runtime, so it is repeated here. The
 * type stops this copy from naming a format the core does not take.
 */
const SENDABLE: readonly ImageType[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

/**
 * The size a picture is shrunk to: no edge longer than 1,568 pixels and about
 * 1.15 million pixels in all. Models commonly scale a larger picture down to
 * about this on their own side (plan §15), so pixels past it cost upload time,
 * and tokens on the wires that bill by area, and show the model nothing more.
 */
const LONG_EDGE = 1568
const MAX_PIXELS = 1_150_000

/** A shrunk JPEG is written again as a JPEG at this quality, which keeps it small. */
const JPEG_QUALITY = 0.9

/**
 * `src/main/workspace-store.ts` refuses a message over these two limits. They
 * are repeated here so a picture over them is turned away when it is attached,
 * before a message is sent and lost. Change both together.
 */
export const IMAGES_PER_MESSAGE = 20
const IMAGE_MAX_BYTES = 10 * 1024 * 1024

/** A picture in the composer, ready to send. */
export interface Attachment {
  upload: ImageUpload
  view: ImageView
}

/**
 * Read a pasted or dropped file as a picture to send. With `shrink` on, a
 * picture over the size above is drawn again at that size. A picture in a
 * format no wire takes is drawn again as a PNG at its own size. Anything else
 * goes as it came. Throws with a reason the composer can show.
 */
export async function prepare(file: Blob, shrink: boolean): Promise<Attachment> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error('this window cannot read it as a picture')
  }
  try {
    const scale = shrink ? fitScale(bitmap.width, bitmap.height) : 1
    const sendable = SENDABLE.find(type => type === file.type)
    const picture =
      scale === 1 && sendable !== undefined
        ? { blob: file, mediaType: sendable, width: bitmap.width, height: bitmap.height }
        : await redraw(bitmap, scale, sendable === 'image/jpeg' ? 'image/jpeg' : 'image/png')
    if (picture.blob.size > IMAGE_MAX_BYTES) {
      throw new Error(`it is over ${IMAGE_MAX_BYTES / 1024 / 1024} MB. Turn on "Shrink images before sending" in Settings, under General.`)
    }
    const src = await readDataUrl(picture.blob)
    const { mediaType, width, height } = picture
    return { upload: { mediaType, width, height, data: src.slice(src.indexOf(',') + 1) }, view: { src, width, height } }
  } finally {
    bitmap.close()
  }
}

function fitScale(width: number, height: number): number {
  return Math.min(1, LONG_EDGE / Math.max(width, height), Math.sqrt(MAX_PIXELS / (width * height)))
}

async function redraw(
  bitmap: ImageBitmap,
  scale: number,
  mediaType: 'image/png' | 'image/jpeg',
): Promise<{ blob: Blob; mediaType: ImageType; width: number; height: number }> {
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('this window could not draw it again at a smaller size')
  context.drawImage(bitmap, 0, 0, width, height)
  const blob = await canvas.convertToBlob(mediaType === 'image/jpeg' ? { type: mediaType, quality: JPEG_QUALITY } : { type: mediaType })
  return { blob, mediaType, width, height }
}

function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('this window could not read its bytes'))
    reader.readAsDataURL(blob)
  })
}

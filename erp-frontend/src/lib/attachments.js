// Task attachments (client round 1, W2): what may be attached, how big, and what the
// prototype can afford to keep. Pure functions, so the same rules move to the server.
//
// The prototype stores everything in the browser (a few MB for the whole demo), so it keeps a
// small preview of images, small PDF/Word files whole, and only the details (name, type,
// size) of anything bigger. With the backend, every file is stored in full.

export const FILE_KINDS = {
  pdf: { label: 'PDF', exts: ['pdf'], mimes: ['application/pdf'] },
  image: { label: 'Image', exts: ['jpg', 'jpeg', 'png'], mimes: ['image/jpeg', 'image/png'] },
  docx: { label: 'Word', exts: ['docx'], mimes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'] },
}
export const ACCEPT = '.pdf,.jpg,.jpeg,.png,.docx'
export const MAX_FILE_BYTES = 10 * 1024 * 1024
export const MAX_PER_TASK = 10
export const KEEP_WHOLE_BYTES = 250 * 1024
export const STORE_BUDGET = 1.5 * 1024 * 1024

const ext = (name = '') => (name.includes('.') ? name.split('.').pop().toLowerCase() : '')

/** 'pdf' | 'image' | 'docx', or null for anything else — by the file name's extension. */
export function fileKind(name) {
  const e = ext(name)
  return Object.keys(FILE_KINDS).find((k) => FILE_KINDS[k].exts.includes(e)) || null
}

export function humanSize(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Why a file cannot be attached, or null when it can. The extension decides the kind; the
 * type the browser reports must agree (a program renamed to .pdf is refused). Some browsers
 * report no type at all — then the extension alone decides.
 */
export function checkFile({ name, type = '', size = 0 }) {
  const kind = fileKind(name)
  if (!kind) return 'Only PDF, JPG, PNG or Word (.docx) files can be attached.'
  if (type && !FILE_KINDS[kind].mimes.includes(type)) return `“${name}” is not really a ${FILE_KINDS[kind].label} file.`
  if (!(size > 0)) return `“${name}” is empty.`
  if (size > MAX_FILE_BYTES) return `“${name}” is ${humanSize(size)} — the limit is ${humanSize(MAX_FILE_BYTES)} per file.`
  return null
}

/** How much attachment data the prototype holds, across all tasks (previews and whole files). */
export function keptBytes(tasks) {
  let n = 0
  for (const t of tasks) for (const a of t.attachments || []) n += (a.preview?.length || 0) + (a.data?.length || 0)
  return n
}

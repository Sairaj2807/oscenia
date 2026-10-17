// Uploaded invitation media — photos, video, music (Invitations v2). The invitation keeps only a
// reference, { key, name, size, type }, so publishing copies a few bytes, not the files.
//
// Two homes, told apart by the key:
//  * `m-…` keys are this browser's IndexedDB: the signed-out demo, which has no server. IndexedDB is
//    shared by every tab and survives a reload, but another browser or phone does not have the file.
//  * any other key is an upload's id on the server (signed in, or the client's edit link): guests
//    fetch it from the public media route (`mediaUrl`), so it shows on every device.
//
// Nothing here runs during render (the smoke test renders on the server).
import { mediaUrl } from './api.js'

const DB = 'oscenia.media'
const STORE = 'files'

/** Upload limits, checked by extension and MIME type together (as lib/attachments.js does). */
export const MEDIA_RULES = {
  photo: { exts: ['jpg', 'jpeg', 'png', 'webp'], types: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 15 * 1024 * 1024, accept: 'image/jpeg,image/png,image/webp' },
  video: { exts: ['mp4', 'mov', 'webm'], types: ['video/mp4', 'video/quicktime', 'video/webm'], maxBytes: 200 * 1024 * 1024, accept: 'video/mp4,video/quicktime,video/webm' },
  music: { exts: ['mp3', 'm4a'], types: ['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/aac'], maxBytes: 20 * 1024 * 1024, accept: 'audio/mpeg,audio/mp4,.mp3,.m4a' },
}

const mb = (n) => `${Math.round(n / 1024 / 1024)} MB`

/** null when the file may be uploaded as `kind`; otherwise a message people can read. */
export function checkMedia(file, kind) {
  const rule = MEDIA_RULES[kind]
  const ext = (file?.name || '').split('.').pop().toLowerCase()
  // Some systems send no type for .m4a/.mov: the extension then decides alone.
  if (!rule.exts.includes(ext) || (file.type && !rule.types.includes(file.type))) {
    const names = [...new Set(rule.exts.map((e) => (e === 'jpeg' ? 'JPG' : e.toUpperCase())))]
    return `Only ${names.slice(0, -1).join(', ')} or ${names.at(-1)} files can be used here.`
  }
  if (file.size > rule.maxBytes) return `That file is ${mb(file.size)}. The limit is ${mb(rule.maxBytes)}.`
  return null
}

let opening = null
function db() {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('This browser cannot keep uploads.'))
  opening ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => { opening = null; reject(req.error) }
  })
  return opening
}

function run(mode, op) {
  return db().then((d) => new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, mode)
    const req = op(tx.objectStore(STORE))
    tx.oncomplete = () => resolve(req.result)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error || new Error('The upload was not saved.'))
  }))
}

/** Saves a file (or Blob) and returns its reference. Rejects with a readable message. */
export async function putMedia(blob, { name = 'file', type = blob.type } = {}) {
  const key = `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  try {
    await run('readwrite', (s) => s.put(blob, key))
  } catch (err) {
    throw new Error(err?.name === 'QuotaExceededError' ? 'This browser has no room left for uploads. Remove a video, or use a link instead.' : 'The upload could not be saved in this browser.')
  }
  return { key, name, size: blob.size, type }
}

// One object URL per key for the life of the page: every section showing the same photo
// shares it, and nothing has to be revoked mid-render.
const urls = new Map()

/** Is this key a file in this browser (the demo), rather than an id on the server? */
export const isLocalKey = (key) => typeof key === 'string' && key.startsWith('m-')

/** The file's URL: the server's for an upload id, else this browser's object URL (null if absent). */
export async function getMediaUrl(key) {
  if (!key) return null
  if (!isLocalKey(key)) return mediaUrl(key)
  if (urls.has(key)) return urls.get(key)
  const blob = await run('readonly', (s) => s.get(key)).catch(() => null)
  if (!blob) return null
  const url = URL.createObjectURL(blob)
  urls.set(key, url)
  return url
}

/** Reset demo data: every upload goes too. */
export function clearMedia() {
  urls.forEach((u) => URL.revokeObjectURL(u))
  urls.clear()
  return run('readwrite', (s) => s.clear()).catch(() => {})
}

/** A shrunk photo (a JPEG data URL from lib/images.js) → a stored reference. */
export async function putPhotoDataUrl(dataUrl, name) {
  return putMedia(await dataUrlToBlob(dataUrl), { name, type: 'image/jpeg' })
}

export async function dataUrlToBlob(dataUrl) {
  return (await fetch(dataUrl)).blob()
}

/** Is this a stored-media reference (as opposed to an old inline data URL)? */
export const isMediaRef = (v) => Boolean(v && typeof v === 'object' && typeof v.key === 'string')

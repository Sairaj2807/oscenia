// Uploaded invitation media under Node: where a reference's key says the file lives, the wire shape of
// every upload (path, credential, form body, progress, cancel, refusals), and the copy for a failure.
//
//   npm run verify:media      (vite-node, so the ESM imports resolve like they do in the app)

import { apiBase, uploadFile, mediaUrl, ApiError } from '../src/lib/api.js'
import { publicApi, whyPublic } from '../src/lib/publicApi.js'
import { eventsApi } from '../src/lib/eventsApi.js'
import { getMediaUrl, isLocalKey } from '../src/lib/mediaStore.js'

let passed = 0
const failures = []
function check(label, ok, detail = '') {
  if (ok) passed += 1
  else failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
}
const section = (name) => console.log(`\n${name}`)

// A stand-in for the browser's XMLHttpRequest: records the call and answers as scripted.
const calls = []
let script = { status: 201, body: '{"key":"a-b","name":"x.png","size":3,"type":"image/png"}', events: [] }
class FakeXhr {
  constructor() { this.headers = {}; this.upload = {}; calls.push(this) }
  open(method, url) { this.method = method; this.url = url }
  setRequestHeader(k, v) { this.headers[k] = v }
  abort() { this.aborted = true; this.onabort?.() }
  send(body) {
    this.body = body
    queueMicrotask(() => {
      for (const f of script.events) this.upload.onprogress?.({ lengthComputable: true, loaded: f, total: 100 })
      if (script.network) return this.onerror?.()
      if (script.hang) return undefined
      this.status = script.status
      this.statusText = 'x'
      this.responseText = script.body
      return this.onload?.()
    })
  }
}
globalThis.XMLHttpRequest = FakeXhr
const file = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })

section('Which home a key names')
check('a browser-local key starts m-', isLocalKey('m-lq3x-ab12cd') && !isLocalKey('3f2a9c1e-0000-4000-8000-000000000000'))
check('a server upload has a public URL from its id alone', mediaUrl('abc-1') === `${apiBase}/public/media/abc-1`)
check('the id is escaped into the path', mediaUrl('a/b') === `${apiBase}/public/media/a%2Fb`)
check('getMediaUrl answers a server key without touching IndexedDB', (await getMediaUrl('3f2a9c1e-0000-4000-8000-000000000000')).endsWith('/public/media/3f2a9c1e-0000-4000-8000-000000000000'))
check('an empty key has no URL', (await getMediaUrl('')) === null)

section('The client uploads through the edit link')
{
  calls.length = 0
  const progress = []
  script = { status: 201, body: '{"key":"a-b","name":"x.png","size":3,"type":"image/png"}', events: [25, 100] }
  const ref = await publicApi.clientUpload('EV-02', 'client-key', file, { name: 'x.png', kind: 'video', onProgress: (f) => progress.push(f) })
  const x = calls[0]
  check('POST to the client media route', x.method === 'POST' && x.url.endsWith('/public/client/EV-02/media?kind=video'), x.url)
  check('the key goes in a header, not the path', x.headers['X-Client-Key'] === 'client-key' && !x.url.includes('client-key'))
  check('and no staff session is sent', !('Authorization' in x.headers))
  check('the body is a form with the file under "file"', x.body instanceof FormData && x.body.get('file')?.name === 'x.png')
  check('progress is reported as a fraction', progress.join() === '0.25,1')
  check('the reply is the reference to put in the content', ref.key === 'a-b' && ref.size === 3 && ref.type === 'image/png')
}

section('Staff upload with their session')
{
  calls.length = 0
  script = { status: 201, body: '{"key":"k","name":"p.jpg","size":3,"type":"image/jpeg"}', events: [] }
  await eventsApi.uploadMedia('uuid-1', file, { name: 'p.jpg', kind: 'photo' })
  await eventsApi.uploadArt('studio-3', file, { name: 'bg.png' })
  check('an event photo goes to the event\'s media route', calls[0].url.endsWith('/events/uuid-1/media?kind=photo'))
  check('template artwork goes to the template\'s art-upload route', calls[1].url.endsWith('/invitation-templates/studio-3/art-upload'))
  check('both are plain multipart forms (the browser writes the boundary)', calls.every((x) => x.body instanceof FormData && !('Content-Type' in x.headers)))
}

section('Refusals, being offline, and cancelling')
{
  script = { status: 422, body: '{"detail":"That file is empty."}', events: [] }
  let err = await uploadFile('/x', new FormData()).catch((e) => e)
  check('a refusal is an ApiError with the server\'s sentence', err instanceof ApiError && err.status === 422 && err.message === 'That file is empty.')

  script = { status: 429, body: '{"detail":"The server is busy.","retry_after":10}', events: [] }
  err = await uploadFile('/x', new FormData()).catch((e) => e)
  check('a busy server says how long to wait', err.status === 429 && err.retryAfter === 10)
  check('a guest-facing message for it', whyPublic(err).code === 'slow_down')

  script = { status: 413, body: '<html>too big</html>', events: [] }
  err = await uploadFile('/x', new FormData()).catch((e) => e)
  check('an HTML error page still gives the status', err.status === 413)

  script = { network: true, events: [] }
  err = await uploadFile('/x', new FormData()).catch((e) => e)
  check('no server is a TypeError, as fetch does, so "offline" is told the same way', err instanceof TypeError)

  script = { hang: true, events: [] }
  const control = new AbortController()
  const pending = uploadFile('/x', new FormData(), { signal: control.signal }).catch((e) => e)
  await Promise.resolve()
  control.abort()
  err = await pending
  check('cancelling aborts the request and rejects with AbortError', calls.at(-1).aborted === true && err.name === 'AbortError')

  const already = new AbortController()
  already.abort()
  const before = calls.length
  err = await uploadFile('/x', new FormData(), { signal: already.signal }).catch((e) => e)
  check('an already-cancelled upload sends nothing', err.name === 'AbortError' && calls.length === before)
}

console.log(`\n${passed} checks passed`)
if (failures.length) {
  console.log(`\n${failures.length} FAILED:\n - ${failures.join('\n - ')}`)
  process.exit(1)
}
console.log('all passed')

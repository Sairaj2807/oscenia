// Opening a stored file that needs the signed-in user's token.
//
// A plain link cannot carry the bearer token, so the bytes are fetched with it and handed to the
// browser as a temporary local URL. Used for files filed against CRM notes; chat and tasks hand out
// short-lived signed links instead.

import { request } from './api.js'

/** Fetch a stored file (`GET /attachments/{id}`) and open it in a new tab, falling back to a download. */
export async function openStoredFile(id, filename = 'file') {
  const response = await request(`/attachments/${id}`, { raw: true })
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const tab = window.open(url, '_blank', 'noopener')
  if (!tab) {
    // A blocked pop-up: download it instead.
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
  }
  // Long enough for the new tab to read it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

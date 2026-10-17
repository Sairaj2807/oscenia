// The signed-in person's Google Calendar connection (backlog item 8), read from the server.
//
// Only used when signed in; the demo keeps its simulated connection in useProto. Nothing here holds
// a token: the server keeps the refresh token (encrypted) and answers with status, events and the
// result of a sync. Connecting is a full-page trip to Google and back, so the screen reads
// `?google=connected|declined|failed` on its way back (`readReturn`).

import { create } from 'zustand'
import { api } from '../lib/api.js'

const say = (err) => (err && err.message) || 'Something went wrong.'

export const useGoogle = create((set, get) => ({
  status: null, // { configured, connected, account, canWrite, showGoogle, addCrmDates }
  events: [], // the month last asked for: { id, title, date, allDay, time }
  eventsFor: '', // 'YYYY-MM' the events belong to
  error: '',
  syncResult: null,
  busy: false,

  async loadStatus() {
    try {
      set({ status: await api.get('/google/status'), error: '' })
    } catch (err) {
      set({ error: say(err) })
    }
  },

  /** Events for one month, or none when not connected or switched off. */
  async loadEvents(year, month) {
    const { status } = get()
    const ym = `${year}-${String(month).padStart(2, '0')}`
    if (!status?.connected || !status.showGoogle) return set({ events: [], eventsFor: ym })
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
    try {
      const events = await api.get('/google/events', { start: `${ym}-01`, end: `${ym}-${String(last).padStart(2, '0')}` })
      set({ events, eventsFor: ym, error: '' })
    } catch (err) {
      // A revoked connection is dropped by the server: re-read so the card offers Connect again.
      set({ events: [], eventsFor: ym, error: say(err) })
      get().loadStatus()
    }
  },

  /** Sends the browser to Google; the person comes back to the Google Calendar screen. */
  async connect(write) {
    set({ busy: true, error: '' })
    try {
      const { url } = await api.get('/google/connect', { write: write ? 'true' : undefined })
      window.location.assign(url)
    } catch (err) {
      set({ error: say(err), busy: false })
    }
  },

  async disconnect() {
    set({ busy: true })
    try {
      await api.delete('/google/connection')
      set({ events: [], syncResult: null, error: '' })
      await get().loadStatus()
    } catch (err) {
      set({ error: say(err) })
    }
    set({ busy: false })
  },

  /** `{ showGoogle }` and/or `{ addCrmDates }`. The server refuses writing back without the wider permission. */
  async setOption(patch) {
    try {
      set({ status: await api.put('/google/options', patch), error: '' })
    } catch (err) {
      set({ error: say(err) })
    }
  },

  async sync() {
    set({ busy: true, error: '', syncResult: null })
    try {
      set({ syncResult: await api.post('/google/sync-crm-dates') })
    } catch (err) {
      set({ error: say(err) })
    }
    set({ busy: false })
  },
}))

/**
 * What Google reported on the way back, taken off the address so a refresh does not show it twice.
 * `null` when the person did not just come back from Google.
 */
export function readReturn() {
  if (typeof window === 'undefined') return null
  const url = new URL(window.location.href)
  const outcome = url.searchParams.get('google')
  if (!outcome) return null
  const reason = url.searchParams.get('reason') || ''
  url.searchParams.delete('google')
  url.searchParams.delete('reason')
  window.history.replaceState(null, '', url.pathname + url.search + url.hash)
  return { outcome, reason }
}

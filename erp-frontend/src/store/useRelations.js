import { create } from 'zustand'
import { api } from '../lib/api'
import { useStore } from './useStore'
import { adaptCalendarItem, adaptRelations, contactBody } from '../lib/relationsApi'

// Signed in, a client's relationships (the people we work with, the events they run every year, the
// greetings sent) and the calendar of what to do when live on the server. This store holds what was read
// and does the writes; the screens choose between it and the demo's copy by whether anyone is signed in.
//
// Every write goes through `useStore.mutate`, so a refusal shows the server's own words (a birthday that
// is not a real date, a nudge that is not due) and nothing is changed on screen that was not saved.

export const useRelations = create((set, get) => ({
  /** `{ [clientUuid]: adaptedRelations }` */
  byClient: {},
  calendar: [],
  calendarDays: 90,
  calendarLoaded: false,

  loadClient: async (uuid) => {
    if (!uuid) return
    try {
      const row = await api.get(`/clients/${uuid}/relations`)
      set((s) => ({ byClient: { ...s.byClient, [uuid]: adaptRelations(row) } }))
    } catch {
      // A role without the CRM module has no relations to show; the panel stays empty.
    }
  },

  loadCalendar: async (days = 90) => {
    try {
      const rows = await api.get('/crm/calendar', { days })
      set({ calendar: rows.map(adaptCalendarItem), calendarDays: days, calendarLoaded: true })
    } catch {
      set({ calendar: [], calendarDays: days, calendarLoaded: true })
    }
  },

  /** Run one write, then re-read what it touched. Resolves `{ ok }` like `mutate`. */
  _write: async (clientUuid, label, call, toast) => {
    const result = await useStore.getState().mutate({ label, call, refresh: [], toast })
    if (result?.ok) {
      await Promise.all([get().loadClient(clientUuid), get().loadCalendar(get().calendarDays)])
    }
    return result
  },

  saveContact: (clientUuid, pic) => get()._write(
    clientUuid,
    `relations:contact:${pic.id || 'new'}`,
    () => (pic.id
      ? api.patch(`/clients/${clientUuid}/contacts/${pic.id}`, contactBody(pic))
      : api.post(`/clients/${clientUuid}/contacts`, contactBody(pic))),
    { title: pic.id ? 'Contact updated' : 'Contact added', body: pic.name, kind: 'cron' },
  ),

  removeContact: (clientUuid, picId, name) => get()._write(
    clientUuid, `relations:contact:${picId}:remove`,
    () => api.delete(`/clients/${clientUuid}/contacts/${picId}`),
    { title: 'Contact removed', body: name || '', kind: 'cron' },
  ),

  saveSettings: (clientUuid, patch) => get()._write(
    clientUuid, 'relations:settings',
    () => api.patch(`/clients/${clientUuid}/relations`, patch),
    null,
  ),

  saveCycle: (clientUuid, cycle) => get()._write(
    clientUuid,
    `relations:cycle:${cycle.id || 'new'}`,
    () => (cycle.id
      ? api.patch(`/clients/${clientUuid}/cycles/${cycle.id}`, { name: cycle.name, history: cycle.history })
      : api.post(`/clients/${clientUuid}/cycles`, { name: cycle.name, history: cycle.history })),
    { title: cycle.id ? 'Recurring event updated' : 'Recurring event added', body: cycle.name, kind: 'cron' },
  ),

  removeCycle: (clientUuid, cycleId, name) => get()._write(
    clientUuid, `relations:cycle:${cycleId}:remove`,
    () => api.delete(`/clients/${clientUuid}/cycles/${cycleId}`),
    { title: 'Recurring event removed', body: name || '', kind: 'cron' },
  ),

  handleNudge: (clientUuid, key, note, label) => get()._write(
    clientUuid, `relations:nudge:${key}`,
    () => api.post(`/clients/${clientUuid}/nudges`, { key, note }),
    { title: 'Outreach logged', body: label || key, kind: 'cron' },
  ),

  markGreetingSent: (clientUuid, { kind, to, channel, year }) => get()._write(
    clientUuid, `relations:greeting:${kind}:${to}:${year}`,
    () => api.post(`/clients/${clientUuid}/greetings`, { kind, to, channel, year }),
    { title: 'Marked as sent', body: to, kind: 'cron' },
  ),
}))

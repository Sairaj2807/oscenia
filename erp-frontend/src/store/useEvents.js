// The events workspace, from the server: events (with their invitation, review and guest
// numbers), guests, the door's scan log, wishes and the studio templates.
//
// Not persisted: the server is the copy, and a signed-out browser must not keep another person's
// guest list. Live only: the signed-out demo keeps using the persisted `useProto` store, and
// `store/chatProto.js` decides which one a screen sees.
//
// Shape of the loading, because an events list card needs each event's invitation and guest
// numbers: the list, then every event's detail in parallel, then (when an event is opened) its
// guests, scans and wishes. There is no push for events, so it is polled: the list once a minute,
// the open event every 20 seconds (a check-in desk should not be a minute behind), and both again
// when the tab comes back into view.

import { create } from 'zustand'
import { eventsApi } from '../lib/eventsApi.js'
import { MUSIC, SECTIONS, registerTemplates } from '../lib/templates.js'
import { cleanSection } from '../lib/invites.js'
import { isIsoDate } from '../lib/events.js'
import { canDo } from '../lib/roles.js'
import { useStore } from './useStore.js'
import { useProto as useDemoProto } from './useProto.js'
import {
  adaptCheckpoint, adaptEvent, adaptGuest, adaptQuestion, adaptScan, adaptTemplate, adaptWish, replaceGuests, replaceScans,
  studioTemplates, upsertEvent, whyRefused,
} from './eventAdapters.js'

export const LIST_POLL_MS = 60_000
export const OPEN_POLL_MS = 20_000

export const toast = (title, body, kind = 'redflag') => {
  try {
    useStore.getState().pushToast({ title, body, kind })
  } catch {
    /* no toast host */
  }
}

/** The finance store's business ids for the server's client and project ids. */
function lookups() {
  const s = useStore.getState()
  const clients = new Map((s.clients || []).filter((c) => c.uuid).map((c) => [c.uuid, c.id]))
  const projects = new Map((s.projects || []).filter((p) => p.uuid).map((p) => [p.uuid, p.id]))
  return { clientNo: (u) => clients.get(u), projectNo: (u) => projects.get(u) }
}

// Typing must not be a request per keystroke, and a request must not land on top of newer typing.
// So an edit shows at once (the screens read the store), and its write waits a moment for the next
// keystroke, one per thing edited. While any write for an event is waiting, reloads leave that event
// alone, and a response only replaces it once nothing is waiting.
const SAVE_DELAY_MS = 500
const pending = new Map() // `${eventNo}|${key}` -> { timer, run }
const queuedUpdates = new Map() // eventNo -> the merged PATCH body not yet sent
const queuedQuestions = new Map() // `${eventNo}|${key}` -> the merged question patch not yet sent
const dirty = (eventNo) => [...pending.keys()].some((k) => k.startsWith(`${eventNo}|`))

let listTimer = null
let openTimer = null
let onVisible = null
let unsubFinance = null

const initial = { events: [], guests: [], scans: [], customTemplates: [], status: 'idle', openNo: null, who: null }

export const useEvents = create((set, get) => ({
  ...initial,

  /** Begin for this person: load, then keep fresh until `stop`. Safe to call again. */
  start: (userId) => {
    get().stop()
    set({ ...initial, who: userId, status: 'loading' })
    get().load()
    listTimer = setInterval(() => !document.hidden && get().load(), LIST_POLL_MS)
    openTimer = setInterval(() => !document.hidden && get().openNo && get().loadEvent(get().openNo), OPEN_POLL_MS)
    onVisible = () => {
      if (document.hidden) return
      get().load()
      if (get().openNo) get().loadEvent(get().openNo)
    }
    document.addEventListener('visibilitychange', onVisible)
    // Client and project business ids come from the finance store, which may finish loading after us.
    unsubFinance = useStore.subscribe((s, prev) => {
      if (s.clients !== prev.clients || s.projects !== prev.projects) get().relink()
    })
  },

  stop: () => {
    clearInterval(listTimer)
    clearInterval(openTimer)
    listTimer = openTimer = null
    if (onVisible) document.removeEventListener('visibilitychange', onVisible)
    onVisible = null
    unsubFinance?.()
    unsubFinance = null
    if (get().who) {
      set({ ...initial })
      // The demo's own studio templates are the registry again (a live login replaced it).
      registerTemplates(useDemoProto.getState().customTemplates)
    }
  },

  /** Every event with its detail, plus the studio templates. Keeps what it had if a reload fails. */
  load: async () => {
    const who = get().who
    try {
      const [rows, templates] = await Promise.all([eventsApi.list(), eventsApi.templates()])
      // One event's detail failing (it was just removed, say) must not blank the list.
      const details = await Promise.all(rows.map((r) => eventsApi.get(r.id).catch(() => r)))
      if (get().who !== who) return // signed out, or someone else, while it loaded
      const have = new Map(get().events.map((e) => [e.id, e]))
      const look = lookups()
      const events = details.map((d) => {
        const next = adaptEvent(d, look)
        // An event with edits still waiting to be saved keeps what is on screen.
        if (dirty(next.id) && have.has(next.id)) return have.get(next.id)
        return { ...next, wishes: have.get(next.id)?.wishes ?? [], editToken: have.get(next.id)?.editToken ?? '' }
      })
      const customTemplates = studioTemplates(templates)
      registerTemplates(customTemplates)
      set({ events, customTemplates, status: 'ready' })
    } catch (err) {
      if (get().who !== who) return
      const wasReady = get().status === 'ready'
      set({ status: wasReady ? 'ready' : 'error' })
      if (!wasReady) toast('Could not load events', whyRefused(err))
    }
  },

  /** One event's guests, scans, wishes and fresh detail. */
  loadEvent: async (eventNo, force = false) => {
    const who = get().who
    const event = get().events.find((e) => e.id === eventNo)
    if (!event || (dirty(eventNo) && !force)) return
    try {
      const [detail, guests, scans, wishes] = await Promise.all([
        eventsApi.get(event.uuid),
        eventsApi.guests(event.uuid),
        eventsApi.scans(event.uuid),
        eventsApi.wishes(event.uuid),
      ])
      if (get().who !== who || (dirty(eventNo) && !force)) return
      const next = { ...adaptEvent(detail, lookups()), wishes: wishes.map(adaptWish) }
      // Only the roles that may publish can read the client link (the others would be refused).
      if (canDo(useStore.getState().role, 'publish_invitation')) {
        next.editToken = await eventsApi.clientLink(event.uuid).then((l) => l.token, () => event.editToken || '')
      }
      set((s) => ({
        events: s.events.map((e) => (e.id === eventNo ? next : e)),
        guests: replaceGuests(s.guests, eventNo, guests.map((g) => adaptGuest(g, eventNo))),
        scans: replaceScans(s.scans, eventNo, scans.map((x) => adaptScan(x, eventNo))),
      }))
    } catch (err) {
      if (get().who === who && !document.hidden) toast('Could not load that event', whyRefused(err))
    }
  },

  /** The event on screen: loaded now and re-read every 20 s. `null` when leaving it. */
  openEvent: (eventNo) => {
    set({ openNo: eventNo || null })
    if (eventNo) get().loadEvent(eventNo)
  },

  // ===========================================================================
  // Writes: events and the invitation (Phase E1)
  // ===========================================================================
  // Same names and arguments as the demo store's actions. Typing-driven ones (content, accent,
  // event settings) show at once and save a moment later; the rest wait for the server and say why
  // when it refuses.

  /** A new draft. Resolves to the new event's number (`EV-04`), or null when refused. */
  createEvent: async ({ name, clientId = '', projectId = '', date, time = '19:00', venue = '' }) => {
    const s = useStore.getState()
    const client = clientId && s.clients.find((c) => c.id === clientId)
    const project = projectId && s.projects.find((p) => p.id === projectId)
    try {
      const detail = await eventsApi.create({
        name: String(name || '').trim(), date, time, venue,
        clientId: client?.uuid || null, projectId: project?.uuid || null,
      })
      const event = adaptEvent(detail, lookups())
      set((st) => ({ events: upsertEvent(st.events, event) }))
      return event.id
    } catch (err) {
      toast('Could not create the event', whyRefused(err))
      return null
    }
  },

  /**
   * Event settings: name, RSVP deadline and fields, max guests, feedback link, wish hold, client.
   * Date, time and venue are not editable here (the server seals them; they move with the
   * invitation's Date & venue section and Publish).
   */
  updateEvent: (eventNo, patch) => {
    const event = get().events.find((e) => e.id === eventNo)
    if (!event) return
    const local = {}
    const body = {}
    for (const [k, v] of Object.entries(patch || {})) {
      if (k === 'name') {
        local.name = String(v)
        if (String(v).trim()) body.name = String(v).trim() // a half-cleared name is not saved
      } else if (k === 'rsvpDeadline') {
        if (isIsoDate(v)) { local.rsvpDeadline = v; body.rsvpDeadline = v }
      } else if (k === 'maxPax') {
        const n = Math.min(50, Math.max(1, Number(v) || 1))
        local.maxPax = n
        body.maxPax = n
      } else if (k === 'rsvpFields') {
        local.rsvpFields = { ...event.rsvpFields, ...v }
        body.rsvpFields = v
      } else if (k === 'feedbackUrl') {
        local.feedbackUrl = String(v)
        // Only a complete link (or none) is saved: the server refuses half-typed ones.
        if (!String(v).trim() || /^https?:\/\//i.test(String(v).trim())) body.feedbackUrl = String(v).trim()
      } else if (k === 'holdWishes') {
        local.holdWishes = Boolean(v)
        body.holdWishes = Boolean(v)
      } else if (k === 'clientId' || k === 'projectId') {
        const s = useStore.getState()
        const row = (k === 'clientId' ? s.clients : s.projects).find((x) => x.id === v)
        if (row?.uuid) { local[k] = v; body[k] = row.uuid }
      } else if (k === 'date' || k === 'time' || k === 'venue') {
        toast('Change it in the invitation', 'Date, time and venue are set in the Date & venue section of the invitation and go live with Publish.', 'project')
      }
    }
    set((s) => ({ events: s.events.map((e) => (e.id === eventNo ? { ...e, ...local } : e)) }))
    if (!Object.keys(body).length) return
    queuedUpdates.set(eventNo, { ...queuedUpdates.get(eventNo), ...body })
    get()._later(eventNo, 'update', async () => {
      const send = queuedUpdates.get(eventNo)
      queuedUpdates.delete(eventNo)
      return send ? eventsApi.update(event.uuid, send) : null
    })
  },

  /** Run `write` after the typing pause; one per (event, key). Failure toasts and reloads the event. */
  _later: (eventNo, key, write, delay = SAVE_DELAY_MS, confirm = null) => {
    const full = `${eventNo}|${key}`
    clearTimeout(pending.get(full)?.timer)
    const run = async () => {
      clearTimeout(pending.get(full)?.timer)
      pending.delete(full)
      try {
        const out = await write()
        if (confirm) {
          if (!dirty(eventNo)) confirm(eventNo, out)
        } else get()._confirm(eventNo, out)
      } catch (err) {
        toast('Not saved', whyRefused(err))
        get()._confirm(eventNo, null)
      }
    }
    pending.set(full, { timer: setTimeout(run, delay), run })
  },

  /** Save everything waiting for this event now (before a step that must see it: publish, submit). */
  flush: async (eventNo) => {
    const mine = [...pending.entries()].filter(([k]) => k.startsWith(`${eventNo}|`))
    await Promise.all(mine.map(([, p]) => p.run()))
  },

  /** The server's answer replaces the event once nothing newer is waiting; a failed write reloads it. */
  _confirm: (eventNo, detail) => {
    if (dirty(eventNo)) return
    if (!detail) {
      get().loadEvent(eventNo)
      return
    }
    const next = adaptEvent(detail, lookups())
    set((s) => {
      const old = s.events.find((e) => e.id === eventNo)
      const merged = { ...next, wishes: old?.wishes ?? [], editToken: old?.editToken ?? '' }
      return { events: s.events.map((e) => (e.id === eventNo ? merged : e)) }
    })
  },

  /** Choose or change the template. Content and the user's own toggles are kept. */
  chooseTemplate: async (eventNo, templateId) => {
    const event = get().events.find((e) => e.id === eventNo)
    if (!event) return false
    try {
      await get().flush(eventNo)
      get()._confirm(eventNo, await eventsApi.setTemplate(event.uuid, templateId))
      return true
    } catch (err) {
      toast('Could not use that template', whyRefused(err))
      return false
    }
  },

  /** A section (or the background music) on or off. Required sections stay on. */
  setSection: (eventNo, sectionId, on) => {
    const event = get().events.find((e) => e.id === eventNo)
    if (!event || (sectionId !== MUSIC && (!SECTIONS[sectionId] || SECTIONS[sectionId].required))) return false
    set((s) => ({
      events: s.events.map((e) => (e.id === eventNo ? { ...e, invite: { ...e.invite, on: { ...e.invite.on, [sectionId]: Boolean(on) } } } : e)),
    }))
    get()._later(eventNo, `section:${sectionId}`, () => eventsApi.setSection(event.uuid, sectionId, Boolean(on)), 150)
    return true
  },

  /** One section's content, cleaned as the server will. Until first publish, date/time/venue follow it. */
  updateContent: (eventNo, sectionId, value) => {
    const event = get().events.find((e) => e.id === eventNo)
    if (!event || !(sectionId in event.invite.content)) return false
    const clean = cleanSection(value)
    const patch = {}
    if (sectionId === 'details' && !event.published) {
      if (isIsoDate(clean.date)) patch.date = clean.date
      patch.time = clean.time
      patch.venue = clean.venue
    }
    set((s) => ({
      events: s.events.map((e) => (e.id === eventNo
        ? { ...e, ...patch, invite: { ...e.invite, content: { ...e.invite.content, [sectionId]: clean } } }
        : e)),
    }))
    get()._later(eventNo, `content:${sectionId}`, () => eventsApi.setContent(event.uuid, sectionId, clean))
    return true
  },

  /** The client's own accent colour over the template's, or null for the template's. */
  setAccent: (eventNo, hex) => {
    const event = get().events.find((e) => e.id === eventNo)
    if (!event || (hex !== null && !/^#[0-9a-f]{6}$/i.test(hex))) return false
    set((s) => ({ events: s.events.map((e) => (e.id === eventNo ? { ...e, invite: { ...e.invite, accent: hex } } : e)) }))
    get()._later(eventNo, 'accent', () => eventsApi.setAccent(event.uuid, hex))
    return true
  },

  /** Hand the draft over for review. */
  submitForReview: (eventNo) => get()._step(eventNo, 'Could not submit for review', (e) => eventsApi.submit(e.uuid)),

  /** Send the draft back with a note saying what to change. */
  returnToClient: (eventNo, note) => {
    const text = String(note || '').trim().slice(0, 500)
    if (!text) return false
    return get()._step(eventNo, 'Could not send it back', (e) => eventsApi.returnToClient(e.uuid, text))
  },

  /** Guests get the draft as it is now; date, time and venue go onto the event. */
  publishInvite: (eventNo, { clampDeadline = false } = {}) =>
    get()._step(eventNo, 'Could not publish', (e) => eventsApi.publish(e.uuid, clampDeadline)),

  /** Guests can no longer open the invitation. */
  unpublish: (eventNo) => get()._step(eventNo, 'Could not unpublish', (e) => eventsApi.unpublish(e.uuid)),

  /** A leaked client link stops working; resolves to the new token (or null). */
  regenerateEditToken: async (eventNo) => {
    const event = get().events.find((e) => e.id === eventNo)
    if (!event) return null
    try {
      const link = await eventsApi.regenerateClientLink(event.uuid)
      set((s) => ({ events: s.events.map((e) => (e.id === eventNo ? { ...e, editToken: link.token } : e)) }))
      return link.token
    } catch (err) {
      toast('Could not make a new client link', whyRefused(err))
      return null
    }
  },

  /** A step the server decides (it saves what is waiting first): true when it went through. */
  _step: async (eventNo, failTitle, call) => {
    const event = get().events.find((e) => e.id === eventNo)
    if (!event) return false
    try {
      await get().flush(eventNo)
      get()._confirm(eventNo, await call(event))
      return true
    } catch (err) {
      toast(failTitle, whyRefused(err))
      return false
    }
  },

  // ===========================================================================
  // Writes: Template Studio
  // ===========================================================================
  // The role argument the screens pass is ignored: the server decides who may (CEO and PM).

  _putTemplate: (row) => {
    const t = adaptTemplate(row)
    const list = get().customTemplates
    const next = list.some((x) => x.id === t.id) ? list.map((x) => (x.id === t.id ? t : x)) : [...list, t]
    registerTemplates(next)
    set({ customTemplates: next })
    return t
  },

  /** A new draft, blank or a copy of `from`. Resolves to its id, or null. */
  createTemplate: async ({ from = null, family = 'private' } = {}) => {
    try {
      return get()._putTemplate(await eventsApi.createTemplate({ fromId: from, family })).id
    } catch (err) {
      toast('Could not make the template', whyRefused(err))
      return null
    }
  },

  /** Save the editor's settings. Resolves to null when saved, otherwise the reason why not. */
  updateTemplate: async (id, patch) => {
    const keep = ['name', 'tagline', 'family', 'palette', 'fonts', 'cover', 'ornament', 'sections', 'off']
    const body = Object.fromEntries(Object.entries(patch || {}).filter(([k]) => keep.includes(k)))
    try {
      get()._putTemplate(await eventsApi.updateTemplate(id, body))
      return null
    } catch (err) {
      return whyRefused(err)
    }
  },

  /** Upload a file for the invitation (or, with `templateId`, for a template's artwork). Resolves
   *  with the reference to put in the content; rejects (readable message) if the server refuses. */
  uploadMedia: (file, { eventId, templateId, ...options } = {}) => {
    if (templateId) return eventsApi.uploadArt(templateId, file, options)
    // The editor knows the event by its number (EV-01); the server is asked by id.
    const event = get().events.find((e) => e.id === eventId)
    if (!event?.uuid) return Promise.reject(new Error('Open the event again, then upload.'))
    return eventsApi.uploadMedia(event.uuid, file, options)
  },

  /** Sets (a reference from `uploadMedia`) or clears (null) one artwork slot. */
  setTemplateArt: async (id, slot, ref) => {
    try {
      get()._putTemplate(await eventsApi.setTemplateArt(id, slot, ref))
      return true
    } catch (err) {
      toast(ref === null ? 'Could not clear the artwork' : 'Could not set the artwork', whyRefused(err))
      return false
    }
  },

  publishTemplate: (id) => get()._templateStep(id, eventsApi.publishTemplate, 'Could not add it to the gallery'),
  unpublishTemplate: (id) => get()._templateStep(id, eventsApi.unpublishTemplate, 'Could not take it out of the gallery'),
  archiveTemplate: (id) => get()._templateStep(id, eventsApi.archiveTemplate, 'Could not archive it'),
  _templateStep: async (id, call, failTitle) => {
    try {
      get()._putTemplate(await call(id))
      return true
    } catch (err) {
      toast(failTitle, whyRefused(err))
      return false
    }
  },

  // ===========================================================================
  // Writes: guests, questions, tables, checkpoints, the door, wishes (Phase E2)
  // ===========================================================================

  _guest: (guestId) => {
    const guest = get().guests.find((g) => g.id === guestId)
    const event = guest && get().events.find((e) => e.id === guest.eventId)
    return guest && event ? { guest, event } : null
  },

  /** Put one guest (the server's row) into the list. */
  _putGuest: (row, eventNo) => {
    const g = adaptGuest(row, eventNo)
    set((s) => ({ guests: s.guests.some((x) => x.id === g.id) ? s.guests.map((x) => (x.id === g.id ? g : x)) : [...s.guests, g] }))
  },

  /** Re-read an event now (also what its list shows), even with edits waiting: after a change the server made. */
  _refresh: (eventNo) => get().loadEvent(eventNo, true),

  /** New guests (rows of {name, phone, email, table, category}). Resolves to how many were added. */
  addGuests: async (eventNo, rows) => {
    const event = get().events.find((e) => e.id === eventNo)
    if (!event) return 0
    try {
      // The server takes text or nothing for the optional fields, never null: leave empty ones out.
      const out = await eventsApi.addGuests(event.uuid, (rows || []).map((r) => ({
        name: String(r.name || ''),
        phone: String(r.phone || ''),
        ...(r.email ? { email: String(r.email) } : {}),
        ...(r.table ? { table: String(r.table) } : {}),
        ...(r.category ? { category: String(r.category) } : {}),
      })))
      await get()._refresh(eventNo)
      return out.added
    } catch (err) {
      toast('Could not add the guests', whyRefused(err))
      return 0
    }
  },

  /** A guest's table, as typed; empty clears it. Resolves to the saved text. */
  setGuestTable: (guestId, table) => get()._guestEdit(guestId, { table: String(table || '').trim().slice(0, 30) }, (e, g, v) => eventsApi.setGuestTable(e.uuid, g.id, v.table), 'Could not set the table'),

  setGuestCategory: (guestId, category) => get()._guestEdit(guestId, { category }, (e, g, v) => eventsApi.setGuestCategory(e.uuid, g.id, v.category), 'Could not change the category'),

  /** Staff-only note; empty clears it. */
  setGuestNote: async (guestId, text) => {
    const note = String(text || '').trim()
    const found = get()._guest(guestId)
    if (!found || note === (found.guest.note || '')) return false
    return (await get()._guestEdit(guestId, { note }, (e, g) => eventsApi.setGuestNote(e.uuid, g.id, note), 'Could not save the note')) !== null
  },

  /** Erase a guest's personal data on their request (cannot be undone): the row stays, anonymised, and
   *  their wishes go. Resolves to true when the server did it. */
  eraseGuest: async (guestId) => {
    const found = get()._guest(guestId)
    if (!found) return false
    try {
      get()._putGuest(await eventsApi.eraseGuest(found.event.uuid, found.guest.id), found.event.id)
      // Their wishes are gone on the server: re-read this event so none is left on screen.
      await get().openEvent?.(found.event.id)
      return true
    } catch (err) {
      toast('Could not erase the guest', whyRefused(err))
      return false
    }
  },

  /** A corrected email; empty clears it. Resolves to true when saved. */
  setGuestEmail: async (guestId, email) => {
    const v = String(email || '').trim()
    if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return false
    return (await get()._guestEdit(guestId, { email: v }, (e, g) => eventsApi.setGuestEmail(e.uuid, g.id, v), 'Could not save the email')) !== null
  },

  /** Show a guest edit at once, then save it; the server's row replaces ours (a refusal restores it). */
  _guestEdit: async (guestId, local, call, failTitle) => {
    const found = get()._guest(guestId)
    if (!found) return null
    const { guest, event } = found
    set((s) => ({ guests: s.guests.map((g) => (g.id === guestId ? { ...g, ...local } : g)) }))
    try {
      const row = await call(event, guest, local)
      get()._putGuest(row, event.id)
      return local.table !== undefined ? local.table : true
    } catch (err) {
      toast(failTitle, whyRefused(err))
      set((s) => ({ guests: s.guests.map((g) => (g.id === guestId ? guest : g)) }))
      return null
    }
  },

  /** A table name to suggest (the guest's own table is free text). */
  addTable: async (eventNo, name) => {
    const event = get().events.find((e) => e.id === eventNo)
    const n = String(name || '').trim()
    if (!event || !n) return false
    try {
      const tables = await eventsApi.addTable(event.uuid, n)
      set((s) => ({ events: s.events.map((e) => (e.id === eventNo ? { ...e, tables } : e)) }))
      return true
    } catch (err) {
      toast('Could not add the table', whyRefused(err))
      return false
    }
  },

  // --- questions -------------------------------------------------------------------

  /** Resolves to the new question's key (`Q-3`), or null (the limit is 10). */
  addQuestion: async (eventNo, type = 'text') => {
    const event = get().events.find((e) => e.id === eventNo)
    if (!event) return null
    try {
      const q = adaptQuestion(await eventsApi.addQuestion(event.uuid, type))
      set((s) => ({ events: s.events.map((e) => (e.id === eventNo ? { ...e, customFields: [...e.customFields, q] } : e)) }))
      return q.id
    } catch (err) {
      toast('Could not add the question', whyRefused(err))
      return null
    }
  },

  /** Typing a label must not be a request per key: show it, save it after the pause. */
  updateQuestion: (eventNo, qId, patch) => {
    const event = get().events.find((e) => e.id === eventNo)
    if (!event || !event.customFields.some((q) => q.id === qId)) return false
    const body = {}
    if (typeof patch.label === 'string') body.label = patch.label.slice(0, 200)
    if (typeof patch.type === 'string') body.type = patch.type
    if (Array.isArray(patch.options)) body.options = [...new Set(patch.options.map((o) => String(o).trim().slice(0, 100)).filter(Boolean))].slice(0, 20)
    for (const k of ['multi', 'required', 'attendingOnly']) if (k in patch) body[k] = Boolean(patch[k])
    // What the screen shows meanwhile (the server tidies the same way and has the last word).
    set((s) => ({
      events: s.events.map((e) => (e.id !== eventNo ? e : {
        ...e,
        customFields: e.customFields.map((q) => {
          if (q.id !== qId) return q
          const merged = { ...q, ...body }
          if (merged.type !== 'choice') merged.multi = false
          if (merged.type === 'text') merged.options = []
          else if (!merged.options.length && q.type === 'text') merged.options = ['Option 1', 'Option 2']
          return merged
        }),
      })),
    }))
    const key = `${eventNo}|${qId}`
    queuedQuestions.set(key, { ...queuedQuestions.get(key), ...body })
    get()._later(eventNo, `question:${qId}`, async () => {
      const send = queuedQuestions.get(key)
      queuedQuestions.delete(key)
      return send ? eventsApi.updateQuestion(event.uuid, qId, send) : null
    }, SAVE_DELAY_MS, (no, q) => {
      if (!q) return
      const next = adaptQuestion(q)
      set((s) => ({ events: s.events.map((e) => (e.id !== no ? e : { ...e, customFields: e.customFields.map((x) => (x.id === next.id ? next : x)) })) }))
    })
    return true
  },

  moveQuestion: async (eventNo, qId, dir) => {
    const event = get().events.find((e) => e.id === eventNo)
    if (!event) return false
    try {
      await get().flush(eventNo)
      const list = await eventsApi.moveQuestion(event.uuid, qId, dir < 0 ? -1 : 1)
      set((s) => ({ events: s.events.map((e) => (e.id === eventNo ? { ...e, customFields: list.map(adaptQuestion) } : e)) }))
      return true
    } catch (err) {
      toast('Could not move the question', whyRefused(err))
      return false
    }
  },

  removeQuestion: async (eventNo, qId) => {
    const event = get().events.find((e) => e.id === eventNo)
    if (!event) return false
    try {
      await get().flush(eventNo)
      await eventsApi.removeQuestion(event.uuid, qId)
      set((s) => ({ events: s.events.map((e) => (e.id === eventNo ? { ...e, customFields: e.customFields.filter((q) => q.id !== qId) } : e)) }))
      return true
    } catch (err) {
      toast('Could not remove the question', whyRefused(err))
      return false
    }
  },

  // --- checkpoints -----------------------------------------------------------------

  addCheckpoint: async (eventNo, name) => {
    const event = get().events.find((e) => e.id === eventNo)
    const n = String(name || '').trim()
    if (!event || !n) return false
    try {
      const cp = adaptCheckpoint(await eventsApi.addCheckpoint(event.uuid, n))
      set((s) => ({ events: s.events.map((e) => (e.id === eventNo ? { ...e, checkpoints: [...e.checkpoints, cp] } : e)) }))
      return true
    } catch (err) {
      toast('Could not add the checkpoint', whyRefused(err))
      return false
    }
  },

  /** Rename a checkpoint or set who it admits (an empty list admits everyone). */
  updateCheckpoint: async (eventNo, checkpointId, patch) => {
    const event = get().events.find((e) => e.id === eventNo)
    if (!event) return false
    const body = {}
    if (typeof patch.name === 'string' && patch.name.trim()) body.name = patch.name.trim()
    if (Array.isArray(patch.categories)) body.categories = patch.categories
    if (!Object.keys(body).length) return false
    const before = event.checkpoints
    set((s) => ({ events: s.events.map((e) => (e.id === eventNo ? { ...e, checkpoints: e.checkpoints.map((c) => (c.id === checkpointId ? { ...c, ...body } : c)) } : e)) }))
    try {
      const cp = adaptCheckpoint(await eventsApi.updateCheckpoint(event.uuid, checkpointId, body))
      set((s) => ({ events: s.events.map((e) => (e.id === eventNo ? { ...e, checkpoints: e.checkpoints.map((c) => (c.id === cp.id ? cp : c)) } : e)) }))
      return true
    } catch (err) {
      toast('Could not change the checkpoint', whyRefused(err))
      set((s) => ({ events: s.events.map((e) => (e.id === eventNo ? { ...e, checkpoints: before } : e)) }))
      return false
    }
  },

  /** The last checkpoint stays, and so does one with scans (the server refuses both). */
  removeCheckpoint: async (eventNo, checkpointId) => {
    const event = get().events.find((e) => e.id === eventNo)
    if (!event) return false
    try {
      await eventsApi.removeCheckpoint(event.uuid, checkpointId)
      set((s) => ({ events: s.events.map((e) => (e.id === eventNo ? { ...e, checkpoints: e.checkpoints.filter((c) => c.id !== checkpointId) } : e)) }))
      return true
    } catch (err) {
      toast('Could not remove the checkpoint', whyRefused(err))
      return false
    }
  },

  // --- the door --------------------------------------------------------------------

  /** Log a scan of this guest at a checkpoint. Resolves to the scan's id, or null. */
  scanGuest: async (guestId, checkpointId) => {
    const found = get()._guest(guestId)
    if (!found) return null
    const { guest, event } = found
    try {
      const out = await eventsApi.scan(event.uuid, { guestId: guest.id, checkpointId })
      get()._putGuest(out.guest, event.id)
      const scan = adaptScan({ id: out.scanId, guestId: guest.id, checkpointId: out.checkpointId, at: out.at }, event.id)
      set((s) => ({ scans: s.scans.some((x) => x.id === scan.id) ? s.scans : [...s.scans, scan] }))
      return scan.id
    } catch (err) {
      toast('Could not log the scan', whyRefused(err))
      return null
    }
  },

  /** Arrival at the first checkpoint; false if they have already arrived. */
  checkIn: async (guestId) => {
    const found = get()._guest(guestId)
    if (!found || found.guest.checkedInAt) return false
    try {
      const out = await eventsApi.checkIn(found.event.uuid, guestId)
      get()._putGuest(out.guest, found.event.id)
      await get()._rescan(found.event.id)
      return true
    } catch (err) {
      toast('Could not check them in', whyRefused(err))
      return false
    }
  },

  /** The desk registers someone who came without an invitation (or checks in a listed guest by phone).
   *  Resolves to { id, walkIn } or null; the reason is shown as a notice. */
  registerWalkIn: async (eventNo, form) => {
    const event = get().events.find((e) => e.id === eventNo)
    if (!event?.uuid) return null
    try {
      const out = await eventsApi.walkIn(event.uuid, {
        name: (form.name || '').trim(), phone: (form.phone || '').trim(),
        email: (form.email || '').trim(), consent: Boolean(form.consent),
      })
      get()._putGuest(out.guest, event.id)
      await get()._rescan(event.id)
      return { id: out.guest.id, walkIn: out.walkIn }
    } catch (err) {
      toast('Could not register the walk-in', whyRefused(err))
      return null
    }
  },

  /** Undo the guest's latest scan; with none left they have not arrived. */
  undoCheckIn: async (guestId) => {
    const found = get()._guest(guestId)
    if (!found) return false
    try {
      get()._putGuest(await eventsApi.undoCheckIn(found.event.uuid, guestId), found.event.id)
      await get()._rescan(found.event.id)
      return true
    } catch (err) {
      toast('Could not undo the check-in', whyRefused(err))
      return false
    }
  },

  _rescan: async (eventNo) => {
    const event = get().events.find((e) => e.id === eventNo)
    if (!event) return
    const rows = await eventsApi.scans(event.uuid).catch(() => null)
    if (rows) set((s) => ({ scans: replaceScans(s.scans, eventNo, rows.map((x) => adaptScan(x, eventNo))) }))
  },

  // --- wishes ----------------------------------------------------------------------

  /** While on, new wishes wait for approval. */
  setHoldWishes: (eventNo, on) => get().updateEvent(eventNo, { holdWishes: Boolean(on) }),

  setWishHidden: (eventNo, wishId, hidden) =>
    get()._wish(eventNo, wishId, (e) => eventsApi.setWishHidden(e.uuid, wishId, Boolean(hidden)), 'Could not change that wish'),

  approveWish: (eventNo, wishId) =>
    get()._wish(eventNo, wishId, (e) => eventsApi.approveWish(e.uuid, wishId), 'Could not approve that wish'),

  _wish: async (eventNo, wishId, call, failTitle) => {
    const event = get().events.find((e) => e.id === eventNo)
    if (!event?.wishes.some((w) => w.id === wishId)) return false
    try {
      const w = adaptWish(await call(event))
      set((s) => ({ events: s.events.map((e) => (e.id === eventNo ? { ...e, wishes: e.wishes.map((x) => (x.id === w.id ? w : x)) } : e)) }))
      return true
    } catch (err) {
      toast(failTitle, whyRefused(err))
      return false
    }
  },

  /** Re-resolve each event's client and project business ids (after finance data arrives). */
  relink: () => {
    const look = lookups()
    set((s) => ({
      events: s.events.map((e) => ({
        ...e,
        clientId: e.clientUuid ? look.clientNo(e.clientUuid) || e.clientUuid : '',
        projectId: e.projectUuid ? look.projectNo(e.projectUuid) || e.projectUuid : '',
      })),
    }))
  },
}))

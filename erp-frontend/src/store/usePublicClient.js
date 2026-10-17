// The client's edit link, from the server. The client opens `?key=` with no login, designs their
// invitation, moderates wishes, marks who they have sent it to, and submits it for review. They
// cannot publish: that stays behind an Oscenia login.
//
// Same actions, names and typing behaviour as the staff store (`useEvents`): an edit shows at once,
// its write follows after a short pause (one per thing edited), and a response only replaces the
// draft once nothing newer is waiting. While `active`, `store/chatProto.js` serves this store to the
// editor in place of the demo store.

import { create } from 'zustand'
import { publicApi, whyPublic } from '../lib/publicApi.js'
import { MUSIC, SECTIONS, registerTemplates } from '../lib/templates.js'
import { cleanSection } from '../lib/invites.js'
import { clientDraft, clientGuest, clientView, clientWish } from './publicAdapters.js'
import { useStore } from './useStore.js'

const SAVE_DELAY_MS = 500
const pending = new Map() // key -> { timer, run }
const dirty = () => pending.size > 0

const toast = (title, body, kind = 'redflag') => {
  try {
    useStore.getState().pushToast({ title, body, kind })
  } catch {
    /* no toast host */
  }
}

let seq = 0

export const usePublicClient = create((set, get) => ({
  active: false,
  status: 'idle', // idle | loading | ready | invalid | offline | error
  eventNo: null,
  key: null,
  event: null,
  templates: [],
  guests: [],

  load: async (eventNo, key) => {
    const mine = ++seq
    set({ active: true, status: 'loading', eventNo, key, event: null, templates: [], guests: [] })
    try {
      const d = await publicApi.client(eventNo, key)
      if (mine !== seq) return
      const view = clientView(d, key)
      registerTemplates(view.templates)
      set({ status: 'ready', ...view })
    } catch (err) {
      if (mine !== seq) return
      if (err instanceof TypeError) set({ status: 'offline', active: false })
      else if (err?.status === 403 || err?.status === 404) set({ status: 'invalid' })
      else set({ status: 'error' })
    }
  },

  /** Leaving the page: the editor goes back to whichever store it had. */
  leave: () => {
    seq += 1
    for (const p of pending.values()) clearTimeout(p.timer)
    pending.clear()
    set({ active: false, status: 'idle', eventNo: null, key: null, event: null, templates: [], guests: [] })
  },

  _patch: (fn) => set((s) => (s.event ? { event: fn(s.event) } : {})),

  /** The server's draft replaces ours once nothing newer is waiting. */
  _apply: (draft) => {
    if (dirty()) return
    get()._patch((e) => ({ ...e, ...clientDraft(draft) }))
  },

  _later: (key, write, delay = SAVE_DELAY_MS) => {
    clearTimeout(pending.get(key)?.timer)
    const run = async () => {
      clearTimeout(pending.get(key)?.timer)
      pending.delete(key)
      try {
        get()._apply(await write())
      } catch (err) {
        toast('Not saved', whyPublic(err).message)
        if (!dirty()) get().reload()
      }
    }
    pending.set(key, { timer: setTimeout(run, delay), run })
  },

  flush: async () => {
    await Promise.all([...pending.values()].map((p) => p.run()))
  },

  reload: async () => {
    const { eventNo, key } = get()
    if (!eventNo || dirty()) return
    try {
      const view = clientView(await publicApi.client(eventNo, key), key)
      registerTemplates(view.templates)
      set({ ...view })
    } catch { /* keep what is on screen */ }
  },

  // --- the draft -----------------------------------------------------------------------------

  /** A file from the client: resolves with the reference to put in the content. */
  uploadMedia: (file, { kind, ...options } = {}) => {
    const { eventNo, key } = get()
    return publicApi.clientUpload(eventNo, key, file, { kind, ...options })
  },

  chooseTemplate: async (_id, templateId) => {
    const { eventNo, key } = get()
    try {
      await get().flush()
      get()._apply(await publicApi.clientSetTemplate(eventNo, key, templateId))
      return true
    } catch (err) {
      toast('Could not use that template', whyPublic(err).message)
      return false
    }
  },

  setSection: (_id, sectionId, on) => {
    const { eventNo, key } = get()
    if (sectionId !== MUSIC && (!SECTIONS[sectionId] || SECTIONS[sectionId].required)) return false
    get()._patch((e) => ({ ...e, invite: { ...e.invite, on: { ...e.invite.on, [sectionId]: Boolean(on) } } }))
    get()._later(`section:${sectionId}`, () => publicApi.clientSetSection(eventNo, key, sectionId, Boolean(on)), 150)
    return true
  },

  updateContent: (_id, sectionId, value) => {
    const { eventNo, key, event } = get()
    if (!event || !(sectionId in event.invite.content)) return false
    const clean = cleanSection(value)
    get()._patch((e) => ({ ...e, invite: { ...e.invite, content: { ...e.invite.content, [sectionId]: clean } } }))
    get()._later(`content:${sectionId}`, () => publicApi.clientSetContent(eventNo, key, sectionId, clean))
    return true
  },

  setAccent: (_id, hex) => {
    const { eventNo, key } = get()
    if (hex !== null && !/^#[0-9a-f]{6}$/i.test(hex)) return false
    get()._patch((e) => ({ ...e, invite: { ...e.invite, accent: hex } }))
    get()._later('accent', () => publicApi.clientSetAccent(eventNo, key, hex))
    return true
  },

  /** Hand the draft to Oscenia for review. */
  submitForReview: async () => {
    const { eventNo, key } = get()
    try {
      await get().flush()
      get()._apply(await publicApi.clientSubmit(eventNo, key))
      return true
    } catch (err) {
      toast('Could not submit', whyPublic(err).message)
      return false
    }
  },

  // --- wishes and sending ----------------------------------------------------------------------

  setHoldWishes: async (_id, hold) => {
    const { eventNo, key } = get()
    get()._patch((e) => ({ ...e, holdWishes: Boolean(hold) }))
    try {
      await publicApi.clientHoldWishes(eventNo, key, Boolean(hold))
    } catch (err) {
      toast('Not saved', whyPublic(err).message)
      get().reload()
    }
  },

  setWishHidden: (_id, wishId, hidden) => get()._wish(wishId, hidden ? 'hide' : 'show'),
  approveWish: (_id, wishId) => get()._wish(wishId, 'approve'),
  _wish: async (wishId, action) => {
    const { eventNo, key } = get()
    try {
      const w = clientWish(await publicApi.clientWish(eventNo, key, wishId, action))
      get()._patch((e) => ({ ...e, wishes: e.wishes.map((x) => (x.id === w.id ? w : x)) }))
      return true
    } catch (err) {
      toast('Could not change that wish', whyPublic(err).message)
      return false
    }
  },

  /** The client sent this guest their invitation themselves. */
  markSentByClient: async (_id, guestId) => {
    const { eventNo, key } = get()
    try {
      const g = clientGuest(await publicApi.clientMarkSent(eventNo, key, guestId), eventNo)
      set((s) => ({ guests: s.guests.map((x) => (x.id === g.id ? g : x)) }))
      return true
    } catch (err) {
      toast('Not saved', whyPublic(err).message)
      return false
    }
  },
}))

// What a guest's browser needs from the server: the published invitation and, on a personal link,
// their own reply; RSVP and wishes; and the walk-in desk form. No sign-in: the personal link's token
// (or the desk link's) is the only credential, and it travels in a header.
//
// When the server cannot be reached at all (the static demo has no backend) `status` becomes
// 'offline' and the pages fall back to the demo store, exactly as before. A server that answers
// with 404 means "not available", never "try the demo".

import { create } from 'zustand'
import { publicApi, whyPublic } from '../lib/publicApi.js'
import { registerTemplates, templateById } from '../lib/templates.js'
import { publicEvent, publicGuest, walkInPage } from './publicAdapters.js'
import { wall } from './chatAdapters.js'

/** A studio template this browser has never seen: register it so the page draws the right design.
 *  A signed-in staff browser already has its own list, which is left alone. */
function learn(template) {
  if (template && !templateById(template.id)) registerTemplates([template])
}

const keyFor = (eventNo) => `oscenia.guest.${eventNo}`
/** The personal-link token this device remembers for an event (storage may be blocked). */
export function rememberedToken(eventNo) {
  try { return localStorage.getItem(keyFor(eventNo)) } catch { return null }
}
export function rememberToken(eventNo, token) {
  try {
    if (token) localStorage.setItem(keyFor(eventNo), token)
    else localStorage.removeItem(keyFor(eventNo))
  } catch { /* not remembered */ }
}

let seq = 0

export const usePublicInvite = create((set, get) => ({
  status: 'idle', // idle | loading | ready | missing | offline | error
  eventNo: null,
  token: null,
  event: null,
  linked: null, // the guest a personal link names
  me: null, // whoever this browser is replying as (the link's guest, or the reply just made)

  load: async (eventNo, token) => {
    const mine = ++seq
    set({ status: 'loading', eventNo, token: token || null, event: null, linked: null, me: null })
    try {
      const d = await publicApi.invite(eventNo, token)
      if (mine !== seq) return
      learn(d.template)
      const guest = publicGuest(d.guest, d.event.eventNo)
      set({ status: 'ready', event: publicEvent(d), linked: guest, me: guest })
    } catch (err) {
      if (mine !== seq) return
      if (err instanceof TypeError) set({ status: 'offline' })
      else if (err?.status === 404) set({ status: 'missing' })
      else set({ status: 'error' })
    }
  },

  /** The guest's reply. Resolves to `{ok, guest}` or `{ok:false, code, message, missing?}`. */
  submitRsvp: async (form) => {
    const { eventNo, token, me } = get()
    const body = {
      name: form.name, phone: form.phone, email: form.email || '', attending: form.attending,
      pax: form.attending ? form.pax : 0, allergies: form.allergies || '', consent: Boolean(form.consent),
      answers: form.answers || {}, website: form.website || '',
    }
    try {
      const out = await publicApi.rsvp(eventNo, body, token || me?.token)
      if (!out.guest) return { ok: true, guest: null } // a bot tripped the trap field: nothing stored
      const guest = publicGuest(out.guest, eventNo)
      rememberToken(eventNo, guest.token)
      set({ me: guest })
      return { ok: true, guest }
    } catch (err) {
      return { ok: false, ...whyPublic(err) }
    }
  },

  /** Stop the marketing consent (`marketing`) or erase this guest's data (`all`). `{ok}` or `{ok:false, message}`. */
  withdraw: async (scope) => {
    const { eventNo, token, me } = get()
    try {
      await publicApi.withdraw(eventNo, scope, token || me?.token)
      if (scope === 'all') {
        // Their link names nobody now: forget it here too.
        rememberToken(eventNo, null)
        set({ token: null, me: null, linked: null })
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, ...whyPublic(err) }
    }
  },

  /** A wish. Resolves to `{ok, state}` ('shown' | 'waiting') or `{ok:false, code, message}`. */
  addWish: async ({ name, text, website }) => {
    const { eventNo, token, me } = get()
    try {
      const out = await publicApi.wish(eventNo, { name: name || '', text, website: website || '' }, token || me?.token)
      if (out.state === 'shown' && out.wish) {
        set((s) => ({
          event: s.event && { ...s.event, wishes: [...s.event.wishes, { id: out.wish.id, guestId: null, name: out.wish.name, text: out.wish.text, at: wall(out.wish.at), hidden: false, approved: true }] },
        }))
      }
      return { ok: true, state: out.state || 'waiting' }
    } catch (err) {
      return { ok: false, ...whyPublic(err) }
    }
  },

  forget: () => {
    seq += 1
    set({ status: 'idle', eventNo: null, token: null, event: null, linked: null, me: null })
  },
}))

// ---------------------------------------------------------------------------------------------
// The walk-in desk
// ---------------------------------------------------------------------------------------------

export const usePublicWalkIn = create((set, get) => ({
  status: 'idle', // idle | loading | ready | missing | offline | error
  eventNo: null,
  desk: null,
  page: null,

  load: async (eventNo, desk) => {
    set({ status: 'loading', eventNo, desk: desk || null, page: null })
    try {
      const d = await publicApi.walkInPage(eventNo, desk)
      learn(d.template)
      set({ status: 'ready', page: walkInPage(d) })
    } catch (err) {
      if (err instanceof TypeError) set({ status: 'offline' })
      else if (err?.status === 404) set({ status: 'missing' })
      else set({ status: 'error' })
    }
  },

  /** Register at the desk. Resolves to `{ok, walkIn}` or `{ok:false, code, message}`. */
  register: async (form) => {
    const { eventNo, desk } = get()
    try {
      const out = await publicApi.walkIn(
        eventNo,
        { name: form.name, phone: form.phone, email: form.email || '', consent: Boolean(form.consent), website: form.website || '' },
        desk,
      )
      return { ok: true, walkIn: out.walkIn }
    } catch (err) {
      return { ok: false, ...whyPublic(err) }
    }
  },
}))

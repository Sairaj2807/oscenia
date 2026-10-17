// The bell's server-side items that are not chat: invitations waiting for review, RSVPs, client
// birthdays and anniversaries (`GET /notifications`).
//
// Kept apart from the chat store on purpose. Chat's list needs a workspace persona; the people
// who run events and the CRM often have none, and must still get their bell. So this loads for
// every signed-in (non-demo) login, whatever chat says about them.
//
// "Live" here is polling: once a minute, and when the tab comes back into view. The chat items
// arrive over the socket; these have no push yet, so a new RSVP shows up within a minute.
//
// What has been read is remembered by this browser (the server keeps none for these), per person.

import { create } from 'zustand'
import { api } from '../lib/api.js'
import { adaptNotification, nowWall } from './chatAdapters.js'
import { sortNotifications } from '../lib/notifications.js'

export const POLL_MS = 60_000
const key = (userId) => `oscenia.notif.read.${userId}`
const MAX_IDS = 300

export function readReadState(userId, storage = globalThis.localStorage) {
  try {
    const raw = JSON.parse(storage?.getItem(key(userId)) || 'null')
    if (raw) return { seenAt: raw.seenAt || '', ids: Array.isArray(raw.ids) ? raw.ids : [] }
  } catch {
    /* unreadable: start clean */
  }
  return { seenAt: '', ids: [] }
}

function saveReadState(userId, state, storage = globalThis.localStorage) {
  try {
    storage?.setItem(key(userId), JSON.stringify(state))
  } catch {
    /* storage full or blocked: read state lasts this tab */
  }
}

/** The list as the screens show it, newest first with things to act on at the top. */
export const adaptNotifications = (items) => sortNotifications((items || []).map(adaptNotification))

let timer = null
let onVisible = null

export const useNotifications = create((set, get) => ({
  userId: null,
  items: [],
  read: { seenAt: '', ids: [] },

  /** Begin for this person: load now, then keep loading. Safe to call again. */
  start: (userId) => {
    get().stop()
    set({ userId, items: [], read: readReadState(userId) })
    get().load()
    timer = setInterval(() => get().load(), POLL_MS)
    if (typeof document !== 'undefined') {
      onVisible = () => document.visibilityState === 'visible' && get().load()
      document.addEventListener('visibilitychange', onVisible)
    }
  },

  stop: () => {
    if (timer) clearInterval(timer)
    timer = null
    if (onVisible && typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
    onVisible = null
    set({ userId: null, items: [] })
  },

  load: async () => {
    const who = get().userId
    if (!who) return
    try {
      const items = adaptNotifications(await api.get('/notifications'))
      if (get().userId === who) set({ items }) // not if they signed out while it was loading
    } catch {
      /* keep what we have; the next poll tries again */
    }
  },

  markRead: (id) => {
    const { userId, read } = get()
    if (!userId || read.ids.includes(id)) return
    const next = { ...read, ids: [...read.ids, id].slice(-MAX_IDS) }
    saveReadState(userId, next)
    set({ read: next })
  },

  markAllRead: () => {
    const { userId } = get()
    if (!userId) return
    const next = { seenAt: nowWall(), ids: [] }
    saveReadState(userId, next)
    set({ read: next })
  },
}))

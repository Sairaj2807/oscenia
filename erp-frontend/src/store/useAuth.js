// Who is signed in.
//
// Kept out of `useStore` on purpose. The main store is business data that gets wiped and
// re-hydrated; identity outlives that and is what decides whether any of it can be fetched
// at all. Mixing the two means a re-hydrate can sign you out.
//
// ---------------------------------------------------------------------------
// What changed from the prototype
// ---------------------------------------------------------------------------
// `role` was a store field with a setter, so the role switcher was theatre: it changed which
// buttons rendered and nothing else. A Project Manager could not approve a PO because the UI
// hid the button, not because anything refused.
//
// Now `role` is whatever `/auth/me` says, and `actions` is the server's resolved permission
// list rather than the client's copy of the matrix. The UI still hides what you cannot do —
// that is courtesy, not security — and the server refuses it regardless.

import { create } from 'zustand'
import { login as apiLogin, logout as apiLogout, logoutEverywhere, me as apiMe, tokens } from '../lib/api.js'
import { ROLES, ROLE_ACTIONS, ACTIONS } from '../lib/roles.js'
import { usersApi } from '../lib/usersApi.js'
import { useStore } from './useStore.js'

/** The person's own language wins over this browser's, once we know who they are. */
const applyLanguage = (user) => {
  if (user?.language && !user.offline) useStore.getState().setLang(user.language)
}

// The demo accounts, one per role. Used by the Topbar switcher, which now signs in as the
// role rather than pretending to be it.
export const DEMO_USERS = {
  ceo: 'rahmat@oscenia.co.id',
  finance: 'lina@oscenia.co.id',
  pm: 'agus@oscenia.co.id',
  sales: 'dinda@oscenia.co.id',
  warehouse: 'bagus@oscenia.co.id',
  team: 'rina@oscenia.co.id',
}

export const DEMO_PASSWORD = 'oscenia-demo-2026'

// Demo mode is a development and test convenience, never part of a deployed build.
//
// It is on under `vite dev`, `vite-node` and plain Node (the verify suites run against seed
// data and need it), and OFF in every production build (`import.meta.env.PROD`). A production
// bundle therefore has no offline sign-in, no demo accounts and no role switcher: the only way
// in is a real account on the server. `VITE_DEMO_MODE=on` opts a deliberate demo build back in.
export const DEMO_MODE =
  import.meta.env?.VITE_DEMO_MODE === 'on' || !import.meta.env?.PROD

// ---------------------------------------------------------------------------
// Offline demo mode
// ---------------------------------------------------------------------------
// The backend is not deployed, so on the hosted link every sign-in fails before it reaches a
// server. When — and only when — the API cannot be reached at all, a demo account signs in
// locally with the client's copy of the permission matrix. A server that answers "wrong
// password" is an ApiError and is still a refusal; only a request that never got an answer
// (fetch throws a TypeError) falls through to here.
//
// Kept in sessionStorage so a refresh stays signed in, and a new tab starts at the door.

const OFFLINE_KEY = 'oscenia.offlineUser'

// `fetch` rejects with a TypeError when no response arrived at all (refused connection, DNS,
// blocked mixed content). An ApiError means a server answered, and a SyntaxError or anything
// else is not "offline" either — none of those may be quietly turned into a demo session.
const unreachable = (err) => err instanceof TypeError

function offlineUser(email) {
  const role = Object.keys(DEMO_USERS).find((r) => DEMO_USERS[r] === email.trim().toLowerCase())
  if (!role) return null
  const allowed = ROLE_ACTIONS[role]
  return {
    id: `offline-${role}`,
    email: DEMO_USERS[role],
    role,
    name: ROLES[role].name,
    actions: allowed === 'all' ? Object.keys(ACTIONS) : allowed,
    offline: true,
  }
}

function saveOffline(user) {
  if (!DEMO_MODE) return
  try {
    if (user) sessionStorage.setItem(OFFLINE_KEY, JSON.stringify(user))
    else sessionStorage.removeItem(OFFLINE_KEY)
  } catch {
    // Storage can be unavailable (private mode, server render). Losing the session on refresh
    // is the only cost.
  }
}

function readOffline() {
  // A stale offline session left in sessionStorage must never sign anyone in on a real build.
  if (!DEMO_MODE) return null
  try {
    const raw = sessionStorage.getItem(OFFLINE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

// An offline session needs no server check, so it is live from the first render — no
// "Checking your session…" flash on refresh in demo mode.
const resumed = readOffline()

export const useAuth = create((set, get) => ({
  user: resumed,
  //: 'unknown' until the stored token has been checked — distinct from 'signed out', because
  //: rendering a login screen to somebody who is already signed in is its own kind of wrong.
  status: resumed ? 'authenticated' : 'unknown',
  error: null,

  /** Resume a session from a stored token, if there is one and it still works. */
  restore: async () => {
    const offline = readOffline()
    if (offline) {
      set({ status: 'authenticated', user: offline, error: null })
      return offline
    }
    if (!tokens.access && !tokens.refresh) {
      set({ status: 'anonymous', user: null })
      return null
    }
    try {
      const user = await apiMe()
      applyLanguage(user)
      set({ status: 'authenticated', user, error: null })
      return user
    } catch {
      // An expired or revoked token is not an error worth showing anyone — it is just being
      // signed out. `me()` has already tried a refresh and failed.
      tokens.clear()
      set({ status: 'anonymous', user: null })
      return null
    }
  },

  signIn: async (email, password) => {
    set({ error: null })
    try {
      await apiLogin(email, password)
      const user = await apiMe()
      applyLanguage(user)
      set({ status: 'authenticated', user })
      return user
    } catch (err) {
      if (!DEMO_MODE && unreachable(err)) {
        // No server, no session: a real build never falls back to a local account.
        const down = new Error('Cannot reach the server. Check your connection and try again.')
        set({ error: down, status: 'anonymous', user: null })
        throw down
      }
      if (unreachable(err)) {
        const user = offlineUser(email)
        // Stray spaces (a copy-paste, an autofill) should not lock anyone out of the demo.
        if (user && password.trim() === DEMO_PASSWORD) {
          saveOffline(user)
          set({ status: 'authenticated', user, error: null })
          return user
        }
        const offline = new Error(
          user
            ? `Wrong password for this demo account. Click the account below to fill it in (the demo password is ${DEMO_PASSWORD}).`
            : 'The server cannot be reached. In demo mode, sign in with one of the demo accounts below.'
        )
        set({ error: offline, status: 'anonymous', user: null })
        throw offline
      }
      set({ error: err, status: 'anonymous', user: null })
      throw err
    }
  },

  signOut: async () => {
    saveOffline(null)
    await apiLogout()
    set({ status: 'anonymous', user: null, error: null })
  },

  /** Replace your own password. Other devices are signed out; this one gets a fresh token pair. */
  changePassword: async (current, next) => {
    const pair = await usersApi.changePassword(current, next)
    tokens.set({ accessToken: pair.accessToken, refreshToken: pair.refreshToken })
    const user = await apiMe()
    set({ user })
    return user
  },

  /** Keep the chosen language for this person (best effort: the choice already works without it). */
  saveLanguage: async (lang) => {
    if (!get().user || get().user.offline) return
    try { await usersApi.setLanguage(lang) } catch { /* remembered in this browser either way */ }
  },

  /** Revoke every session this person has, on every device, then sign out here. Throws (and stays
   *  signed in, so it can be tried again) if the server could not be told. */
  signOutEverywhere: async () => {
    await logoutEverywhere()
    saveOffline(null)
    set({ status: 'anonymous', user: null, error: null })
  },

  /** Switch demo role by actually signing in as that person. */
  switchRole: async (role) => {
    const email = DEMO_MODE ? DEMO_USERS[role] : null
    if (!email) return null
    if (get().user?.offline) {
      const user = offlineUser(email)
      saveOffline(user)
      set({ status: 'authenticated', user, error: null })
      return user
    }
    await apiLogout()
    return get().signIn(email, DEMO_PASSWORD)
  },

  /** Whether the signed-in user may do something, per the server's own answer. */
  can: (action) => Boolean(get().user?.actions?.includes(action)),
}))

export const selectRole = (s) => s.user?.role ?? 'ceo'

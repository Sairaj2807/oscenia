// Used only by the render check (scripts/smoke.config.js aliases `zustand` here).
//
// zustand's React hook hands a server render the store's *initial* state, so a render check
// that mutates the store and renders again would only ever see seed data — its "after every
// action" and "in Bahasa" passes tested nothing. This `create` reads the live state for the
// server snapshot too. The app itself uses real zustand; nothing here ships.
import { useSyncExternalStore } from 'react'
import { createStore } from 'zustand/vanilla'

export function create(initializer) {
  const api = createStore(initializer)
  const useBoundStore = (selector = (s) => s) =>
    useSyncExternalStore(api.subscribe, () => selector(api.getState()), () => selector(api.getState()))
  Object.assign(useBoundStore, api)
  return useBoundStore
}

// One report from the server, kept fresh (W4).
//
//   const cash = useReport('/reports/cash-position', { asOf }, adaptCashPosition)
//   // → { data, loading, error, reload }
//
// A page uses this when signed in and keeps computing from `lib/ledger.js` otherwise (the demo), so the
// two sources sit side by side and agree (`npm run verify:reports` proves they do on realistic books).
//
// What it does, and why:
// * Fetches on mount and whenever the parameters change.
// * Fetches again when the journal is re-read. Every write that moves money refreshes the journal
//   (`mutate` → `loadSome(['journal', …])`), so "the journal object changed" is exactly "the ledger may
//   have moved". Not a timer, and not on every render.
// * Throws away an answer that arrives after a newer request was made (a quick period change must not
//   be overwritten by the slower earlier answer).
// * Keeps the last good answer on screen while the next one loads, so a figure does not blank out and
//   jump on every posting.
// * `enabled: false` (the demo, or a screen that is not showing) makes no request.

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { useStore } from './useStore.js'

/** A stable key for a request, so equal parameters (in any key order) are the same request. */
export function reportKey(path, params = {}) {
  const parts = Object.keys(params || {})
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort()
    .map((k) => `${k}=${Array.isArray(params[k]) ? params[k].join(',') : params[k]}`)
  return `${path}?${parts.join('&')}`
}

export function useReport(path, params, adapt = (x) => x, { enabled = true } = {}) {
  const journal = useStore((s) => s.journal)
  const [state, setState] = useState({ data: null, loading: enabled, error: null })
  const latest = useRef(0)
  const key = reportKey(path, params)

  // `params` is an object literal at the call site, so it is the key (not the object) that says
  // whether the request changed.
  const paramsRef = useRef(params)
  paramsRef.current = params
  const adaptRef = useRef(adapt)
  adaptRef.current = adapt

  const load = useCallback(async () => {
    const ticket = (latest.current += 1)
    setState((s) => ({ ...s, loading: true }))
    try {
      const raw = await api.get(path, paramsRef.current)
      if (ticket !== latest.current) return // a newer request has been made since
      setState({ data: adaptRef.current(raw), loading: false, error: null })
    } catch (err) {
      if (ticket !== latest.current) return
      setState((s) => ({ ...s, loading: false, error: err }))
    }
  }, [path, key])

  useEffect(() => {
    if (!enabled) return undefined
    load()
    return () => { latest.current += 1 } // leaving: nothing it was waiting for should land
  }, [enabled, load, journal])

  return { ...state, reload: load }
}

/**
 * Development only: the page holds both the server's figure and the browser's, and they must agree.
 * When they differ by more than `tolerance` (Rp 1: both sides are exact to the cent) it says so once
 * per pair in the console and records it on `window.__reportDiffs`, so a drift between the two cannot
 * go unnoticed. Does nothing in a production build, and nothing until both figures are there.
 */
const reported = new Set()
export function useCrossCheck(label, server, client, tolerance = 1) {
  useEffect(() => {
    if (!import.meta.env?.DEV) return
    if (server == null || client == null) return
    const s = Number(server)
    const c = Number(client)
    if (!Number.isFinite(s) || !Number.isFinite(c) || Math.abs(s - c) <= tolerance) return
    const id = `${label}|${s}|${c}`
    if (reported.has(id)) return
    reported.add(id)
    console.warn(`[report cross-check] ${label}: server ${s}, browser ${c} (the browser is ${c - s > 0 ? '+' : ''}${(c - s).toFixed(2)})`)
    if (typeof window !== 'undefined') window.__reportDiffs = [...(window.__reportDiffs || []), { label, server: s, client: c }]
  }, [label, server, client, tolerance])
}

// The WebSocket to the chat server: connect, authenticate, stay connected, hand frames up.
//
// It only *delivers*. Every change is made over REST (lib/chatApi.js) and announced here
// afterwards; this module sends nothing but `auth`, `reauth`, `ping`, `typing` and `presence`.
//
// What it is careful about:
//
//  * **Auth is the first frame**, not the URL: a token in a query string ends up in logs. The
//    server answers `hello`; until then the socket is "connecting".
//  * **A lost connection is normal.** It reconnects with exponential backoff and jitter, and
//    tells its owner each time it is open again (`onOpen`) so the store can catch up from the
//    server rather than trust what it missed.
//  * **The close code says what to do.** 4401 (credentials) → refresh the session and retry,
//    but not forever; 4403 (not allowed) → stop; 1013 (this server is not the chat hub) and
//    4429 (too many connections) → wait longer; anything else → ordinary backoff.
//  * **A silent connection is dead.** It pings every 25 s and closes one that has said nothing
//    for 60, because a half-open TCP connection looks fine to the browser for minutes.
//  * **The token is renewed in place** (`reauth`) before the 30-minute access token runs out,
//    so a long-open tab is not cut off.
//
// Dependencies are injectable (`WebSocketImpl`) so the same code runs under Node in tests.

import { toCamel } from './api.js'

const HEARTBEAT_MS = 25_000
const SILENCE_MS = 60_000
const WATCHDOG_MS = 5_000
const REAUTH_MS = 15 * 60_000
const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 30_000
const SLOW_RETRY_MS = 15_000
const MAX_AUTH_RETRIES = 3

export const CLOSE = { BAD_AUTH: 4401, FORBIDDEN: 4403, SLOW: 4408, IDLE: 4410, TOO_MANY: 4429, NOT_LEADER: 1013 }

/**
 * @param {object} o
 * @param {() => string} o.url            the ws:// address
 * @param {() => string|null} o.getToken  the current access token
 * @param {() => Promise<unknown>} o.refreshSession  make the access token fresh (or throw)
 * @param {(frame: object) => void} o.onFrame        every frame after `hello`, camelCased
 * @param {(state: string, info?: object) => void} o.onState  connecting | open | reconnecting | closed | forbidden
 * @param {(hello: object) => void} [o.onOpen]       the server said `hello`
 */
export function createChatSocket({ url, getToken, refreshSession, onFrame, onState, onOpen, WebSocketImpl }) {
  const WS = WebSocketImpl || globalThis.WebSocket
  let ws = null
  let stopped = true
  let attempt = 0
  let authFailures = 0
  let lastSeen = 0
  let timers = []
  let retryTimer = null
  let generation = 0 // a stale socket's late events must not act on a newer one

  const clearTimers = () => {
    timers.forEach(clearInterval)
    timers = []
  }

  const raw = (frame) => {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(frame))
  }

  const schedule = (delay) => {
    clearTimeout(retryTimer)
    retryTimer = setTimeout(open, delay)
  }

  const backoff = () => {
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt)
    attempt += 1
    return base / 2 + Math.random() * (base / 2) // jitter: not everyone reconnects at once
  }

  function startKeepAlive(mine) {
    lastSeen = Date.now()
    timers.push(setInterval(() => raw({ op: 'ping' }), HEARTBEAT_MS))
    timers.push(
      setInterval(() => {
        if (mine !== generation) return
        if (Date.now() - lastSeen > SILENCE_MS) ws?.close() // dead: let onclose reconnect
      }, WATCHDOG_MS)
    )
    timers.push(
      setInterval(async () => {
        try {
          await refreshSession()
          const token = getToken()
          if (token && mine === generation) raw({ op: 'reauth', token })
        } catch {
          /* the next request will notice the session is gone */
        }
      }, REAUTH_MS)
    )
  }

  async function open() {
    if (stopped) return
    const mine = ++generation
    // Abandon whatever came before: an old socket left open would stay authenticated, keep
    // using one of the person's few connection slots, and deliver events nobody listens to.
    clearTimers()
    const previous = ws
    ws = null
    try { previous?.close() } catch { /* already gone */ }
    onState(attempt === 0 ? 'connecting' : 'reconnecting')
    try {
      await refreshSession() // a fresh access token, or an exception if signed out
    } catch {
      if (!stopped) schedule(backoff())
      return
    }
    if (stopped || mine !== generation) return
    const token = getToken()
    if (!token) {
      stopped = true
      onState('closed')
      return
    }

    const socket = new WS(url())
    ws = socket
    socket.onopen = () => socket.send(JSON.stringify({ op: 'auth', token }))
    socket.onmessage = (event) => {
      if (mine !== generation) return
      lastSeen = Date.now()
      let frame
      try {
        frame = toCamel(JSON.parse(event.data))
      } catch {
        return // not JSON: ignore rather than crash the connection
      }
      if (frame.type === 'hello') {
        attempt = 0
        authFailures = 0
        startKeepAlive(mine)
        onState('open', frame)
        onOpen?.(frame)
      } else if (frame.type !== 'pong' && frame.type !== 'reauthed') {
        onFrame(frame)
      }
    }
    socket.onerror = () => {} // the close event that follows carries what matters
    socket.onclose = (event) => {
      if (mine !== generation) return
      clearTimers()
      if (stopped) return
      const code = event.code
      if (code === CLOSE.FORBIDDEN) {
        stopped = true
        onState('forbidden')
        return
      }
      onState('reconnecting', { code })
      if (code === CLOSE.BAD_AUTH) {
        authFailures += 1
        if (authFailures > MAX_AUTH_RETRIES) {
          stopped = true
          onState('closed', { code })
          return
        }
        schedule(500) // refreshSession() at the top of open() renews the token
      } else if (code === CLOSE.NOT_LEADER || code === CLOSE.TOO_MANY) {
        schedule(SLOW_RETRY_MS)
      } else {
        schedule(backoff())
      }
    }
  }

  return {
    start() {
      if (!stopped) return
      stopped = false
      attempt = 0
      authFailures = 0
      open()
    },
    stop() {
      stopped = true
      generation += 1
      clearTimers()
      clearTimeout(retryTimer)
      try { ws?.close(1000) } catch { /* already gone */ }
      ws = null
      onState('closed')
    },
    /** Reconnect now (for example when the tab comes back to the foreground). */
    nudge() {
      // Already open, or opening: another attempt would only race it.
      if (stopped || (ws && (ws.readyState === 0 || ws.readyState === 1))) return
      attempt = 0
      schedule(0)
    },
    typing: (channelId) => raw({ op: 'typing', channel_id: channelId }),
    activity: (state) => raw({ op: 'presence', state }),
    get isOpen() {
      return Boolean(ws && ws.readyState === 1)
    },
  }
}

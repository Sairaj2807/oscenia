// What each thing the server tells us (or we do) does to the chat state — as pure functions.
//
// Kept out of the store so they run under Node (`scripts/verify-chat-adapters.mjs`) and so the
// rules are in one readable place:
//
//  * Applying an event twice, or late, changes nothing: a message is replaced only by a copy
//    with a higher `rev`. The server numbers every change to a channel (`rev`), so a stale or
//    repeated frame is recognisable on sight.
//  * A gap in those numbers means we missed something. The reducer says so (`needsSync`)
//    rather than guessing; the store then asks `/chat/sync`.
//  * Unread counts follow the server's definition: other people's messages beyond what you
//    have read. A channel you have open does not count up — reading it is already under way.
//
// Each `apply…` takes the current state and an event and returns `{ patch, needsSync }`, or
// `null` when there is nothing to do.

import {
  adaptChannel,
  adaptJoinRequest,
  adaptMessage,
  adaptNotification,
  bySeq,
} from './chatAdapters.js'

export const TYPING_MS = 5000

const channelOf = (state, id) => state.channels.find((c) => c.id === id)

/** All messages, grouped by channel and in conversation order within each. */
export function sortMessages(list) {
  return [...list].sort((a, b) => (a.channelId < b.channelId ? -1 : a.channelId > b.channelId ? 1 : bySeq(a, b)))
}

/**
 * Put `msg` in `messages`. A copy still being sent (`pending`, same `clientMsgId`) is what the
 * server's version replaces. Returns the new list, or the same one if `msg` is not newer.
 */
export function upsertMessage(messages, msg) {
  const known =
    messages.find((m) => m.id === msg.id) ||
    (msg.clientMsgId ? messages.find((m) => m.pending && m.clientMsgId === msg.clientMsgId) : null)
  if (known && !known.pending && !known.failed && (known.rev ?? -1) >= (msg.rev ?? -1)) return messages
  const without = known ? messages.filter((m) => m !== known) : messages
  return sortMessages([...without, msg])
}

/** Merge a page of messages (history, or the newest page) into `messages`. */
export function mergeMessages(messages, incoming) {
  let out = messages
  for (const m of incoming) out = upsertMessage(out, m)
  return out
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** `message.new`, `message.updated`, `message.deleted`, `reaction.updated`. */
export function applyMessageEvent(state, ev) {
  const channel = channelOf(state, ev.channelId)
  if (!channel) return null
  const msg = adaptMessage(ev.message, state.ctx)
  const known = state.messages.find((m) => m.id === msg.id)
  if (known && !known.pending && (known.rev ?? -1) >= msg.rev) return null // already have it

  const loaded = Boolean(state.loaded[ev.channelId])
  const patch = {}
  if (loaded || known) patch.messages = upsertMessage(state.messages, msg)

  const mine = msg.authorId === state.meNo
  const isOpen = state.openChannelId === ev.channelId
  let { unread, unreadMentions } = channel
  if (ev.type === 'message.new' && !mine && !isOpen) {
    unread += 1
    if (msg.mentions.includes(state.meUuid)) unreadMentions += 1
  }
  if (ev.type === 'message.deleted' && known && !known.deleted && !mine && !isOpen && known.seq > channel.lastReadSeq) {
    unread = Math.max(0, unread - 1)
    if (known.mentions?.includes(state.meUuid)) unreadMentions = Math.max(0, unreadMentions - 1)
  }
  const gap = loaded && ev.rev > channel.rev + 1
  patch.channels = state.channels.map((c) =>
    c.id === ev.channelId ? { ...c, rev: Math.max(c.rev, ev.rev), unread, unreadMentions } : c
  )
  return { patch, needsSync: gap ? [ev.channelId] : [] }
}

/** `read.updated`: another tab or device of ours read a channel. */
export function applyReadEvent(state, ev) {
  const channel = channelOf(state, ev.channelId)
  if (!channel) return null
  const caughtUp = ev.lastReadSeq >= channel.rev
  return {
    patch: {
      channels: state.channels.map((c) =>
        c.id === ev.channelId
          ? { ...c, lastReadSeq: Math.max(c.lastReadSeq, ev.lastReadSeq), ...(caughtUp ? { unread: 0, unreadMentions: 0 } : {}) }
          : c
      ),
    },
    needsSync: [],
  }
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/** `channel.created` / `channel.updated`: this channel, as this person may see it. */
export function applyChannelEvent(state, ev) {
  const next = adaptChannel(ev.channel, state.ctx)
  const existing = channelOf(state, next.id)
  const merged = existing
    ? {
        ...next,
        // A manager's list of requests came from a separate call; the event does not carry it.
        requests: next.canManage && existing.requests.length ? existing.requests : next.requests,
        // Counters from the event are the server's current word, but never step backwards past
        // what this device has already marked read.
        lastReadSeq: Math.max(existing.lastReadSeq, next.lastReadSeq),
      }
    : next
  const channels = existing
    ? state.channels.map((c) => (c.id === next.id ? merged : c))
    : [...state.channels, merged]
  return { patch: { channels }, needsSync: [] }
}

/** `channel.removed`: it is no longer visible to us at all. */
export function applyChannelRemoved(state, ev) {
  if (!channelOf(state, ev.channelId)) return null
  const { [ev.channelId]: _gone, ...loaded } = state.loaded
  return {
    patch: {
      channels: state.channels.filter((c) => c.id !== ev.channelId),
      messages: state.messages.filter((m) => m.channelId !== ev.channelId),
      loaded,
    },
    needsSync: [],
  }
}

/** `join_request.created` / `join_request.decided`: keep a manager's list of requests current. */
export function applyJoinRequestEvent(state, ev) {
  const req = adaptJoinRequest(ev.request, state.ctx)
  const channelId = ev.request.channelId
  const channel = channelOf(state, channelId)
  if (!channel) return null
  const mine = req.memberId === state.meNo
  const others = channel.requests.filter((r) => r.id !== req.id && !(mine && r.memberId === state.meNo))
  const requests = mine || channel.canManage ? [...others, req] : channel.requests
  return {
    patch: { channels: state.channels.map((c) => (c.id === channelId ? { ...c, requests } : c)) },
    needsSync: [],
  }
}

// ---------------------------------------------------------------------------
// Presence, typing, notifications
// ---------------------------------------------------------------------------

export function applyPresenceEvent(state, ev) {
  const no = state.ctx.noOf(ev.userId)
  const presence = { ...state.presence }
  if (ev.status === 'offline') delete presence[no]
  else presence[no] = ev.status
  return { patch: { presence }, needsSync: [] }
}

/** `typing`: they are typing now; the entry expires on its own (see `pruneTyping`). */
export function applyTypingEvent(state, ev, now = Date.now()) {
  const no = state.ctx.noOf(ev.userId)
  if (no === state.meNo) return null
  const inChannel = { ...(state.typing[ev.channelId] || {}), [no]: now + TYPING_MS }
  return { patch: { typing: { ...state.typing, [ev.channelId]: inChannel } }, needsSync: [] }
}

/** Drop typing entries that have expired. Returns `null` if nothing changed. */
export function pruneTyping(typing, now = Date.now()) {
  let changed = false
  const out = {}
  for (const [channelId, people] of Object.entries(typing)) {
    const live = Object.fromEntries(Object.entries(people).filter(([, until]) => until > now))
    if (Object.keys(live).length !== Object.keys(people).length) changed = true
    if (Object.keys(live).length) out[channelId] = live
  }
  return changed ? out : null
}

export function applyNotificationEvent(state, ev) {
  const item = adaptNotification(ev.notification)
  if (state.notifications.some((n) => n.id === item.id)) return null
  return { patch: { notifications: [item, ...state.notifications] }, needsSync: [] }
}

/** Route one server frame to its reducer. Unknown frames are ignored, on purpose: a newer
 *  server may say more than this client knows. */
export function reduceEvent(state, ev, now = Date.now()) {
  switch (ev.type) {
    case 'message.new':
    case 'message.updated':
    case 'message.deleted':
    case 'reaction.updated':
      return applyMessageEvent(state, { ...ev, channelId: ev.channelId })
    case 'read.updated':
      return applyReadEvent(state, ev)
    case 'channel.created':
    case 'channel.updated':
      return applyChannelEvent(state, ev)
    case 'channel.removed':
      return applyChannelRemoved(state, ev)
    case 'join_request.created':
    case 'join_request.decided':
      return applyJoinRequestEvent(state, ev)
    case 'presence':
      return applyPresenceEvent(state, ev)
    case 'typing':
      return applyTypingEvent(state, ev, now)
    case 'notification.new':
      return applyNotificationEvent(state, ev)
    default:
      return null
  }
}

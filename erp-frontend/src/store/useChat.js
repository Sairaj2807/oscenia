// Team chat, live: the state the chat screens read when a real person is signed in.
//
// Deliberately *not* persisted and *not* part of `useProto`. `useProto` is the prototype's
// browser-only demo store and is saved to localStorage; live chat data belongs to the server,
// and putting it in that store would leave one person's messages in the browser for the next.
// The screens still read it through `store/chatProto.js`, which gives them the same names
// (`channels`, `messages`, `members`, `postMessage` …) from whichever source is in use.
//
// What this store does:
//
//  * **Loads** the workspace (`GET /chat/bootstrap`) once, then each channel's newest messages
//    when it is opened, and older ones on request. Unread counts come from the server; a
//    channel's messages are not all in memory, so they cannot be counted here.
//  * **Changes things over REST**, optimistically where it matters (a sent message appears at
//    once, marked pending, and is replaced by the server's copy), and says so when it fails.
//  * **Listens** on the WebSocket and applies each event with the pure reducers in
//    `chatEvents.js`; after any reconnect it asks the server what it missed instead of trusting
//    that nothing was lost.
//
// Nothing here is a business rule. Who may do what is decided by the server; this state exists
// to show the answer, and the optimistic updates are always replaced by it.

import { create } from 'zustand'
import { chatApi } from '../lib/chatApi.js'
import { apiBase, me as fetchMe, tokens } from '../lib/api.js'
import { createChatSocket } from '../lib/chatSocket.js'
import { useStore } from './useStore.js'
import { toTokens } from '../lib/chat.js'
import {
  adaptAttachment,
  adaptBootstrap,
  adaptChannel,
  adaptJoinRequest,
  adaptMessage,
  adaptNotification,
  adaptPresence,
  nowWall,
  adaptMeeting,
  upsertMeeting,
} from './chatAdapters.js'
import { mergeMessages, pruneTyping, reduceEvent, sortMessages, upsertMessage } from './chatEvents.js'
import { emitFrame, taskIds } from './chatFrames.js'

const PAGE = 50
const READ_DEBOUNCE_MS = 300
const TYPING_SEND_GAP_MS = 2000
const IDLE_AFTER_MS = 5 * 60_000

const readTimers = new Map()
const typingSent = new Map()
let socket = null
let detachActivity = () => {}
let pruneTimer = null

// --- small helpers ------------------------------------------------------------------------

const toast = (title, body) => {
  try {
    useStore.getState().pushToast({ title, body })
  } catch {
    /* no toast host */
  }
}

const reason = (err) => {
  if (err?.status === 429) return `You are going too fast. Try again in ${err.retryAfter || 'a few'} seconds.`
  return err?.message || 'Something went wrong.'
}

const newId = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`)

const notifKey = (uuid) => `oscenia.chat.notifRead.${uuid}`
function readNotifState(uuid) {
  try {
    const raw = JSON.parse(localStorage.getItem(notifKey(uuid)) || 'null')
    if (raw) return { userKey: uuid, seenAt: raw.seenAt || '', ids: raw.ids || [] }
  } catch {
    /* unreadable: start clean */
  }
  return { userKey: uuid, seenAt: '', ids: [] }
}
function saveNotifState(state) {
  try {
    localStorage.setItem(notifKey(state.userKey), JSON.stringify({ seenAt: state.seenAt, ids: state.ids }))
  } catch {
    /* private mode: it just resets on reload */
  }
}

/** Fresh channels from the server, keeping what only an earlier call knew (a manager's list of
 *  join requests). */
function mergeChannels(old, fresh) {
  return fresh.map((c) => {
    const before = old.find((o) => o.id === c.id)
    return before && c.canManage && before.requests.length ? { ...c, requests: before.requests } : c
  })
}

const INITIAL = {
  status: 'idle', // idle | loading | ready | forbidden | error
  error: null,
  connection: 'closed', // closed | connecting | open | reconnecting | forbidden
  ctx: null,
  meNo: null,
  meUuid: null,
  personaId: null,
  myStatus: 'online',
  members: [],
  projectDivisions: {},
  chatProjects: [],
  channels: [],
  messages: [],
  lastRead: {},
  presence: {},
  loaded: {}, // channelId -> { loading, hasMoreBefore, error? }
  openChannelId: null,
  typing: {},
  notifications: [],
  notifRead: { userKey: null, seenAt: '', ids: [] },
  meetings: [], // finished calls, oldest first (briefs; `detail` says whether read in full)
  meetingState: {}, // id -> loading | ready | missing
  serverOffsetMs: 0,
}

export const useChat = create((set, get) => ({
  ...INITIAL,

  /** The current moment in the screens' time format, corrected for the server's clock. */
  now: () => nowWall(get().serverOffsetMs),

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  start: async () => {
    const { status } = get()
    if (status === 'loading' || status === 'ready') return
    set({ status: 'loading', error: null })
    await get().load()
    if (get().status === 'ready') get().connect()
  },

  stop: () => {
    socket?.stop()
    socket = null
    detachActivity()
    detachActivity = () => {}
    clearInterval(pruneTimer)
    pruneTimer = null
    readTimers.forEach(clearTimeout)
    readTimers.clear()
    set({ ...INITIAL })
  },

  /** The workspace: people, projects, the channels you can open and the ones you see locked. */
  load: async () => {
    try {
      const a = adaptBootstrap(await chatApi.bootstrap())
      set((s) => {
        const channels = mergeChannels(s.channels, a.channels)
        const ids = new Set(channels.map((c) => c.id))
        return {
          status: 'ready',
          error: null,
          ctx: a.ctx,
          meNo: a.meNo,
          meUuid: a.meUuid,
          personaId: a.meNo,
          myStatus: a.myStatus,
          members: a.members,
          projectDivisions: a.projectDivisions,
          chatProjects: a.chatProjects,
          channels,
          messages: s.messages.filter((m) => ids.has(m.channelId)),
          presence: a.presence,
          notifRead: s.notifRead.userKey === a.meUuid ? s.notifRead : readNotifState(a.meUuid),
        }
      })
      get().loadNotifications()
    } catch (err) {
      if (err?.status === 403) set({ status: 'forbidden', error: err })
      else set((s) => ({ status: s.status === 'ready' ? 'ready' : 'error', error: err }))
    }
  },

  /** After a reconnect: refresh the workspace, then replay what changed in each channel we
   *  hold, from the newest change we had seen there. */
  resync: async () => {
    const s = get()
    const cursors = {}
    for (const channelId of Object.keys(s.loaded)) {
      const revs = s.messages.filter((m) => m.channelId === channelId && !m.pending && m.rev != null).map((m) => m.rev)
      cursors[channelId] = revs.length ? Math.max(...revs) : 0
    }
    await get().load()
    if (!Object.keys(cursors).length) return
    try {
      const res = await chatApi.sync(cursors)
      for (const ch of res.channels) {
        if (ch.reset) await get().reloadChannel(ch.channelId)
        else set((st) => ({ messages: mergeMessages(st.messages, ch.messages.map((m) => adaptMessage(m, st.ctx))) }))
      }
    } catch {
      /* the next event or reconnect will catch up */
    }
  },

  syncChannel: async (channelId) => {
    const revs = get().messages.filter((m) => m.channelId === channelId && !m.pending && m.rev != null).map((m) => m.rev)
    try {
      const res = await chatApi.sync({ [channelId]: revs.length ? Math.max(...revs) : 0 })
      for (const ch of res.channels) {
        if (ch.reset) await get().reloadChannel(ch.channelId)
        else set((st) => ({ messages: mergeMessages(st.messages, ch.messages.map((m) => adaptMessage(m, st.ctx))) }))
      }
    } catch {
      /* ignore */
    }
  },

  // ===========================================================================
  // The WebSocket
  // ===========================================================================

  connect: () => {
    if (socket) return
    socket = createChatSocket({
      url: () => `${apiBase.replace(/^http/, 'ws')}/chat/ws`,
      getToken: () => tokens.access,
      refreshSession: () => fetchMe(),
      onState: (state, info) => {
        set({ connection: state })
        if (state === 'open' && info?.serverTime) set({ serverOffsetMs: Date.parse(info.serverTime) - Date.now() })
        if (state === 'forbidden') set({ status: 'forbidden' })
      },
      onOpen: (hello) => {
        const { ctx, myStatus } = get()
        if (ctx) set({ presence: adaptPresence(hello.presence, myStatus, ctx) })
        get().resync()
      },
      onFrame: (frame) => get().receive(frame),
    })
    socket.start()
    detachActivity = attachActivity(socket)
    pruneTimer = setInterval(() => {
      const pruned = pruneTyping(get().typing)
      if (pruned) set({ typing: pruned })
    }, 1000)
  },

  /** One frame from the server. */
  receive: (frame) => {
    emitFrame(frame) // other stores (tasks) listen for the frames that are theirs
    if (frame.type === 'notifications.refresh') {
      // A task you can see changed: its bell items are worked out on the server, so ask again.
      get().loadNotifications()
      return
    }
    if (frame.type === 'bootstrap.invalidate') {
      get().load()
      return
    }
    if (frame.type === 'meeting.updated') {
      // Carries no content: ask again and be told what *we* may read.
      const known = get().meetings.find((m) => m.id === frame.meetingId)
      if (known?.detail) get().loadMeeting(frame.meetingId)
      else get().loadMeetings(frame.channelId)
      return
    }
    // A finished call leaves a line in the channel: its meeting is new to us.
    if (frame.type === 'message.new' && frame.message?.kind === 'call') get().loadMeetings(frame.channelId)
    const out = reduceEvent(get(), frame)
    if (!out) return
    set(out.patch)
    out.needsSync.forEach((id) => get().syncChannel(id))
  },

  /** Tell people in the channel we are typing (the server rate-limits it too). */
  sendTyping: (channelId) => {
    const last = typingSent.get(channelId) || 0
    if (Date.now() - last < TYPING_SEND_GAP_MS) return
    typingSent.set(channelId, Date.now())
    socket?.typing(channelId)
  },

  // ===========================================================================
  // Reading
  // ===========================================================================

  setOpenChannel: (id) => set({ openChannelId: id }),

  /** A channel's newest messages, the first time it is opened. */
  loadChannel: async (channelId) => {
    const s = get()
    const channel = s.channels.find((c) => c.id === channelId)
    if (!channel || channel.locked) return
    const state = s.loaded[channelId]
    if (state && !state.error) return
    set((st) => ({ loaded: { ...st.loaded, [channelId]: { loading: true, hasMoreBefore: false } } }))
    try {
      const page = await chatApi.messages(channelId, { limit: PAGE })
      set((st) => {
        const adapted = page.messages.map((m) => adaptMessage(m, st.ctx))
        const newest = adapted.reduce((n, m) => Math.max(n, m.rev ?? 0), 0)
        return {
          messages: mergeMessages(st.messages, adapted),
          // What we just read may be newer than the workspace load: do not mistake the next live
          // event for a gap.
          channels: st.channels.map((c) => (c.id === channelId ? { ...c, rev: Math.max(c.rev, newest) } : c)),
          loaded: { ...st.loaded, [channelId]: { loading: false, hasMoreBefore: page.hasMoreBefore } },
        }
      })
      get().loadMeetings(channelId)
    } catch (err) {
      set((st) => ({ loaded: { ...st.loaded, [channelId]: { loading: false, hasMoreBefore: false, error: err } } }))
    }
  },

  // ===========================================================================
  // Who works on a project (the PM's "Team & access")
  // ===========================================================================

  /** Add or remove a division on a project. The server takes the whole list, so send the changed
   *  one; then read the workspace again (it also tells everyone else's browser). */
  toggleProjectDivision: async (projectNo, division) => {
    const s = get()
    const project = s.chatProjects.find((p) => p.projectNo === projectNo || p.id === projectNo)
    if (!project) return false
    const now = s.projectDivisions[project.id] || []
    const next = now.includes(division) ? now.filter((d) => d !== division) : [...now, division]
    try {
      await chatApi.setProjectDivisions(project.id, next)
      await get().load()
      return true
    } catch (err) {
      toast('Could not change the divisions', reason(err))
      return false
    }
  },

  /** Add or remove a staff member or intern on a project (leaders and the PM reach projects
   *  through their division, so they are not named). */
  toggleMemberProject: async (memberNo, projectNo) => {
    const s = get()
    const project = s.chatProjects.find((p) => p.projectNo === projectNo || p.id === projectNo)
    const person = s.members.find((m) => m.id === memberNo)
    if (!project || !person || !['staff', 'intern'].includes(person.workspaceRole)) return false
    const named = s.members
      .filter((m) => ['staff', 'intern'].includes(m.workspaceRole) && (m.projectIds || []).includes(project.id))
      .map((m) => m.uuid)
    const next = named.includes(person.uuid) ? named.filter((u) => u !== person.uuid) : [...named, person.uuid]
    try {
      await chatApi.setProjectMembers(project.id, next)
      await get().load()
      return true
    } catch (err) {
      toast('Could not change the team', reason(err))
      return false
    }
  },

  // ===========================================================================
  // Meetings: what a call left behind
  // ===========================================================================

  /** The calls held in a channel, without what was said (that is `loadMeeting`). */
  loadMeetings: async (channelId) => {
    try {
      const list = await chatApi.channelMeetings(channelId)
      set((st) => ({ meetings: list.reduce((acc, m) => upsertMeeting(acc, adaptMeeting(m, st.ctx)), st.meetings) }))
    } catch {
      /* the call lines still show; their buttons appear on the next try */
    }
  },

  /** One meeting in full — if the server says we may read it. 404 and "restricted" both end in
   *  a meeting we cannot read, which the panel shows the same way. */
  loadMeeting: async (id) => {
    set((st) => ({ meetingState: { ...st.meetingState, [id]: 'loading' } }))
    try {
      const m = await chatApi.meeting(id)
      set((st) => ({ meetings: upsertMeeting(st.meetings, adaptMeeting(m, st.ctx)), meetingState: { ...st.meetingState, [id]: 'ready' } }))
    } catch {
      set((st) => ({ meetingState: { ...st.meetingState, [id]: 'missing' } }))
    }
  },

  /** Who may read the minutes and open the files. True when saved. */
  setMeetingAccess: async (id, { mode, extraIds = [], filesViewOnly }) => {
    const s = get()
    try {
      const m = await chatApi.setMeetingAccess(id, {
        mode,
        readerIds: extraIds.map((no) => s.ctx.uuidOf(no)).filter(Boolean),
        filesViewOnly,
      })
      set((st) => ({ meetings: upsertMeeting(st.meetings, adaptMeeting(m, st.ctx)) }))
      return true
    } catch (err) {
      toast('Could not save access', reason(err))
      return false
    }
  },

  /** Write the minutes from the stored transcript. `{ ok, reason }`: `reason` says why they are
   *  rule-based rather than AI-written (not_configured | limit | failed), when they are. */
  writeMinutes: async (id, { lang = 'en', useAi = true } = {}) => {
    try {
      const res = await chatApi.writeMinutes(id, { lang, useAi })
      set((st) => ({ meetings: upsertMeeting(st.meetings, adaptMeeting(res.meeting, st.ctx)) }))
      return { ok: true, reason: res.reason || null }
    } catch (err) {
      toast('Could not write the minutes', reason(err))
      return { ok: false, reason: null }
    }
  },

  /**
   * Turn the minutes' action items into tasks (through the same rules as making one by hand: only
   * people the caller may assign, never twice). `{ created: ['T-405'], skipped: [{ text, why }] }`,
   * or `{ error }`. The tasks themselves arrive over the socket; they are also read again here.
   */
  createTasksFromMeeting: async (id) => {
    try {
      const res = await chatApi.meetingTasks(id)
      set((st) => ({ meetings: upsertMeeting(st.meetings, adaptMeeting(res.meeting, st.ctx)) }))
      emitFrame({ type: 'tasks.refresh' }) // the lifecycle reads the task list again
      // (the screen joins them into one sentence)
      return { created: res.created, skipped: res.skipped.map((k) => `${k.text} — ${k.why}`) }
    } catch (err) {
      return { created: [], skipped: [], error: reason(err) }
    }
  },

  /** Post the minutes in the channel. Returns the message id, or null. */
  postMeetingSummary: async (id) => {
    try {
      const res = await chatApi.postMinutes(id)
      set((st) => ({ messages: mergeMessages(st.messages, [adaptMessage(res, st.ctx)]) }))
      get().loadMeeting(id)
      return res.id
    } catch (err) {
      toast('Could not post the minutes', reason(err))
      return null
    }
  },

  reloadChannel: async (channelId) => {
    set((st) => {
      const { [channelId]: _gone, ...loaded } = st.loaded
      return { loaded, messages: st.messages.filter((m) => m.channelId !== channelId) }
    })
    await get().loadChannel(channelId)
  },

  /** Earlier messages, above the ones on screen. */
  loadOlder: async (channelId) => {
    const s = get()
    const mine = s.messages.filter((m) => m.channelId === channelId && m.seq != null)
    if (!mine.length || s.loaded[channelId]?.loading) return
    const before = Math.min(...mine.map((m) => m.seq))
    set((st) => ({ loaded: { ...st.loaded, [channelId]: { ...st.loaded[channelId], loading: true } } }))
    try {
      const page = await chatApi.messages(channelId, { before, limit: PAGE })
      set((st) => ({
        messages: mergeMessages(st.messages, page.messages.map((m) => adaptMessage(m, st.ctx))),
        loaded: { ...st.loaded, [channelId]: { loading: false, hasMoreBefore: page.hasMoreBefore } },
      }))
    } catch (err) {
      set((st) => ({ loaded: { ...st.loaded, [channelId]: { ...st.loaded[channelId], loading: false } } }))
      toast('Could not load earlier messages', reason(err))
    }
  },

  /** Everything up to now counts as read: at once on screen, and on the server a moment later
   *  (so scrolling through a busy channel makes one request, not fifty). */
  markRead: (channelId) => {
    const channel = get().channels.find((c) => c.id === channelId)
    if (!channel || channel.locked) return
    if (channel.unread === 0 && channel.unreadMentions === 0 && channel.lastReadSeq >= channel.rev) return
    set((s) => ({
      channels: s.channels.map((c) =>
        c.id === channelId ? { ...c, unread: 0, unreadMentions: 0, lastReadSeq: c.rev } : c
      ),
    }))
    clearTimeout(readTimers.get(channelId))
    readTimers.set(
      channelId,
      setTimeout(async () => {
        const rev = get().channels.find((c) => c.id === channelId)?.rev ?? channel.rev
        try {
          await chatApi.read(channelId, rev)
          get().loadNotifications()
        } catch {
          /* the next load brings the server's count back */
        }
      }, READ_DEBOUNCE_MS)
    )
  },

  // ===========================================================================
  // Messages
  // ===========================================================================

  /**
   * Send a message. It appears at once, marked `pending`, and is replaced by the server's copy;
   * if the server refuses it stays, marked `failed`, with Retry and Discard. Returns the
   * temporary id (the composer clears itself when it gets one).
   */
  postMessage: (channelId, text, _parentId = null, quoteId = null, files = []) => {
    const s = get()
    const channel = s.channels.find((c) => c.id === channelId)
    if (!channel || channel.locked || !text.trim()) return null
    const tokensText = toTokens(text.trim(), s.members, new Set(taskIds()))
    const clientMsgId = newId()
    const draft = {
      id: `pending-${clientMsgId}`,
      channelId,
      authorId: s.meNo,
      at: get().now(),
      text: tokensText,
      reactions: {},
      parentId: null,
      quoteId,
      editedAt: null,
      deleted: false,
      mentions: [],
      attachments: files,
      clientMsgId,
      pending: true,
    }
    set((st) => ({ messages: sortMessages([...st.messages, draft]) }))
    get().deliver(draft)
    return draft.id
  },

  /** Send (or resend) a draft. The same `clientMsgId` makes a retry safe: the server hands back
   *  the original message if the first attempt did arrive. */
  deliver: async (draft) => {
    try {
      const res = await chatApi.send(draft.channelId, {
        text: draft.text,
        quoteId: draft.quoteId,
        clientMsgId: draft.clientMsgId,
        attachmentIds: (draft.attachments || []).map((a) => a.id),
      })
      set((st) => {
        const real = adaptMessage(res, st.ctx)
        const without = st.messages.filter((m) => m.clientMsgId !== draft.clientMsgId || !m.pending)
        return {
          messages: upsertMessage(without, real),
          channels: st.channels.map((c) =>
            c.id === draft.channelId ? { ...c, rev: Math.max(c.rev, real.rev), lastReadSeq: Math.max(c.lastReadSeq, real.seq) } : c
          ),
        }
      })
    } catch (err) {
      set((st) => ({
        messages: st.messages.map((m) =>
          m.clientMsgId === draft.clientMsgId && m.pending ? { ...m, pending: false, failed: true, error: reason(err) } : m
        ),
      }))
    }
  },

  retrySend: (id) => {
    const draft = get().messages.find((m) => m.id === id && m.failed)
    if (!draft) return
    const again = { ...draft, failed: false, pending: true, error: undefined }
    set((st) => ({ messages: st.messages.map((m) => (m.id === id ? again : m)) }))
    get().deliver(again)
  },

  discardSend: (id) => set((st) => ({ messages: st.messages.filter((m) => m.id !== id) })),

  editMessage: (id, text) => {
    const s = get()
    const msg = s.messages.find((m) => m.id === id)
    if (!msg || msg.deleted || msg.pending || msg.authorId !== s.meNo || !text.trim()) return false
    const next = toTokens(text.trim(), s.members, new Set(taskIds()))
    const prev = msg
    set((st) => ({ messages: st.messages.map((m) => (m.id === id ? { ...m, text: next, editedAt: get().now() } : m)) }))
    chatApi
      .edit(id, next)
      .then((res) => set((st) => ({ messages: upsertMessage(st.messages, adaptMessage(res, st.ctx)) })))
      .catch((err) => {
        set((st) => ({ messages: st.messages.map((m) => (m.id === id ? prev : m)) }))
        toast('Could not edit the message', reason(err))
      })
    return true
  },

  deleteMessage: (id) => {
    const msg = get().messages.find((m) => m.id === id)
    if (!msg || msg.deleted || msg.pending) return false
    set((st) => ({ messages: st.messages.map((m) => (m.id === id ? { ...m, text: '', deleted: true, reactions: {}, attachments: [] } : m)) }))
    chatApi
      .remove(id)
      .then((res) => set((st) => ({ messages: upsertMessage(st.messages, adaptMessage(res, st.ctx)) })))
      .catch((err) => {
        set((st) => ({ messages: st.messages.map((m) => (m.id === id ? msg : m)) }))
        toast('Could not delete the message', reason(err))
      })
    return true
  },

  toggleReaction: (id, emoji) => {
    const s = get()
    const msg = s.messages.find((m) => m.id === id)
    if (!msg || msg.deleted || msg.pending) return false
    const who = msg.reactions[emoji] || []
    const had = who.includes(s.meNo)
    const reactions = { ...msg.reactions, [emoji]: had ? who.filter((x) => x !== s.meNo) : [...who, s.meNo] }
    if (!reactions[emoji].length) delete reactions[emoji]
    set((st) => ({ messages: st.messages.map((m) => (m.id === id ? { ...m, reactions } : m)) }))
    ;(had ? chatApi.unreact(id, emoji) : chatApi.react(id, emoji))
      .then((res) => set((st) => ({ messages: upsertMessage(st.messages, adaptMessage(res, st.ctx)) })))
      .catch((err) => {
        set((st) => ({ messages: st.messages.map((m) => (m.id === id ? msg : m)) }))
        toast('Could not react', reason(err))
      })
    return true
  },

  // ===========================================================================
  // Files
  // ===========================================================================

  uploadFile: async (channelId, file) => adaptAttachment(await chatApi.upload(channelId, file)),

  /** A fresh link to an attachment (they expire in minutes), put back into the message. */
  refreshAttachment: async (attachment) => {
    const fresh = adaptAttachment(await chatApi.attachmentUrl(attachment.id))
    set((st) => ({
      messages: st.messages.map((m) =>
        m.attachments?.some((a) => a.id === fresh.id)
          ? { ...m, attachments: m.attachments.map((a) => (a.id === fresh.id ? fresh : a)) }
          : m
      ),
    }))
    return fresh.url
  },

  // ===========================================================================
  // Channels and people
  // ===========================================================================

  /** Open (or make) a direct message with a person, by their member number. */
  openDm: async (memberNo) => {
    const { ctx } = get()
    const uuid = ctx?.uuidOf(memberNo)
    if (!uuid) return null
    try {
      const channel = adaptChannel(await chatApi.openDm(uuid), ctx)
      set((st) => ({
        channels: st.channels.some((c) => c.id === channel.id)
          ? st.channels.map((c) => (c.id === channel.id ? { ...c, ...channel } : c))
          : [...st.channels, channel],
      }))
      return channel.id
    } catch (err) {
      toast('Could not open the conversation', reason(err))
      return null
    }
  },

  /** Make a channel. Rejects with the server's reason, which the form shows. */
  createChannel: async ({ projectId = null, kind = 'text', name, topic = '', access, divisions, memberIds = [], blockedIds = [], listed }) => {
    if (kind === 'voice') throw new Error('Voice channels are not available yet.')
    const { ctx } = get()
    const channel = adaptChannel(
      await chatApi.createChannel({
        projectId, name, topic, access, divisions,
        memberIds: memberIds.map(ctx.uuidOf).filter(Boolean),
        blockedIds: blockedIds.map(ctx.uuidOf).filter(Boolean),
        listed,
      }),
      ctx
    )
    set((st) => ({ channels: [...st.channels.filter((c) => c.id !== channel.id), channel] }))
    return channel.id
  },

  /** Change a channel. Rejects with the server's reason. */
  updateChannel: async (id, patch) => {
    const { ctx } = get()
    const body = { ...patch }
    if (patch.memberIds) body.memberIds = patch.memberIds.map(ctx.uuidOf).filter(Boolean)
    if (patch.blockedIds) body.blockedIds = patch.blockedIds.map(ctx.uuidOf).filter(Boolean)
    const next = adaptChannel(await chatApi.updateChannel(id, body), ctx)
    set((st) => ({
      channels: st.channels.map((c) => (c.id === id ? { ...next, requests: c.requests } : c)),
    }))
    return true
  },

  /** A manager's list of who has asked into a channel (every answer, newest last). */
  loadRequests: async (channelId) => {
    const { ctx } = get()
    try {
      const list = (await chatApi.joinRequests(channelId, 'all')).map((r) => adaptJoinRequest(r, ctx))
      set((st) => ({ channels: st.channels.map((c) => (c.id === channelId ? { ...c, requests: list } : c)) }))
    } catch {
      /* not a manager, or the channel went away: nothing to list */
    }
  },

  requestToJoin: async (channelId, note = '') => {
    try {
      const jr = await chatApi.requestJoin(channelId, note)
      const request = adaptJoinRequest(jr, get().ctx)
      set((st) => ({ channels: st.channels.map((c) => (c.id === channelId ? { ...c, requests: [request] } : c)) }))
      return true
    } catch (err) {
      toast('Could not send the request', reason(err))
      return false
    }
  },

  decideJoinRequest: async (channelId, memberNo, approve) => {
    const channel = get().channels.find((c) => c.id === channelId)
    const request = channel?.requests.find((r) => r.memberId === memberNo && r.status === 'pending')
    if (!request?.id) return false
    try {
      const done = adaptJoinRequest(await chatApi.decide(request.id, approve), get().ctx)
      set((st) => ({
        channels: st.channels.map((c) =>
          c.id === channelId ? { ...c, requests: c.requests.map((r) => (r.id === done.id ? done : r)) } : c
        ),
      }))
      get().loadNotifications()
      return true
    } catch (err) {
      toast('Could not record the decision', reason(err))
      return false
    }
  },

  /** Online, idle, do not disturb or invisible: what others see while you are connected. */
  setStatus: (status) => {
    const prev = get().myStatus
    set((st) => ({ myStatus: status, presence: { ...st.presence, [st.meNo]: status } }))
    chatApi.setStatus(status).catch((err) => {
      set((st) => ({ myStatus: prev, presence: { ...st.presence, [st.meNo]: prev } }))
      toast('Could not change your status', reason(err))
    })
    return true
  },

  // ===========================================================================
  // The bell
  // ===========================================================================

  loadNotifications: async () => {
    try {
      const res = await chatApi.notifications(50)
      set({ notifications: res.items.map(adaptNotification) })
    } catch {
      /* keep what we have */
    }
  },

  markNotificationRead: (id) => {
    const s = get().notifRead
    if (s.ids.includes(id)) return
    const next = { ...s, ids: [...s.ids, id].slice(-300) }
    saveNotifState(next)
    set({ notifRead: next })
  },

  markAllNotificationsRead: () => {
    const next = { ...get().notifRead, seenAt: get().now(), ids: [] }
    saveNotifState(next)
    set({ notifRead: next })
  },
}))

// ---------------------------------------------------------------------------
// Presence follows what you are doing
// ---------------------------------------------------------------------------

/** Tell the server when this tab is in the background, or you have been away five minutes, so
 *  others see "idle" rather than a person who is plainly not there. Returns a detach function. */
function attachActivity(sock) {
  if (typeof document === 'undefined') return () => {}
  let idle = false
  let timer
  const set = (value) => {
    if (idle === value) return
    idle = value
    sock.activity(value ? 'idle' : 'active')
  }
  const touch = () => {
    set(false)
    clearTimeout(timer)
    timer = setTimeout(() => set(true), IDLE_AFTER_MS)
  }
  const onVisibility = () => {
    if (document.hidden) set(true)
    else {
      touch()
      sock.nudge() // back in the foreground: do not wait out a backoff
    }
  }
  const events = ['keydown', 'pointerdown', 'wheel']
  events.forEach((e) => window.addEventListener(e, touch, { passive: true }))
  document.addEventListener('visibilitychange', onVisibility)
  touch()
  return () => {
    clearTimeout(timer)
    events.forEach((e) => window.removeEventListener(e, touch))
    document.removeEventListener('visibilitychange', onVisibility)
  }
}

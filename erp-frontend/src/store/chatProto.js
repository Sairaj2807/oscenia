// One door for the chat screens: `useProto` — the same name, shape and actions they were written
// against — answered from the live server when a real person is signed in, and from the
// prototype's browser-only demo store otherwise.
//
// ---------------------------------------------------------------------------
// Why a facade, not a rewrite
// ---------------------------------------------------------------------------
// The chat screens read the store in about sixty places and mix chat state (channels, messages,
// members) with things that have no server yet (tasks, calls, meetings). Rewriting each read
// would be a large diff for no gain. Instead this module is a drop-in `useProto`: in demo mode
// it is the prototype's store untouched; in live mode it is that store with the *chat* slices
// and actions swapped for `useChat`'s. Everything else — tasks, which the chat only links to by
// id — still comes from the demo store, as it does today.
//
// What stays honest in live mode:
//  * calls and meetings are empty, and their actions do nothing: there is no server for them;
//  * the "viewing as" persona is simply you (`personaId` is your member number);
//  * `now` is the real moment (Jakarta wall clock, corrected for the server's), not the demo's
//    frozen date, because the 15-minute edit window is about real time.

import { useMemo } from 'react'
import { useAuth } from './useAuth.js'
import { demoNow as protoDemoNow, selectPersona, useProto as useProtoStore } from './useProto.js'
import { useChat } from './useChat.js'
import { useTasks } from './useTasks.js'
import { useEvents, toast as eventsToast } from './useEvents.js'
import { usePublicClient } from './usePublicClient.js'
import { useStore } from './useStore.js'

export { selectPersona }

/** A real session (not the offline demo, which has no server to ask). */
export const isLiveUser = (user) => Boolean(user && !user.offline)
const liveNow = () => isLiveUser(useAuth.getState().user)

const nothing = () => {}
const refuse = () => false

// ---------------------------------------------------------------------------
// Events (the staff screens). Signed in, they read `useEvents`; every action below is the server's
// once `useEvents` implements it, and until then (or for good, where there is no server side:
// media, messaging, campaigns) it says so instead of quietly changing the demo store's copy.
// ---------------------------------------------------------------------------
export const EVENT_ACTIONS = [
  'createEvent', 'updateEvent', 'chooseTemplate', 'setSection', 'updateContent', 'setAccent',
  'submitForReview', 'returnToClient', 'publishInvite', 'unpublish', 'regenerateEditToken',
  'setHoldWishes', 'setWishHidden', 'approveWish',
  'addQuestion', 'updateQuestion', 'moveQuestion', 'removeQuestion',
  'addGuests', 'eraseGuest', 'setGuestTable', 'setGuestCategory', 'setGuestNote', 'setGuestEmail', 'addTable',
  'addReminder', 'updateReminder', 'removeReminder', 'sendReminderNow',
  'sendBroadcast', 'sendScheduledNow', 'cancelBroadcast', 'retryFailed', 'markSentByClient',
  'scanGuest', 'registerWalkIn', 'checkIn', 'undoCheckIn', 'addCheckpoint', 'updateCheckpoint', 'removeCheckpoint',
  'createTemplate', 'updateTemplate', 'setTemplateArt', 'uploadMedia', 'publishTemplate', 'unpublishTemplate', 'archiveTemplate',
]

const notConnected = (name) => () => {
  eventsToast('Not connected yet', `${name} is not connected to the server yet, so nothing was changed.`)
  return false
}

/**
 * The client's edit link, as the editor sees it: their one event, the studio templates, their guest
 * list, and only the actions their key allows (design, submit, wishes, marking guests as sent).
 * Everything else — questions, the door, templates, publishing — is refused, as it is on the server.
 */
const NO_ROWS = []
const eventLists = new WeakMap() // the same event, the same one-item list (a selector must not get a new array each time)
function listOf(event) {
  if (!event) return NO_ROWS
  if (!eventLists.has(event)) eventLists.set(event, [event])
  return eventLists.get(event)
}

function clientView(proto, client) {
  const out = {
    ...proto,
    events: listOf(client.event),
    guests: client.guests,
    scans: NO_ROWS,
    customTemplates: client.templates,
    eventsStatus: 'ready',
    // Not signed in, but the editor must behave as it does against a server: no browser-only uploads.
    live: true,
    openEvent: nothing,
  }
  for (const name of EVENT_ACTIONS) out[name] = client[name] || notConnected(name)
  return out
}

/** The events slices and actions for a live view: the server's where built, a refusal elsewhere. */
function eventsView() {
  const ev = useEvents.getState()
  const out = {
    events: ev.events,
    guests: ev.guests,
    scans: ev.scans,
    customTemplates: ev.customTemplates,
    eventsStatus: ev.status,
    openEvent: ev.openEvent,
  }
  for (const name of EVENT_ACTIONS) out[name] = ev[name] || notConnected(name)
  return out
}

/** The demo store's state with the chat parts replaced by the server's. */
function view(proto, chat) {
  return {
    ...proto,

    // --- chat slices, from the server -------------------------------------------------
    members: chat.members,
    channels: chat.channels,
    messages: chat.messages,
    lastRead: chat.lastRead,
    presence: chat.presence,
    personaId: chat.personaId,
    projectDivisions: chat.projectDivisions,

    // --- tasks are the server's too ---------------------------------------------------
    tasks: useTasks.getState().tasks,
    tasksStatus: useTasks.getState().status,
    createTask: useTasks.getState().createTask,
    startTask: useTasks.getState().startTask,
    blockTask: useTasks.getState().blockTask,
    unblockTask: useTasks.getState().unblockTask,
    submitTask: useTasks.getState().submitTask,
    approveTask: useTasks.getState().approveTask,
    rejectTask: useTasks.getState().rejectTask,
    addAttachment: useTasks.getState().addAttachment,
    removeAttachment: useTasks.getState().removeAttachment,
    openAttachment: useTasks.getState().openAttachment,
    toggleProjectDivision: chat.toggleProjectDivision,
    toggleMemberProject: chat.toggleMemberProject,

    // --- meetings are the server's; live calls have no server yet ---------------------
    activeCall: null,
    meetings: chat.meetings,
    meetingState: chat.meetingState,

    // --- events are the server's too ----------------------------------------------------
    ...eventsView(),

    // --- live-only state the screens use ----------------------------------------------
    live: true,
    chatProjects: chat.chatProjects,
    chatStatus: chat.status,
    chatError: chat.error,
    connection: chat.connection,
    loaded: chat.loaded,
    typing: chat.typing,
    chatNotifications: chat.notifications,
    notifRead: { [chat.personaId]: chat.notifRead },
    now: chat.now,

    // --- the prototype's action names, answered by the server -------------------------
    markRead: chat.markRead,
    postMessage: chat.postMessage,
    editMessage: chat.editMessage,
    deleteMessage: chat.deleteMessage,
    toggleReaction: chat.toggleReaction,
    openDm: chat.openDm,
    createChannel: chat.createChannel,
    updateChannel: chat.updateChannel,
    requestToJoin: chat.requestToJoin,
    decideJoinRequest: chat.decideJoinRequest,
    setStatus: chat.setStatus,
    markNotificationRead: chat.markNotificationRead,
    markAllNotificationsRead: chat.markAllNotificationsRead,
    selectPersona: nothing, // you are who you signed in as

    // --- and the ones that only exist live --------------------------------------------
    loadChannel: chat.loadChannel,
    loadOlder: chat.loadOlder,
    loadRequests: chat.loadRequests,
    setOpenChannel: chat.setOpenChannel,
    sendTyping: chat.sendTyping,
    retrySend: chat.retrySend,
    discardSend: chat.discardSend,
    uploadFile: chat.uploadFile,
    refreshAttachment: chat.refreshAttachment,
    loadMeeting: chat.loadMeeting,
    setMeetingAccess: chat.setMeetingAccess,
    writeMinutes: chat.writeMinutes,
    postMeetingSummary: chat.postMeetingSummary,
    createTasksFromMeeting: chat.createTasksFromMeeting,

    // --- calls: no server, so no-ops --------------------------------------------------
    startCall: refuse,
    joinCall: refuse,
    leaveCall: nothing,
    toggleShare: nothing,
    addCallNote: refuse,
    addCallFile: refuse,
  }
}

/**
 * Drop-in for the prototype's `useProto(selector)`.
 *
 * Both stores are subscribed to on every render (hooks cannot be conditional) but with the
 * "wrong" one reduced to a constant, so a change in a store that is not in use re-renders
 * nothing. When live, each subscription computes the same merged selection; either answers.
 */
export function useProto(selector = (s) => s) {
  // The client's edit link, while its page holds a key, takes the door over from everything else.
  const clientMode = usePublicClient((c) => c.active)
  const fromClient = usePublicClient((c) => (c.active ? selector(clientView(useProtoStore.getState(), c)) : 0))
  const live = useAuth((s) => isLiveUser(s.user))
  const fromDemo = useProtoStore((p) => (live ? 0 : selector(p)))
  const fromLive = useChat((c) => (live ? selector(view(useProtoStore.getState(), c)) : 0))
  // Tasks live in their own store: subscribe so a change re-renders this component, and the
  // selector above (run again on that render) reads them fresh.
  useTasks((t) => (live ? t.tasks : 0))
  useTasks((t) => (live ? t.status : 0))
  // Events likewise: a change in their store must re-render what reads them.
  useEvents((e) => (live ? e.events : 0))
  useEvents((e) => (live ? e.guests : 0))
  useEvents((e) => (live ? e.scans : 0))
  useEvents((e) => (live ? e.customTemplates : 0))
  useEvents((e) => (live ? e.status : 0))
  if (clientMode) return fromClient
  return live ? fromLive : fromDemo
}

/**
 * The projects the workspace pages draw cards for, in the shape they read (`id` is the business
 * number `EVT-…`). Demo: the finance store's. Signed in: the ones the server's workspace names —
 * a team member has no finance data, so the finance store would be empty for them.
 */
export function useWorkspaceProjects() {
  const live = useAuth((s) => isLiveUser(s.user))
  const demo = useStore((s) => s.projects)
  const chat = useChat((c) => c.chatProjects)
  return useMemo(
    () => (live ? chat.map((p) => ({ id: p.projectNo, uuid: p.id, name: p.name, client: p.client, eventDate: p.eventDate, pm: p.pm, stage: p.stage })) : demo),
    [live, chat, demo]
  )
}

useProto.getState = () => {
  const client = usePublicClient.getState()
  if (client.active) return clientView(useProtoStore.getState(), client)
  return liveNow() ? view(useProtoStore.getState(), useChat.getState()) : useProtoStore.getState()
}
useProto.setState = (...args) => useProtoStore.setState(...args)
useProto.subscribe = (...args) => useProtoStore.subscribe(...args)

/** "Now" as the chat screens measure it: real time when live, the demo's fixed date otherwise. */
export function demoNow() {
  return liveNow() ? useChat.getState().now() : protoDemoNow()
}

// State for the prototype modules — project workspace, team chat, events/RSVP and the CRM
// relationship layer. Front-end only until the client signs off on the prototype.
//
// ---------------------------------------------------------------------------
// Why a separate store, and why it persists
// ---------------------------------------------------------------------------
// `useStore` is the ERP's business data: in memory, re-hydrated from the API, gone on
// refresh (apart from offline demo clients, which it saves itself). These modules have no
// API yet, and the demo depends on two browser tabs agreeing —
// a guest submits an RSVP on the public invitation page, and the staff dashboard in the other
// tab shows it. So this store is saved to localStorage and re-read when another tab writes.
//
// Keeping it apart also marks the seam: when the backend arrives, these actions become API
// calls and nothing in the finance store has to move.

import { create } from 'zustand'
import { useStore } from './useStore.js'
import { persist, createJSONStorage } from 'zustand/middleware'
import { DEMO_TODAY } from '../lib/format.js'
import {
  seedMembers, seedProjectDivisions, seedTasks, seedChannels, seedMessages,
  seedEvents, seedGuests, seedScans, seedRelations, seedGreetingLog, FOLLOW_UP_THANKS, seedGoogleEvents, seedPoDelivery,
  seedVendorStages, seedPresence, DIVISIONS, seedMeetings,
} from './protoSeed.js'
import {
  assignableMembers, approvalStage, canSeeTask, canSubmit, canWorkOn, visibleChannels,
  CHANNEL_ACCESS, channelAccess, canOpenChannel, discoverableChannels, canManageChannel, canCreateChannel, homeChannel, callLogChannel,
} from '../lib/workspaceAccess.js'
import { checkFile, fileKind, keptBytes, MAX_PER_TASK, KEEP_WHOLE_BYTES, STORE_BUDGET } from '../lib/attachments.js'
import { simulateTranscript, canSeeMeeting, canManageMeeting, MEETING_ACCESS } from '../lib/meetings.js'
import {
  DELIVERY_STATUSES, MANUAL_CHECKS, VENDOR_STAGES, vendorChecklist, vendorStageError, vendorStageOf, resumeStageOf, vendorKey,
} from '../lib/vendors.js'
import { canDo, ROLES } from '../lib/roles.js'
import { blankInvite, cleanSection, liveInvite, visibleSections, WISH_LIMITS } from '../lib/invites.js'
import { templateById, SECTIONS, MUSIC, registerTemplates, validateTemplate, newTemplate, inGallery, ART_SLOTS } from '../lib/templates.js'
import { clearMedia, putMedia } from '../lib/mediaStore.js'
import { toTokens, canEditMessage, canDeleteMessage, dmId, minutesBetween, callLength, USER_STATUSES } from '../lib/chat.js'
import {
  matchGuest, rsvpOpen, normPhone, reminderAudience, isIsoDate, ruleLabel,
  newGuestToken, toCategory, GUEST_CATEGORIES, MAX_PAX_LIMIT, AUDIENCES, eventCheckpoints,
  cleanAnswers, questionsFor, QUESTION_TYPES, MAX_QUESTIONS, cleanTable,
} from '../lib/events.js'
import { isMonthDay, guestContacts, campaignAudience, isEmail } from '../lib/crm.js'
import { broadcastAudience, broadcastProblem, recipientRows, deliveryOf, audienceLabel } from '../lib/broadcasts.js'

const STORAGE_KEY = 'oscenia.proto'

// localStorage holds a few MB per site. When it is full a write throws, which would abort the
// action mid-way (an RSVP with no confirmation) — so the write is caught, the change stays for
// this tab, and the person is told once that it will not survive a reload.
let warnedFull = false
const guardedLocalStorage = {
  getItem: (k) => localStorage.getItem(k),
  removeItem: (k) => localStorage.removeItem(k),
  setItem: (k, v) => {
    try {
      localStorage.setItem(k, v)
    } catch {
      if (!warnedFull) {
        warnedFull = true
        useStore.getState().pushToast({
          title: 'Browser storage is full',
          body: 'Recent changes show here but will not survive a reload. Remove a large invitation photo, or use “Reset demo data”.',
          kind: 'redflag',
        })
      }
    }
  },
}

export const EMPTY_RELATION = {
  pics: [], anniversary: null, greetAnniversary: false, anniversaryChannel: 'whatsapp',
  nudgeLeadMonths: 3, cycles: [], handledNudges: [], outreach: [],
}

const nextScanId = (scans) => `SC-${String(Math.max(0, ...scans.map((x) => Number(x.id.slice(3)) || 0)) + 1).padStart(3, '0')}`

// How the send log names each audience.
const SENT_TO = { attending: 'attending', pending: 'not replied', attended: 'came', noshow: 'did not come' }

// Bump when the seed's shape changes: an older saved copy is discarded instead of being
// merged into a shape it does not fit.
// 2: guest categories, personal links, notes, checkpoints + scans, follow-ups. 3: RSVP questions.
// 4: direct messages, quoted replies and call logs in the seed. 5: round 2 — vendor stages now,
// and the channel and meeting shapes that follow in the same round (one reset for all of it).
// 6: Invitations v2 — template-based invitations (invite / published / review), wishes, broadcasts.
const VERSION = 6

// ---------------------------------------------------------------------------
// The demo clock
// ---------------------------------------------------------------------------
// The demo lives on one fixed day (DEMO_TODAY), so a timestamp is that day plus the wall-clock
// time. Across real days that collapses: a message sent yesterday at 18:00 would read as
// "later today" this morning — sorting above newer ones, never showing as unread, and editable
// for ever. So the store keeps `clock`, the latest stamp it has handed out, and never stamps
// earlier than it.

function wallStamp() {
  const d = new Date()
  return `${DEMO_TODAY}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const plusMinute = (at) => new Date(Date.parse(`${at}:00Z`) + 60000).toISOString().slice(0, 16)

/** "Now" in the demo's world — never earlier than anything already recorded. */
export function demoNow() {
  const c = useProto.getState().clock
  const w = wallStamp()
  return c && c > w ? c : w
}

// The latest moment the seed records, so the first new action lands after all of it.
function seedClock() {
  const stamps = [
    ...seedTasks.flatMap((t) => t.activity.map((a) => a.at)),
    ...seedMessages.map((m) => m.at),
    ...seedGuests.flatMap((g) => [g.respondedAt, g.checkedInAt, g.consentAt]),
    ...seedEvents.flatMap((e) => e.sendLog.map((l) => l.at)),
    ...seedGreetingLog.map((l) => l.at),
  ].filter(Boolean)
  return stamps.reduce((a, b) => (b > a ? b : a), '')
}

const seedState = () => ({
  // The workspace/chat persona being viewed as — the demo's stand-in for "who is signed in"
  // inside these modules (PM, Division Leader, Staff, Intern).
  personaId: 'M-01',
  members: structuredClone(seedMembers),
  projectDivisions: structuredClone(seedProjectDivisions),
  tasks: structuredClone(seedTasks),
  channels: structuredClone(seedChannels),
  messages: structuredClone(seedMessages),
  // lastRead[personaId][channelId] = timestamp of the newest message they have seen. The seed
  // starts everyone caught up to the end of 24 Jul, so only the latest day shows as unread.
  lastRead: Object.fromEntries(seedMembers.map((m) => [
    m.id, Object.fromEntries(seedChannels.map((c) => [c.id, '2026-07-24T23:59'])),
  ])),
  events: structuredClone(seedEvents),
  guests: structuredClone(seedGuests),
  // Every scan at an event's checkpoints: { id, eventId, guestId, checkpointId, at }.
  scans: structuredClone(seedScans),
  relations: structuredClone(seedRelations),
  greetingLog: structuredClone(seedGreetingLog),
  campaigns: [],
  // Delivery status per purchase order (V1): { [poId]: { status, at, by } }. The POs and their
  // accounting status live in the ERP store; with the backend this becomes a column on the PO.
  // A new top-level key, so an older saved demo just gets the seed when merged.
  poDelivery: structuredClone(seedPoDelivery),
  // Where each vendor stands (V2): { [vendorId]: { stage, at, by, reason?, checks, history[] } }.
  // Browser-only like delivery; with the backend it becomes a field on the vendor.
  vendorStages: structuredClone(seedVendorStages),
  // The call in progress (CH2, simulated): { channelId, video, startedAt, hostId, participantIds, sharingId }.
  activeCall: null,
  // Chat status per member (CH3): { [memberId]: 'online'|'idle'|'dnd'|'invisible'|'offline' }.
  // Simulated for everyone but the persona, who sets their own from the user panel.
  presence: structuredClone(seedPresence),
  // Meeting records (CH4), one per ended call: { id, channelId, logChannelId, dm, video,
  // startedAt, endedAt, hostId, participantIds, transcript[], notes[], files[],
  // access: { mode, extraIds }, filesViewOnly, summary }. See lib/meetings.js for who reads them.
  meetings: structuredClone(seedMeetings),
  // Google Calendar (C2) — simulated: nothing leaves the browser. A new top-level key, so a
  // saved demo from before simply gets this default when merged (no version bump needed).
  googleCalendar: { connected: false, account: '', connectedAt: null, showGoogle: true, addCrmDates: false },
  googleEvents: structuredClone(seedGoogleEvents),
  // The design team's invitation templates (round 3, Template Studio), as lib/templates.js
  // validateTemplate describes them, plus who made them and when. Browser-only like the rest;
  // a new key, so an older saved demo gets the empty default when merged (no version bump).
  customTemplates: [],
  clock: seedClock(),
  // notifRead[personaId] = { seenAt, ids } — notifications themselves are worked out from the
  // data (lib/notifications.js); only what was read is kept. Like chat, everyone starts caught
  // up to the end of 24 Jul.
  notifRead: Object.fromEntries(seedMembers.map((m) => [m.id, { seenAt: '2026-07-24T23:59', ids: [] }])),
})

// Every workspace action re-checks the access rules for the persona acting, and returns
// false when refused. The screens hide what a persona cannot do, but the rule lives here —
// the same place it will live on the server.

export const useProto = create(
  persist(
    (set, get) => {
      const me = () => get().members.find((m) => m.id === get().personaId)

      // Hands out the next timestamp and moves the clock on. Called before a `set`, never
      // inside one.
      const stamp = () => {
        const c = get().clock
        const w = wallStamp()
        const at = c && c >= w ? plusMinute(c) : w
        set({ clock: at })
        return at
      }
      const findTask = (id) => get().tasks.find((t) => t.id === id)
      // Everything holding files, for the one browser-storage budget (W2, CH4).
      const fileHolders = (s) => [...s.tasks, ...s.meetings.map((m) => ({ attachments: m.files })), { attachments: s.activeCall?.files || [] }]

      // Template Studio: moves a studio template between draft, gallery and archive. Only a
      // template that validates may enter the gallery. An archived template goes back to the
      // gallery only by way of Restore (archived → draft), never straight to published.
      const setTemplateStatus = (id, status, role) => {
        if (!canDo(role, 'manage_templates')) return false
        const cur = get().customTemplates.find((t) => t.id === id)
        if (!cur || cur.status === status || validateTemplate({ ...cur, status })) return false
        if (cur.status === 'archived' && status !== 'draft') return false
        const at = stamp()
        set((s) => ({ customTemplates: s.customTemplates.map((t) => (t.id === id ? { ...t, status, updatedAt: at } : t)) }))
        return true
      }

      // Sends a platform batch of invitations (Invitations v2, D9): one row per guest per
      // channel, the guests it reached marked invited, a line in the send log — in one write.
      // `batch` is new, or a scheduled one already in the list. Returns how many guests.
      const fireBroadcast = (eventId, batch) => {
        const at = stamp()
        const s = get()
        const ev = s.events.find((e) => e.id === eventId)
        const guests = broadcastAudience(s.guests.filter((g) => g.eventId === eventId), batch.audience)
        const recipients = recipientRows(guests, batch.channel, at)
        const reached = new Set(recipients.filter((r) => r.status !== 'failed').map((r) => r.guestId))
        const sent = { ...batch, createdAt: batch.createdAt || at, status: 'sent', sentAt: at, recipients }
        const entry = {
          id: `SL-${Math.max(0, ...ev.sendLog.map((l) => Number(l.id.slice(3)) || 0)) + 1}`, at,
          label: 'Invitation', channel: batch.channel, audience: audienceLabel(batch.audience), count: guests.length,
        }
        const known = (ev.broadcasts || []).some((b) => b.id === batch.id)
        set({
          events: s.events.map((e) => (e.id === eventId
            ? { ...e, broadcasts: known ? e.broadcasts.map((b) => (b.id === batch.id ? sent : b)) : [...(e.broadcasts || []), sent], sendLog: [...e.sendLog, entry] }
            : e)),
          guests: s.guests.map((g) => (reached.has(g.id) ? { ...g, invitedAt: at, invitedVia: 'platform' } : g)),
        })
        return guests.length
      }

      // Replace one task, appending an activity entry by the current persona.
      const changeTask = (id, patch, text, kind) => {
        const at = stamp()
        set((s) => ({
          tasks: s.tasks.map((t) =>
            t.id === id
              ? { ...t, ...patch, activity: [...t.activity, { at, by: s.personaId, text, kind }] }
              : t
          ),
        }))
      }

      // Move a task from one of `from` to `to`, if the persona may work on it.
      const seesChannel = (s, channelId) => visibleChannels(me(), s.channels, s.projectDivisions).some((c) => c.id === channelId)

      // Ends `call` and logs it: kind, length and everyone who took part. A call in a voice
      // channel (CH3) is logged in its linked text channel.
      const endCall = (call) => {
        const at = stamp()
        const s = get()
        const names = (call.joinedIds || call.participantIds).map((id) => s.members.find((m) => m.id === id)?.name || id)
        const next = Math.max(0, ...s.messages.map((m) => Number(m.id.slice(4)) || 0)) + 1
        const room = s.channels.find((c) => c.id === call.channelId && c.kind === 'voice')
        const where = room ? callLogChannel(room, s.channels, s.members, s.projectDivisions) : null
        // The meeting record (CH4): kept even when the call is not logged in a channel.
        const channel = s.channels.find((c) => c.id === call.channelId)
        const project = channel?.projectId && useStore.getState().projects.find((p) => p.id === channel.projectId)
        const meetingId = `MTG-${Math.max(0, ...s.meetings.map((m) => Number(m.id.slice(4)) || 0)) + 1}`
        const participantIds = call.joinedIds || call.participantIds
        const meeting = {
          id: meetingId, channelId: call.channelId, logChannelId: room ? where?.id || null : call.channelId, dm: Boolean(channel?.dm),
          video: call.video, startedAt: call.startedAt, endedAt: at, hostId: call.hostId, participantIds,
          transcript: simulateTranscript({ participantIds, hostId: call.hostId, startedAt: call.startedAt, endedAt: at }, project?.name),
          notes: call.notes || [], files: call.files || [],
          access: { mode: 'participants', extraIds: [] }, filesViewOnly: false, summary: null,
        }
        if (room && !where) return set({ activeCall: null, meetings: [...s.meetings, meeting] })
        const log = {
          id: `MSG-${String(next).padStart(3, '0')}`, channelId: where?.id || call.channelId, authorId: call.hostId, at, kind: 'call',
          text: `${call.video ? 'Video call' : 'Voice call'}${room ? ` in ${room.name}` : ''} · ${callLength(minutesBetween(call.startedAt, at))} · ${names.join(', ')}`,
          reactions: {}, parentId: null, quoteId: null, editedAt: null, deleted: false,
          ...(room ? { voiceChannelId: room.id } : {}),
          meetingId,
        }
        set({ activeCall: null, messages: [...s.messages, log], meetings: [...s.meetings, meeting] })
      }

      // CH5: the access fields of a channel, cleaned against who exists and what the project
      // has. Returns the fields, or null when the rule makes no sense (no division ticked).
      const cleanAccess = (s, projectId, input, wasBlocked = []) => {
        const access = CHANNEL_ACCESS.includes(input.access) ? input.access : 'project'
        const allowed = projectId ? s.projectDivisions[projectId] || [] : DIVISIONS
        const divisions = [...new Set(input.divisions || [])].filter((d) => allowed.includes(d))
        if (access === 'divisions' && !divisions.length) return null
        const exists = (id) => s.members.some((m) => m.id === id)
        // The PM can't be blocked, and nobody blocks themselves — nor lifts a block on themselves.
        const blockedIds = [...new Set([...(input.blockedIds || []), ...wasBlocked.filter((id) => id === s.personaId)])]
          .filter((id) => exists(id) && (id !== s.personaId || wasBlocked.includes(id)) && s.members.find((m) => m.id === id).workspaceRole !== 'pm')
        let memberIds = [...new Set(input.memberIds || [])].filter((id) => exists(id) && !blockedIds.includes(id))
        // Whoever makes a channel invite-only stays in it.
        if (access === 'invite' && !memberIds.includes(s.personaId)) memberIds = [...memberIds, s.personaId]
        const listed = input.listed ?? !(access === 'invite' && !projectId)
        return { access, divisions: access === 'divisions' ? divisions : [], memberIds, blockedIds, listed: Boolean(listed) }
      }

      // After access changes, anyone on the live call there who lost access is dropped; if
      // nobody is left, the call ends.
      const dropFromCall = () => {
        const s = get()
        const call = s.activeCall
        const channel = call && s.channels.find((c) => c.id === call.channelId)
        if (!channel) return
        const keep = call.participantIds.filter((id) => canOpenChannel(s.members.find((m) => m.id === id), channel, s.projectDivisions))
        if (keep.length === call.participantIds.length) return
        if (!keep.length) return endCall(call)
        set({ activeCall: { ...call, participantIds: keep, sharingId: keep.includes(call.sharingId) ? call.sharingId : null } })
      }

      const channelName = (name, kind) => (kind === 'voice'
        ? name.trim().replace(/\s+/g, ' ').slice(0, 40)
        : name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 32))

      const move = (id, from, to, text, extra = {}) => {
        const t = findTask(id)
        if (!t || !from.includes(t.status) || !canWorkOn(me(), t)) return false
        changeTask(id, { status: to, ...extra }, text, 'status')
        return true
      }

      return {
        ...seedState(),

        setPersona: (personaId) => set({ personaId }),

        // --- tasks ---------------------------------------------------------------

        /** Returns the new task id, or null when the persona may not assign that person. */
        createTask: ({ projectId, title, description = '', assigneeId, deadline, priority = 'Medium' }) => {
          const s = get()
          const allowed = assignableMembers(me(), projectId, s.members, s.projectDivisions)
          const assignee = allowed.find((m) => m.id === assigneeId)
          if (!assignee || !title.trim() || !deadline) return null
          const next = Math.max(0, ...s.tasks.map((t) => Number(t.id.slice(2)) || 0)) + 1
          const id = `T-${next}`
          const now = stamp()
          // A leader may pick anyone in their division; staff and interns see a project only
          // through projectIds, so being given a task on it makes them a member.
          const joins = ['staff', 'intern'].includes(assignee.workspaceRole) && !(assignee.projectIds || []).includes(projectId)
          set({
            members: joins
              ? s.members.map((m) => (m.id === assigneeId ? { ...m, projectIds: [...(m.projectIds || []), projectId] } : m))
              : s.members,
            tasks: [...get().tasks, {
              id, projectId, division: assignee.division, title: title.trim(), description: description.trim(),
              assigneeId, assignedById: s.personaId, assignedAt: now, deadline, priority, status: 'To do',
              blockerReason: '', approvals: {}, completedAt: null,
              activity: [{ at: now, by: s.personaId, text: 'assigned', kind: 'assign' }],
            }],
          })
          return id
        },

        startTask: (id) => move(id, ['To do'], 'In progress', 'started'),

        blockTask: (id, reason) => {
          if (!reason?.trim()) return false
          const t = findTask(id)
          if (!t || !['To do', 'In progress'].includes(t.status) || !canWorkOn(me(), t)) return false
          changeTask(id, { status: 'Blocked', blockerReason: reason.trim() }, `blocked: ${reason.trim()}`, 'block')
          return true
        },

        unblockTask: (id) => move(id, ['Blocked'], 'In progress', 'unblocked', { blockerReason: '' }),

        /** Only the assignee submits — never the PM or a leader on their behalf (decision W3). */
        submitTask: (id) => {
          const t = findTask(id)
          if (!t || !canSubmit(me(), t)) return false
          return move(id, ['In progress'], 'Submitted', 'submitted for approval')
        },

        /** Gives whichever approval stage the persona holds on this task. */
        approveTask: (id) => {
          const t = findTask(id)
          const stage = t && approvalStage(me(), t, get().members)
          if (!stage) return false
          const mark = { by: get().personaId, at: stamp() }
          if (stage === 'leader') {
            changeTask(id, { status: 'Leader approved', approvals: { ...t.approvals, leader: mark } }, 'approved (Division Leader)', 'approve')
          } else {
            changeTask(id, { status: 'PM approved', approvals: { ...t.approvals, pm: mark }, completedAt: mark.at }, 'approved (PM) — done', 'approve')
          }
          return true
        },

        /** Sends the task back to In progress. A comment is required — the assignee needs to know why. */
        rejectTask: (id, comment) => {
          const t = findTask(id)
          if (!t || !comment?.trim() || !approvalStage(me(), t, get().members)) return false
          changeTask(id, { status: 'In progress', approvals: {} }, `rejected: ${comment.trim()}`, 'reject')
          return true
        },

        // --- task attachments (W2) ---------------------------------------------------

        /**
         * Attaches a file the screen has already read: { name, type, size, preview?, data? }.
         * Anyone who can see the task may attach, until it is done. The file itself (`data`) is
         * kept only when small and while the demo's storage budget allows; otherwise just its
         * details. Returns { id } or { error } with a message to show.
         */
        addAttachment: (taskId, file) => {
          const s = get()
          const t = findTask(taskId)
          if (!t || !canSeeTask(me(), t, s.projectDivisions)) return { error: 'You cannot open this task.' }
          if (t.status === 'PM approved') return { error: 'This task is done — attachments are closed.' }
          const problem = checkFile(file)
          if (problem) return { error: problem }
          const list = t.attachments || []
          if (list.length >= MAX_PER_TASK) return { error: `A task can hold up to ${MAX_PER_TASK} files.` }
          let budget = STORE_BUDGET - keptBytes(fileHolders(s))
          const preview = file.preview && file.preview.length <= budget ? file.preview : undefined
          budget -= preview?.length || 0
          const data = file.data && file.size <= KEEP_WHOLE_BYTES && file.data.length <= budget ? file.data : undefined
          const next = Math.max(0, ...list.map((a) => Number(String(a.id).slice(2)) || 0)) + 1
          const at = stamp()
          const att = { id: `A-${next}`, name: file.name, kind: fileKind(file.name), size: file.size, by: s.personaId, at, preview, data }
          set({
            tasks: s.tasks.map((x) => (x.id === taskId
              ? { ...x, attachments: [...list, att], activity: [...x.activity, { at, by: s.personaId, text: `attached ${file.name}`, kind: 'attach' }] }
              : x)),
          })
          return { id: att.id }
        },

        /** The person who attached a file, or the PM, may remove it — not once the task is done. */
        removeAttachment: (taskId, attachmentId) => {
          const s = get()
          const t = findTask(taskId)
          const att = (t?.attachments || []).find((a) => a.id === attachmentId)
          if (!att || t.status === 'PM approved' || !canSeeTask(me(), t, s.projectDivisions)) return false
          if (att.by !== s.personaId && me()?.workspaceRole !== 'pm') return false
          const at = stamp()
          set({
            tasks: s.tasks.map((x) => (x.id === taskId
              ? { ...x, attachments: x.attachments.filter((a) => a.id !== attachmentId), activity: [...x.activity, { at, by: s.personaId, text: `removed ${att.name}`, kind: 'attach' }] }
              : x)),
          })
          return true
        },

        // --- chat ------------------------------------------------------------------

        /**
         * Posts as the persona, if they can see the channel. `quoteId` (CH1) quotes another
         * message of the same channel in a main-chat reply. Returns the message id or null.
         * `parentId` (a thread reply) is still accepted so older saved data stays valid, but the
         * chat no longer creates one: threads were removed in client round 3.
         */
        postMessage: (channelId, text, parentId = null, quoteId = null) => {
          const s = get()
          const channel = visibleChannels(me(), s.channels, s.projectDivisions).find((c) => c.id === channelId)
          // A voice channel has no messages of its own (CH3).
          if (!channel || channel.kind === 'voice' || !text.trim()) return null
          if (parentId && !s.messages.some((m) => m.id === parentId && m.channelId === channelId && !m.parentId)) return null
          if (quoteId && !s.messages.some((m) => m.id === quoteId && m.channelId === channelId)) return null
          const tokens = toTokens(text.trim(), s.members, new Set(s.tasks.map((t) => t.id)))
          const next = Math.max(0, ...s.messages.map((m) => Number(m.id.slice(4)) || 0)) + 1
          const id = `MSG-${String(next).padStart(3, '0')}`
          const at = stamp()
          set({
            messages: [...s.messages, { id, channelId, authorId: s.personaId, at, text: tokens, reactions: {}, parentId, quoteId, editedAt: null, deleted: false }],
            // Your own message is read by definition.
            lastRead: { ...get().lastRead, [s.personaId]: { ...get().lastRead[s.personaId], [channelId]: at } },
          })
          return id
        },

        editMessage: (id, text) => {
          const s = get()
          const msg = s.messages.find((m) => m.id === id)
          if (!msg || !text.trim() || !canEditMessage(me(), msg, demoNow()) || !seesChannel(s, msg.channelId)) return false
          const tokens = toTokens(text.trim(), s.members, new Set(s.tasks.map((t) => t.id)))
          const editedAt = stamp()
          set({ messages: get().messages.map((m) => (m.id === id ? { ...m, text: tokens, editedAt } : m)) })
          return true
        },

        /** Leaves a "message deleted" placeholder so replies still make sense. */
        deleteMessage: (id) => {
          const s = get()
          const msg = s.messages.find((m) => m.id === id)
          // The PM may delete any message — in channels they can see; never inside others' DMs.
          if (!msg || !canDeleteMessage(me(), msg, demoNow()) || !seesChannel(s, msg.channelId)) return false
          set({ messages: s.messages.map((m) => (m.id === id ? { ...m, text: '', deleted: true, reactions: {} } : m)) })
          return true
        },

        toggleReaction: (id, emoji) => {
          const s = get()
          const msg = s.messages.find((m) => m.id === id)
          const visible = msg && visibleChannels(me(), s.channels, s.projectDivisions).some((c) => c.id === msg.channelId)
          if (!visible || msg.deleted) return false
          const who = msg.reactions[emoji] || []
          const next = who.includes(s.personaId) ? who.filter((x) => x !== s.personaId) : [...who, s.personaId]
          const reactions = { ...msg.reactions, [emoji]: next }
          if (next.length === 0) delete reactions[emoji]
          set({ messages: s.messages.map((m) => (m.id === id ? { ...m, reactions } : m)) })
          return true
        },

        /** The persona's DM with another team member, created on first use. Returns its id or null. */
        openDm: (otherId) => {
          const s = get()
          if (!me() || otherId === s.personaId || !s.members.some((m) => m.id === otherId)) return null
          const id = dmId(s.personaId, otherId)
          if (!s.channels.some((c) => c.id === id)) {
            set({ channels: [...s.channels, { id, dm: true, memberIds: [s.personaId, otherId].sort(), name: '', projectId: null }] })
          }
          return id
        },

        // --- calls (CH2, simulated) -----------------------------------------------------

        /** Starts a call in a channel or DM the persona can see. One call at a time. */
        startCall: (channelId, video = false) => {
          const s = get()
          if (s.activeCall || !visibleChannels(me(), s.channels, s.projectDivisions).some((c) => c.id === channelId)) return false
          // participantIds: on the call now; joinedIds: everyone who took part, for the log.
          set({ activeCall: { channelId, video: Boolean(video), startedAt: stamp(), hostId: s.personaId, participantIds: [s.personaId], joinedIds: [s.personaId], sharingId: null, notes: [], files: [] } })
          return true
        },

        /** Someone who can see the channel joins (or rejoins) — the persona, or a simulated teammate. */
        joinCall: (memberId) => {
          const s = get()
          const call = s.activeCall
          const who = s.members.find((m) => m.id === (memberId || s.personaId))
          if (!call || !who || call.participantIds.includes(who.id)) return false
          if (!visibleChannels(who, s.channels, s.projectDivisions).some((c) => c.id === call.channelId)) return false
          const joinedIds = call.joinedIds || call.participantIds
          set({ activeCall: { ...call, participantIds: [...call.participantIds, who.id], joinedIds: joinedIds.includes(who.id) ? joinedIds : [...joinedIds, who.id] } })
          return true
        },

        /** Starts or stops the persona sharing their screen; only one person shares at a time. */
        toggleShare: () => {
          const s = get()
          const call = s.activeCall
          if (!call || !call.participantIds.includes(s.personaId)) return false
          set({ activeCall: { ...call, sharingId: call.sharingId === s.personaId ? null : s.personaId } })
          return true
        },

        /**
         * The persona leaves. When the host leaves, or the last person does, the call ends and
         * is logged in the channel: kind, length and who was on it.
         */
        leaveCall: () => {
          const s = get()
          const call = s.activeCall
          if (!call || !call.participantIds.includes(s.personaId)) return false
          const left = call.participantIds.filter((id) => id !== s.personaId)
          if (call.hostId !== s.personaId && left.length) {
            set({ activeCall: { ...call, participantIds: left, sharingId: call.sharingId === s.personaId ? null : call.sharingId } })
            return true
          }
          endCall(call)
          return true
        },

        // --- meetings (CH4) ------------------------------------------------------------

        /** A note typed during the call, by anyone on it. It goes into the meeting record. */
        addCallNote: (text) => {
          const s = get()
          const call = s.activeCall
          const clean = String(text || '').trim().slice(0, 500)
          if (!call || !call.participantIds.includes(s.personaId) || !clean) return false
          const at = stamp()
          const next = Math.max(0, ...(call.notes || []).map((n) => Number(n.id.slice(2)) || 0)) + 1
          set({ activeCall: { ...get().activeCall, notes: [...(call.notes || []), { id: `N-${next}`, by: s.personaId, at, text: clean }] } })
          return true
        },

        /** A file shared during the call: the task-attachment rules and the same storage budget. */
        addCallFile: (file) => {
          const s = get()
          const call = s.activeCall
          if (!call || !call.participantIds.includes(s.personaId)) return { error: 'Join the call to share a file.' }
          const problem = checkFile(file)
          if (problem) return { error: problem }
          const list = call.files || []
          if (list.length >= MAX_PER_TASK) return { error: `A meeting can hold up to ${MAX_PER_TASK} files.` }
          let budget = STORE_BUDGET - keptBytes(fileHolders(s))
          const preview = file.preview && file.preview.length <= budget ? file.preview : undefined
          budget -= preview?.length || 0
          const data = file.data && file.size <= KEEP_WHOLE_BYTES && file.data.length <= budget ? file.data : undefined
          const next = Math.max(0, ...list.map((a) => Number(String(a.id).slice(2)) || 0)) + 1
          const at = stamp()
          const att = { id: `F-${next}`, name: file.name, kind: fileKind(file.name), size: file.size, by: s.personaId, at, preview, data }
          set({ activeCall: { ...get().activeCall, files: [...list, att] } })
          return { id: att.id }
        },

        /** Who may read the minutes and files — the host, or the PM (not for a DM call). */
        setMeetingAccess: (id, { mode, extraIds = [], filesViewOnly }) => {
          const s = get()
          const m = s.meetings.find((x) => x.id === id)
          if (!m || !canManageMeeting(me(), m, s.channels) || !MEETING_ACCESS.includes(mode)) return false
          // A DM call's minutes stay with the people on the call, whatever is asked.
          if (m.dm && mode !== 'participants') return false
          const channel = s.channels.find((c) => c.id === m.channelId)
          // Only people who can open the channel can be named; the rest could never read it.
          const named = [...new Set(extraIds)].filter((x) => canOpenChannel(s.members.find((p) => p.id === x), channel, s.projectDivisions))
          set({
            meetings: s.meetings.map((x) => (x.id === id ? {
              ...x, access: { mode, extraIds: mode === 'people' ? named : [] },
              filesViewOnly: filesViewOnly === undefined ? x.filesViewOnly : Boolean(filesViewOnly),
            } : x)),
          })
          return true
        },

        /** Stores a summary + MOM (AI or offline) on a meeting the persona can read. */
        saveMeetingSummary: (id, summary) => {
          const s = get()
          const m = s.meetings.find((x) => x.id === id)
          if (!m || !summary || !canSeeMeeting(me(), m, s.channels, s.projectDivisions)) return false
          // Writing the first minutes is open to readers; replacing them is the host's (or PM's).
          if (m.summary && !canManageMeeting(me(), m, s.channels)) return false
          // Action items already turned into tasks keep their task, so tasks are never made twice.
          const linked = new Map((m.summary?.actionItems || []).filter((a) => a.taskId).map((a) => [a.text, a.taskId]))
          const isAi = summary.source === 'ai' && ['deepseek', 'openai'].includes(summary.provider)
          const strings = (v) => (Array.isArray(v) ? v.map((x) => String(x).slice(0, 400)).filter(Boolean).slice(0, 20) : [])
          const clean = {
            overview: String(summary.overview || '').slice(0, 1200),
            agenda: strings(summary.agenda), discussion: strings(summary.discussion), decisions: strings(summary.decisions),
            actionItems: (Array.isArray(summary.actionItems) ? summary.actionItems : []).slice(0, 20).map((a) => ({
              text: String(a.text || '').slice(0, 200),
              // Only someone who was on the call owns an action item: a task title must not take
              // the minutes to someone the host never shared them with.
              ownerId: m.participantIds.includes(a.ownerId) ? a.ownerId : null,
              due: /^\d{4}-\d{2}-\d{2}$/.test(a.due || '') ? a.due : null,
            })).filter((a) => a.text).map((a) => (linked.has(a.text) ? { ...a, taskId: linked.get(a.text) } : a)),
            // Provenance is checked, not taken on trust: "AI" only with a known provider.
            source: isAi ? 'ai' : summary.source === 'demo' ? 'demo' : 'offline',
            provider: isAi ? summary.provider : null,
            model: isAi ? String(summary.model || '').slice(0, 60) : null,
            at: stamp(), by: s.personaId,
          }
          set({ meetings: get().meetings.map((x) => (x.id === id ? { ...x, summary: clean } : x)) })
          return true
        },

        /**
         * Turns the action items into tasks through createTask, so the persona's assignment
         * rules apply. Items already turned into a task, without an owner or due date, or for
         * someone the persona may not assign, are skipped. Returns { created[], skipped[] }.
         */
        createTasksFromMeeting: (id) => {
          const s = get()
          const m = s.meetings.find((x) => x.id === id)
          const channel = m && s.channels.find((c) => c.id === m.channelId)
          if (!m?.summary || !canSeeMeeting(me(), m, s.channels, s.projectDivisions)) return { created: [], skipped: [], error: 'You cannot read this meeting.' }
          if (!channel.projectId) return { created: [], skipped: m.summary.actionItems.map((a) => a.text), error: 'Tasks belong to a project; this call was not on one.' }
          const created = []
          const skipped = []
          const items = m.summary.actionItems.map((a) => {
            if (a.taskId) return a
            const taskId = a.ownerId && a.due
              ? get().createTask({ projectId: channel.projectId, title: a.text.slice(0, 80), description: `From meeting ${m.id} (${m.startedAt.slice(0, 10)}).`, assigneeId: a.ownerId, deadline: a.due })
              : null
            if (taskId) created.push(taskId)
            else skipped.push(a.text)
            return taskId ? { ...a, taskId } : a
          })
          set({ meetings: get().meetings.map((x) => (x.id === id ? { ...x, summary: { ...x.summary, actionItems: items } } : x)) })
          return { created, skipped }
        },

        /**
         * Posts the summary in the channel — only when the minutes are open to the whole
         * channel, so posting can never show them to someone the host kept out.
         */
        postMeetingSummary: (id) => {
          const s = get()
          const m = s.meetings.find((x) => x.id === id)
          if (!m?.summary || m.dm || m.access.mode !== 'channel' || !m.logChannelId || m.summaryPostedAt) return null
          if (!canSeeMeeting(me(), m, s.channels, s.projectDivisions)) return null
          // A voice room's access may have changed since the call: check the destination again.
          const room = s.channels.find((c) => c.id === m.channelId && c.kind === 'voice')
          if (room && callLogChannel(room, s.channels, s.members, s.projectDivisions)?.id !== m.logChannelId) return null
          const sum = m.summary
          const text = [
            `Meeting summary (${m.id}): ${sum.overview}`,
            sum.decisions.length ? `Decisions: ${sum.decisions.join('; ')}` : '',
            sum.actionItems.length ? `Action items: ${sum.actionItems.map((a) => `${a.text}${a.ownerId ? ` (@${s.members.find((p) => p.id === a.ownerId)?.name})` : ''}`).join('; ')}` : '',
          ].filter(Boolean).join('\n')
          const msgId = get().postMessage(m.logChannelId, text)
          if (msgId) set({ meetings: get().meetings.map((x) => (x.id === id ? { ...x, summaryPostedAt: demoNow() } : x)) })
          return msgId
        },

        /** The persona's chat status (CH3): online, idle, do not disturb or invisible. */
        setStatus: (status) => {
          if (!me() || !USER_STATUSES.includes(status)) return false
          set({ presence: { ...get().presence, [get().personaId]: status } })
          return true
        },

        // --- channel access (CH5) ------------------------------------------------------

        /**
         * A new text or voice channel on a project (or the company, `projectId` null), by
         * someone who may manage channels there. Returns its id, or null when refused.
         */
        createChannel: ({ projectId = null, kind = 'text', name, topic = '', ...rule }) => {
          const s = get()
          if (!canCreateChannel(me(), projectId, s.projectDivisions)) return null
          if (projectId && !s.projectDivisions[projectId]) return null
          const clean = channelName(name || '', kind)
          const fields = cleanAccess(s, projectId, rule)
          if (!clean || !fields) return null
          const sameServer = s.channels.filter((c) => !c.dm && (c.projectId || null) === projectId)
          if (sameServer.some((c) => (c.kind === 'voice') === (kind === 'voice') && c.name.toLowerCase() === clean.toLowerCase())) return null
          const base = `${kind === 'voice' ? 'vc' : 'ch'}-${(projectId || 'co').toLowerCase()}-${clean.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
          let id = base
          for (let n = 2; s.channels.some((c) => c.id === id); n++) id = `${base}-${n}`
          // A voice channel logs its calls in the server's main text channel (homeChannel).
          const home = homeChannel(s.channels, projectId)
          const channel = {
            id, name: clean, projectId, topic: String(topic).trim().slice(0, 120), ...fields, requests: [],
            ...(kind === 'voice' ? { kind: 'voice', textChannelId: home?.id || null } : {}),
          }
          set({ channels: [...s.channels, channel] })
          return id
        },

        /** Name, topic and who may join — by someone who may manage the channel. */
        updateChannel: (id, patch) => {
          const s = get()
          const c = s.channels.find((x) => x.id === id)
          if (!c || !canManageChannel(me(), c, s.projectDivisions)) return false
          const name = patch.name === undefined ? c.name : channelName(patch.name, c.kind)
          if (!name) return false
          const current = channelAccess(c)
          const fields = cleanAccess(s, c.projectId, { ...current, ...patch }, current.blockedIds)
          if (!fields) return false
          const next = { ...c, name, topic: patch.topic === undefined ? c.topic : String(patch.topic).trim().slice(0, 120), ...fields }
          delete next.division
          set({ channels: s.channels.map((x) => (x.id === id ? next : x)) })
          dropFromCall()
          return true
        },

        /** Asks to be let into a channel the persona can see locked. One open request at a time. */
        requestToJoin: (id, note = '') => {
          const s = get()
          const c = discoverableChannels(me(), s.channels, s.projectDivisions).find((x) => x.id === id)
          if (!c || (c.requests || []).some((r) => r.memberId === s.personaId && r.status === 'pending')) return false
          const at = stamp()
          const request = { memberId: s.personaId, at, note: String(note).trim().slice(0, 200), status: 'pending' }
          // Asking again after a decline replaces the old answer.
          set({ channels: get().channels.map((x) => (x.id === id ? { ...x, requests: [...(x.requests || []).filter((r) => r.memberId !== s.personaId), request] } : x)) })
          return true
        },

        /** Approves (lets them in) or declines a pending join request. */
        decideJoinRequest: (id, memberId, approve) => {
          const s = get()
          const c = s.channels.find((x) => x.id === id)
          if (!c || memberId === s.personaId || !canManageChannel(me(), c, s.projectDivisions)) return false
          if (!(c.requests || []).some((r) => r.memberId === memberId && r.status === 'pending')) return false
          const at = stamp()
          const a = channelAccess(c)
          set({
            channels: get().channels.map((x) => (x.id !== id ? x : {
              ...x,
              requests: x.requests.map((r) => (r.memberId === memberId && r.status === 'pending' ? { ...r, status: approve ? 'approved' : 'declined', decidedBy: s.personaId, decidedAt: at } : r)),
              // The rule is written out in full, so a channel saved in the older shape (only
              // `division`) does not turn invite-only once it has a member list.
              ...(approve ? { access: a.access, divisions: a.divisions, memberIds: [...new Set([...a.memberIds, memberId])], blockedIds: a.blockedIds.filter((b) => b !== memberId) } : {}),
            })),
          })
          return true
        },

        /** Everything in the channel up to its newest message counts as seen by the persona. */
        markRead: (channelId) => {
          const s = get()
          if (!seesChannel(s, channelId)) return
          const newest = s.messages.filter((m) => m.channelId === channelId).reduce((a, m) => (m.at > a ? m.at : a), '')
          if (!newest || s.lastRead[s.personaId]?.[channelId] >= newest) return
          set({ lastRead: { ...s.lastRead, [s.personaId]: { ...s.lastRead[s.personaId], [channelId]: newest } } })
        },

        // --- events & invitations ------------------------------------------------

        /** A draft event with a starter invitation. Returns its id. */
        createEvent: ({ name, clientId = '', projectId = '', date, time = '19:00', venue = '' }) => {
          const s = get()
          const next = Math.max(0, ...s.events.map((e) => Number(e.id.slice(3)) || 0)) + 1
          const id = `EV-${String(next).padStart(2, '0')}`
          // RSVPs close a week before — or on the day itself for an event less than a week out,
          // so a new event is never born with RSVPs already closed.
          const weekBefore = new Date(`${date}T00:00:00Z`)
          weekBefore.setUTCDate(weekBefore.getUTCDate() - 7)
          const rsvpDeadline = weekBefore.toISOString().slice(0, 10) >= DEMO_TODAY ? weekBefore.toISOString().slice(0, 10) : date
          set({
            events: [...s.events, {
              id, name: name.trim(), clientId, projectId, date, time, venue,
              rsvpDeadline,
              status: 'Draft',
              // Prototype only: the client edit link carries this key. The backend will issue a
              // real, revocable token.
              editToken: Math.random().toString(36).slice(2, 10),
              // No template yet: staff or the client start in the gallery (Invitations v2).
              invite: blankInvite({ name: name.trim(), date, time, venue }),
              published: null,
              review: { state: 'editing', submittedAt: null, submittedBy: null, note: '', returnedAt: null },
              holdWishes: false,
              wishes: [],
              broadcasts: [],
              rsvpFields: { email: true, allergies: true, pax: true },
              maxPax: 2,
              tables: ['T1', 'T2', 'T3', 'T4', 'T5'],
              checkpoints: [{ id: 'CP-1', name: 'Main Entrance', categories: [] }],
              feedbackUrl: '',
              customFields: [],
              reminders: [],
              sendLog: [],
            }],
          })
          return id
        },

        /**
         * Event details: name, date, venue, RSVP settings, status. A cleared or invalid date is
         * ignored — every reminder, deadline and report is computed from it.
         */
        updateEvent: (id, patch) => {
          const clean = { ...patch }
          for (const k of ['date', 'rsvpDeadline']) if (k in clean && !isIsoDate(clean[k])) delete clean[k]
          if ('maxPax' in clean) clean.maxPax = Math.min(MAX_PAX_LIMIT, Math.max(1, Number(clean.maxPax) || 1))
          // Publishing is its own step (publishInvite / unpublish), never a field edit.
          delete clean.status
          delete clean.published
          if (Object.keys(clean).length) set((s) => ({ events: s.events.map((e) => (e.id === id ? { ...e, ...clean } : e)) }))
        },

        // --- the invitation draft (Invitations v2) ---------------------------------
        // Staff and the client's link both edit `invite`; guests see `published` (D7).

        /**
         * Picks or changes the template. Content and the user's own toggles are kept. A studio
         * template must be in the gallery to be newly picked; an invitation already on one that
         * was since withdrawn or archived keeps it (and keeps rendering).
         */
        chooseTemplate: (id, templateId) => {
          const tpl = templateById(templateId)
          const ev = get().events.find((e) => e.id === id)
          if (!tpl || !ev || (!inGallery(tpl) && ev.invite.templateId !== templateId)) return false
          set((s) => ({ events: s.events.map((e) => (e.id === id ? { ...e, invite: { ...e.invite, templateId } } : e)) }))
          return true
        },

        /** Switches a section (or the background music) on or off. Required sections stay on. */
        setSection: (id, sectionId, on) => {
          if (sectionId !== MUSIC && (!SECTIONS[sectionId] || SECTIONS[sectionId].required)) return false
          set((s) => ({ events: s.events.map((e) => (e.id === id ? { ...e, invite: { ...e.invite, on: { ...e.invite.on, [sectionId]: Boolean(on) } } } : e)) }))
          return true
        },

        /**
         * Replaces one section's content (cleaned: lib/invites.js cleanSection). Until the event
         * is first published, date, time and venue also go straight onto the event, so its
         * reminders and check-in follow; after that they wait for Publish (D8).
         */
        updateContent: (id, sectionId, value) => {
          const ev = get().events.find((e) => e.id === id)
          if (!ev || !(sectionId in ev.invite.content)) return false
          const clean = cleanSection(value)
          const patch = {}
          if (sectionId === 'details' && !ev.published) {
            if (isIsoDate(clean.date)) patch.date = clean.date
            patch.time = clean.time
            patch.venue = clean.venue
          }
          set((s) => ({
            events: s.events.map((e) => (e.id === id
              ? { ...e, ...patch, invite: { ...e.invite, content: { ...e.invite.content, [sectionId]: clean } } }
              : e)),
          }))
          return true
        },

        /** The client's own accent colour over the template's, or null for the template's. */
        setAccent: (id, hex) => {
          if (hex !== null && !/^#[0-9a-f]{6}$/i.test(hex)) return false
          set((s) => ({ events: s.events.map((e) => (e.id === id ? { ...e, invite: { ...e.invite, accent: hex } } : e)) }))
          return true
        },

        // --- review and publish (Invitations v2, D7) ----------------------------------

        /** The client (or staff) hands the draft to Oscenia for review. */
        submitForReview: (id, by = 'client') => {
          const ev = get().events.find((e) => e.id === id)
          if (!ev?.invite.templateId) return false
          const at = stamp()
          set((s) => ({ events: s.events.map((e) => (e.id === id ? { ...e, review: { state: 'submitted', submittedAt: at, submittedBy: by, note: '', returnedAt: null } } : e)) }))
          return true
        },

        /** Staff send the draft back with a note saying what to change. */
        returnToClient: (id, note) => {
          const text = String(note || '').trim().slice(0, 500)
          const ev = get().events.find((e) => e.id === id)
          if (!ev || !text) return false
          const at = stamp()
          set((s) => ({ events: s.events.map((e) => (e.id === id ? { ...e, review: { ...e.review, state: 'returned', note: text, returnedAt: at } } : e)) }))
          return true
        },

        /**
         * Guests get the draft as it is now. Its date, time and venue go onto the event, so
         * reminders, the RSVP deadline and check-in follow (D8). `clampDeadline` pulls an RSVP
         * deadline that would fall after the new date back to the date itself.
         */
        publishInvite: (id, { clampDeadline = false } = {}) => {
          const ev = get().events.find((e) => e.id === id)
          if (!ev?.invite.templateId) return false
          const d = ev.invite.content.details
          const date = isIsoDate(d.date) ? d.date : ev.date
          const patch = {
            status: 'Published', published: structuredClone(ev.invite), date, time: d.time, venue: d.venue,
            review: { state: 'editing', submittedAt: null, submittedBy: null, note: '', returnedAt: null },
          }
          if (clampDeadline && ev.rsvpDeadline > date) patch.rsvpDeadline = date
          set((s) => ({ events: s.events.map((e) => (e.id === id ? { ...e, ...patch } : e)) }))
          return true
        },

        /** Guests can no longer open the invitation. The last published copy is kept. */
        unpublish: (id) => set((s) => ({ events: s.events.map((e) => (e.id === id ? { ...e, status: 'Draft' } : e)) })),

        /** A leaked client link stops working; the client needs the new one (D14). */
        regenerateEditToken: (id) => {
          const token = Math.random().toString(36).slice(2, 10)
          set((s) => ({ events: s.events.map((e) => (e.id === id ? { ...e, editToken: token } : e)) }))
          return token
        },

        // --- wishes (Invitations v2, D13) ----------------------------------------------
        // Live, not part of the draft: a wish, the hold switch and hiding or approving one
        // all apply straight away. Staff and the client's link may both moderate.

        /**
         * A guest's wish from the invitation page. Only a published invitation that shows the
         * wishes section takes one. A guest from a personal link signs with their listed name;
         * anyone else types one. Each may leave a few, never the same words twice. Returns the
         * wish id, or null when refused.
         */
        addWish: (eventId, { guestId = null, name = '', text = '' } = {}) => {
          const s = get()
          const ev = s.events.find((e) => e.id === eventId)
          const live = liveInvite(ev)
          if (!live || !visibleSections(live).includes('wishes')) return null
          const g = guestId ? s.guests.find((x) => x.id === guestId && x.eventId === eventId) : null
          if (guestId && !g) return null
          const who = String(g?.name || name).trim().slice(0, WISH_LIMITS.name)
          const body = String(text).trim().slice(0, WISH_LIMITS.text)
          if (!who || !body) return null
          const wishes = ev.wishes || []
          const theirs = wishes.filter((w) => (g ? w.guestId === g.id : !w.guestId && w.name.toLowerCase() === who.toLowerCase()))
          if (wishes.length >= WISH_LIMITS.total || theirs.length >= WISH_LIMITS.perGuest || theirs.some((w) => w.text === body)) return null
          const id = `W-${Math.max(0, ...wishes.map((w) => Number(w.id.slice(2)) || 0)) + 1}`
          const at = stamp()
          const wish = { id, guestId: g?.id || null, name: who, text: body, at, hidden: false, approved: !ev.holdWishes }
          set((x) => ({ events: x.events.map((e) => (e.id === eventId ? { ...e, wishes: [...(e.wishes || []), wish] } : e)) }))
          return id
        },

        /** While on, new wishes wait for approval. Wishes already showing stay up. */
        setHoldWishes: (eventId, on) => set((s) => ({ events: s.events.map((e) => (e.id === eventId ? { ...e, holdWishes: Boolean(on) } : e)) })),

        /** Hides a wish from guests, or shows it again. It is kept on record either way. */
        setWishHidden: (eventId, wishId, hidden) => {
          const ev = get().events.find((e) => e.id === eventId)
          if (!ev?.wishes?.some((w) => w.id === wishId)) return false
          set((s) => ({
            events: s.events.map((e) => (e.id === eventId ? { ...e, wishes: e.wishes.map((w) => (w.id === wishId ? { ...w, hidden: Boolean(hidden) } : w)) } : e)),
          }))
          return true
        },

        /** Lets a waiting wish show (and brings back a hidden one). */
        approveWish: (eventId, wishId) => {
          const ev = get().events.find((e) => e.id === eventId)
          if (!ev?.wishes?.some((w) => w.id === wishId)) return false
          set((s) => ({
            events: s.events.map((e) => (e.id === eventId ? { ...e, wishes: e.wishes.map((w) => (w.id === wishId ? { ...w, approved: true, hidden: false } : w)) } : e)),
          }))
          return true
        },

        // --- custom RSVP questions (R7) — staff only; the client's link cannot change them ---

        /** Returns the new question's id, or null at the limit. */
        addQuestion: (eventId, type = 'text') => {
          const ev = get().events.find((e) => e.id === eventId)
          const qs = ev?.customFields || []
          if (!ev || !Object.hasOwn(QUESTION_TYPES, type) || qs.length >= MAX_QUESTIONS) return null
          // Ids are never reused: a removed question's answers stay in guests' records, and a
          // new question must not inherit them.
          const next = Math.max(ev.questionSeq || 0, ...qs.map((q) => Number(q.id.slice(2)) || 0)) + 1
          const q = {
            id: `Q-${next}`, label: '', type, options: type === 'text' ? [] : ['Option 1', 'Option 2'],
            multi: false, required: false, attendingOnly: true,
          }
          set((s) => ({ events: s.events.map((e) => (e.id === eventId ? { ...e, customFields: [...qs, q], questionSeq: next } : e)) }))
          return q.id
        },

        /** Options are trimmed, de-duplicated and never blank; "several answers" is for choices only. */
        updateQuestion: (eventId, qId, patch) => {
          const ev = get().events.find((e) => e.id === eventId)
          if (!ev) return false
          const clean = {}
          if (typeof patch.label === 'string') clean.label = patch.label.slice(0, 200)
          if (Object.hasOwn(QUESTION_TYPES, patch.type ?? '')) clean.type = patch.type
          if (Array.isArray(patch.options)) clean.options = [...new Set(patch.options.map((o) => String(o).trim().slice(0, 100)).filter(Boolean))].slice(0, 20)
          for (const k of ['multi', 'required', 'attendingOnly']) if (k in patch) clean[k] = Boolean(patch[k])
          set((s) => ({
            events: s.events.map((e) => (e.id === eventId
              ? {
                ...e,
                customFields: (e.customFields || []).map((q) => {
                  if (q.id !== qId) return q
                  const merged = { ...q, ...clean }
                  if (merged.type !== 'choice') merged.multi = false
                  if (merged.type === 'text') merged.options = []
                  else if (!merged.options.length && q.type === 'text') merged.options = ['Option 1', 'Option 2']
                  return merged
                }),
              }
              : e)),
          }))
          return true
        },

        moveQuestion: (eventId, qId, dir) => {
          const ev = get().events.find((e) => e.id === eventId)
          const qs = [...(ev?.customFields || [])]
          const i = qs.findIndex((q) => q.id === qId)
          const j = i + (dir < 0 ? -1 : 1)
          if (i < 0 || j < 0 || j >= qs.length) return false
          ;[qs[i], qs[j]] = [qs[j], qs[i]]
          set((s) => ({ events: s.events.map((e) => (e.id === eventId ? { ...e, customFields: qs } : e)) }))
          return true
        },

        /** The question goes; guests' earlier answers stay in their record but are no longer shown. */
        removeQuestion: (eventId, qId) => {
          const ev = get().events.find((e) => e.id === eventId)
          if (!ev || !(ev.customFields || []).some((q) => q.id === qId)) return false
          set((s) => ({ events: s.events.map((e) => (e.id === eventId ? { ...e, customFields: e.customFields.filter((q) => q.id !== qId) } : e)) }))
          return true
        },


        /**
         * A guest's RSVP from the public invitation page — no sign-in. Matched to the client's
         * list by phone or email; anyone else becomes an off-list guest. Returns the guest id,
         * or null when RSVPs are closed or the form is incomplete.
         */
        submitRsvp: (eventId, form) => {
          const s = get()
          const event = s.events.find((e) => e.id === eventId)
          if (!event || !rsvpOpen(event) || !form.name?.trim() || !form.phone?.trim()) return null
          const attending = form.attending === true
          // The event's own questions (R7): a required one left empty refuses the reply.
          const { answers, missing } = cleanAnswers(event, attending, form.answers)
          if (missing.length) return null
          const at = stamp()
          const maxPax = Math.min(event.maxPax, MAX_PAX_LIMIT)
          const answer = {
            name: form.name.trim(),
            phone: form.phone.trim(),
            email: (form.email || '').trim(),
            rsvp: attending ? 'Attending' : 'Declined',
            pax: attending ? Math.min(Math.max(1, Number(form.pax) || 1), maxPax) : 0,
            allergies: attending ? (form.allergies || '').trim() : '',
            consent: Boolean(form.consent),
            consentAt: form.consent ? at : null,
            respondedAt: at,
          }
          // A changed reply replaces the answers to what this guest was asked now; answers to
          // questions they are no longer asked (an accept-only question after declining) go.
          // Answers to a removed question stay in the record, unseen (see removeQuestion).
          const asked = new Set(questionsFor(event, attending).map((q) => q.id))
          // A personal link (R3) names the guest outright; otherwise match by phone or email.
          const byToken = form.token && s.guests.find((g) => g.eventId === eventId && g.token === form.token)
          const existing = byToken || matchGuest(s.guests, eventId, form)
          if (existing) {
            // Keep the client's spelling of the name, any table already assigned, and the
            // email on the list when the guest left that optional field blank. The phone the
            // guest typed wins: it is the one reminders will reach.
            // Consent given before is kept: an unticked box on a changed reply is not a
            // withdrawal (that is an explicit unsubscribe), same as at the walk-in desk.
            set({
              guests: get().guests.map((g) =>
                g.id === existing.id
                  ? {
                    ...g, ...answer, name: g.name, email: answer.email || g.email,
                    answers: {
                      ...Object.fromEntries(Object.entries(g.answers || {}).filter(([id]) => !asked.has(id) && !(event.customFields || []).some((q) => q.id === id))),
                      ...answers,
                    },
                    consent: answer.consent || g.consent,
                    consentAt: answer.consent && !g.consent ? at : g.consentAt,
                  }
                  : g
              ),
            })
            return existing.id
          }
          const next = Math.max(0, ...s.guests.map((g) => Number(g.id.slice(2)) || 0)) + 1
          const id = `G-${String(next).padStart(3, '0')}`
          set({
            guests: [...get().guests, {
              id, eventId, token: newGuestToken(), category: 'Regular', note: '', noteBy: null, noteAt: null,
              onMasterList: false, table: '', checkedInAt: null, walkIn: false, invitedAt: null, invitedVia: null, ...answer, answers,
            }],
          })
          return id
        },

        // --- guest list, reminders, check-in ------------------------------------------

        /** Adds guests to the client's list, skipping phones already on it. Returns how many were added. */
        addGuests: (eventId, rows) => {
          const s = get()
          const known = new Set(s.guests.filter((g) => g.eventId === eventId).map((g) => normPhone(g.phone)))
          let next = Math.max(0, ...s.guests.map((g) => Number(g.id.slice(2)) || 0))
          const added = []
          for (const r of rows) {
            const phone = normPhone(r.phone || '')
            if (!r.name?.trim() || phone.length < 8 || known.has(phone)) continue
            known.add(phone)
            added.push({
              id: `G-${String(++next).padStart(3, '0')}`, eventId, token: newGuestToken(),
              category: toCategory(r.category), note: '', noteBy: null, noteAt: null, answers: {},
              name: r.name.trim(), phone: r.phone.trim(), email: (r.email || '').trim(),
              onMasterList: true, rsvp: null, pax: 0, allergies: '', consent: false, consentAt: null,
              respondedAt: null, table: cleanTable(r.table), checkedInAt: null, walkIn: false, invitedAt: null, invitedVia: null,
            })
          }
          if (added.length) set({ guests: [...s.guests, ...added] })
          return added.length
        },

        /** Any text (round 4), trimmed and capped at MAX_TABLE_LENGTH; empty clears it. */
        setGuestTable: (guestId, table) => {
          const value = cleanTable(table)
          set((s) => ({ guests: s.guests.map((g) => (g.id === guestId ? { ...g, table: value } : g)) }))
          return value
        },

        setGuestCategory: (guestId, category) => {
          if (!GUEST_CATEGORIES.includes(category)) return false
          set((s) => ({ guests: s.guests.map((g) => (g.id === guestId ? { ...g, category } : g)) }))
          return true
        },

        /**
         * Erase a guest's personal data on their request: the row stays (anonymised) so the headcount and the
         * door's history do not change; their link stops working and their wishes go. Cannot be undone.
         */
        eraseGuest: (guestId) => {
          const g = get().guests.find((x) => x.id === guestId)
          if (!g || g.erasedAt) return false
          const at = stamp()
          set((s) => ({
            guests: s.guests.map((x) => (x.id === guestId ? {
              ...x, name: 'Erased guest', phone: '', email: '', allergies: '', answers: {},
              note: '', noteBy: null, noteAt: null, consent: false, consentAt: null,
              token: newGuestToken(), erasedAt: at,
            } : x)),
            events: s.events.map((e) => (e.id === g.eventId ? { ...e, wishes: (e.wishes || []).filter((w) => w.guestId !== guestId) } : e)),
          }))
          return true
        },

        /** Staff-only note on a guest (R5), e.g. why they did not come. Empty text clears it. */
        setGuestNote: (guestId, text, byName) => {
          const note = (text || '').trim()
          const g = get().guests.find((x) => x.id === guestId)
          if (!g || note === (g.note || '')) return false
          const at = stamp()
          set((s) => ({
            guests: s.guests.map((x) => (x.id === guestId
              ? { ...x, note, noteBy: note ? byName || 'Oscenia staff' : null, noteAt: note ? at : null }
              : x)),
          }))
          return true
        },

        /**
         * Adds or corrects a guest's email (e.g. one their invitation email failed for), so a
         * retry can reach them. Empty clears it; anything else must look like an address.
         */
        setGuestEmail: (guestId, email) => {
          const v = String(email || '').trim().slice(0, 200)
          if (v && !isEmail(v)) return false
          if (!get().guests.some((g) => g.id === guestId)) return false
          set((s) => ({ guests: s.guests.map((g) => (g.id === guestId ? { ...g, email: v } : g)) }))
          return true
        },

        addTable: (eventId, name) => {
          const n = name.trim()
          const ev = get().events.find((e) => e.id === eventId)
          if (!n || !ev || ev.tables.includes(n)) return false
          set((s) => ({ events: s.events.map((e) => (e.id === eventId ? { ...e, tables: [...e.tables, n] } : e)) }))
          return true
        },

        /** A D-n reminder, or with when = 'after' a D+n follow-up to the guests who came (R4). */
        addReminder: (eventId, when = 'before') => {
          const ev = get().events.find((e) => e.id === eventId)
          if (!ev) return
          const next = Math.max(0, ...ev.reminders.map((r) => Number(r.id.slice(2)) || 0)) + 1
          const rule = when === 'after'
            ? { id: `R-${next}`, when, daysBefore: 1, audience: 'attended', channel: 'both', active: true, template: FOLLOW_UP_THANKS }
            : {
              id: `R-${next}`, when, daysBefore: 1, audience: 'attending', channel: 'whatsapp', active: true,
              template: 'Hi {name}, see you tomorrow at {event}, {venue}. Please have your QR code ready.',
            }
          set((s) => ({ events: s.events.map((e) => (e.id === eventId ? { ...e, reminders: [...e.reminders, rule] } : e)) }))
        },

        /** Switching a rule between before and after also moves its audience to one that fits. */
        updateReminder: (eventId, ruleId, patch) =>
          set((s) => ({
            events: s.events.map((e) => (e.id === eventId
              ? {
                ...e,
                reminders: e.reminders.map((r) => {
                  if (r.id !== ruleId) return r
                  const merged = { ...r, ...patch }
                  const fits = AUDIENCES[merged.when || 'before']
                  return merged.audience in fits ? merged : { ...merged, audience: Object.keys(fits)[0] }
                }),
              }
              : e)),
          })),

        removeReminder: (eventId, ruleId) =>
          set((s) => ({
            events: s.events.map((e) => (e.id === eventId ? { ...e, reminders: e.reminders.filter((r) => r.id !== ruleId) } : e)),
          })),

        /**
         * Simulated send: records who a rule would reach now, in the send log. Real WhatsApp
         * Business / email delivery arrives with the backend. Returns the count.
         */
        sendReminderNow: (eventId, ruleId) => {
          const s = get()
          const ev = s.events.find((e) => e.id === eventId)
          const rule = ev?.reminders.find((r) => r.id === ruleId)
          if (!rule) return 0
          // A follow-up is about the event that happened: nothing to send before the day.
          if (rule.when === 'after' && DEMO_TODAY < ev.date) return 0
          const count = reminderAudience(rule, s.guests.filter((g) => g.eventId === eventId)).length
          const next = Math.max(0, ...ev.sendLog.map((l) => Number(l.id.slice(3)) || 0)) + 1
          const entry = {
            id: `SL-${next}`, at: stamp(), label: `${ruleLabel(rule)} ${rule.when === 'after' ? 'follow-up' : 'reminder'}`,
            channel: rule.channel, audience: SENT_TO[rule.audience] || 'not replied', count,
          }
          set({ events: get().events.map((e) => (e.id === eventId ? { ...e, sendLog: [...e.sendLog, entry] } : e)) })
          return count
        },

        // --- sending invitations (Invitations v2, D9) ----------------------------------
        // Simulated like the reminders: each guest's outcome comes from lib/broadcasts.js
        // deliveryOf. Only a published invitation can be sent — before that a link opens nothing.

        /**
         * Oscenia sends the invitation by WhatsApp and/or email to all guests, those not
         * invited yet, or one category. With `scheduledAt` the batch is saved as Scheduled: the
         * demo lives on one day, so it waits for "Send now" (the backend sends it on time).
         * Returns the batch id, or null when refused (lib/broadcasts.js broadcastProblem).
         */
        sendBroadcast: (eventId, { channel, subject = '', message = '', audience, scheduledAt = null, by = 'Oscenia staff' } = {}) => {
          const s = get()
          const ev = s.events.find((e) => e.id === eventId)
          const form = { channel, subject: String(subject).trim(), message: String(message).trim(), audience, scheduledAt: scheduledAt || null }
          if (!ev || broadcastProblem(ev, s.guests.filter((g) => g.eventId === eventId), form, demoNow())) return null
          const id = `BC-${Math.max(0, ...(ev.broadcasts || []).map((b) => Number(b.id.slice(3)) || 0)) + 1}`
          const batch = {
            id, mode: 'platform', ...form, subject: channel === 'whatsapp' ? '' : form.subject,
            createdAt: null, by: String(by).slice(0, 80), status: 'scheduled', sentAt: null, recipients: [],
          }
          if (form.scheduledAt) {
            batch.createdAt = stamp()
            set((x) => ({ events: x.events.map((e) => (e.id === eventId ? { ...e, broadcasts: [...(e.broadcasts || []), batch] } : e)) }))
          } else {
            fireBroadcast(eventId, batch)
          }
          return id
        },

        /** A scheduled batch goes now, to its audience as it stands now. Returns how many guests. */
        sendScheduledNow: (eventId, broadcastId) => {
          const ev = get().events.find((e) => e.id === eventId)
          const b = ev?.broadcasts?.find((x) => x.id === broadcastId)
          if (!b || b.status !== 'scheduled' || broadcastProblem(ev, get().guests.filter((g) => g.eventId === eventId), { ...b, scheduledAt: null })) return 0
          return fireBroadcast(eventId, b)
        },

        /** A scheduled batch that has not gone yet is called off (kept in the history). */
        cancelBroadcast: (eventId, broadcastId) => {
          const ev = get().events.find((e) => e.id === eventId)
          if (ev?.broadcasts?.find((x) => x.id === broadcastId)?.status !== 'scheduled') return false
          set((s) => ({ events: s.events.map((e) => (e.id === eventId ? { ...e, broadcasts: e.broadcasts.map((b) => (b.id === broadcastId ? { ...b, status: 'cancelled' } : b)) } : e)) }))
          return true
        },

        /**
         * Sends a batch's failed messages again. A guest whose details have since been fixed
         * (an email added) gets it; the rest stay failed, with the reason as it is now.
         * Returns how many messages went through this time.
         */
        retryFailed: (eventId, broadcastId) => {
          const s = get()
          const ev = s.events.find((e) => e.id === eventId)
          const b = ev?.broadcasts?.find((x) => x.id === broadcastId)
          if (!b || b.status !== 'sent' || ev.status !== 'Published') return 0
          const byId = new Map(s.guests.map((g) => [g.id, g]))
          const again = b.recipients.map((r) => (r.status === 'failed' && byId.has(r.guestId) ? deliveryOf(byId.get(r.guestId), r.channel) : null))
          const fixed = again.filter((o) => o && o.status !== 'failed').length
          if (!fixed) return 0
          const at = stamp()
          const recipients = b.recipients.map((r, i) => (again[i] ? { ...r, ...again[i], at: again[i].status === 'failed' ? r.at : at } : r))
          const reached = new Set(recipients.filter((r, i) => again[i] && r.status !== 'failed').map((r) => r.guestId))
          const entry = {
            id: `SL-${Math.max(0, ...ev.sendLog.map((l) => Number(l.id.slice(3)) || 0)) + 1}`, at,
            label: 'Invitation (retry)', channel: b.channel, audience: audienceLabel(b.audience), count: reached.size,
          }
          set({
            events: get().events.map((e) => (e.id === eventId
              ? { ...e, broadcasts: e.broadcasts.map((x) => (x.id === broadcastId ? { ...x, recipients } : x)), sendLog: [...e.sendLog, entry] }
              : e)),
            guests: get().guests.map((g) => (reached.has(g.id) ? { ...g, invitedAt: at, invitedVia: 'platform' } : g)),
          })
          return fixed
        },

        /** The client sent this guest their link from their own WhatsApp (or copied it to send). */
        markSentByClient: (eventId, guestId) => {
          const ev = get().events.find((e) => e.id === eventId)
          if (ev?.status !== 'Published' || !get().guests.some((g) => g.id === guestId && g.eventId === eventId)) return false
          const at = stamp()
          set((s) => ({ guests: s.guests.map((g) => (g.id === guestId ? { ...g, invitedAt: at, invitedVia: 'client' } : g)) }))
          return true
        },

        /**
         * One scan of a guest at one checkpoint (R1). Every scan is logged: a repeat, or a guest
         * outside the checkpoint's categories, is for the desk to judge, so the screen warns and
         * the store records. The first scan anywhere is their arrival. Returns the scan id.
         */
        scanGuest: (guestId, checkpointId) => {
          const s = get()
          const g = s.guests.find((x) => x.id === guestId)
          const ev = g && s.events.find((e) => e.id === g.eventId)
          if (!ev || !eventCheckpoints(ev).some((c) => c.id === checkpointId)) return null
          const at = stamp()
          const id = nextScanId(s.scans)
          set({
            scans: [...s.scans, { id, eventId: ev.id, guestId, checkpointId, at }],
            guests: g.checkedInAt ? s.guests : s.guests.map((x) => (x.id === guestId ? { ...x, checkedInAt: at } : x)),
          })
          return id
        },

        /** Arrival at the first checkpoint; false if they have already arrived. */
        checkIn: (guestId) => {
          const g = get().guests.find((x) => x.id === guestId)
          if (!g || g.checkedInAt) return false
          const ev = get().events.find((e) => e.id === g.eventId)
          return Boolean(get().scanGuest(guestId, eventCheckpoints(ev)[0].id))
        },

        /**
         * Undoes the guest's latest scan; with none left they have not arrived. A walk-in keeps
         * their first scan: it is their whole record.
         */
        undoCheckIn: (guestId) => {
          const s = get()
          const g = s.guests.find((x) => x.id === guestId)
          if (!g || !g.checkedInAt) return false
          const mine = s.scans.filter((x) => x.guestId === guestId).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
          if (g.walkIn && mine.length <= 1) return false
          const last = mine.at(-1)
          set({
            scans: last ? s.scans.filter((x) => x.id !== last.id) : s.scans,
            guests: mine.length > 1 ? s.guests : s.guests.map((x) => (x.id === guestId ? { ...x, checkedInAt: null } : x)),
          })
          return true
        },

        addCheckpoint: (eventId, name) => {
          const n = (name || '').trim()
          const ev = get().events.find((e) => e.id === eventId)
          const cps = eventCheckpoints(ev)
          if (!n || !ev || cps.some((c) => c.name.toLowerCase() === n.toLowerCase())) return false
          const next = Math.max(0, ...cps.map((c) => Number(c.id.slice(3)) || 0)) + 1
          set((s) => ({ events: s.events.map((e) => (e.id === eventId ? { ...e, checkpoints: [...cps, { id: `CP-${next}`, name: n, categories: [] }] } : e)) }))
          return true
        },

        /** Rename a checkpoint or set who it admits (an empty list = everyone). */
        updateCheckpoint: (eventId, checkpointId, patch) => {
          const ev = get().events.find((e) => e.id === eventId)
          if (!ev) return false
          const clean = {}
          if (typeof patch.name === 'string' && patch.name.trim()) clean.name = patch.name.trim()
          if (Array.isArray(patch.categories)) clean.categories = patch.categories.filter((c) => GUEST_CATEGORIES.includes(c))
          set((s) => ({
            events: s.events.map((e) => (e.id === eventId
              ? { ...e, checkpoints: eventCheckpoints(e).map((c) => (c.id === checkpointId ? { ...c, ...clean } : c)) }
              : e)),
          }))
          return true
        },

        /** The last checkpoint stays, and so does one with scans: its log would lose its place. */
        removeCheckpoint: (eventId, checkpointId) => {
          const s = get()
          const ev = s.events.find((e) => e.id === eventId)
          const cps = eventCheckpoints(ev)
          if (!ev || cps.length <= 1 || s.scans.some((x) => x.eventId === eventId && x.checkpointId === checkpointId)) return false
          set({ events: s.events.map((e) => (e.id === eventId ? { ...e, checkpoints: cps.filter((c) => c.id !== checkpointId) } : e)) })
          return true
        },

        /**
         * A guest registering at the desk by scanning the walk-in QR (decision 10). Someone on
         * the list is simply checked in; anyone else is added as a walk-in. Either way their
         * consent choice is recorded for the CRM. Returns { id, walkIn } or null.
         */
        registerWalkIn: (eventId, form) => {
          const s = get()
          const ev = s.events.find((e) => e.id === eventId)
          if (!ev || ev.status !== 'Published' || !form.name?.trim() || normPhone(form.phone || '').length < 8) return null
          const at = stamp()
          const consent = Boolean(form.consent)
          const listed = s.guests.find((g) => g.eventId === eventId && normPhone(g.phone) === normPhone(form.phone))
          const entrance = eventCheckpoints(ev)[0].id
          if (listed) {
            // One write, so another tab never sees the scan without the arrival or vice versa.
            set({
              scans: listed.checkedInAt ? s.scans : [...s.scans, { id: nextScanId(s.scans), eventId, guestId: listed.id, checkpointId: entrance, at }],
              guests: get().guests.map((g) => (g.id === listed.id ? {
                ...g,
                checkedInAt: g.checkedInAt || at,
                email: g.email || (form.email || '').trim(),
                // Ticking the box here adds consent; leaving it unticked does not withdraw an
                // earlier yes given on the RSVP form.
                consent: consent || g.consent,
                consentAt: consent && !g.consent ? at : g.consentAt,
              } : g)),
            })
            return { id: listed.id, walkIn: false }
          }
          const next = Math.max(0, ...s.guests.map((g) => Number(g.id.slice(2)) || 0)) + 1
          const id = `G-${String(next).padStart(3, '0')}`
          set({
            scans: [...s.scans, { id: nextScanId(s.scans), eventId, guestId: id, checkpointId: entrance, at }],
            guests: [...get().guests, {
              id, eventId, token: newGuestToken(), category: 'Regular', note: '', noteBy: null, noteAt: null, answers: {},
              name: form.name.trim(), phone: form.phone.trim(), email: (form.email || '').trim(),
              onMasterList: false, rsvp: null, pax: 1, allergies: '', consent, consentAt: consent ? at : null,
              respondedAt: null, table: '', checkedInAt: at, walkIn: true, invitedAt: null, invitedVia: null,
            }],
          })
          return { id, walkIn: true }
        },

        // --- notifications -------------------------------------------------------------

        markNotificationRead: (id) =>
          set((s) => {
            const r = s.notifRead[s.personaId] || { seenAt: '', ids: [] }
            if (r.ids.includes(id)) return {}
            // Only the recent ones matter; older items are covered by seenAt.
            return { notifRead: { ...s.notifRead, [s.personaId]: { ...r, ids: [...r.ids, id].slice(-200) } } }
          }),

        markAllNotificationsRead: () => {
          const seenAt = demoNow()
          set((s) => ({ notifRead: { ...s.notifRead, [s.personaId]: { seenAt, ids: [] } } }))
        },

        // --- CRM relationship layer ---------------------------------------------------

        /**
         * Company-level settings: anniversary, its greeting, how early to nudge. A client added
         * after the seed has no record yet, so it starts from EMPTY_RELATION.
         */
        updateRelation: (clientId, patch) =>
          set((s) => ({ relations: { ...s.relations, [clientId]: { ...EMPTY_RELATION, ...s.relations[clientId], ...patch } } })),

        /** Adds or edits a PIC. Birthday is MM-DD. Returns false when name or birthday is missing/invalid. */
        savePic: (clientId, pic) => {
          const r = { ...EMPTY_RELATION, ...get().relations[clientId] }
          if (!pic.name?.trim() || (pic.birthday && !isMonthDay(pic.birthday))) return false
          const clean = { greet: true, channel: 'whatsapp', role: '', phone: '', email: '', birthday: '', ...pic, name: pic.name.trim() }
          const pics = clean.id
            ? r.pics.map((p) => (p.id === clean.id ? clean : p))
            : [...r.pics, { ...clean, id: `P-${clientId.slice(3)}${Date.now().toString(36).slice(-4)}` }]
          get().updateRelation(clientId, { pics })
          return true
        },

        removePic: (clientId, picId) => {
          const r = get().relations[clientId]
          if (r) get().updateRelation(clientId, { pics: r.pics.filter((p) => p.id !== picId) })
        },

        /**
         * Staff reached out about an upcoming edition: the nudge leaves the calendar, and the
         * outreach lands in the client's interaction history in the main CRM.
         */
        handleNudge: (clientId, key, note) => {
          const r = { ...EMPTY_RELATION, ...get().relations[clientId] }
          const at = stamp()
          // Kept here as well as in the main CRM: without a backend the main store is not
          // saved, and the record of who was called must not vanish on reload.
          get().updateRelation(clientId, {
            handledNudges: [...(r.handledNudges || []), key],
            outreach: [...(r.outreach || []), { key, at, note }],
          })
          useStore.getState().logInteraction(clientId, { type: 'Call', note })
        },

        /** Simulated greeting send, recorded in the greeting log. */
        sendGreeting: ({ clientId, kind, to, channel }) => {
          const s = get()
          const next = Math.max(0, ...s.greetingLog.map((l) => Number(l.id.slice(3)) || 0)) + 1
          const at = stamp()
          set({ greetingLog: [...get().greetingLog, { id: `GL-${next}`, at, clientId, kind, to, channel }] })
        },

        /**
         * Simulated marketing campaign. Consent is enforced here, not trusted from the screen:
         * whoever is passed in, only contacts who agreed are counted as recipients.
         */
        /**
         * A campaign to the ticked contacts (C1). The audience is rebuilt here from the keys —
         * never taken from the screen — and only those with marketing consent receive it; the
         * rest are counted as skipped. Returns the entry, or null when nobody would receive it.
         */
        createCampaign: ({ name, channel, keys }) => {
          const s = get()
          const { recipients, skipped } = campaignAudience(guestContacts(s.guests, s.events), keys || [])
          if (!recipients.length || !name?.trim()) return null
          const next = Math.max(0, ...s.campaigns.map((c) => Number(String(c.id).slice(4)) || 0)) + 1
          const entry = {
            id: `CMP-${next}`, at: stamp(), name: name.trim(), channel,
            count: recipients.length, skipped: skipped.length, keys: recipients.map((c) => c.key),
          }
          set({ campaigns: [...s.campaigns, entry] })
          return entry
        },

        // --- Template Studio (client round 3) ---------------------------------------------
        //
        // The design team's own invitation templates. Like the vendor actions, the ERP login
        // decides who may (`manage_templates`: CEO and PMs), so the role comes from the caller.
        // Invitations store only a template id: a change to a template in use reaches its
        // guests at once (the studio warns), and nothing is ever hard-deleted — archived ones
        // leave the gallery but keep drawing the invitations already on them.

        /** A new draft — blank, or a copy of `from` (a built-in or studio template). Its id, or null. */
        createTemplate: ({ from = null, family = 'private' } = {}, role) => {
          if (!canDo(role, 'manage_templates')) return null
          const base = from ? templateById(from) : null
          if (from && !base) return null
          const n = Math.max(0, ...get().customTemplates.map((t) => Number(t.id.split('-')[1]) || 0)) + 1
          const at = stamp()
          const t = { ...newTemplate({ id: `studio-${n}`, from: base, family }), createdAt: at, updatedAt: at, by: ROLES[role]?.name || 'Oscenia staff' }
          if (validateTemplate(t)) return null
          set((s) => ({ customTemplates: [...s.customTemplates, t] }))
          return t.id
        },

        /**
         * Saves the editor's settings (name, tagline, family, colours, fonts, cover, ornament,
         * section order and defaults). Null when saved; otherwise why not. Archived templates
         * are restored before they are edited.
         */
        updateTemplate: (id, patch, role) => {
          if (!canDo(role, 'manage_templates')) return 'This login cannot design templates.'
          const cur = get().customTemplates.find((t) => t.id === id)
          if (!cur) return 'Unknown template.'
          if (cur.status === 'archived') return 'Restore the template before editing it.'
          const keep = ['name', 'tagline', 'family', 'palette', 'fonts', 'cover', 'ornament', 'sections', 'off']
          const clean = Object.fromEntries(Object.entries(patch || {}).filter(([k]) => keep.includes(k)))
          if (typeof clean.name === 'string') clean.name = clean.name.trim()
          if (typeof clean.tagline === 'string') clean.tagline = clean.tagline.trim()
          const next = { ...cur, ...clean }
          const problem = validateTemplate(next)
          if (problem) return problem
          next.updatedAt = stamp()
          set((s) => ({ customTemplates: s.customTemplates.map((t) => (t.id === id ? next : t)) }))
          return null
        },

        /** The signed-out demo has no server: an upload is kept in this browser (lib/mediaStore.js). */
        uploadMedia: (blob, { name, type } = {}) => putMedia(blob, { name, type }),

        /** Sets or clears one artwork file (a lib/mediaStore.js reference) on a template. */
        setTemplateArt: (id, slot, ref, role) => {
          if (!canDo(role, 'manage_templates') || !ART_SLOTS.includes(slot)) return false
          // A photo file only (JPG, PNG, WebP — never SVG); some systems send no type, then the name decides.
          const photo = (r) => /^image\/(jpeg|png|webp)$/.test(r.type || '') || (!r.type && /\.(jpe?g|png|webp)$/i.test(r.name || ''))
          if (ref !== null && !(ref && typeof ref.key === 'string' && photo(ref))) return false
          const cur = get().customTemplates.find((t) => t.id === id)
          if (!cur || cur.status === 'archived') return false
          const at = stamp()
          set((s) => ({ customTemplates: s.customTemplates.map((t) => (t.id === id ? { ...t, art: { ...t.art, [slot]: ref }, updatedAt: at } : t)) }))
          return true
        },

        /** Add to gallery / take out of it (back to draft) / archive. Archived → draft restores. */
        publishTemplate: (id, role) => setTemplateStatus(id, 'published', role),
        unpublishTemplate: (id, role) => setTemplateStatus(id, 'draft', role),
        archiveTemplate: (id, role) => setTemplateStatus(id, 'archived', role),

        // --- PO delivery (V1) ------------------------------------------------------------

        /** Delivery on a live order only — a draft or a cancelled PO has nothing to deliver. */
        setPoDelivery: (po, status, byName) => {
          if (!po || !DELIVERY_STATUSES.includes(status) || po.status === 'Draft' || po.status === 'Cancelled') return false
          set((s) => ({ poDelivery: { ...s.poDelivery, [po.id]: { status, at: stamp(), by: byName || 'Oscenia staff' } } }))
          return true
        },

        // --- vendor lifecycle (V2) -------------------------------------------------------
        //
        // The ERP login decides who may approve (Vendors is an ERP module), so the role and name
        // come from the caller rather than from the "Viewing as" persona. `hasLivePo` comes from
        // the ERP store's purchase orders. Returns null when done, or the reason it was refused.

        setVendorStage: (vendor, to, { role, by, reason = '', hasLivePo = false } = {}) => {
          const key = vendorKey(vendor)
          if (!key) return 'Unknown vendor.'
          const entry = get().vendorStages[key]
          const from = vendorStageOf(get().vendorStages, key)
          const error = vendorStageError({
            from, to, reason, hasLivePo,
            canApprove: canDo(role, 'approve_po'),
            checklistComplete: vendorChecklist(vendor, entry?.checks).complete,
            resumeTo: resumeStageOf(entry),
          })
          if (error) return error
          // Bringing a vendor in or moving it forward only needs access to Vendors.
          if (!canDo(role, 'request_po') && !canDo(role, 'approve_po')) return 'This login cannot change vendors.'
          const at = stamp()
          const row = { stage: to, at, by: by || 'Oscenia staff', ...(reason.trim() ? { reason: reason.trim() } : {}) }
          set((s) => {
            const cur = s.vendorStages[key]
            return {
              vendorStages: {
                ...s.vendorStages,
                [key]: {
                  ...row,
                  checks: cur?.checks || {},
                  // A vendor never recorded before starts its history at the stage it was in.
                  history: [...(cur?.history || [{ stage: from, at: null, by: null }]), row],
                },
              },
            }
          })
          return null
        },

        /** A new vendor enters the board as a Prospect. */
        addVendorProspect: (vendorId, by) => {
          if (!vendorId || get().vendorStages[vendorId]) return false
          const at = stamp()
          const row = { stage: VENDOR_STAGES[0], at, by: by || 'Oscenia staff' }
          set((s) => ({ vendorStages: { ...s.vendorStages, [vendorId]: { ...row, checks: {}, history: [row] } } }))
          return true
        },

        /** Tick or untick a hand-checked onboarding item. Once approved, the checklist is settled. */
        toggleVendorCheck: (vendorId, key, role) => {
          if (!MANUAL_CHECKS.includes(key)) return false
          if (!canDo(role, 'request_po') && !canDo(role, 'approve_po')) return false
          const stage = vendorStageOf(get().vendorStages, vendorId)
          if (stage !== 'Prospect' && stage !== 'Onboarding') return false
          set((s) => {
            const cur = s.vendorStages[vendorId] || { stage, at: null, by: null, history: [] }
            const checks = { ...(cur.checks || {}), [key]: !cur.checks?.[key] }
            return { vendorStages: { ...s.vendorStages, [vendorId]: { ...cur, checks } } }
          })
          return true
        },

        // --- Google Calendar (C2, simulated) --------------------------------------------

        connectGoogle: (account) => {
          if (!isEmail(account)) return false
          set((s) => ({ googleCalendar: { ...s.googleCalendar, connected: true, account: account.trim(), connectedAt: stamp() } }))
          return true
        },

        disconnectGoogle: () =>
          set((s) => ({ googleCalendar: { ...s.googleCalendar, connected: false, account: '', connectedAt: null, addCrmDates: false } })),

        setGoogleOption: (patch) =>
          set((s) => ({
            googleCalendar: {
              ...s.googleCalendar,
              ...('showGoogle' in patch ? { showGoogle: Boolean(patch.showGoogle) } : {}),
              ...('addCrmDates' in patch && s.googleCalendar.connected ? { addCrmDates: Boolean(patch.addCrmDates) } : {}),
            },
          })),

        // --- team & access (PM only) ----------------------------------------------

        toggleProjectDivision: (projectId, division) => {
          if (me()?.workspaceRole !== 'pm') return false
          set((s) => {
            const current = s.projectDivisions[projectId] || []
            const next = current.includes(division) ? current.filter((d) => d !== division) : [...current, division]
            return { projectDivisions: { ...s.projectDivisions, [projectId]: next } }
          })
          return true
        },

        /** Staff and interns join projects one by one; leaders follow their division. */
        toggleMemberProject: (memberId, projectId) => {
          if (me()?.workspaceRole !== 'pm') return false
          set((s) => ({
            members: s.members.map((m) => {
              if (m.id !== memberId || !['staff', 'intern'].includes(m.workspaceRole)) return m
              const ids = m.projectIds || []
              return { ...m, projectIds: ids.includes(projectId) ? ids.filter((p) => p !== projectId) : [...ids, projectId] }
            }),
          }))
          return true
        },

        /** Back to the seeded demo, in this tab and (via storage) every other one. */
        resetDemo: () => {
          set(seedState())
          clearMedia()
          useStore.getState().resetDemoClients()
          useStore.getState().resetDemoVendors()
        },
      }
    },
    {
      name: STORAGE_KEY,
      version: VERSION,
      storage: createJSONStorage(() => guardedLocalStorage),
      // Only shared data is saved; actions come from the code. The persona is left out: it is
      // this tab's "who am I viewing as", so two tabs can show two people side by side.
      partialize: (s) => Object.fromEntries(Object.entries(s).filter(([k, v]) => typeof v !== 'function' && k !== 'personaId')),
      // …and a copy saved before that rule must not overwrite this tab's persona either.
      // A demo saved at this version before the voice channels existed (CH3, same round-2 bump)
      // gets them added rather than going without.
      merge: (saved, current) => {
        const out = { ...current, ...saved, personaId: current.personaId }
        // Studio templates (round 3) are a list or nothing; each one is re-validated when registered.
        if (!Array.isArray(out.customTemplates)) out.customTemplates = []
        if (Array.isArray(saved?.channels) && !saved.channels.some((c) => c.kind === 'voice')) {
          out.channels = [...saved.channels, ...current.channels.filter((c) => c.kind === 'voice')]
        }
        // …and, saved before company #general existed (CH3), it gets the channel and the Lounge logs there.
        if (Array.isArray(out.channels) && !out.channels.some((c) => c.id === 'ch-general')) {
          const general = current.channels.find((c) => c.id === 'ch-general')
          if (general) out.channels = [...out.channels, general].map((c) => (c.id === 'vc-lounge' ? { ...c, textChannelId: 'ch-general' } : c))
        }
        // …and, saved before meetings existed, its seeded call lines are linked to theirs.
        if (Array.isArray(saved?.messages) && !saved.meetings) {
          const links = new Map(current.messages.filter((x) => x.meetingId).map((x) => [x.id, x.meetingId]))
          out.messages = saved.messages.map((x) => (links.has(x.id) && x.kind === 'call' && !x.meetingId ? { ...x, meetingId: links.get(x.id) } : x))
        }
        return out
      },
      // A saved copy from another version is dropped rather than half-merged.
      migrate: () => seedState(),
    }
  )
)

// The design team's templates are read everywhere through lib/templates.js (templateById,
// themeOf…), which is plain data with no store: hand them over now and on every change —
// an action, a reset, or a rehydrate when another tab saved one.
registerTemplates(useProto.getState().customTemplates)
useProto.subscribe((s, prev) => {
  if (s.customTemplates !== prev.customTemplates) registerTemplates(s.customTemplates)
})

// Another tab wrote (an RSVP, a check-in): re-read so this tab shows it without a refresh.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) useProto.persist.rehydrate()
  })
}

/** The member currently being viewed as. */
export const selectPersona = (s) => s.members.find((m) => m.id === s.personaId) || s.members[0]

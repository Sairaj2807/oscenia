// Server → screen, for team chat.
//
// The chat screens were written against the prototype's own data: people are `M-05`, channels
// have `memberIds` and `blockedIds`, a message's time is "2026-07-24T11:00" in Jakarta wall
// clock. The server speaks UUIDs and ISO instants. These pure functions are the whole seam —
// no store, no browser — so `scripts/verify-chat-adapters.mjs` can run them under Node.
//
// ---------------------------------------------------------------------------
// The one subtle part: agreeing with the server about who can open what
// ---------------------------------------------------------------------------
// The server decides what each person may open, and sends two lists: channels they can open
// and channels they can see locked. But the screens *also* run the prototype's access rules
// (`visibleChannels`, `discoverableChannels` in lib/workspaceAccess.js) over `channels` to draw
// the sidebar. Those rules read `memberIds` and `blockedIds`, which the server only shows to
// whoever can manage a channel — so left alone, an invite-only channel you were let into would
// look closed to the client and vanish.
//
// So `adaptChannel` fills the gaps just enough that the client's rules reach the server's
// answer: a channel the server says you can open lists you among its members (the project
// check still applies); one it says is locked does not. `verify-chat-adapters.mjs` proves the
// two agree over every shape of channel the server can send.

import { fileUrl } from '../lib/api.js'

const TZ = 'Asia/Jakarta'

const wallFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/**
 * An instant as the screens write it: "2026-07-24T11:00", Jakarta wall clock. Minute
 * precision is deliberate — `startsGroup`, the day dividers and `canEditMessage` all read this
 * string — so messages in one minute are ordered by `seq`, not by this.
 */
export function wall(instant) {
  if (!instant) return ''
  const d = instant instanceof Date ? instant : new Date(instant)
  if (Number.isNaN(d.getTime())) return ''
  const p = Object.fromEntries(wallFormat.formatToParts(d).map((x) => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`
}

/** The current moment in the same form, corrected by how far the server's clock is from ours. */
export const nowWall = (offsetMs = 0) => wall(new Date(Date.now() + offsetMs))

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/** A server member → the prototype's member. `id` is the member number: it is what stored
 *  message text mentions (`<@M-05>`). The UUID is kept for the calls that need it.
 *
 *  `projectIds` carries each project twice — the server's UUID (what channels point at) and the
 *  business number `EVT-…` (what the workspace pages and the project routes use) — so the
 *  prototype's rules, which compare ids, work on either unchanged. */
export function adaptMember(m, projectNoOf) {
  // (`.map(adaptMember)` passes an index here; only a Map counts.)
  const nos = projectNoOf instanceof Map ? projectNoOf : new Map()
  const uuids = m.projectIds || []
  const both = uuids.flatMap((id) => (nos.get(id) && nos.get(id) !== id ? [id, nos.get(id)] : [id]))
  return {
    id: m.memberNo,
    uuid: m.id,
    name: m.name,
    initials: m.initials,
    workspaceRole: m.workspaceRole,
    division: m.division || undefined,
    title: m.title || undefined,
    projectIds: both,
  }
}

/** Lookups between the two kinds of id. */
export function makeContext(meUuid, members) {
  const noOfUuid = new Map(members.map((m) => [m.uuid, m.id]))
  const uuidOfNo = new Map(members.map((m) => [m.id, m.uuid]))
  return {
    meUuid,
    meNo: noOfUuid.get(meUuid) || null,
    noOf: (uuid) => noOfUuid.get(uuid) || uuid,
    uuidOf: (no) => uuidOfNo.get(no) || null,
    has: (no) => uuidOfNo.has(no),
  }
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

const unique = (list) => [...new Set(list)]

/**
 * A server channel → the prototype's channel.
 *
 * `locked` is the server's answer (it is in the second list: visible but not openable).
 */
export function adaptChannel(c, ctx) {
  const locked = Boolean(c.locked)
  const known = (c.memberIds || []).map(ctx.noOf)
  let memberIds
  if (c.isDm) {
    // A DM is its two people; the server names the other one.
    memberIds = unique([ctx.meNo, ctx.noOf(c.dmWith)]).sort()
  } else if (locked) {
    memberIds = known.filter((id) => id !== ctx.meNo)
  } else {
    // Open to me: list me, so the client's rules agree even if I was let in by name.
    memberIds = unique([...known, ctx.meNo])
  }
  // Sent only to those who manage the channel; otherwise nothing to show.
  const blockedIds = (c.blockedIds || []).map(ctx.noOf)

  const mine = c.myRequest
    ? [{ memberId: ctx.meNo, status: c.myRequest, at: '', decidedBy: null, note: '' }]
    : []

  return {
    id: c.id,
    key: c.key || null,
    name: c.name || '',
    topic: c.topic || '',
    projectId: c.projectId || null,
    projectNo: c.projectNo || null,
    access: c.access,
    divisions: c.divisions || [],
    listed: c.listed,
    dm: Boolean(c.isDm),
    memberIds,
    blockedIds,
    requests: mine,
    // What the server knows that the prototype's channel did not:
    locked,
    canManage: Boolean(c.canManage),
    rev: c.rev || 0,
    lastReadSeq: c.lastReadSeq || 0,
    unread: c.unread || 0,
    unreadMentions: c.unreadMentions || 0,
  }
}

/** `{ [projectId]: divisions }`, which the access rules read. Keyed by the UUID and by the
 *  business number, for the same reason as `adaptMember`. */
export function projectDivisionsFrom(projects) {
  const out = {}
  for (const p of projects) {
    out[p.id] = p.divisions || []
    if (p.projectNo && p.projectNo !== p.id) out[p.projectNo] = p.divisions || []
  }
  return out
}

/** The projects as the rail and the workspace's project cards want them. `id` is the UUID; the
 *  workspace pages use `projectNo` as the id (see `useWorkspaceProjects`). No money here. */
export const adaptProjects = (projects) =>
  projects.map((p) => ({
    id: p.id, name: p.name, projectNo: p.projectNo,
    client: p.clientName || '', eventDate: p.eventDate || '', pm: p.pmName || '', stage: p.stage || '',
  }))

/** A join request → the prototype's `{ memberId, at, note, status, decidedBy }`, plus its id. */
export function adaptJoinRequest(r, ctx) {
  return {
    id: r.id,
    memberId: ctx.noOf(r.userId),
    at: wall(r.createdAt),
    note: r.note || '',
    status: r.status,
    decidedBy: r.decidedBy ? ctx.noOf(r.decidedBy) : null,
    decidedAt: r.decidedAt ? wall(r.decidedAt) : null,
  }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export function adaptAttachment(a) {
  return { id: a.id, filename: a.filename, contentType: a.contentType, sizeBytes: a.sizeBytes, url: fileUrl(a.url) }
}

/** A server message → the prototype's message. `kind` is left off for an ordinary one: the
 *  screens read "no kind" as "an ordinary text message" (it is what lets you edit it). */
export function adaptMessage(m, ctx) {
  const reactions = {}
  for (const [emoji, who] of Object.entries(m.reactions || {})) {
    if (who.length) reactions[emoji] = who.map(ctx.noOf)
  }
  const out = {
    id: m.id,
    channelId: m.channelId,
    authorId: m.authorNo || ctx.noOf(m.authorId),
    at: wall(m.createdAt),
    text: m.text,
    reactions,
    parentId: null,
    quoteId: m.quoteId || null,
    editedAt: m.editedAt ? wall(m.editedAt) : null,
    deleted: Boolean(m.deleted),
    seq: m.seq,
    rev: m.rev,
    mentions: m.mentions || [],
    attachments: (m.attachments || []).map(adaptAttachment),
    clientMsgId: m.clientMsgId || null,
  }
  if (m.kind && m.kind !== 'text') out.kind = m.kind
  if (m.meetingId) out.meetingId = m.meetingId
  return out
}

// ---------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------

/**
 * A server meeting → the prototype's meeting record, plus what the server says the caller may do
 * (`canRead`, `canManage`, `canOpenFiles`, `canPostSummary`). A brief (from a channel's list) has
 * no transcript, notes, files or summary body: those keys are left off, so merging it over a
 * meeting already loaded in full does not wipe them. `detail` says whether they are here.
 */
export function adaptMeeting(m, ctx) {
  const no = ctx.noOf
  const s = m.summary
  const out = {
    id: m.id,
    channelId: m.channelId,
    logChannelId: m.logChannelId || null,
    dm: false,
    video: Boolean(m.video),
    startedAt: wall(m.startedAt),
    endedAt: wall(m.endedAt),
    hostId: no(m.hostId),
    participantIds: (m.participantIds || []).map(no),
    access: { mode: m.access, extraIds: (m.readerIds || []).map(no) },
    filesViewOnly: Boolean(m.filesViewOnly),
    hasSummary: Boolean(m.hasSummary),
    summaryPostedAt: m.summaryPostedAt ? wall(m.summaryPostedAt) : null,
    canRead: Boolean(m.canRead),
    canManage: Boolean(m.canManage),
    canOpenFiles: Boolean(m.canOpenFiles),
    canPostSummary: Boolean(m.canPostSummary),
    detail: Array.isArray(m.transcript),
  }
  if (out.detail) {
    out.transcript = m.transcript.map((l) => ({ at: wall(l.at), speakerId: no(l.speakerId), text: l.text }))
    out.notes = (m.notes || []).map((n) => ({ id: n.id, by: no(n.authorId), at: wall(n.at), text: n.text }))
    out.files = (m.files || []).map((f) => ({ id: f.id, name: f.filename, kind: f.kind, size: f.sizeBytes, by: no(f.uploaderId), at: wall(f.at) }))
    out.summary = s
      ? {
          overview: s.overview, agenda: s.agenda || [], discussion: s.discussion || [], decisions: s.decisions || [],
          actionItems: (s.actionItems || []).map((a) => ({ text: a.text, ownerId: a.ownerId ? no(a.ownerId) : null, due: a.due || null, ...(a.taskNo ? { taskId: a.taskNo } : {}) })),
          source: s.source, provider: s.provider || null, model: s.model || null,
          at: s.at ? wall(s.at) : null, by: s.by ? no(s.by) : null,
        }
      : null
  }
  return out
}

const EMPTY_DETAIL = { transcript: [], notes: [], files: [], summary: null, detail: false }

/** Fold a newly adapted meeting into the one already held. If the caller can no longer read it,
 *  what was said is dropped — losing access takes the minutes with it. */
export function mergeMeeting(prev, next) {
  const base = prev && next.canRead ? prev : { ...EMPTY_DETAIL }
  return { ...base, ...next, detail: next.canRead ? (next.detail || Boolean(prev?.detail)) : false }
}

/** Put `next` into a list of meetings by id, oldest call first. */
export function upsertMeeting(list, next) {
  const i = list.findIndex((m) => m.id === next.id)
  const merged = mergeMeeting(i >= 0 ? list[i] : null, next)
  const out = i >= 0 ? list.map((m, j) => (j === i ? merged : m)) : [...list, merged]
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
}

/** Keep one channel's messages in conversation order. `seq` is the order; ties cannot happen
 *  among sent messages, and a message still being sent (no `seq`) belongs at the end. */
export function bySeq(a, b) {
  const sa = a.seq ?? Number.MAX_SAFE_INTEGER
  const sb = b.seq ?? Number.MAX_SAFE_INTEGER
  return sa - sb || a.at.localeCompare(b.at)
}

// ---------------------------------------------------------------------------
// Presence, notifications
// ---------------------------------------------------------------------------

/** `{ [memberNo]: status }` for everyone who is not offline. The caller's own entry is their
 *  chosen status, so the panel at the bottom left shows what they set. */
export function adaptPresence(presence, myStatus, ctx) {
  const out = {}
  for (const [uuid, status] of Object.entries(presence || {})) out[ctx.noOf(uuid)] = status
  if (ctx.meNo && myStatus) out[ctx.meNo] = myStatus
  return out
}

export function adaptNotification(n) {
  return { id: n.id, kind: n.kind, at: wall(n.at), title: n.title, body: n.body, to: n.to, read: n.read }
}

// ---------------------------------------------------------------------------
// The whole bootstrap
// ---------------------------------------------------------------------------

/** Everything `GET /chat/bootstrap` says, as the slices the screens read. */
export function adaptBootstrap(boot) {
  const projects = boot.projects || []
  const projectNoOf = new Map(projects.map((p) => [p.id, p.projectNo]))
  const members = boot.members.map((m) => adaptMember(m, projectNoOf))
  const ctx = makeContext(boot.me.id, members)
  return {
    ctx,
    meNo: ctx.meNo,
    meUuid: boot.me.id,
    myStatus: boot.myStatus || 'online',
    members,
    projectDivisions: projectDivisionsFrom(projects),
    chatProjects: adaptProjects(projects),
    channels: [...boot.channels, ...boot.discoverable].map((c) => adaptChannel(c, ctx)),
    presence: adaptPresence(boot.presence, boot.myStatus, ctx),
  }
}
